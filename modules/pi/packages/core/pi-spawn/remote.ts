import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
  PiCapacityAdmission,
  PiCapacityCoordinator,
  PiCapacityProvider,
  PiCapacitySessionBinding,
  PiCapacitySessionRequest,
  PiCapacitySessionResult,
  PiSpawnConfig,
  PiSpawnLifecycle,
  PiSpawnModel,
  PiSpawnResult,
  PiWorkspaceResultApplyOutcome,
  PiWorkspaceResultApplyRequest,
  PiWorkspaceResultReference,
  UsageStats,
} from "./index.js";

export interface PiCapacityExecutionProfile {
  agentDir?: string;
  tools?: string[];
  noExtensions?: boolean;
  extensionPaths?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string[];
}

export interface PiSpawnRuntimeFactoryOptions {
  sessionManager: SessionManager;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  executionProfile?: PiCapacityExecutionProfile;
  reason: "create" | "open";
}

/** Acquires one live runtime. Placement may remain local or lease another executor. */
export type PiSpawnRuntimeFactory = (
  options: PiSpawnRuntimeFactoryOptions,
) => Promise<PiSessionRuntime>;

export interface PiSpawnServerCapacityOptions {
  catalogueDir: string;
  executorRoot: string;
  repositories: Readonly<Record<string, string>>;
  executionProfiles: Readonly<Record<string, PiCapacityExecutionProfile>>;
}

export interface PiSpawnServerServiceOptions {
  defaultCwd?: string;
  agentDir?: string;
  /** A shared catalogue directory. Omit to use pi's per-cwd session directories. */
  sessionDir?: string;
  /** Admit sessions by repository identity instead of treating request cwd as portable. */
  capacity?: PiSpawnServerCapacityOptions;
  modelRuntime?: ModelRuntime;
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
export class PiSpawnServerService
  implements PiServerService, PiCapacityCoordinator
{
  readonly #defaultCwd: string;
  readonly #agentDir: string;
  readonly #sessionDir: string | undefined;
  readonly #runtimeFactory: PiSpawnRuntimeFactory;
  readonly #capacity: LocalPiSessionCapacity | undefined;
  readonly #listModelsOverride: (() => Promise<ModelMetadata[]>) | undefined;
  #pendingAdmission:
    | {
        admissionRef: string;
        request: PiCapacitySessionRequest;
        sessionId?: string;
      }
    | undefined;
  #modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(options: PiSpawnServerServiceOptions = {}) {
    this.#defaultCwd = path.resolve(options.defaultCwd ?? process.cwd());
    this.#agentDir = path.resolve(options.agentDir ?? getAgentDir());
    this.#sessionDir = options.sessionDir
      ? path.resolve(options.sessionDir)
      : undefined;
    this.#runtimeFactory =
      options.runtimeFactory ?? ((input) => this.#createLocalRuntime(input));
    this.#capacity = options.capacity
      ? new LocalPiSessionCapacity({
          catalogueDir: options.capacity.catalogueDir,
          executorRoot: options.capacity.executorRoot,
          repositories: options.capacity.repositories,
          executionProfiles: options.capacity.executionProfiles,
          runtimeFactory: this.#runtimeFactory,
        })
      : undefined;
    this.#listModelsOverride = options.listModels;
    if (options.modelRuntime) {
      this.#modelRuntimePromise = Promise.resolve(options.modelRuntime);
    }
  }

  async admitSession(
    request: PiCapacitySessionRequest,
  ): Promise<PiCapacityAdmission> {
    const capacity = this.#requireCapacity();
    if (this.#pendingAdmission) {
      throw new PiServerError(
        "session_locked",
        "capacity already has a pending session admission",
      );
    }
    const validated = capacity.validateAdmission(request);
    const admission = {
      admissionRef: randomUUID(),
      request: validated,
    };
    this.#pendingAdmission = admission;
    return { admissionRef: admission.admissionRef };
  }

  async bindSession(
    admission: PiCapacityAdmission,
    sessionId: string,
  ): Promise<PiCapacitySessionBinding> {
    const pending = this.#pendingAdmission;
    if (
      !pending ||
      pending.admissionRef !== admission.admissionRef ||
      pending.sessionId !== sessionId
    ) {
      throw new Error(
        `capacity admission ${admission.admissionRef} is not bound to session ${sessionId}`,
      );
    }
    this.#pendingAdmission = undefined;
    return { admissionRef: admission.admissionRef, sessionId };
  }

  async cancelAdmission(admission: PiCapacityAdmission): Promise<void> {
    if (this.#pendingAdmission?.admissionRef === admission.admissionRef) {
      this.#pendingAdmission = undefined;
    }
  }

  async authorizeContinuation(
    request: PiCapacitySessionRequest,
    sessionId: string,
  ): Promise<PiCapacitySessionBinding> {
    const record = this.#requireCapacity().getRecord(sessionId);
    if (
      record.workspace.repositoryId !== request.repositoryId ||
      record.workspace.baseRevision !== request.baseRevision ||
      record.executionProfileId !== request.executionProfileId ||
      record.parentSessionId !== request.parentSessionId
    ) {
      throw new Error(
        `capacity continuation ${sessionId} does not match repository, base revision, execution profile, and parent provenance`,
      );
    }
    return { admissionRef: record.admissionRef, sessionId };
  }

  async getSessionResult(
    binding: PiCapacitySessionBinding,
  ): Promise<PiCapacitySessionResult> {
    return this.#requireCapacity().getSessionResult(binding);
  }

  async applyWorkspaceResult(
    request: PiWorkspaceResultApplyRequest,
  ): Promise<PiWorkspaceResultApplyOutcome> {
    return this.#requireCapacity().applyWorkspaceResult(request);
  }

  async listSessions(): Promise<SessionMetadata[]> {
    if (this.#capacity) return this.#capacity.listSessions();
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
    if (this.#capacity) {
      const admission = this.#pendingAdmission;
      if (!admission || admission.sessionId) {
        throw new PiServerError(
          "invalid_request",
          "capacity session creation requires a pending coordinator admission",
        );
      }
      admission.sessionId = options.id;
      return this.#capacity.createSession({
        sessionId: options.id,
        admissionRef: admission.admissionRef,
        ...admission.request,
        ...(options.name ? { name: options.name } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.thinkingLevel
          ? { thinkingLevel: options.thinkingLevel }
          : {}),
      });
    }
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
    if (this.#capacity) return this.#capacity.acquireSession(sessionId);
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

  #requireCapacity(): LocalPiSessionCapacity {
    if (!this.#capacity) {
      throw new Error("pi server service has no capacity coordinator");
    }
    return this.#capacity;
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
      const profile = options.executionProfile;
      const agentDir = path.resolve(profile?.agentDir ?? target.agentDir);
      const services = await createAgentSessionServices({
        cwd: target.cwd,
        agentDir,
        modelRuntime,
        ...(profile
          ? {
              resourceLoaderOptions: {
                ...(profile.noExtensions === undefined
                  ? {}
                  : { noExtensions: profile.noExtensions }),
                ...(profile.extensionPaths
                  ? { additionalExtensionPaths: profile.extensionPaths }
                  : {}),
                ...(profile.systemPrompt
                  ? { systemPrompt: profile.systemPrompt }
                  : {}),
                ...(profile.appendSystemPrompt
                  ? { appendSystemPrompt: profile.appendSystemPrompt }
                  : {}),
              },
            }
          : {}),
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
        ...(profile?.tools ? { tools: profile.tools } : {}),
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

export type PiCapacitySessionLifecycle = "active" | "suspending" | "suspended";

export interface PiCapacityArtifactReference {
  key: string;
}

/** Durable identity and the last acknowledged checkpoint for one pi session. */
export interface PiCapacitySessionRecord {
  sessionId: string;
  admissionRef: string;
  createdAt: number;
  updatedAt: number;
  sessionName?: string;
  parentSessionId?: string;
  workspace: {
    repositoryId: string;
    baseRevision: string;
  };
  workspaceCheckpointRef: PiCapacityArtifactReference;
  sessionLogRef: PiCapacityArtifactReference;
  workspaceResultRef?: PiWorkspaceResultReference;
  executionProfileId: string;
  leaseEpoch: number;
  lifecycle: PiCapacitySessionLifecycle;
}

interface PiWorkspaceResultRecord {
  id: string;
  admissionRef: string;
  sessionId: string;
  repositoryId: string;
  baseRevision: string;
  workspaceCheckpointRef: PiCapacityArtifactReference;
}

export interface LocalPiSessionCapacityOptions {
  catalogueDir: string;
  executorRoot: string;
  repositories: Readonly<Record<string, string>>;
  executionProfiles: Readonly<Record<string, PiCapacityExecutionProfile>>;
  runtimeFactory: PiSpawnRuntimeFactory;
}

export interface CreateLocalPiSessionOptions extends PiCapacitySessionRequest {
  sessionId: string;
  admissionRef: string;
  name?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

function runCommand(
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function command(
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): string {
  const result = runCommand(executable, args, env);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${executable} ${args.join(" ")} failed with status ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function git(repository: string, args: readonly string[]): string {
  return command("git", ["-C", repository, ...args]);
}

function nulPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function fsyncFile(file: string): void {
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function acknowledgeFile(temporaryPath: string, finalPath: string): void {
  fsyncFile(temporaryPath);
  fs.renameSync(temporaryPath, finalPath);
  fsyncDirectory(path.dirname(finalPath));
}

/**
 * One fenced, host-local materialization of a durable pi session.
 *
 * PiServer calls dispose when an idle runtime loses its final attachment. Here
 * that operation checkpoints the workspace and session log before releasing the
 * lease, so the server never needs to treat an executor path as durable state.
 */
export class LocalPiSessionLease implements PiSessionRuntime {
  readonly sessionId: string;
  readonly leaseEpoch: number;
  readonly executorDir: string;
  readonly workspacePath: string;
  readonly #delegate: PiSessionRuntime;
  readonly #suspendOperation: (
    publishWorkspaceResult: boolean,
  ) => Promise<void>;
  #state: PiCapacitySessionLifecycle = "active";
  #inFlight = 0;
  #publishWorkspaceResult = true;

  constructor(options: {
    sessionId: string;
    leaseEpoch: number;
    executorDir: string;
    workspacePath: string;
    delegate: PiSessionRuntime;
    suspend: (publishWorkspaceResult: boolean) => Promise<void>;
  }) {
    this.sessionId = options.sessionId;
    this.leaseEpoch = options.leaseEpoch;
    this.executorDir = options.executorDir;
    this.workspacePath = options.workspacePath;
    this.#delegate = options.delegate;
    this.#suspendOperation = options.suspend;
  }

  snapshot(): SessionSnapshot | Promise<SessionSnapshot> {
    this.#assertActive();
    return this.#delegate.snapshot();
  }

  getPhase(): SessionPhase {
    return this.#state === "active" ? this.#delegate.getPhase() : "idle";
  }

  prompt(input: PromptInput): Promise<void> {
    return this.#run(() => this.#delegate.prompt(input));
  }

  steer(input: SteerInput): Promise<void> {
    return this.#run(() => this.#delegate.steer(input));
  }

  abort(): Promise<void> {
    this.#publishWorkspaceResult = false;
    return this.#run(() => this.#delegate.abort());
  }

  setModel(model: ModelRef): Promise<void> {
    return this.#run(() => this.#delegate.setModel(model));
  }

  setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
    return this.#run(() => this.#delegate.setThinking(thinkingLevel));
  }

  subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
    this.#assertActive();
    return this.#delegate.subscribe(listener);
  }

  async suspend(): Promise<void> {
    if (this.#state === "suspending") {
      throw new SessionBusyError("session suspension is already in progress");
    }
    if (this.#state === "active") {
      if (this.#inFlight > 0 || this.#delegate.getPhase() !== "idle") {
        throw new SessionBusyError("cannot suspend a busy session");
      }
      this.#state = "suspending";
    }

    await this.#suspendOperation(this.#publishWorkspaceResult);
    this.#state = "suspended";
  }

  async dispose(): Promise<void> {
    if (this.#state === "suspended") return;
    await this.suspend();
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertActive();
    this.#inFlight += 1;
    try {
      return await operation();
    } finally {
      this.#inFlight -= 1;
    }
  }

  #assertActive(): void {
    if (this.#state !== "active") {
      throw new PiServerError(
        "session_locked",
        `session lease is ${this.#state}`,
      );
    }
  }
}

/** Local filesystem/git proof of the workspace-above-session capacity seam. */
export class LocalPiSessionCapacity {
  readonly #catalogueDir: string;
  readonly #executorRoot: string;
  readonly #recordsDir: string;
  readonly #workspaceArtifactsDir: string;
  readonly #sessionArtifactsDir: string;
  readonly #workspaceResultsDir: string;
  readonly #lockPath: string;
  readonly #repositories: ReadonlyMap<string, string>;
  readonly #executionProfiles: ReadonlyMap<string, PiCapacityExecutionProfile>;
  readonly #runtimeFactory: PiSpawnRuntimeFactory;

  constructor(options: LocalPiSessionCapacityOptions) {
    this.#catalogueDir = path.resolve(options.catalogueDir);
    this.#executorRoot = path.resolve(options.executorRoot);
    this.#recordsDir = path.join(this.#catalogueDir, "records");
    this.#workspaceArtifactsDir = path.join(
      this.#catalogueDir,
      "workspace-checkpoints",
    );
    this.#sessionArtifactsDir = path.join(this.#catalogueDir, "session-logs");
    this.#workspaceResultsDir = path.join(
      this.#catalogueDir,
      "workspace-results",
    );
    this.#lockPath = path.join(this.#catalogueDir, "catalogue.lock");
    this.#repositories = new Map(
      Object.entries(options.repositories).map(([id, repository]) => [
        id,
        path.resolve(repository),
      ]),
    );
    this.#executionProfiles = new Map(
      Object.entries(options.executionProfiles),
    );
    this.#runtimeFactory = options.runtimeFactory;
    fs.mkdirSync(this.#recordsDir, { recursive: true });
    fs.mkdirSync(this.#workspaceArtifactsDir, { recursive: true });
    fs.mkdirSync(this.#sessionArtifactsDir, { recursive: true });
    fs.mkdirSync(this.#workspaceResultsDir, { recursive: true });
    fs.mkdirSync(this.#executorRoot, { recursive: true });
  }

  validateAdmission(
    request: PiCapacitySessionRequest,
  ): PiCapacitySessionRequest {
    const repository = this.#repository(request.repositoryId);
    if (!this.#executionProfiles.has(request.executionProfileId)) {
      throw new Error(
        `unknown execution profile: ${request.executionProfileId}`,
      );
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(request.baseRevision)) {
      throw new Error("baseRevision must be a full immutable commit id");
    }
    const baseRevision = git(repository, [
      "rev-parse",
      "--verify",
      `${request.baseRevision}^{commit}`,
    ]);
    if (baseRevision.toLowerCase() !== request.baseRevision.toLowerCase()) {
      throw new Error(
        `base revision is not immutable: ${request.baseRevision}`,
      );
    }
    return {
      ...request,
      baseRevision,
    };
  }

  getRecord(sessionId: string): PiCapacitySessionRecord {
    const recordPath = this.#recordPath(sessionId);
    if (!fs.existsSync(recordPath)) throw new SessionNotFoundError(sessionId);
    return JSON.parse(
      fs.readFileSync(recordPath, "utf8"),
    ) as PiCapacitySessionRecord;
  }

  getSessionResult(binding: PiCapacitySessionBinding): PiCapacitySessionResult {
    const record = this.getRecord(binding.sessionId);
    if (record.admissionRef !== binding.admissionRef) {
      throw new Error(
        `admission ${binding.admissionRef} does not own session ${binding.sessionId}`,
      );
    }
    if (record.lifecycle !== "suspended" || !record.workspaceResultRef) {
      throw new Error(`session result is not available: ${binding.sessionId}`);
    }
    return { ...binding, resultRef: record.workspaceResultRef };
  }

  applyWorkspaceResult(
    request: PiWorkspaceResultApplyRequest,
  ): PiWorkspaceResultApplyOutcome {
    const resultPath = this.#resultPath(request.resultRef.id);
    if (!fs.existsSync(resultPath)) {
      return {
        status: "rejected",
        code: "unknown_result",
        message: `unknown workspace result: ${request.resultRef.id}`,
      };
    }
    const result = JSON.parse(
      fs.readFileSync(resultPath, "utf8"),
    ) as PiWorkspaceResultRecord;
    if (result.sessionId !== request.sessionId) {
      return {
        status: "rejected",
        code: "session_mismatch",
        message: `workspace result belongs to session ${result.sessionId}, not ${request.sessionId}`,
      };
    }
    if (result.repositoryId !== request.repositoryId) {
      return {
        status: "rejected",
        code: "repository_mismatch",
        message: `workspace result belongs to repository ${result.repositoryId}, not ${request.repositoryId}`,
      };
    }
    if (result.baseRevision !== request.baseRevision) {
      return {
        status: "rejected",
        code: "base_mismatch",
        message: `workspace result uses base ${result.baseRevision}, not ${request.baseRevision}`,
      };
    }

    const repository = this.#repository(request.repositoryId);
    let targetRoot: string;
    try {
      targetRoot = path.resolve(
        git(request.targetCwd, ["rev-parse", "--show-toplevel"]),
      );
    } catch {
      return {
        status: "rejected",
        code: "target_repository_mismatch",
        message: `target is not the registered ${request.repositoryId} worktree`,
      };
    }
    if (fs.realpathSync(targetRoot) !== fs.realpathSync(repository)) {
      return {
        status: "rejected",
        code: "target_repository_mismatch",
        message: `target is not the registered ${request.repositoryId} worktree`,
      };
    }

    const baseCheck = runCommand("git", [
      "-C",
      targetRoot,
      "merge-base",
      "--is-ancestor",
      result.baseRevision,
      "HEAD",
    ]);
    if (baseCheck.status !== 0) {
      return {
        status: "rejected",
        code: "incompatible_base",
        message: `base ${result.baseRevision} is unavailable or is not an ancestor of target HEAD`,
      };
    }

    const scratch = fs.mkdtempSync(path.join(this.#catalogueDir, "apply-"));
    const gitDir = path.join(scratch, "repository.git");
    const indexFile = path.join(scratch, "parent.index");
    const patchFile = path.join(scratch, "result.patch");
    const authorEnvironment = {
      GIT_AUTHOR_NAME: "pi capacity",
      GIT_AUTHOR_EMAIL: "pi-capacity@local",
      GIT_COMMITTER_NAME: "pi capacity",
      GIT_COMMITTER_EMAIL: "pi-capacity@local",
    };

    try {
      command("git", ["clone", "--quiet", "--bare", targetRoot, gitDir]);
      const childRef = "refs/pi-apply/child";
      command("git", [
        "--git-dir",
        gitDir,
        "fetch",
        "--quiet",
        path.join(
          this.#workspaceArtifactsDir,
          result.workspaceCheckpointRef.key,
        ),
        `refs/pi-capacity/checkpoint:${childRef}`,
      ]);
      const childCommit = command("git", [
        "--git-dir",
        gitDir,
        "rev-parse",
        childRef,
      ]);
      const childParent = command("git", [
        "--git-dir",
        gitDir,
        "rev-parse",
        `${childCommit}^`,
      ]);
      if (childParent !== result.baseRevision) {
        return {
          status: "rejected",
          code: "base_mismatch",
          message: `workspace artifact parent is ${childParent}, expected ${result.baseRevision}`,
        };
      }

      const worktreeEnvironment = {
        ...authorEnvironment,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: targetRoot,
        GIT_INDEX_FILE: indexFile,
        GIT_OPTIONAL_LOCKS: "0",
      };
      const parentHead = git(targetRoot, ["rev-parse", "HEAD"]);
      command("git", ["read-tree", parentHead], worktreeEnvironment);
      command("git", ["add", "-A", "-f", "--", "."], worktreeEnvironment);
      const parentTree = command("git", ["write-tree"], worktreeEnvironment);
      const parentCommit = command(
        "git",
        [
          "--git-dir",
          gitDir,
          "commit-tree",
          parentTree,
          "-p",
          parentHead,
          "-m",
          "pi capacity parent snapshot",
        ],
        authorEnvironment,
      );
      const childPaths = nulPaths(
        command("git", [
          "--git-dir",
          gitDir,
          "diff",
          "--name-only",
          "-z",
          result.baseRevision,
          childCommit,
        ]),
      );
      const stagedPaths = new Set(
        nulPaths(
          command(
            "git",
            ["-C", targetRoot, "diff", "--cached", "--name-only", "-z"],
            { GIT_OPTIONAL_LOCKS: "0" },
          ),
        ),
      );
      const stagedChildPaths = childPaths.filter((entry) =>
        stagedPaths.has(entry),
      );
      if (stagedChildPaths.length > 0) {
        return {
          status: "rejected",
          code: "staged_path",
          message: `child result touches staged paths: ${stagedChildPaths.join(", ")}`,
          paths: stagedChildPaths,
        };
      }

      const merge = runCommand(
        "git",
        [
          "--git-dir",
          gitDir,
          "merge-tree",
          "--write-tree",
          "--name-only",
          "--messages",
          "--merge-base",
          result.baseRevision,
          parentCommit,
          childCommit,
        ],
        authorEnvironment,
      );
      if (merge.error) throw merge.error;
      if (merge.status === 1) {
        const parentPaths = new Set(
          nulPaths(
            command("git", [
              "--git-dir",
              gitDir,
              "diff",
              "--name-only",
              "-z",
              result.baseRevision,
              parentTree,
            ]),
          ),
        );
        const conflicts = childPaths.filter((entry) => parentPaths.has(entry));
        return {
          status: "conflict",
          paths: conflicts.length > 0 ? conflicts : childPaths,
          message:
            merge.stdout.trim() ||
            merge.stderr.trim() ||
            "workspace result conflicts with parent changes",
        };
      }
      if (merge.status !== 0) {
        throw new Error(
          `git merge-tree failed with status ${merge.status}: ${merge.stderr.trim()}`,
        );
      }
      const mergedTree = merge.stdout.split("\n", 1)[0]?.trim();
      if (!mergedTree) throw new Error("git merge-tree returned no tree");
      if (mergedTree === parentTree) return { status: "already_applied" };

      const appliedPaths = nulPaths(
        command("git", [
          "--git-dir",
          gitDir,
          "diff",
          "--name-only",
          "-z",
          parentTree,
          mergedTree,
        ]),
      );
      const patch = runCommand("git", [
        "--git-dir",
        gitDir,
        "diff",
        "--binary",
        "--full-index",
        parentTree,
        mergedTree,
      ]);
      if (patch.error) throw patch.error;
      if (patch.status !== 0) {
        throw new Error(
          `git diff failed with status ${patch.status}: ${patch.stderr.trim()}`,
        );
      }
      fs.writeFileSync(patchFile, patch.stdout, "utf8");
      command("git", ["-C", targetRoot, "apply", "--check", patchFile], {
        GIT_OPTIONAL_LOCKS: "0",
      });
      command("git", ["-C", targetRoot, "apply", patchFile], {
        GIT_OPTIONAL_LOCKS: "0",
      });
      return { status: "applied", paths: appliedPaths };
    } finally {
      fs.rmSync(scratch, { force: true, recursive: true });
    }
  }

  listSessions(): SessionMetadata[] {
    return fs
      .readdirSync(this.#recordsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        JSON.parse(fs.readFileSync(path.join(this.#recordsDir, entry), "utf8")),
      )
      .map((record: PiCapacitySessionRecord) => ({
        id: record.sessionId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.sessionName ? { sessionName: record.sessionName } : {}),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createSession(
    options: CreateLocalPiSessionOptions,
  ): Promise<LocalPiSessionLease> {
    this.#withCatalogueLock(() => {
      if (fs.existsSync(this.#recordPath(options.sessionId))) {
        throw new PiServerError(
          "session_locked",
          `session already exists: ${options.sessionId}`,
        );
      }
    });
    const admission = this.validateAdmission(options);
    const repository = this.#repository(admission.repositoryId);
    const baseRevision = admission.baseRevision;
    const executionProfile = this.#executionProfile(
      admission.executionProfileId,
    );
    const executorDir = this.#allocateExecutor(options.sessionId, 1);
    const executor = this.#provisionExecutor(
      repository,
      baseRevision,
      executorDir,
    );
    const sessionDir = path.join(executor.executorDir, "pi-session");
    const manager = SessionManager.create(executor.workspacePath, sessionDir, {
      id: options.sessionId,
    });
    if (options.name) manager.appendSessionInfo(options.name);
    const sessionFile = persistSessionHeader(manager);
    const persistedManager = SessionManager.open(
      sessionFile,
      sessionDir,
      executor.workspacePath,
    );
    let runtime: PiSessionRuntime | undefined;

    try {
      runtime = await this.#runtimeFactory({
        sessionManager: persistedManager,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        executionProfile,
        reason: "create",
      });
      if (runtime.getPhase() !== "idle") {
        throw new SessionBusyError("new session runtime is not idle");
      }
      const workspaceCheckpointRef = this.#persistWorkspaceCheckpoint(
        executor.workspacePath,
        baseRevision,
      );
      const sessionLogRef = this.#persistSessionLog(sessionFile);
      const createdAt = timestamp(
        persistedManager.getHeader()?.timestamp,
        Date.now(),
      );
      const record: PiCapacitySessionRecord = {
        sessionId: options.sessionId,
        admissionRef: options.admissionRef,
        createdAt,
        updatedAt: createdAt,
        ...(options.name ? { sessionName: options.name } : {}),
        ...(admission.parentSessionId
          ? { parentSessionId: admission.parentSessionId }
          : {}),
        workspace: { repositoryId: admission.repositoryId, baseRevision },
        workspaceCheckpointRef,
        sessionLogRef,
        executionProfileId: admission.executionProfileId,
        leaseEpoch: 1,
        lifecycle: "active",
      };
      this.#withCatalogueLock(() => {
        if (fs.existsSync(this.#recordPath(options.sessionId))) {
          throw new PiServerError(
            "session_locked",
            `session already exists: ${options.sessionId}`,
          );
        }
        this.#writeRecord(record);
      });
      return this.#createLease(record, executor, sessionFile, runtime);
    } catch (error) {
      if (runtime) await runtime.dispose().catch(() => {});
      fs.rmSync(executorDir, { force: true, recursive: true });
      throw error;
    }
  }

  async acquireSession(sessionId: string): Promise<LocalPiSessionLease> {
    let record!: PiCapacitySessionRecord;
    let runtime: PiSessionRuntime | undefined;
    let executorDir: string | undefined;
    this.#withCatalogueLock(() => {
      const current = this.getRecord(sessionId);
      if (current.lifecycle !== "suspended") {
        throw new PiServerError(
          "session_locked",
          `session lease is ${current.lifecycle}: ${sessionId}`,
        );
      }
      this.#executionProfile(current.executionProfileId);
      record = {
        ...current,
        updatedAt: Date.now(),
        leaseEpoch: current.leaseEpoch + 1,
        lifecycle: "active",
      };
      this.#writeRecord(record);
    });

    try {
      const repository = this.#repository(record.workspace.repositoryId);
      executorDir = this.#allocateExecutor(record.sessionId, record.leaseEpoch);
      const executor = this.#provisionExecutor(
        repository,
        record.workspace.baseRevision,
        executorDir,
      );
      this.#restoreWorkspace(
        executor.workspacePath,
        record.workspace.baseRevision,
        record.workspaceCheckpointRef,
      );
      const sessionFile = this.#materializeSessionLog(
        executor.executorDir,
        record.sessionLogRef,
      );
      const manager = SessionManager.open(
        sessionFile,
        path.dirname(sessionFile),
        executor.workspacePath,
      );
      if (manager.getSessionId() !== record.sessionId) {
        throw new Error(
          `session artifact ${record.sessionLogRef.key} contains ${manager.getSessionId()}, expected ${record.sessionId}`,
        );
      }
      runtime = await this.#runtimeFactory({
        sessionManager: manager,
        executionProfile: this.#executionProfile(record.executionProfileId),
        reason: "open",
      });
      if (runtime.getPhase() !== "idle") {
        throw new SessionBusyError("resumed session runtime is not idle");
      }
      return this.#createLease(record, executor, sessionFile, runtime);
    } catch (error) {
      if (runtime) await runtime.dispose().catch(() => {});
      if (executorDir) {
        try {
          fs.rmSync(executorDir, { force: true, recursive: true });
        } catch {
          // Lease rollback must not depend on cleaning a failed executor path.
        }
      }
      this.#withCatalogueLock(() => {
        const current = this.getRecord(record.sessionId);
        if (
          current.leaseEpoch === record.leaseEpoch &&
          current.lifecycle === "active"
        ) {
          this.#writeRecord({
            ...current,
            updatedAt: Date.now(),
            lifecycle: "suspended",
          });
        }
      });
      throw error;
    }
  }

  #createLease(
    record: PiCapacitySessionRecord,
    executor: { executorDir: string; workspacePath: string },
    sessionFile: string,
    runtime: PiSessionRuntime,
  ): LocalPiSessionLease {
    return new LocalPiSessionLease({
      sessionId: record.sessionId,
      leaseEpoch: record.leaseEpoch,
      executorDir: executor.executorDir,
      workspacePath: executor.workspacePath,
      delegate: runtime,
      suspend: (publishWorkspaceResult) =>
        this.#suspend(
          record,
          executor.workspacePath,
          sessionFile,
          runtime,
          publishWorkspaceResult,
        ),
    });
  }

  async #suspend(
    lease: PiCapacitySessionRecord,
    workspacePath: string,
    sessionFile: string,
    runtime: PiSessionRuntime,
    publishWorkspaceResult: boolean,
  ): Promise<void> {
    this.#withCatalogueLock(() => {
      const current = this.#authoritativeRecord(lease, "active");
      this.#writeRecord({
        ...current,
        updatedAt: Date.now(),
        lifecycle: "suspending",
      });
    });

    await runtime.dispose();
    const workspaceCheckpointRef = this.#persistWorkspaceCheckpoint(
      workspacePath,
      lease.workspace.baseRevision,
    );
    const sessionLogRef = this.#persistSessionLog(sessionFile);
    let workspaceResultRef: PiWorkspaceResultReference | undefined;
    if (publishWorkspaceResult) {
      workspaceResultRef = { id: randomUUID() };
      this.#writeWorkspaceResult({
        id: workspaceResultRef.id,
        admissionRef: lease.admissionRef,
        sessionId: lease.sessionId,
        repositoryId: lease.workspace.repositoryId,
        baseRevision: lease.workspace.baseRevision,
        workspaceCheckpointRef,
      });
    }

    this.#withCatalogueLock(() => {
      const current = this.#authoritativeRecord(lease, "suspending");
      this.#writeRecord({
        ...current,
        updatedAt: Date.now(),
        workspaceCheckpointRef,
        sessionLogRef,
        ...(workspaceResultRef ? { workspaceResultRef } : {}),
        lifecycle: "suspended",
      });
    });
    fs.rmSync(path.dirname(workspacePath), { force: true, recursive: true });
  }

  #authoritativeRecord(
    lease: PiCapacitySessionRecord,
    lifecycle: PiCapacitySessionLifecycle,
  ): PiCapacitySessionRecord {
    const current = this.getRecord(lease.sessionId);
    if (current.leaseEpoch !== lease.leaseEpoch) {
      throw new PiServerError(
        "session_locked",
        `stale lease epoch ${lease.leaseEpoch}; current epoch is ${current.leaseEpoch}`,
      );
    }
    if (current.lifecycle !== lifecycle) {
      throw new PiServerError(
        "session_locked",
        `lease ${lease.leaseEpoch} is ${current.lifecycle}, expected ${lifecycle}`,
      );
    }
    return current;
  }

  #allocateExecutor(sessionId: string, leaseEpoch: number): string {
    return path.join(
      this.#executorRoot,
      `${Buffer.from(sessionId).toString("base64url")}-${leaseEpoch}-${randomUUID()}`,
    );
  }

  #repository(repositoryId: string): string {
    const repository = this.#repositories.get(repositoryId);
    if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
    return repository;
  }

  #executionProfile(executionProfileId: string): PiCapacityExecutionProfile {
    const profile = this.#executionProfiles.get(executionProfileId);
    if (!profile) {
      throw new Error(
        `execution profile ${executionProfileId} is unavailable on this capacity`,
      );
    }
    return profile;
  }

  #provisionExecutor(
    repository: string,
    baseRevision: string,
    executorDir: string,
  ): { executorDir: string; workspacePath: string } {
    const resolvedExecutorDir = path.resolve(executorDir);
    if (fs.existsSync(resolvedExecutorDir)) {
      throw new Error(
        `executor directory already exists: ${resolvedExecutorDir}`,
      );
    }
    fs.mkdirSync(resolvedExecutorDir, { recursive: true });
    const workspacePath = path.join(resolvedExecutorDir, "workspace");
    command("git", [
      "clone",
      "--quiet",
      "--no-checkout",
      repository,
      workspacePath,
    ]);
    git(workspacePath, ["checkout", "--quiet", "--detach", baseRevision]);
    return { executorDir: resolvedExecutorDir, workspacePath };
  }

  #persistWorkspaceCheckpoint(
    workspacePath: string,
    baseRevision: string,
  ): PiCapacityArtifactReference {
    const key = `${randomUUID()}.bundle`;
    const finalPath = path.join(this.#workspaceArtifactsDir, key);
    const temporaryPath = `${finalPath}.tmp`;
    const temporaryIndex = path.join(
      path.dirname(workspacePath),
      `.checkpoint-index-${randomUUID()}`,
    );
    const environment = {
      GIT_INDEX_FILE: temporaryIndex,
      GIT_AUTHOR_NAME: "pi capacity",
      GIT_AUTHOR_EMAIL: "pi-capacity@local",
      GIT_COMMITTER_NAME: "pi capacity",
      GIT_COMMITTER_EMAIL: "pi-capacity@local",
    };
    const checkpointRef = "refs/pi-capacity/checkpoint";

    try {
      command(
        "git",
        ["-C", workspacePath, "read-tree", baseRevision],
        environment,
      );
      command(
        "git",
        ["-C", workspacePath, "add", "-A", "-f", "--", "."],
        environment,
      );
      const tree = command(
        "git",
        ["-C", workspacePath, "write-tree"],
        environment,
      );
      const checkpoint = command(
        "git",
        [
          "-C",
          workspacePath,
          "-c",
          "commit.gpgSign=false",
          "commit-tree",
          tree,
          "-p",
          baseRevision,
          "-m",
          "pi capacity checkpoint",
        ],
        environment,
      );
      git(workspacePath, ["update-ref", checkpointRef, checkpoint]);
      git(workspacePath, ["bundle", "create", temporaryPath, checkpointRef]);
      acknowledgeFile(temporaryPath, finalPath);
      return { key };
    } finally {
      fs.rmSync(temporaryIndex, { force: true });
      fs.rmSync(temporaryPath, { force: true });
      try {
        git(workspacePath, ["update-ref", "-d", checkpointRef]);
      } catch {
        // The ref is temporary; preserve the original checkpoint failure.
      }
    }
  }

  #restoreWorkspace(
    workspacePath: string,
    baseRevision: string,
    reference: PiCapacityArtifactReference,
  ): void {
    const artifact = path.join(this.#workspaceArtifactsDir, reference.key);
    git(workspacePath, [
      "fetch",
      "--quiet",
      artifact,
      "refs/pi-capacity/checkpoint",
    ]);
    const checkpoint = git(workspacePath, ["rev-parse", "FETCH_HEAD"]);
    git(workspacePath, ["read-tree", "--reset", "-u", checkpoint]);
    git(workspacePath, ["read-tree", "--reset", baseRevision]);
  }

  #persistSessionLog(sessionFile: string): PiCapacityArtifactReference {
    fsyncFile(sessionFile);
    const key = `${randomUUID()}.jsonl`;
    const finalPath = path.join(this.#sessionArtifactsDir, key);
    const temporaryPath = `${finalPath}.tmp`;
    const lines = fs.readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string") {
      throw new Error("capacity session artifact has no valid header");
    }
    if (header.parentSession !== undefined) {
      throw new Error(
        "capacity session artifacts cannot persist parentSession paths",
      );
    }
    lines[0] = JSON.stringify({ ...header, cwd: "." });
    fs.writeFileSync(temporaryPath, `${lines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    acknowledgeFile(temporaryPath, finalPath);
    return { key };
  }

  #materializeSessionLog(
    executorDir: string,
    reference: PiCapacityArtifactReference,
  ): string {
    const sessionDir = path.join(executorDir, "pi-session");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "session.jsonl");
    fs.copyFileSync(
      path.join(this.#sessionArtifactsDir, reference.key),
      sessionFile,
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(sessionFile, 0o600);
    return sessionFile;
  }

  #recordPath(sessionId: string): string {
    return path.join(
      this.#recordsDir,
      `${Buffer.from(sessionId).toString("base64url")}.json`,
    );
  }

  #resultPath(resultId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(resultId)) {
      return path.join(this.#workspaceResultsDir, "invalid");
    }
    return path.join(this.#workspaceResultsDir, `${resultId}.json`);
  }

  #writeWorkspaceResult(result: PiWorkspaceResultRecord): void {
    const resultPath = this.#resultPath(result.id);
    const temporaryPath = `${resultPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    acknowledgeFile(temporaryPath, resultPath);
  }

  #writeRecord(record: PiCapacitySessionRecord): void {
    const recordPath = this.#recordPath(record.sessionId);
    const temporaryPath = `${recordPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    acknowledgeFile(temporaryPath, recordPath);
  }

  #withCatalogueLock<T>(operation: () => T): T {
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.#lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PiServerError("session_locked", "capacity catalogue is busy");
      }
      throw error;
    }
    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(this.#lockPath, { force: true });
    }
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
  readonly #coordinator: PiCapacityCoordinator | undefined;

  constructor(client: PiClient, coordinator?: PiCapacityCoordinator) {
    this.#client = client;
    this.#coordinator = coordinator;
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
    if (config.capacity && !this.#coordinator) {
      lifecycle.status = "failed";
      lifecycle.errorKind = "setup";
      lifecycle.exitCode = 1;
      lifecycle.endedAt = startedAt;
      return {
        ...remoteResult([], lifecycle),
        exitCode: 1,
        stopReason: "error",
        errorMessage: "capacity session requires a coordinator",
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
    let admission: PiCapacityAdmission | undefined;
    let binding: PiCapacitySessionBinding | undefined;
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
      if (config.capacity) {
        if (config.session?.id) {
          binding = await this.#coordinator!.authorizeContinuation(
            config.capacity,
            config.session.id,
          );
        } else {
          admission = await this.#coordinator!.admitSession(config.capacity);
        }
      }
      if (interruption) throw new Error("remote pi session interrupted");

      if (config.session?.id) {
        remote = await RemoteSession.open(this.#client, config.session.id);
      } else {
        remote = await RemoteSession.create(this.#client, {
          cwd: config.capacity ? "." : config.cwd,
          ...(requestedModel ? { model: requestedModel } : {}),
        });
        if (admission) {
          if (!remote.id)
            throw new Error("remote pi server returned no session id");
          binding = await this.#coordinator!.bindSession(admission, remote.id);
        }
      }
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
      if (admission && !binding) {
        await this.#coordinator?.cancelAdmission(admission).catch(() => {});
      }
      if (lifecycle.status === "succeeded" && config.capacity && binding) {
        try {
          const sessionResult =
            await this.#coordinator!.getSessionResult(binding);
          const workspaceApply = await this.#coordinator!.applyWorkspaceResult({
            resultRef: sessionResult.resultRef,
            sessionId: binding.sessionId,
            repositoryId: config.capacity.repositoryId,
            baseRevision: config.capacity.baseRevision,
            targetCwd: config.cwd,
          });
          result.session = {
            ...result.session,
            sessionId: binding.sessionId,
            continueId: binding.sessionId,
            resultRef: sessionResult.resultRef.id,
            workspaceApply,
          };
          if (
            workspaceApply.status === "conflict" ||
            workspaceApply.status === "rejected"
          ) {
            result.exitCode = 1;
            result.stopReason = "error";
            result.errorMessage = workspaceApply.message;
            lifecycle.status = "failed";
            lifecycle.errorKind = "agent";
          }
        } catch (error) {
          result.exitCode = 1;
          result.stopReason = "error";
          result.errorMessage =
            error instanceof Error ? error.message : String(error);
          lifecycle.status = "failed";
          lifecycle.errorKind = "agent";
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
  const { fauxAssistantMessage, fauxProvider } =
    await import("@earendil-works/pi-ai");
  const { PiClient } = await import("@earendil-works/pi-client");
  const { createUnixTransportFactory } =
    await import("@earendil-works/pi-client/unix");
  const { TEST_MODEL, TestServerService, TestSessionRuntime } =
    await import("@earendil-works/pi-server/testing");
  const { createUnixServer } = await import("@earendil-works/pi-server/unix");
  const { clearConfigCache, setGlobalSettingsPath } =
    await import("@bds_pi/config");
  const roots: string[] = [];

  const makeRoot = () => {
    const root = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "pi-remote-"),
    );
    roots.push(root);
    return root;
  };

  const makeCatalogueRepository = (root: string) => {
    const repository = path.join(root, "catalogue-repository");
    fs.mkdirSync(repository);
    command("git", ["init", "--quiet", "--initial-branch=main", repository]);
    fs.writeFileSync(path.join(repository, "modified.txt"), "base\n");
    fs.writeFileSync(path.join(repository, "deleted.txt"), "delete me\n");
    fs.writeFileSync(path.join(repository, "parent.txt"), "parent base\n");
    git(repository, ["add", "."]);
    git(repository, [
      "-c",
      "user.name=pi capacity test",
      "-c",
      "user.email=pi-capacity-test@local",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    return {
      repository,
      baseRevision: git(repository, ["rev-parse", "HEAD"]),
    };
  };

  const makeFauxModelRuntime = async (root: string) => {
    const faux = fauxProvider({
      provider: `capacity-faux-${randomUUID()}`,
      models: [{ id: "capacity-model", name: "Capacity model" }],
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const model = faux.getModel();
    fs.mkdirSync(path.join(root, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agent", "settings.json"),
      JSON.stringify({
        defaultProvider: model.provider,
        defaultModel: model.id,
      }),
    );
    return {
      faux,
      modelRuntime,
      model: { provider: model.provider, id: model.id },
    };
  };

  const readCapacityRecord = (
    catalogueDir: string,
    sessionId: string,
  ): PiCapacitySessionRecord =>
    JSON.parse(
      fs.readFileSync(
        path.join(
          catalogueDir,
          "records",
          `${Buffer.from(sessionId).toString("base64url")}.json`,
        ),
        "utf8",
      ),
    ) as PiCapacitySessionRecord;

  const capacityService = (options: {
    root: string;
    catalogueDir: string;
    executorRoot: string;
    repository: string;
    modelRuntime: ModelRuntime;
  }) =>
    new PiSpawnServerService({
      agentDir: path.join(options.root, "agent"),
      modelRuntime: options.modelRuntime,
      capacity: {
        catalogueDir: options.catalogueDir,
        executorRoot: options.executorRoot,
        repositories: { dots: options.repository },
        executionProfiles: {
          "local-test": {},
          delegate: {
            tools: ["read", "bash", "edit", "write"],
            noExtensions: true,
          },
        },
      },
    });

  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition did not become true within 10 seconds");
  };

  afterEach(() => {
    clearConfigCache();
    setGlobalSettingsPath(
      path.join(
        process.env.TMPDIR ?? "/tmp",
        `missing-pi-config-${Date.now()}`,
      ),
    );
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

  describe("LocalPiSessionCapacity", () => {
    it("runs delegate through capacity, unix pi, real tools, result apply, and continuation", async () => {
      const root = makeRoot();
      const { repository, baseRevision } = makeCatalogueRepository(root);
      const catalogueDir = path.join(root, "capacity-catalogue");
      const executorRootA = path.join(root, "simulated-host-a", "executors");
      const executorRootB = path.join(
        root,
        "simulated-host-b",
        "different-executors",
      );
      const parentSessionFile = path.join(root, "parent-session.jsonl");
      const parentSessionId = "durable-parent-session";
      const { faux, modelRuntime } = await makeFauxModelRuntime(root);
      const { createCapacityDelegateExtension } =
        await import("../../extensions/delegate/index.js");
      const settingsPath = path.join(root, "delegate-settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          "@bds_pi/delegate": {
            capacity: {
              repositoryId: "dots",
              executionProfileId: "delegate",
            },
          },
        }),
      );
      setGlobalSettingsPath(settingsPath);
      clearConfigCache();
      const delegateTool = (
        client: PiClient,
        coordinator: PiCapacityCoordinator,
      ) => {
        const tools: Array<{ execute: (...args: any[]) => Promise<any> }> = [];
        createCapacityDelegateExtension(
          client,
          coordinator,
        )({
          registerTool(tool: unknown) {
            tools.push(tool as (typeof tools)[number]);
          },
          on() {},
        } as any);
        expect(tools).toHaveLength(1);
        return tools[0]!;
      };
      let releaseFirst = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseSecond = () => {};
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      faux.setResponses([
        async () => {
          await firstGate;
          return fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "write-modified",
                name: "write",
                arguments: {
                  path: "modified.txt",
                  content: "child modified\n",
                },
              },
              {
                type: "toolCall",
                id: "delete-tracked",
                name: "bash",
                arguments: { command: "rm deleted.txt" },
              },
              {
                type: "toolCall",
                id: "write-untracked",
                name: "write",
                arguments: {
                  path: "nested/untracked.txt",
                  content: "child untracked\n",
                },
              },
            ],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("first response"),
        async () => {
          await secondGate;
          return fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "inspect-restored-workspace",
                name: "bash",
                arguments: {
                  command:
                    "printf 'modified='; cat modified.txt; test ! -e deleted.txt && echo 'deleted=missing'; printf 'nested='; cat nested/untracked.txt",
                },
              },
            ],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("second response"),
      ]);

      const serviceA = capacityService({
        root,
        catalogueDir,
        executorRoot: executorRootA,
        repository,
        modelRuntime,
      });
      const socketA = path.join(root, "host-a.sock");
      const serverA = createUnixServer(serviceA, { path: socketA });
      await serverA.start();
      const clientA = await PiClient.connect({
        transportFactory: createUnixTransportFactory({ path: socketA }),
      });
      const delegateA = delegateTool(clientA, serviceA);
      const parentContext = {
        cwd: repository,
        sessionManager: {
          getSessionId: () => parentSessionId,
          getSessionFile: () => parentSessionFile,
        },
      };
      const firstPending = (delegateA.execute as any)(
        "delegate-first",
        { prompt: "edit the repository", description: "first capacity turn" },
        new AbortController().signal,
        undefined,
        parentContext,
      );
      await Promise.race([
        waitFor(() => faux.state.callCount === 1),
        firstPending.then((completed: unknown) => {
          throw new Error(
            `delegate completed before its model call: ${JSON.stringify(completed)}`,
          );
        }),
      ]);
      const executorA = path.join(
        executorRootA,
        fs.readdirSync(executorRootA)[0] ?? "missing",
      );
      expect(fs.existsSync(path.join(executorA, "workspace"))).toBe(true);
      releaseFirst();
      const first = (await firstPending) as {
        isError: boolean;
        details: {
          sessionId?: string;
          continueId?: string;
          resultRef?: string;
          workspaceApply?: PiWorkspaceResultApplyOutcome;
          messages: Message[];
        };
      };
      const sessionId = first.details.sessionId ?? "";

      try {
        expect(first.isError, JSON.stringify(first, null, 2)).not.toBe(true);
        expect(sessionId).not.toBe("");
        expect(first.details.continueId).toBe(sessionId);
        expect(first.details.resultRef).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.details.workspaceApply).toEqual({
          status: "applied",
          paths: ["deleted.txt", "modified.txt", "nested/untracked.txt"],
        });
        expect(
          first.details.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (part) => part.type === "toolCall" && part.name === "write",
              ),
          ),
        ).toBe(true);
        expect(
          fs.readFileSync(path.join(repository, "modified.txt"), "utf8"),
        ).toBe("child modified\n");
        expect(fs.existsSync(path.join(repository, "deleted.txt"))).toBe(false);
        expect(
          fs.readFileSync(
            path.join(repository, "nested", "untracked.txt"),
            "utf8",
          ),
        ).toBe("child untracked\n");

        const suspended = readCapacityRecord(catalogueDir, sessionId);
        expect(suspended).toMatchObject({
          sessionId,
          parentSessionId,
          workspace: { repositoryId: "dots", baseRevision },
          executionProfileId: "delegate",
          leaseEpoch: 1,
          lifecycle: "suspended",
        });
        const durableMetadata = [
          JSON.stringify(suspended),
          ...fs
            .readdirSync(path.join(catalogueDir, "workspace-results"))
            .map((entry) =>
              fs.readFileSync(
                path.join(catalogueDir, "workspace-results", entry),
                "utf8",
              ),
            ),
          ...fs
            .readdirSync(path.join(catalogueDir, "session-logs"))
            .map((entry) =>
              fs.readFileSync(
                path.join(catalogueDir, "session-logs", entry),
                "utf8",
              ),
            ),
          JSON.stringify(first.details),
        ].join("\n");
        for (const localIdentity of [
          executorRootA,
          socketA,
          parentSessionFile,
          repository,
        ]) {
          expect(durableMetadata).not.toContain(localIdentity);
        }
      } finally {
        await clientA.dispose();
        await serverA.close();
      }

      expect(fs.existsSync(executorA)).toBe(false);

      const resultRef = { id: first.details.resultRef! };
      const applyRequest = {
        resultRef,
        sessionId,
        repositoryId: "dots",
        baseRevision,
        targetCwd: repository,
      };
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toEqual({
        status: "already_applied",
      });

      git(repository, ["reset", "--hard", "--quiet", baseRevision]);
      git(repository, ["clean", "-fdx", "--quiet"]);
      fs.writeFileSync(path.join(repository, "parent.txt"), "parent staged\n");
      git(repository, ["add", "parent.txt"]);
      fs.appendFileSync(
        path.join(repository, "parent.txt"),
        "parent unstaged\n",
      );
      fs.writeFileSync(
        path.join(repository, "parent-only.txt"),
        "parent only\n",
      );
      const unchangedHead = git(repository, ["rev-parse", "HEAD"]);
      const unrelatedIndex = fs.readFileSync(
        path.join(repository, ".git", "index"),
      );
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toEqual({
        status: "applied",
        paths: ["deleted.txt", "modified.txt", "nested/untracked.txt"],
      });
      expect(fs.readFileSync(path.join(repository, "parent.txt"), "utf8")).toBe(
        "parent staged\nparent unstaged\n",
      );
      expect(
        fs.readFileSync(path.join(repository, "parent-only.txt"), "utf8"),
      ).toBe("parent only\n");
      expect(fs.readFileSync(path.join(repository, ".git", "index"))).toEqual(
        unrelatedIndex,
      );
      expect(git(repository, ["rev-parse", "HEAD"])).toBe(unchangedHead);
      expect(git(repository, ["diff", "--cached", "--name-only"])).toBe(
        "parent.txt",
      );
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toEqual({
        status: "already_applied",
      });

      const snapshotParent = () => {
        const paths = nulPaths(
          git(repository, [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ]),
        ).sort();
        return {
          head: git(repository, ["rev-parse", "HEAD"]),
          index: fs.readFileSync(path.join(repository, ".git", "index")),
          status: git(repository, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]),
          files: paths.map((entry) => [
            entry,
            fs.existsSync(path.join(repository, entry))
              ? fs.readFileSync(path.join(repository, entry)).toString("base64")
              : null,
          ]),
        };
      };

      git(repository, ["reset", "--hard", "--quiet", baseRevision]);
      git(repository, ["clean", "-fdx", "--quiet"]);
      fs.writeFileSync(
        path.join(repository, "modified.txt"),
        "parent conflict\n",
      );
      fs.writeFileSync(
        path.join(repository, "conflict-witness.txt"),
        "preserve\n",
      );
      const beforeConflict = snapshotParent();
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toMatchObject({
        status: "conflict",
        paths: ["modified.txt"],
      });
      expect(snapshotParent()).toEqual(beforeConflict);
      expect(
        fs.readFileSync(path.join(repository, "modified.txt"), "utf8"),
      ).toBe("parent conflict\n");

      for (const invalid of [
        {
          ...applyRequest,
          resultRef: { id: randomUUID() },
          expected: "unknown_result",
        },
        {
          ...applyRequest,
          repositoryId: "other",
          expected: "repository_mismatch",
        },
        {
          ...applyRequest,
          baseRevision: "0".repeat(40),
          expected: "base_mismatch",
        },
        {
          ...applyRequest,
          sessionId: "other-session",
          expected: "session_mismatch",
        },
      ]) {
        const { expected, ...request } = invalid;
        expect(await serviceA.applyWorkspaceResult(request)).toMatchObject({
          status: "rejected",
          code: expected,
        });
        expect(snapshotParent()).toEqual(beforeConflict);
      }
      const otherRoot = fs.mkdtempSync(path.join(root, "other-repository-"));
      const otherRepository = makeCatalogueRepository(otherRoot).repository;
      const otherStatus = git(otherRepository, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const otherIndex = fs.readFileSync(
        path.join(otherRepository, ".git", "index"),
      );
      expect(
        await serviceA.applyWorkspaceResult({
          ...applyRequest,
          targetCwd: otherRepository,
        }),
      ).toMatchObject({
        status: "rejected",
        code: "target_repository_mismatch",
      });
      expect(
        git(otherRepository, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
      ).toBe(otherStatus);
      expect(
        fs.readFileSync(path.join(otherRepository, ".git", "index")),
      ).toEqual(otherIndex);
      expect(snapshotParent()).toEqual(beforeConflict);

      git(repository, ["reset", "--hard", "--quiet", baseRevision]);
      git(repository, ["clean", "-fdx", "--quiet"]);
      fs.writeFileSync(
        path.join(repository, "modified.txt"),
        "staged child path\n",
      );
      git(repository, ["add", "modified.txt"]);
      fs.appendFileSync(
        path.join(repository, "modified.txt"),
        "unstaged tail\n",
      );
      const beforeStaged = snapshotParent();
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toMatchObject({
        status: "rejected",
        code: "staged_path",
        paths: ["modified.txt"],
      });
      expect(snapshotParent()).toEqual(beforeStaged);

      git(repository, ["reset", "--hard", "--quiet", baseRevision]);
      git(repository, ["clean", "-fdx", "--quiet"]);
      const baseTree = git(repository, ["rev-parse", `${baseRevision}^{tree}`]);
      const unrelatedCommit = command(
        "git",
        ["-C", repository, "commit-tree", baseTree, "-m", "unrelated"],
        {
          GIT_AUTHOR_NAME: "pi capacity test",
          GIT_AUTHOR_EMAIL: "pi-capacity-test@local",
          GIT_COMMITTER_NAME: "pi capacity test",
          GIT_COMMITTER_EMAIL: "pi-capacity-test@local",
        },
      );
      git(repository, ["checkout", "--quiet", "--detach", unrelatedCommit]);
      const beforeIncompatible = snapshotParent();
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toMatchObject({
        status: "rejected",
        code: "incompatible_base",
      });
      expect(snapshotParent()).toEqual(beforeIncompatible);
      git(repository, ["checkout", "--quiet", "main"]);

      const recordCount = fs.readdirSync(
        path.join(catalogueDir, "records"),
      ).length;
      await expect(
        serviceA.admitSession({
          repositoryId: "dots",
          baseRevision: "0".repeat(40),
          executionProfileId: "delegate",
          parentSessionId,
        }),
      ).rejects.toThrow();
      await expect(
        serviceA.admitSession({
          repositoryId: "wrong",
          baseRevision,
          executionProfileId: "delegate",
          parentSessionId,
        }),
      ).rejects.toThrow("unknown repository");
      await expect(
        serviceA.admitSession({
          repositoryId: "dots",
          baseRevision,
          executionProfileId: "unknown-profile",
          parentSessionId,
        }),
      ).rejects.toThrow("unknown execution profile");
      expect(fs.readdirSync(path.join(catalogueDir, "records"))).toHaveLength(
        recordCount,
      );

      git(repository, ["reset", "--hard", "--quiet", baseRevision]);
      git(repository, ["clean", "-fdx", "--quiet"]);
      expect(await serviceA.applyWorkspaceResult(applyRequest)).toMatchObject({
        status: "applied",
      });

      const serviceB = capacityService({
        root,
        catalogueDir,
        executorRoot: executorRootB,
        repository,
        modelRuntime,
      });
      fs.rmSync(executorRootB, { recursive: true });
      fs.writeFileSync(executorRootB, "block executor allocation\n");
      const socketB = path.join(root, "host-b.sock");
      const serverB = createUnixServer(serviceB, { path: socketB });
      await serverB.start();
      const clientB = await PiClient.connect({
        transportFactory: createUnixTransportFactory({ path: socketB }),
      });
      const delegateB = delegateTool(clientB, serviceB);

      try {
        const failedPlacement = await (delegateB.execute as any)(
          "delegate-placement-failure",
          {
            prompt: "continue after placement",
            description: "placement failure",
            continueId: sessionId,
          },
          new AbortController().signal,
          undefined,
          parentContext,
        );
        expect(failedPlacement.isError).toBe(true);
        expect(readCapacityRecord(catalogueDir, sessionId)).toMatchObject({
          leaseEpoch: 2,
          lifecycle: "suspended",
        });
        fs.rmSync(executorRootB);
        fs.mkdirSync(executorRootB, { recursive: true });

        const secondPending = (delegateB.execute as any)(
          "delegate-second",
          {
            prompt: "inspect the restored repository",
            description: "second capacity turn",
            continueId: sessionId,
          },
          new AbortController().signal,
          undefined,
          parentContext,
        );
        await waitFor(() => faux.state.callCount === 3);
        const executorB = path.join(
          executorRootB,
          fs.readdirSync(executorRootB)[0] ?? "missing",
        );
        expect(executorB).not.toBe(executorA);
        expect(fs.existsSync(path.join(executorB, "workspace"))).toBe(true);
        releaseSecond();
        const second = await secondPending;
        expect(second.isError).not.toBe(true);
        expect(second.details.sessionId).toBe(sessionId);
        expect(second.details.continueId).toBe(sessionId);
        expect(second.details.workspaceApply.status).toBe("already_applied");
        expect(
          second.details.messages.filter(
            (message: Message) => message.role === "user",
          ),
        ).toHaveLength(2);
        expect(
          (second.details.messages as Message[])
            .filter(
              (message: Message): message is ToolResultMessage<unknown> =>
                message.role === "toolResult" && message.toolName === "bash",
            )
            .map((message) =>
              message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            )
            .join("\n"),
        ).toContain(
          "modified=child modified\ndeleted=missing\nnested=child untracked",
        );
        expect(
          second.details.messages.some(
            (message: Message) =>
              message.role === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "text" && part.text === "first response",
              ),
          ),
        ).toBe(true);
        expect(
          second.details.messages.some(
            (message: Message) =>
              message.role === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "text" && part.text === "second response",
              ),
          ),
        ).toBe(true);
        expect(fs.existsSync(executorB)).toBe(false);
        expect(readCapacityRecord(catalogueDir, sessionId)).toMatchObject({
          leaseEpoch: 3,
          lifecycle: "suspended",
        });
      } finally {
        await clientB.dispose();
        await serverB.close();
      }
    }, 60_000);

    it("rejects suspension during a real turn and fences the old lease", async () => {
      const root = makeRoot();
      const { repository, baseRevision } = makeCatalogueRepository(root);
      const catalogueDir = path.join(root, "capacity-catalogue");
      const { faux, modelRuntime, model } = await makeFauxModelRuntime(root);
      let releaseTurn = () => {};
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      faux.setResponses([
        async () => {
          await turnGate;
          return fauxAssistantMessage("finished response");
        },
      ]);
      const serviceA = capacityService({
        root,
        catalogueDir,
        executorRoot: path.join(root, "host-a"),
        repository,
        modelRuntime,
      });
      const admission = await serviceA.admitSession({
        repositoryId: "dots",
        baseRevision,
        executionProfileId: "local-test",
      });
      const acquiredA = await serviceA.createSession({
        id: "fenced-session",
        cwd: path.join(root, "ignored-request-cwd"),
        model,
      });
      await serviceA.bindSession(admission, "fenced-session");
      expect(acquiredA).toBeInstanceOf(LocalPiSessionLease);
      const hostA = acquiredA as LocalPiSessionLease;
      const turn = hostA.prompt({ text: "held turn" });
      await waitFor(() => faux.state.callCount === 1);
      expect(hostA.getPhase()).toBe("turn");
      await expect(hostA.suspend()).rejects.toThrow(
        "cannot suspend a busy session",
      );
      expect(readCapacityRecord(catalogueDir, hostA.sessionId).lifecycle).toBe(
        "active",
      );
      releaseTurn();
      await turn;
      expect(hostA.getPhase()).toBe("idle");
      await hostA.suspend();

      const serviceB = capacityService({
        root,
        catalogueDir,
        executorRoot: path.join(root, "host-b"),
        repository,
        modelRuntime,
      });
      const acquiredB = await serviceB.openSession(hostA.sessionId);
      expect(acquiredB).toBeInstanceOf(LocalPiSessionLease);
      const hostB = acquiredB as LocalPiSessionLease;
      const activeOnHostB = readCapacityRecord(catalogueDir, hostB.sessionId);
      expect(activeOnHostB).toMatchObject({
        leaseEpoch: 2,
        lifecycle: "active",
      });
      await expect(hostA.suspend()).rejects.toThrow(
        "stale lease epoch 1; current epoch is 2",
      );
      expect(readCapacityRecord(catalogueDir, hostB.sessionId)).toEqual(
        activeOnHostB,
      );
      await hostB.suspend();
    });

    it("fails closed in suspending when a checkpoint artifact cannot publish", async () => {
      const root = makeRoot();
      const { repository, baseRevision } = makeCatalogueRepository(root);
      const catalogueDir = path.join(root, "capacity-catalogue");
      const { modelRuntime, model } = await makeFauxModelRuntime(root);
      const service = capacityService({
        root,
        catalogueDir,
        executorRoot: path.join(root, "host-a"),
        repository,
        modelRuntime,
      });
      const admission = await service.admitSession({
        repositoryId: "dots",
        baseRevision,
        executionProfileId: "local-test",
      });
      const acquired = await service.createSession({
        id: "failed-checkpoint",
        model,
      });
      await service.bindSession(admission, "failed-checkpoint");
      expect(acquired).toBeInstanceOf(LocalPiSessionLease);
      const lease = acquired as LocalPiSessionLease;
      const acknowledged = readCapacityRecord(catalogueDir, lease.sessionId);
      const sessionArtifacts = path.join(catalogueDir, "session-logs");
      fs.rmSync(sessionArtifacts, { recursive: true });
      fs.writeFileSync(sessionArtifacts, "block artifact publication\n");

      await expect(lease.suspend()).rejects.toThrow();
      expect(readCapacityRecord(catalogueDir, lease.sessionId)).toMatchObject({
        workspaceCheckpointRef: acknowledged.workspaceCheckpointRef,
        sessionLogRef: acknowledged.sessionLogRef,
        leaseEpoch: 1,
        lifecycle: "suspending",
      });
      await expect(lease.suspend()).rejects.toThrow(
        "session suspension is already in progress",
      );
      await expect(service.openSession(lease.sessionId)).rejects.toThrow(
        "session lease is suspending",
      );
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

    it.each(["cancelled", "timed_out"] as const)(
      "does not publish a capacity result when remote work is %s",
      async (interruption) => {
        const root = makeRoot();
        const { repository, baseRevision } = makeCatalogueRepository(root);
        const catalogueDir = path.join(root, "capacity-catalogue");
        const executorRoot = path.join(root, "executors");
        const { faux, modelRuntime } = await makeFauxModelRuntime(root);
        let releaseTurn = () => {};
        const turnGate = new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        faux.setResponses([
          async () => {
            await turnGate;
            return fauxAssistantMessage("too late");
          },
        ]);
        const service = capacityService({
          root,
          catalogueDir,
          executorRoot,
          repository,
          modelRuntime,
        });
        const socketPath = path.join(root, "pi.sock");
        const server = createUnixServer(service, { path: socketPath });
        await server.start();
        const client = await PiClient.connect({
          transportFactory: createUnixTransportFactory({ path: socketPath }),
        });
        const controller = new AbortController();

        try {
          const pending = new RemotePiCapacityProvider(client, service).run({
            cwd: repository,
            task: "keep working",
            capacity: {
              repositoryId: "dots",
              baseRevision,
              executionProfileId: "delegate",
            },
            signal: controller.signal,
            ...(interruption === "timed_out" ? { timeoutMs: 20 } : {}),
          });
          await waitFor(() => faux.state.callCount === 1);
          if (interruption === "cancelled") controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 30));
          releaseTurn();
          const result = await pending;
          const sessionId = result.session?.sessionId ?? "";

          expect(result.lifecycle?.status).toBe(interruption);
          expect(result.stopReason).toBe("aborted");
          expect(result.session?.resultRef).toBeUndefined();
          expect(sessionId).not.toBe("");
          const record = readCapacityRecord(catalogueDir, sessionId);
          expect(record.lifecycle).toBe("suspended");
          expect(record.workspaceResultRef).toBeUndefined();
          expect(
            fs.readdirSync(path.join(catalogueDir, "workspace-results")),
          ).toHaveLength(0);
          expect(fs.readdirSync(executorRoot)).toHaveLength(0);
        } finally {
          releaseTurn();
          await client.dispose();
          await server.close();
        }
      },
      30_000,
    );

    it("fails before admission when a spawn profile cannot cross protocol v1", async () => {
      let admissionCount = 0;
      let transportCount = 0;
      const client = new PiClient({
        transportFactory: async () => {
          transportCount += 1;
          throw new Error("transport should not be opened");
        },
      });
      const coordinator = {
        async admitSession() {
          admissionCount += 1;
          throw new Error("admission should not be requested");
        },
      } as unknown as PiCapacityCoordinator;
      const provider = new RemotePiCapacityProvider(client, coordinator);

      const capacity = {
        repositoryId: "dots",
        baseRevision: "0".repeat(40),
        executionProfileId: "delegate",
      };
      const unsupportedCases: Array<[string, Partial<PiSpawnConfig>]> = [
        ["builtinTools", { builtinTools: ["read"] }],
        ["extensionTools", { extensionTools: ["finder"] }],
        ["systemPromptBody", { systemPromptBody: "custom" }],
        ["env", { env: { PI_TEST: "1" } }],
        ["configPath", { configPath: "/tmp/local-config.json" }],
        [
          "session.parentSession",
          { session: { parentSession: "/tmp/parent.jsonl" } },
        ],
      ];
      for (const [field, unsupported] of unsupportedCases) {
        const result = await provider.run({
          cwd: makeRoot(),
          task: "test",
          capacity,
          ...unsupported,
        });

        expect(result.lifecycle).toMatchObject({
          status: "failed",
          errorKind: "unsupported",
        });
        expect(result.errorMessage).toContain(field);
      }
      expect(admissionCount).toBe(0);
      expect(transportCount).toBe(0);
      await client.dispose();
    });
  });
}
