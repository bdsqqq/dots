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

export interface PiSpawnCapacityAdmission {
  repositoryId: string;
  baseRevision: string;
}

export interface PiSpawnServerCapacityOptions {
  catalogueDir: string;
  executorRoot: string;
  repositories: Readonly<Record<string, string>>;
  executionProfileId: string;
  admitSession: (
    sessionId: string,
  ) => PiSpawnCapacityAdmission | Promise<PiSpawnCapacityAdmission>;
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
export class PiSpawnServerService implements PiServerService {
  readonly #defaultCwd: string;
  readonly #agentDir: string;
  readonly #sessionDir: string | undefined;
  readonly #runtimeFactory: PiSpawnRuntimeFactory;
  readonly #capacity: LocalPiSessionCapacity | undefined;
  readonly #admitCapacitySession:
    | PiSpawnServerCapacityOptions["admitSession"]
    | undefined;
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
    this.#capacity = options.capacity
      ? new LocalPiSessionCapacity({
          catalogueDir: options.capacity.catalogueDir,
          executorRoot: options.capacity.executorRoot,
          repositories: options.capacity.repositories,
          executionProfileId: options.capacity.executionProfileId,
          runtimeFactory: this.#runtimeFactory,
        })
      : undefined;
    this.#admitCapacitySession = options.capacity?.admitSession;
    this.#listModelsOverride = options.listModels;
    if (options.modelRuntime) {
      this.#modelRuntimePromise = Promise.resolve(options.modelRuntime);
    }
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
    if (this.#capacity && this.#admitCapacitySession) {
      const admission = await this.#admitCapacitySession(options.id);
      return this.#capacity.createSession({
        sessionId: options.id,
        ...admission,
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

export type PiCapacitySessionLifecycle = "active" | "suspending" | "suspended";

export interface PiCapacityArtifactReference {
  key: string;
}

/** Durable identity and the last acknowledged checkpoint for one pi session. */
export interface PiCapacitySessionRecord {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  sessionName?: string;
  workspace: {
    repositoryId: string;
    baseRevision: string;
  };
  workspaceCheckpointRef: PiCapacityArtifactReference;
  sessionLogRef: PiCapacityArtifactReference;
  executionProfileId: string;
  leaseEpoch: number;
  lifecycle: PiCapacitySessionLifecycle;
}

export interface LocalPiSessionCapacityOptions {
  catalogueDir: string;
  executorRoot: string;
  repositories: Readonly<Record<string, string>>;
  executionProfileId: string;
  runtimeFactory: PiSpawnRuntimeFactory;
}

export interface CreateLocalPiSessionOptions {
  sessionId: string;
  repositoryId: string;
  baseRevision: string;
  name?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

function command(
  executable: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
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
  readonly #suspendOperation: () => Promise<void>;
  #state: PiCapacitySessionLifecycle = "active";
  #inFlight = 0;

  constructor(options: {
    sessionId: string;
    leaseEpoch: number;
    executorDir: string;
    workspacePath: string;
    delegate: PiSessionRuntime;
    suspend: () => Promise<void>;
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

    await this.#suspendOperation();
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
  readonly #lockPath: string;
  readonly #repositories: ReadonlyMap<string, string>;
  readonly #executionProfileId: string;
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
    this.#lockPath = path.join(this.#catalogueDir, "catalogue.lock");
    this.#repositories = new Map(
      Object.entries(options.repositories).map(([id, repository]) => [
        id,
        path.resolve(repository),
      ]),
    );
    this.#executionProfileId = options.executionProfileId;
    this.#runtimeFactory = options.runtimeFactory;
    fs.mkdirSync(this.#recordsDir, { recursive: true });
    fs.mkdirSync(this.#workspaceArtifactsDir, { recursive: true });
    fs.mkdirSync(this.#sessionArtifactsDir, { recursive: true });
    fs.mkdirSync(this.#executorRoot, { recursive: true });
  }

  getRecord(sessionId: string): PiCapacitySessionRecord {
    const recordPath = this.#recordPath(sessionId);
    if (!fs.existsSync(recordPath)) throw new SessionNotFoundError(sessionId);
    return JSON.parse(
      fs.readFileSync(recordPath, "utf8"),
    ) as PiCapacitySessionRecord;
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
    const repository = this.#repository(options.repositoryId);
    const baseRevision = git(repository, [
      "rev-parse",
      "--verify",
      `${options.baseRevision}^{commit}`,
    ]);
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
        createdAt,
        updatedAt: createdAt,
        ...(options.name ? { sessionName: options.name } : {}),
        workspace: { repositoryId: options.repositoryId, baseRevision },
        workspaceCheckpointRef,
        sessionLogRef,
        executionProfileId: this.#executionProfileId,
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
      if (current.executionProfileId !== this.#executionProfileId) {
        throw new Error(
          `execution profile ${current.executionProfileId} is unavailable on this capacity`,
        );
      }
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
      suspend: () =>
        this.#suspend(record, executor.workspacePath, sessionFile, runtime),
    });
  }

  async #suspend(
    lease: PiCapacitySessionRecord,
    workspacePath: string,
    sessionFile: string,
    runtime: PiSessionRuntime,
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

    this.#withCatalogueLock(() => {
      const current = this.#authoritativeRecord(lease, "suspending");
      this.#writeRecord({
        ...current,
        updatedAt: Date.now(),
        workspaceCheckpointRef,
        sessionLogRef,
        lifecycle: "suspended",
      });
    });
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
    fs.copyFileSync(sessionFile, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporaryPath, 0o600);
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
  const { fauxAssistantMessage, fauxProvider } =
    await import("@earendil-works/pi-ai");
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

  const makeCatalogueRepository = (root: string) => {
    const repository = path.join(root, "catalogue-repository");
    fs.mkdirSync(repository);
    command("git", ["init", "--quiet", "--initial-branch=main", repository]);
    fs.writeFileSync(path.join(repository, "modified.txt"), "base\n");
    fs.writeFileSync(path.join(repository, "deleted.txt"), "delete me\n");
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
    baseRevision: string;
    modelRuntime: ModelRuntime;
  }) =>
    new PiSpawnServerService({
      agentDir: path.join(options.root, "agent"),
      modelRuntime: options.modelRuntime,
      capacity: {
        catalogueDir: options.catalogueDir,
        executorRoot: options.executorRoot,
        repositories: { dots: options.repository },
        executionProfileId: "local-test",
        admitSession: () => ({
          repositoryId: "dots",
          baseRevision: options.baseRevision,
        }),
      },
    });

  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition did not become true");
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

  describe("LocalPiSessionCapacity", () => {
    it("serves real turns across an executor checkpoint and reacquirable failed placement", async () => {
      const root = makeRoot();
      const { repository, baseRevision } = makeCatalogueRepository(root);
      const catalogueDir = path.join(root, "capacity-catalogue");
      const executorRootA = path.join(root, "simulated-host-a", "executors");
      const executorRootB = path.join(
        root,
        "simulated-host-b",
        "different-executors",
      );
      const requestedCwd = path.join(root, "request-cwd-is-not-identity");
      const { faux, modelRuntime, model } = await makeFauxModelRuntime(root);
      faux.setResponses([
        fauxAssistantMessage("first response"),
        fauxAssistantMessage("second response"),
      ]);

      const serviceA = capacityService({
        root,
        catalogueDir,
        executorRoot: executorRootA,
        repository,
        baseRevision,
        modelRuntime,
      });
      const socketA = path.join(root, "host-a.sock");
      const serverA = createUnixServer(serviceA, { path: socketA });
      await serverA.start();
      const clientA = await PiClient.connect({
        transportFactory: createUnixTransportFactory({ path: socketA }),
      });
      let remoteA: RemoteSession | undefined;
      let sessionId = "";
      let workspaceA = "";
      let executorA = "";
      let dirtyStatus = "";

      try {
        remoteA = await RemoteSession.create(clientA, {
          cwd: requestedCwd,
          model,
        });
        sessionId = remoteA.id ?? "";
        expect(sessionId).not.toBe("");
        await remoteA.submit("first turn");
        expect(remoteA.phase).toBe("idle");
        expect(remoteA.state.transcript).toEqual([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "first turn" }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "first response" }],
          }),
        ]);

        workspaceA = remoteA.snapshot?.cwd ?? "";
        executorA = path.dirname(workspaceA);
        expect(workspaceA.startsWith(`${executorRootA}${path.sep}`)).toBe(true);
        fs.writeFileSync(path.join(workspaceA, "modified.txt"), "dirty\n");
        fs.rmSync(path.join(workspaceA, "deleted.txt"));
        fs.mkdirSync(path.join(workspaceA, "nested"));
        fs.writeFileSync(
          path.join(workspaceA, "nested", "untracked.txt"),
          "untracked\n",
        );
        dirtyStatus = git(workspaceA, [
          "status",
          "--short",
          "--untracked-files=all",
        ]);
        expect(dirtyStatus).toBe(
          "D deleted.txt\n M modified.txt\n?? nested/untracked.txt",
        );

        await remoteA.dispose();
        const suspended = readCapacityRecord(catalogueDir, sessionId);
        expect(suspended).toMatchObject({
          sessionId,
          workspace: { repositoryId: "dots", baseRevision },
          executionProfileId: "local-test",
          leaseEpoch: 1,
          lifecycle: "suspended",
        });
        expect(JSON.stringify(suspended)).not.toContain(workspaceA);
        expect(JSON.stringify(suspended)).not.toContain(requestedCwd);
      } finally {
        await remoteA?.dispose().catch(() => {});
        await clientA.dispose();
        await serverA.close();
      }

      fs.rmSync(executorA, { recursive: true });
      expect(fs.existsSync(executorA)).toBe(false);

      const serviceB = capacityService({
        root,
        catalogueDir,
        executorRoot: executorRootB,
        repository,
        baseRevision,
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
      let remoteB: RemoteSession | undefined;

      try {
        await expect(RemoteSession.open(clientB, sessionId)).rejects.toThrow();
        expect(readCapacityRecord(catalogueDir, sessionId)).toMatchObject({
          leaseEpoch: 2,
          lifecycle: "suspended",
        });
        fs.rmSync(executorRootB);
        fs.mkdirSync(executorRootB, { recursive: true });

        remoteB = await RemoteSession.open(clientB, sessionId);
        const workspaceB = remoteB.snapshot?.cwd ?? "";
        expect(remoteB.id).toBe(sessionId);
        expect(workspaceB).not.toBe(workspaceA);
        expect(workspaceB.startsWith(`${executorRootB}${path.sep}`)).toBe(true);
        expect(remoteB.state.transcript).toEqual([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "first turn" }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "first response" }],
          }),
        ]);
        expect(
          git(workspaceB, ["status", "--short", "--untracked-files=all"]),
        ).toBe(dirtyStatus);
        expect(
          fs.readFileSync(path.join(workspaceB, "modified.txt"), "utf8"),
        ).toBe("dirty\n");
        expect(fs.existsSync(path.join(workspaceB, "deleted.txt"))).toBe(false);
        expect(
          fs.readFileSync(
            path.join(workspaceB, "nested", "untracked.txt"),
            "utf8",
          ),
        ).toBe("untracked\n");

        await remoteB.submit("second turn");
        expect(remoteB.phase).toBe("idle");
        expect(remoteB.state.transcript).toEqual([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "first turn" }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "first response" }],
          }),
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "second turn" }],
          }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "second response" }],
          }),
        ]);
        expect(readCapacityRecord(catalogueDir, sessionId)).toMatchObject({
          leaseEpoch: 3,
          lifecycle: "active",
        });
      } finally {
        await remoteB?.dispose().catch(() => {});
        await clientB.dispose();
        await serverB.close();
      }
    }, 40_000);

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
        baseRevision,
        modelRuntime,
      });
      const acquiredA = await serviceA.createSession({
        id: "fenced-session",
        cwd: path.join(root, "ignored-request-cwd"),
        model,
      });
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
        baseRevision,
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
        baseRevision,
        modelRuntime,
      });
      const acquired = await service.createSession({
        id: "failed-checkpoint",
        model,
      });
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
