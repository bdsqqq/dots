import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { PiClient } from "@earendil-works/pi-client";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { RemoteSession } from "@earendil-works/pi-coding-agent/client";
import type {
  ModelMetadata,
  ModelRef,
  SessionMetadata,
  SessionPhase,
  SessionSnapshot,
  ThinkingLevel,
  TranscriptItem,
  Usage as ProtocolUsage,
} from "@earendil-works/pi-protocol";
import {
  PiServerError,
  SessionBusyError,
  SessionNotFoundError,
  toProtocolAssistantMessage,
  toProtocolModelMetadata,
  toProtocolToolResultMessage,
  toProtocolUserMessage,
  type CreateSessionOptions,
  type PiServerService,
  type PiSessionRuntime,
  type PiSessionRuntimeEvent,
  type PromptInput,
  type SteerInput,
} from "@earendil-works/pi-server";
import type {
  PiCapacityProvider,
  PiSpawnConfig,
  PiSpawnLifecycle,
  PiSpawnModel,
  PiSpawnResult,
  UsageStats,
} from "./index.js";

export interface PiSpawnRuntimeFactoryOptions {
  sessionManager: SessionManager;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  reason: "create" | "open";
}

/** Acquires one live runtime. Placement may remain local or lease another executor. */
export type PiSpawnRuntimeFactory = (
  options: PiSpawnRuntimeFactoryOptions,
) => Promise<PiSessionRuntime>;

export interface PiSpawnServerServiceOptions {
  defaultCwd?: string;
  agentDir?: string;
  /** A shared catalogue directory. Omit to use pi's per-cwd session directories. */
  sessionDir?: string;
  runtimeFactory?: PiSpawnRuntimeFactory;
  listModels?: () => Promise<ModelMetadata[]>;
}

function timestamp(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function persistSessionHeader(sessionManager: SessionManager): string {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) {
    throw new Error("failed to allocate a persistent pi session");
  }

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const entries = [header, ...sessionManager.getEntries()];
  fs.writeFileSync(
    sessionFile,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
  return sessionFile;
}

function parentSessionId(
  parentSessionPath: string | undefined,
): string | undefined {
  if (!parentSessionPath) return undefined;
  try {
    const line = fs.readFileSync(parentSessionPath, "utf8").split("\n")[0];
    if (!line) return undefined;
    const header = JSON.parse(line) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string"
      ? header.id
      : undefined;
  } catch {
    return undefined;
  }
}

function isProtocolMessage(message: { role: string }): message is Message {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

function transcriptItemId(
  sessionId: string,
  message: Message,
  index: number,
): string {
  return `${sessionId}:${message.role}:${message.timestamp}:${index}`;
}

function toProtocolTranscript(session: AgentSession): TranscriptItem[] {
  const messages = session.messages.filter(isProtocolMessage);
  const entryIds = new Map<object, string>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === "message" && isProtocolMessage(entry.message)) {
      entryIds.set(entry.message, entry.id);
    }
  }

  const calls = new Map<string, ToolCall>();
  return messages.map((message, index) => {
    const id =
      entryIds.get(message) ??
      transcriptItemId(session.sessionId, message, index);
    if (message.role === "user") {
      return toProtocolUserMessage(message, { id });
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") calls.set(part.id, part);
      }
      return toProtocolAssistantMessage(message, { id });
    }

    const call = calls.get(message.toolCallId);
    if (!call) {
      throw new TypeError(
        `tool result ${message.toolCallId} has no preceding tool call`,
      );
    }
    return toProtocolToolResultMessage(message, { id, call });
  });
}

function runtimePhase(session: AgentSession): SessionPhase {
  if (session.isRetrying) return "retry";
  if (session.isCompacting) return "compaction";
  if (session.isStreaming) return "turn";
  return "idle";
}

/** Adapts a coding-agent runtime to upstream pi's transport-neutral runtime. */
export class AgentSessionPiRuntime implements PiSessionRuntime {
  readonly #runtime: AgentSessionRuntime;
  readonly #createdAt: number;
  readonly #listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
  readonly #unsubscribe: () => void;
  #revision = 0;
  #updatedAt: number;
  #startingTurn = false;
  #disposed = false;

  constructor(runtime: AgentSessionRuntime) {
    this.#runtime = runtime;
    const now = Date.now();
    this.#createdAt = timestamp(
      runtime.session.sessionManager.getHeader()?.timestamp,
      now,
    );
    this.#updatedAt = now;
    this.#unsubscribe = runtime.session.subscribe(() => {
      this.#revision += 1;
      this.#updatedAt = Date.now();
      for (const listener of this.#listeners) listener({ type: "snapshot" });
    });
  }

  snapshot(): SessionSnapshot {
    this.#assertLive();
    const session = this.#runtime.session;
    const model = session.model;
    if (!model)
      throw new PiServerError("invalid_request", "session has no model");
    const transcript = toProtocolTranscript(session);
    const lastTimestamp = transcript.reduce(
      (latest, item) => Math.max(latest, item.timestamp),
      this.#createdAt,
    );
    const queuedSteer = session.getSteeringMessages().map((text, index) => ({
      id: `${session.sessionId}:steer:${index}`,
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: this.#updatedAt,
    }));

    return {
      id: session.sessionId,
      ...(session.sessionName ? { name: session.sessionName } : {}),
      cwd: this.#runtime.cwd,
      createdAt: this.#createdAt,
      updatedAt: Math.max(this.#updatedAt, lastTimestamp),
      phase: this.getPhase(),
      model: { provider: model.provider, id: model.id },
      thinkingLevel: session.thinkingLevel,
      attached: false,
      locked: true,
      revision: this.#revision,
      transcript,
      queuedSteer,
      queuedSteerCount: queuedSteer.length,
    };
  }

  getPhase(): SessionPhase {
    if (this.#disposed) return "idle";
    return this.#startingTurn ? "turn" : runtimePhase(this.#runtime.session);
  }

  async prompt(input: PromptInput): Promise<void> {
    this.#assertLive();
    if (this.getPhase() !== "idle") {
      throw new SessionBusyError("session is already running");
    }
    this.#startingTurn = true;
    try {
      await this.#runtime.session.prompt(input.text, { source: "rpc" });
    } finally {
      this.#startingTurn = false;
    }
  }

  async steer(input: SteerInput): Promise<void> {
    this.#assertLive();
    if (this.getPhase() !== "turn") {
      throw new SessionBusyError("session has no active turn to steer");
    }
    await this.#runtime.session.steer(input.text);
  }

  async abort(): Promise<void> {
    this.#assertLive();
    await this.#runtime.session.abort();
  }

  async setModel(model: ModelRef): Promise<void> {
    this.#assertIdle("change model");
    const resolved = this.#runtime.session.modelRuntime.getModel(
      model.provider,
      model.id,
    );
    if (!resolved) {
      throw new PiServerError(
        "invalid_request",
        `unknown model: ${model.provider}/${model.id}`,
      );
    }
    await this.#runtime.session.setModel(resolved);
  }

  async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
    this.#assertIdle("change thinking level");
    this.#runtime.session.setThinkingLevel(thinkingLevel);
  }

  subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
    this.#assertLive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#listeners.clear();
    try {
      await this.#runtime.session.abort();
    } finally {
      await this.#runtime.dispose();
    }
  }

  #assertIdle(action: string): void {
    this.#assertLive();
    if (this.getPhase() !== "idle") {
      throw new SessionBusyError(`cannot ${action} while session is busy`);
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new PiServerError("session_locked", "session runtime is disposed");
    }
  }
}

/**
 * durable session catalogue and runtime acquisition boundary for pi servers.
 *
 * PiServer supplies connection ownership and transport. this service persists
 * its exact server-assigned IDs, while runtimeFactory is the capacity seam.
 */
export class PiSpawnServerService implements PiServerService {
  readonly #defaultCwd: string;
  readonly #agentDir: string;
  readonly #sessionDir: string | undefined;
  readonly #runtimeFactory: PiSpawnRuntimeFactory;
  readonly #listModelsOverride: (() => Promise<ModelMetadata[]>) | undefined;
  #modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(options: PiSpawnServerServiceOptions = {}) {
    this.#defaultCwd = path.resolve(options.defaultCwd ?? process.cwd());
    this.#agentDir = path.resolve(options.agentDir ?? getAgentDir());
    this.#sessionDir = options.sessionDir
      ? path.resolve(options.sessionDir)
      : undefined;
    this.#runtimeFactory =
      options.runtimeFactory ?? ((input) => this.#createLocalRuntime(input));
    this.#listModelsOverride = options.listModels;
  }

  async listSessions(): Promise<SessionMetadata[]> {
    const sessions = await this.#sessions();
    return sessions.map((session) => {
      const parentId = parentSessionId(session.parentSessionPath);
      return {
        id: session.id,
        createdAt: session.created.getTime(),
        updatedAt: session.modified.getTime(),
        ...(parentId ? { parentSessionId: parentId } : {}),
        ...(session.name ? { sessionName: session.name } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
      };
    });
  }

  async listModels(): Promise<ModelMetadata[]> {
    if (this.#listModelsOverride) return this.#listModelsOverride();
    const runtime = await this.#modelRuntime();
    const available = new Set(
      (await runtime.getAvailable()).map(
        (model) => `${model.provider}\0${model.id}`,
      ),
    );
    return runtime
      .getModels()
      .map((model) =>
        toProtocolModelMetadata(
          model,
          available.has(`${model.provider}\0${model.id}`),
        ),
      );
  }

  async createSession(
    options: CreateSessionOptions,
  ): Promise<PiSessionRuntime> {
    if ((await this.#find(options.id)) !== undefined) {
      throw new PiServerError(
        "session_locked",
        `session already exists: ${options.id}`,
      );
    }

    const cwd = path.resolve(options.cwd ?? this.#defaultCwd);
    const manager = SessionManager.create(cwd, this.#sessionDir, {
      id: options.id,
    });
    if (options.name) manager.appendSessionInfo(options.name);
    const sessionFile = persistSessionHeader(manager);
    const persistedManager = SessionManager.open(
      sessionFile,
      this.#sessionDir,
      cwd,
    );

    try {
      return await this.#runtimeFactory({
        sessionManager: persistedManager,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        reason: "create",
      });
    } catch (error) {
      try {
        const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
        if (lines.length <= (options.name ? 2 : 1)) fs.rmSync(sessionFile);
      } catch {
        // preserve any session that escaped the header-only allocation state.
      }
      throw error;
    }
  }

  async openSession(sessionId: string): Promise<PiSessionRuntime> {
    const session = await this.#find(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return this.#runtimeFactory({
      sessionManager: SessionManager.open(
        session.path,
        this.#sessionDir,
        session.cwd || undefined,
      ),
      reason: "open",
    });
  }

  async #sessions() {
    return this.#sessionDir
      ? SessionManager.listAll(this.#sessionDir)
      : SessionManager.listAll();
  }

  async #find(sessionId: string) {
    return (await this.#sessions()).find((session) => session.id === sessionId);
  }

  #modelRuntime(): Promise<ModelRuntime> {
    this.#modelRuntimePromise ??= ModelRuntime.create({
      authPath: path.join(this.#agentDir, "auth.json"),
      modelsPath: path.join(this.#agentDir, "models.json"),
      refreshOnCreate: true,
    });
    return this.#modelRuntimePromise;
  }

  async #createLocalRuntime(
    options: PiSpawnRuntimeFactoryOptions,
  ): Promise<PiSessionRuntime> {
    const modelRuntime = await this.#modelRuntime();
    const createRuntime: CreateAgentSessionRuntimeFactory = async (target) => {
      const services = await createAgentSessionServices({
        cwd: target.cwd,
        agentDir: target.agentDir,
        modelRuntime,
      });
      const model = options.model
        ? services.modelRuntime.getModel(
            options.model.provider,
            options.model.id,
          )
        : undefined;
      if (options.model && !model) {
        throw new PiServerError(
          "invalid_request",
          `unknown model: ${options.model.provider}/${options.model.id}`,
        );
      }
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: target.sessionManager,
        sessionStartEvent: target.sessionStartEvent,
        model,
        thinkingLevel: options.thinkingLevel,
      });
      return {
        ...result,
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.sessionManager.getCwd(),
      agentDir: this.#agentDir,
      sessionManager: options.sessionManager,
      sessionStartEvent: {
        type: "session_start",
        reason: options.reason === "create" ? "new" : "resume",
      },
    });
    return new AgentSessionPiRuntime(runtime);
  }
}

function remoteUnsupported(config: PiSpawnConfig): string | undefined {
  const unsupported: string[] = [];
  if (config.builtinTools !== undefined) unsupported.push("builtinTools");
  if (config.extensionTools !== undefined) unsupported.push("extensionTools");
  if (config.systemPromptBody?.trim()) unsupported.push("systemPromptBody");
  if (config.followUp !== undefined) unsupported.push("followUp");
  if (config.env !== undefined) unsupported.push("env");
  if (config.configPath !== undefined) unsupported.push("configPath");
  if (config.session?.persist === false)
    unsupported.push("session.persist=false");
  if (config.session?.parentSession) unsupported.push("session.parentSession");
  if (config.session?.leafId) unsupported.push("session.leafId");
  return unsupported.length > 0
    ? `remote pi sessions do not support yet: ${unsupported.join(", ")}`
    : undefined;
}

function modelRef(model: PiSpawnModel): ModelRef {
  if (typeof model !== "string") {
    return { provider: model.provider, id: model.id };
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`remote model must be provider/modelId: ${model}`);
  }
  return {
    provider: model.slice(0, separator),
    id: model.slice(separator + 1),
  };
}

function fromProtocolUsage(usage: ProtocolUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function emptyAiUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fromProtocolTranscript(
  transcript: readonly TranscriptItem[],
  models: readonly ModelMetadata[],
): Message[] {
  return transcript.map((item): Message => {
    if (item.role === "user") {
      return {
        role: "user",
        content: item.content.map((part) => ({ ...part })),
        timestamp: item.timestamp,
      } satisfies UserMessage;
    }
    if (item.role === "assistant") {
      const model = models.find(
        (candidate) =>
          candidate.provider === item.model.provider &&
          candidate.id === item.model.id,
      );
      if (!model) {
        throw new Error(
          `remote server omitted model metadata for ${item.model.provider}/${item.model.id}`,
        );
      }
      const stopReason =
        item.status === "streaming" ? "pending" : item.stopReason;
      return {
        role: "assistant",
        content: item.content.map((part) =>
          part.type === "toolCall"
            ? {
                type: "toolCall" as const,
                id: part.toolCallId,
                name: part.toolName,
                arguments: part.input as Record<string, unknown>,
              }
            : { ...part },
        ),
        provider: item.model.provider,
        model: item.model.id,
        api: model.api as AssistantMessage["api"],
        ...(item.responseModel ? { responseModel: item.responseModel } : {}),
        usage: item.usage ? fromProtocolUsage(item.usage) : emptyAiUsage(),
        stopReason,
        ...(item.status === "error" || item.status === "aborted"
          ? { errorMessage: item.errorMessage }
          : {}),
        timestamp: item.timestamp,
      } satisfies AssistantMessage;
    }
    return {
      role: "toolResult",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      content: item.content.map((part) => ({ ...part })),
      ...(item.details === undefined ? {} : { details: item.details }),
      ...(item.usage ? { usage: fromProtocolUsage(item.usage) } : {}),
      isError: item.isError,
      timestamp: item.timestamp,
    } satisfies ToolResultMessage;
  });
}

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function usageFromMessages(messages: readonly Message[]): UsageStats {
  const total = emptyUsage();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    total.turns += 1;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    if (usage.cacheWrite1h !== undefined) {
      total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
    }
    if (usage.reasoning !== undefined) {
      total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    }
    total.cost += usage.cost.total;
    total.costBreakdown = {
      input: (total.costBreakdown?.input ?? 0) + usage.cost.input,
      output: (total.costBreakdown?.output ?? 0) + usage.cost.output,
      cacheRead: (total.costBreakdown?.cacheRead ?? 0) + usage.cost.cacheRead,
      cacheWrite:
        (total.costBreakdown?.cacheWrite ?? 0) + usage.cost.cacheWrite,
      total: (total.costBreakdown?.total ?? 0) + usage.cost.total,
    };
    total.contextTokens = usage.totalTokens;
  }
  return total;
}

function lastAssistant(
  messages: readonly Message[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function remoteResult(
  transcript: readonly TranscriptItem[],
  lifecycle: PiSpawnLifecycle,
  sessionId?: string,
  models: readonly ModelMetadata[] = [],
): PiSpawnResult {
  const messages = fromProtocolTranscript(transcript, models);
  const assistant = lastAssistant(messages);
  return {
    exitCode: 0,
    messages,
    stderr: "",
    usage: usageFromMessages(messages),
    ...(assistant
      ? {
          model: `${assistant.provider}/${assistant.model}`,
          stopReason: assistant.stopReason,
          ...(assistant.errorMessage
            ? { errorMessage: assistant.errorMessage }
            : {}),
        }
      : {}),
    ...(sessionId ? { session: { sessionId, continueId: sessionId } } : {}),
    lifecycle,
  };
}

/** Runs compatible piSpawn work through an upstream RemoteSession/PiClient. */
export class RemotePiCapacityProvider implements PiCapacityProvider {
  readonly #client: PiClient;

  constructor(client: PiClient) {
    this.#client = client;
  }

  async run(config: PiSpawnConfig): Promise<PiSpawnResult> {
    if (
      config.timeoutMs !== undefined &&
      (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive finite number");
    }

    const startedAt = new Date().toISOString();
    const lifecycle: PiSpawnLifecycle = {
      pid: null,
      processGroupId: null,
      owner: config.owner ?? null,
      startedAt,
      endedAt: null,
      status: "starting",
      exitCode: null,
      signal: null,
      errorKind: null,
      cancellationRequestedAt: null,
      timeoutMs: config.timeoutMs ?? null,
      timedOutAt: null,
    };
    const unsupported = remoteUnsupported(config);
    if (unsupported) {
      lifecycle.status = "failed";
      lifecycle.errorKind = "unsupported";
      lifecycle.exitCode = 1;
      lifecycle.endedAt = startedAt;
      return {
        ...remoteResult([], lifecycle),
        exitCode: 1,
        stopReason: "error",
        errorMessage: unsupported,
      };
    }
    if (config.signal?.aborted) {
      lifecycle.status = "cancelled";
      lifecycle.errorKind = "cancelled";
      lifecycle.exitCode = 1;
      lifecycle.cancellationRequestedAt = startedAt;
      lifecycle.endedAt = startedAt;
      return {
        ...remoteResult([], lifecycle),
        exitCode: 1,
        stopReason: "aborted",
        errorMessage: "remote pi session cancelled",
      };
    }

    let remote: RemoteSession | undefined;
    let result = remoteResult([], lifecycle);
    let unsubscribe: (() => void) | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let abortPromise: Promise<void> | undefined;
    let interruption: "cancelled" | "timed_out" | undefined;
    let interruptionError: string | undefined;
    const requestAbort = (reason: "cancelled" | "timed_out") => {
      if (interruption) return;
      interruption = reason;
      const now = new Date().toISOString();
      if (reason === "cancelled") lifecycle.cancellationRequestedAt = now;
      else lifecycle.timedOutAt = now;
      if (remote) {
        abortPromise = remote.abort().catch((error) => {
          interruptionError =
            error instanceof Error ? error.message : String(error);
        });
      }
    };
    const onAbort = () => requestAbort("cancelled");
    config.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const requestedModel = config.model ? modelRef(config.model) : undefined;
      remote = config.session?.id
        ? await RemoteSession.open(this.#client, config.session.id)
        : await RemoteSession.create(this.#client, {
            cwd: config.cwd,
            ...(requestedModel ? { model: requestedModel } : {}),
          });
      if (requestedModel && config.session?.id && !interruption) {
        await remote.setModel(requestedModel);
      }

      if (!interruption) lifecycle.status = "running";
      result = remoteResult(
        remote.state.transcript,
        lifecycle,
        remote.id,
        remote.models,
      );
      unsubscribe = remote.subscribe((state) => {
        result = remoteResult(
          state.transcript,
          lifecycle,
          remote?.id,
          remote?.models,
        );
        config.onUpdate?.({ ...result, messages: [...result.messages] });
      });
      if (config.timeoutMs !== undefined && !interruption) {
        timeout = setTimeout(() => requestAbort("timed_out"), config.timeoutMs);
      }

      if (!interruption) {
        await remote.submit(`Delegated task: ${config.task}`);
      }
      if (abortPromise) await abortPromise;
      result = remoteResult(
        remote.state.transcript,
        lifecycle,
        remote.id,
        remote.models,
      );

      const assistant = lastAssistant(result.messages);
      if (interruption) {
        result.exitCode = 1;
        result.stopReason = "aborted";
        result.errorMessage =
          interruptionError ??
          (interruption === "cancelled"
            ? "remote pi session cancelled"
            : `remote pi session timed out after ${config.timeoutMs}ms`);
        lifecycle.status = interruption;
        lifecycle.errorKind =
          interruption === "cancelled" ? "cancelled" : "timeout";
      } else if (
        assistant?.stopReason === "error" ||
        assistant?.stopReason === "aborted"
      ) {
        result.exitCode = 1;
        lifecycle.status = "failed";
        lifecycle.errorKind = "agent";
      } else {
        lifecycle.status = "succeeded";
      }
    } catch (error) {
      result.exitCode = 1;
      result.stopReason = interruption ? "aborted" : "error";
      result.errorMessage =
        error instanceof Error ? error.message : String(error);
      lifecycle.status = interruption ?? "failed";
      lifecycle.errorKind = interruption
        ? interruption === "cancelled"
          ? "cancelled"
          : "timeout"
        : this.#client.connectionState === "connected"
          ? "agent"
          : "transport";
    } finally {
      if (timeout) clearTimeout(timeout);
      config.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      if (remote) {
        try {
          await remote.dispose();
        } catch (error) {
          if (result.exitCode === 0) {
            result.exitCode = 1;
            result.stopReason = "error";
            result.errorMessage =
              error instanceof Error ? error.message : String(error);
            lifecycle.status = "failed";
            lifecycle.errorKind = "transport";
          }
        }
      }
      lifecycle.exitCode = result.exitCode;
      lifecycle.endedAt = new Date().toISOString();
      config.onUpdate?.({ ...result, messages: [...result.messages] });
    }

    return result;
  }
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { PiClient } = await import("@earendil-works/pi-client");
  const { createUnixTransportFactory } =
    await import("@earendil-works/pi-client/unix");
  const { TEST_MODEL, TestServerService, TestSessionRuntime } =
    await import("@earendil-works/pi-server/testing");
  const { createUnixServer } = await import("@earendil-works/pi-server/unix");
  const roots: string[] = [];

  const makeRoot = () => {
    const root = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "pi-remote-"),
    );
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  describe("PiSpawnServerService", () => {
    it("persists server-assigned ids and reacquires disposed sessions", async () => {
      const root = makeRoot();
      const runtimes: InstanceType<typeof TestSessionRuntime>[] = [];
      const service = new PiSpawnServerService({
        defaultCwd: root,
        sessionDir: path.join(root, "sessions"),
        listModels: async () => [TEST_MODEL],
        runtimeFactory: async ({ sessionManager }) => {
          const createdAt = timestamp(
            sessionManager.getHeader()?.timestamp,
            Date.now(),
          );
          const runtime = new TestSessionRuntime(
            {
              snapshot: {
                id: sessionManager.getSessionId(),
                cwd: sessionManager.getCwd(),
                createdAt,
                updatedAt: createdAt,
                phase: "idle",
                model: { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
                thinkingLevel: "off",
                attached: false,
                locked: true,
                revision: 0,
                transcript: [],
                queuedSteer: [],
                queuedSteerCount: 0,
              },
            },
            () => {},
          );
          runtimes.push(runtime);
          return runtime;
        },
      });

      const first = await service.createSession({
        id: "server-id",
        cwd: root,
        name: "worker task",
      });
      await first.dispose();

      expect(await service.listSessions()).toEqual([
        expect.objectContaining({
          id: "server-id",
          cwd: root,
          sessionName: "worker task",
        }),
      ]);
      const reopened = await service.openSession("server-id");
      expect((await reopened.snapshot()).id).toBe("server-id");
      expect(runtimes).toHaveLength(2);
      await reopened.dispose();
    });
  });

  describe("RemotePiCapacityProvider", () => {
    it("runs a piSpawn task through RemoteSession over a unix transport", async () => {
      const root = makeRoot();
      const socketPath = path.join(root, "pi.sock");
      const service = new TestServerService();
      const server = createUnixServer(service, { path: socketPath });
      await server.start();
      const client = await PiClient.connect({
        transportFactory: createUnixTransportFactory({ path: socketPath }),
      });

      try {
        const provider = new RemotePiCapacityProvider(client);
        const pending = provider.run({ cwd: root, task: "inspect this tree" });
        while (!service.lastCreatedId) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const runtime = service.latestRuntime(service.lastCreatedId);
        while (runtime.getPhase() === "idle") {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        runtime.finishPrompt();

        const result = await pending;
        expect(result.lifecycle?.status).toBe("succeeded");
        expect(result.session?.sessionId).toBe(service.lastCreatedId);
        expect(
          result.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ).toContain("reply:Delegated task: inspect this tree");
        await runtime.disposed.promise;
      } finally {
        await client.dispose();
        await server.close();
      }
    });

    it("aborts and disposes remote work when its lease times out", async () => {
      const root = makeRoot();
      const socketPath = path.join(root, "pi.sock");
      const service = new TestServerService();
      const server = createUnixServer(service, { path: socketPath });
      await server.start();
      const client = await PiClient.connect({
        transportFactory: createUnixTransportFactory({ path: socketPath }),
      });

      try {
        const provider = new RemotePiCapacityProvider(client);
        const result = await provider.run({
          cwd: root,
          task: "keep working",
          timeoutMs: 20,
        });
        const runtime = service.latestRuntime(service.lastCreatedId!);

        expect(result.lifecycle).toMatchObject({
          status: "timed_out",
          errorKind: "timeout",
        });
        expect(result.lifecycle?.timedOutAt).not.toBeNull();
        expect(result.stopReason).toBe("aborted");
        await runtime.disposed.promise;
      } finally {
        await client.dispose();
        await server.close();
      }
    });

    it("fails before admission when a spawn profile cannot cross protocol v1", async () => {
      const service = new TestServerService();
      const client = new PiClient({
        transportFactory: async () => {
          throw new Error("transport should not be opened");
        },
      });
      const provider = new RemotePiCapacityProvider(client);

      const result = await provider.run({
        cwd: makeRoot(),
        task: "test",
        builtinTools: ["read"],
      });

      expect(result.lifecycle).toMatchObject({
        status: "failed",
        errorKind: "unsupported",
      });
      expect(result.errorMessage).toContain("builtinTools");
      expect(service.lastCreatedId).toBeUndefined();
      await client.dispose();
    });
  });
}
