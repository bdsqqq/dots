import { createHash, randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  applyWorkflowGraphEvent,
  type WorkflowGraphEvent,
  type WorkflowGraphNode,
} from "./graph.js";
import {
  JournalStore,
  ZERO_USAGE,
  type WorkflowNodeRecord,
  type WorkflowUsage,
} from "./journal.js";
import {
  runWorkflowScript,
  spawnDirectRunner,
  workflowAgentOutcome,
  type RunnerLauncher,
} from "./process-runner.js";
import type { WorkflowSource } from "./source.js";

export const HARD_MAX_CONCURRENCY = 16;
export const HARD_MAX_AGENTS = 1000;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_AGENTS = 64;
const MAX_GRAPH_NODES = 2000;
const GRAPH_PROGRESS_INTERVAL_MS = 50;

const DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "format_file",
  "skill",
];
const SAFE_TOOLS = new Set(DEFAULT_TOOLS);
const MUTATING_TOOLS = new Set(["edit", "write", "format_file"]);

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  schema?: Record<string, unknown>;
  cacheKey?: string;
}

export interface WorkflowProgress {
  runId: string;
  status: string;
  running: number;
  completed: number;
  failed: number;
  cached: number;
  total: number;
  usage: WorkflowUsage;
  graph: WorkflowGraphNode[];
}

export interface RuntimeResult {
  value: unknown;
  cached: number;
  graph: WorkflowGraphNode[];
}

interface AgentExecution {
  value: unknown;
  cached: boolean;
}

export interface SpawnRequest {
  prompt: string;
  options: WorkflowAgentOptions;
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  node: WorkflowNodeRecord;
  source: WorkflowSource;
  parentSessionFile: string;
  cwd: string;
  signal?: AbortSignal;
  ctx: ExtensionContext;
  onUsage: (usage: WorkflowUsage) => void;
  onSession: (sessionId: string, sessionFile: string) => Promise<void>;
}

export interface SpawnResult {
  result: unknown;
  sessionId: string;
  sessionFile: string;
  usage: WorkflowUsage;
}

export type SpawnAgent = (request: SpawnRequest) => Promise<SpawnResult>;

export function normalizeLimits(
  maxConcurrency?: number,
  maxAgents?: number,
): { maxConcurrency: number; maxAgents: number } {
  const concurrency = maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const agents = maxAgents ?? DEFAULT_MAX_AGENTS;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > HARD_MAX_CONCURRENCY
  ) {
    throw new Error(
      `maxConcurrency must be an integer from 1 to ${HARD_MAX_CONCURRENCY}`,
    );
  }
  if (!Number.isInteger(agents) || agents < 1 || agents > HARD_MAX_AGENTS) {
    throw new Error(
      `maxAgents must be an integer from 1 to ${HARD_MAX_AGENTS}`,
    );
  }
  return { maxConcurrency: concurrency, maxAgents: agents };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", cancelled);
        this.active++;
        resolve();
      };
      const cancelled = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", cancelled, { once: true });
    });
  }
}

function abortError(): Error {
  return new DOMException("workflow cancelled", "AbortError");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    return String(value);
  return value;
}

export function hashInput(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "assistant"
    )
      continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    return content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function resolveModel(
  value: string | undefined,
  ctx: ExtensionContext,
): NonNullable<ExtensionContext["model"]> {
  if (!value) {
    if (!ctx.model) throw new Error("workflow child requires an active model");
    return ctx.model;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    throw new Error(`invalid model override: ${value}; expected provider/id`);
  const model = ctx.modelRegistry.find(
    value.slice(0, slash),
    value.slice(slash + 1),
  );
  if (!model) throw new Error(`model not found: ${value}`);
  return model;
}

export function selectChildTools(
  tools: string[] | undefined,
  schema: boolean,
): string[] {
  const requested = tools ?? DEFAULT_TOOLS;
  const unsafe = requested.filter((tool) => !SAFE_TOOLS.has(tool));
  if (unsafe.length > 0)
    throw new Error(
      `workflow child tools are not allowed: ${unsafe.join(", ")}`,
    );
  return schema
    ? [...new Set([...requested, "workflow_result"])]
    : [...requested];
}

function addUsage(target: WorkflowUsage, message: unknown): void {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "assistant"
  )
    return;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  target.input += Number(usage.input ?? 0);
  target.output += Number(usage.output ?? 0);
  target.cacheRead += Number(usage.cacheRead ?? 0);
  target.cacheWrite += Number(usage.cacheWrite ?? 0);
  const cost = usage.cost;
  target.cost += Number(
    cost && typeof cost === "object"
      ? ((cost as { total?: unknown }).total ?? 0)
      : 0,
  );
  target.turns++;
}

export const spawnPersistentAgent: SpawnAgent = async (request) => {
  const { options, ctx, node } = request;
  if (request.signal?.aborted) throw abortError();
  let structuredResult: unknown;
  const customTools = options.schema
    ? [
        defineTool({
          name: "workflow_result",
          label: "Workflow Result",
          description:
            "Return the final workflow node result. Call this as the final action.",
          parameters: options.schema as TSchema,
          async execute(_id, params) {
            structuredResult = params;
            return {
              content: [{ type: "text", text: "workflow result captured" }],
              details: params,
              terminate: true,
            };
          },
        }),
      ]
    : [];

  const settingsManager = SettingsManager.create(request.cwd, getAgentDir());
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: Boolean(options.cacheKey),
  });
  await resourceLoader.reload({
    resolveProjectTrust: async () => ctx.isProjectTrusted(),
  });
  const manager = SessionManager.create(request.cwd, undefined, {
    parentSession: request.parentSessionFile,
  });
  manager.appendSessionInfo(
    `workflow:${request.source.meta.name}:${options.label ?? node.nodeId.slice(0, 8)}`,
  );
  manager.appendCustomEntry("workflow:child", {
    runId: request.node.nodeId.split(":")[0],
    nodeId: node.nodeId,
    phase: node.phase,
    label: node.label,
  });
  const childSessionFile = manager.getSessionFile();
  if (!childSessionFile)
    throw new Error("workflow child session was not persisted");
  await request.onSession(manager.getSessionId(), childSessionFile);

  const { session } = await createAgentSession({
    cwd: request.cwd,
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    tools: request.tools,
    customTools,
    sessionManager: manager,
    modelRegistry: ctx.modelRegistry,
    authStorage: ctx.modelRegistry.authStorage,
    settingsManager,
    resourceLoader,
  });
  const usage = { ...ZERO_USAGE };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end") addUsage(usage, event.message);
    if (event.type === "message_update" || event.type === "message_end")
      request.onUsage({ ...usage });
  });
  const abort = () => void session.abort();
  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (request.signal?.aborted) {
      await session.abort();
      throw abortError();
    }
    await session.prompt(request.prompt);
    const firstAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (firstAssistant?.stopReason === "aborted" || request.signal?.aborted)
      throw abortError();
    if (firstAssistant?.stopReason === "error" || firstAssistant?.errorMessage)
      throw new Error(firstAssistant.errorMessage ?? "child agent failed");
    if (options.schema && structuredResult === undefined) {
      if (request.signal?.aborted) throw abortError();
      await session.prompt(
        "Your previous response did not call workflow_result. Call workflow_result now with the final value and no other output.",
      );
    }
    if (options.schema && structuredResult === undefined)
      throw new Error(
        "child did not call workflow_result after one corrective follow-up",
      );
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") throw abortError();
    if (lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage)
      throw new Error(lastAssistant.errorMessage ?? "child agent failed");
    const sessionFile = session.sessionFile;
    if (!sessionFile)
      throw new Error("workflow child session was not persisted");
    return {
      result: options.schema
        ? structuredResult
        : finalAssistantText(session.messages),
      sessionId: session.sessionId,
      sessionFile,
      usage,
    };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
};

export class WorkflowRuntime {
  private readonly semaphore: Semaphore;
  private agentSequence = 0;
  private launched = 0;
  private cached = 0;
  private readonly controller = new AbortController();
  private readonly cancellationSignal: AbortSignal;
  private readonly runSignal: AbortSignal;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly graph: WorkflowGraphNode[];
  private readonly graphAliases = new Map<string, string>();
  private graphProgressTimer?: ReturnType<typeof setTimeout>;
  private lastGraphProgressAt = 0;

  constructor(
    private readonly source: WorkflowSource,
    private readonly args: unknown,
    private readonly limits: { maxConcurrency: number; maxAgents: number },
    private readonly store: JournalStore,
    private readonly parentSessionFile: string,
    private readonly ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    private readonly onProgress: (progress: WorkflowProgress) => void,
    private readonly spawnAgent: SpawnAgent = spawnPersistentAgent,
    private readonly runnerLauncher: RunnerLauncher | undefined = undefined,
  ) {
    this.semaphore = new Semaphore(limits.maxConcurrency);
    this.launched = store.journal.nodes.length;
    const draftPhases = (source.meta.phases ?? []).slice(
      0,
      MAX_GRAPH_NODES - 2,
    );
    this.graph = [
      {
        id: "workflow",
        kind: "workflow",
        label: source.meta.name,
        status: "running",
        order: 0,
      },
      ...draftPhases.map(
        (phase, index): WorkflowGraphNode => ({
          id: `draft:phase:${index}`,
          parentId: index === 0 ? "workflow" : `draft:phase:${index - 1}`,
          kind: "phase",
          label: phase,
          phase,
          status: "pending",
          order: Number.MAX_SAFE_INTEGER - draftPhases.length + index,
          draft: true,
        }),
      ),
      ...((source.meta.phases?.length ?? 0) > draftPhases.length
        ? [
            {
              id: "workflow:overflow",
              parentId: "workflow",
              kind: "item" as const,
              label: "additional draft phases hidden",
              status: "pending" as const,
              order: Number.MAX_SAFE_INTEGER,
              draft: true,
            },
          ]
        : []),
    ];
    this.cancellationSignal = AbortSignal.any(
      [signal, store.signal].filter((candidate): candidate is AbortSignal =>
        Boolean(candidate),
      ),
    );
    this.runSignal = AbortSignal.any([
      this.cancellationSignal,
      this.controller.signal,
    ]);
  }

  async run(): Promise<RuntimeResult> {
    this.emitProgress();
    try {
      const value = await runWorkflowScript(
        {
          body: this.source.body,
          args: this.args,
          filename: this.source.path,
          signal: this.runSignal,
          onFatal: (error) => this.controller.abort(error),
          onGraphEvent: (event) => this.applyGraphEvent(event),
          agent: async ({ prompt, options, phase }) => {
            const outcome = await this.trackAgent(prompt, {
              ...(options as WorkflowAgentOptions),
              ...(phase === undefined ? {} : { phase }),
            });
            return workflowAgentOutcome(outcome.value, outcome.cached);
          },
        },
        this.runnerLauncher,
      );
      await this.drainAgents();
      this.setGraphTerminalStatus("completed");
      return {
        value,
        cached: this.cached,
        graph: this.graph.map((node) => ({ ...node })),
      };
    } catch (error) {
      const cancelled = this.cancellationSignal.aborted;
      this.controller.abort();
      await this.drainAgents();
      this.setGraphTerminalStatus(cancelled ? "cancelled" : "failed");
      throw error;
    }
  }

  private trackAgent(
    prompt: string,
    options?: WorkflowAgentOptions,
  ): Promise<AgentExecution> {
    const invocation = this.agent(prompt, options);
    this.inFlight.add(invocation);
    void invocation.then(
      () => this.inFlight.delete(invocation),
      () => this.inFlight.delete(invocation),
    );
    void invocation.catch(() => undefined);
    return invocation;
  }

  private async drainAgents(): Promise<void> {
    do {
      while (this.inFlight.size > 0)
        await Promise.allSettled([...this.inFlight]);
      await Promise.resolve();
    } while (this.inFlight.size > 0);
  }

  private async agent(
    prompt: string,
    options: WorkflowAgentOptions = {},
  ): Promise<AgentExecution> {
    if (typeof prompt !== "string" || prompt.trim() === "")
      throw new Error("agent prompt must be a non-empty string");
    if (this.runSignal.aborted) throw abortError();
    const phase = options.phase;
    const model = resolveModel(options.model, this.ctx);
    const thinkingLevel = options.thinkingLevel ?? "medium";
    const tools = selectChildTools(options.tools, Boolean(options.schema));
    const sequence = ++this.agentSequence;
    const key = options.cacheKey ?? `node-${sequence}`;
    if (options.cacheKey && tools.some((tool) => MUTATING_TOOLS.has(tool)))
      throw new Error(
        "cacheKey cannot be used with edit, write, or format_file because their side effects cannot be replayed",
      );
    if (options.cacheKey && tools.some((tool) => tool !== "workflow_result"))
      throw new Error(
        "cacheKey requires tools: [] because filesystem and skill inputs are not captured by the cache key",
      );
    const inputHash = hashInput({
      cacheAbi: 3,
      scriptHash: this.source.hash,
      prompt,
      cwd: this.ctx.cwd,
      contextHash: createHash("sha256")
        .update(this.ctx.getSystemPrompt())
        .digest("hex"),
      execution: {
        model: stableValue(model),
        thinkingLevel,
        tools,
        schema: stableValue(options.schema),
      },
    });
    const cached = options.cacheKey
      ? this.store.findCompleted(key, inputHash)
      : undefined;
    if (cached) {
      this.cached++;
      this.emitProgress();
      return { value: cached.result, cached: true };
    }
    if (++this.launched > this.limits.maxAgents)
      throw new Error(`workflow exceeded maxAgents (${this.limits.maxAgents})`);

    const node: WorkflowNodeRecord = {
      nodeId: `${this.store.journal.runId}:${randomUUID()}`,
      key,
      inputHash,
      status: "running",
      phase,
      label: options.label,
      usage: { ...ZERO_USAGE },
      startedAt: new Date().toISOString(),
    };
    await this.store.mutate((journal) => journal.nodes.push(node));
    this.emitProgress();

    try {
      return await this.semaphore.run(async () => {
        const result = await this.spawnAgent({
          prompt,
          options: { ...options, phase },
          model,
          thinkingLevel,
          tools,
          node,
          source: this.source,
          parentSessionFile: this.parentSessionFile,
          cwd: this.ctx.cwd,
          signal: this.runSignal,
          ctx: this.ctx,
          onUsage: (usage) => {
            node.usage = usage;
            this.emitProgress();
          },
          onSession: async (sessionId, sessionFile) => {
            await this.store.mutate(() => {
              node.childSessionId = sessionId;
              node.childSessionFile = sessionFile;
            });
          },
        });
        await this.store.mutate(() => {
          Object.assign(node, {
            status: "completed",
            result: result.result,
            childSessionId: result.sessionId,
            childSessionFile: result.sessionFile,
            usage: result.usage,
            finishedAt: new Date().toISOString(),
          });
        });
        this.emitProgress();
        return { value: result.result, cached: false };
      }, this.runSignal);
    } catch (error) {
      await this.store.mutate(() => {
        node.status = this.runSignal.aborted ? "cancelled" : "failed";
        node.error = error instanceof Error ? error.message : String(error);
        node.finishedAt = new Date().toISOString();
      });
      this.emitProgress();
      throw error;
    }
  }

  private applyGraphEvent(event: WorkflowGraphEvent): void {
    const normalized = this.resolveDraftGraphEvent(event);
    if (
      normalized.type === "node" &&
      !this.graph.some((node) => node.id === normalized.node.id) &&
      this.graph.length >= MAX_GRAPH_NODES - 1
    ) {
      if (!this.graph.some((node) => node.id === "workflow:overflow")) {
        this.graph.push({
          id: "workflow:overflow",
          parentId: "workflow",
          kind: "item",
          label: "additional control-flow nodes hidden",
          status: "running",
          order: Number.MAX_SAFE_INTEGER,
        });
      }
    } else {
      applyWorkflowGraphEvent(this.graph, normalized);
    }
    this.scheduleGraphProgress();
  }

  private resolveDraftGraphEvent(
    event: WorkflowGraphEvent,
  ): WorkflowGraphEvent {
    if (event.type === "status") {
      return {
        ...event,
        id: this.graphAliases.get(event.id) ?? event.id,
      };
    }

    const parentId = event.node.parentId
      ? (this.graphAliases.get(event.node.parentId) ?? event.node.parentId)
      : undefined;
    if (event.node.kind === "phase") {
      const candidates = this.graph.filter(
        (node) =>
          node.kind === "phase" &&
          node.draft === true &&
          node.status === "pending" &&
          node.label === event.node.label,
      );
      const draft =
        candidates.find((node) => node.parentId === parentId) ??
        (parentId === "workflow" ? candidates[0] : undefined);
      if (draft) {
        this.graphAliases.set(event.node.id, draft.id);
        return {
          type: "node",
          node: {
            ...event.node,
            id: draft.id,
            parentId: draft.parentId,
            order: draft.order,
            draft: false,
          },
        };
      }
    }

    return {
      type: "node",
      node: {
        ...event.node,
        parentId,
      },
    };
  }

  private scheduleGraphProgress(): void {
    const elapsed = Date.now() - this.lastGraphProgressAt;
    if (elapsed >= GRAPH_PROGRESS_INTERVAL_MS) {
      this.lastGraphProgressAt = Date.now();
      this.emitProgress();
      return;
    }
    if (this.graphProgressTimer) return;
    this.graphProgressTimer = setTimeout(() => {
      this.graphProgressTimer = undefined;
      this.lastGraphProgressAt = Date.now();
      this.emitProgress();
    }, GRAPH_PROGRESS_INTERVAL_MS - elapsed);
  }

  private setGraphTerminalStatus(
    status: "completed" | "failed" | "cancelled",
  ): void {
    if (this.graphProgressTimer) clearTimeout(this.graphProgressTimer);
    this.graphProgressTimer = undefined;
    const root = this.graph.find((node) => node.id === "workflow");
    if (root) root.status = status;
    for (const node of this.graph) {
      if (node.status === "running") node.status = status;
    }
    this.emitProgress();
  }

  private emitProgress(): void {
    const nodes = this.store.journal.nodes;
    this.onProgress({
      runId: this.store.journal.runId,
      status: this.store.journal.status,
      running: nodes.filter((node) => node.status === "running").length,
      completed: nodes.filter((node) => node.status === "completed").length,
      failed: nodes.filter(
        (node) => node.status === "failed" || node.status === "cancelled",
      ).length,
      cached: this.cached,
      total: nodes.length,
      usage: nodes.reduce(
        (usage, node) => ({
          input: usage.input + node.usage.input,
          output: usage.output + node.usage.output,
          cacheRead: usage.cacheRead + node.usage.cacheRead,
          cacheWrite: usage.cacheWrite + node.usage.cacheWrite,
          cost: usage.cost + node.usage.cost,
          turns: usage.turns + node.usage.turns,
        }),
        { ...ZERO_USAGE },
      ),
      graph: this.graph.map((node) => ({ ...node })),
    });
  }
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const join = (...parts: string[]) => pathModule.join(...parts);
  const dirs: string[] = [];
  const stores: JournalStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.release()));
    await Promise.all(
      dirs
        .splice(0)
        .map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function harness(
    body: string,
    spawn: SpawnAgent,
    limits = { maxConcurrency: 2, maxAgents: 10 },
    signal?: AbortSignal,
    phases?: string[],
  ) {
    const dir = await mkdtemp(join(tmpdir(), "workflow-runtime-"));
    dirs.push(dir);
    const source: WorkflowSource = {
      source: "inline",
      body,
      meta: {
        name: "test",
        description: "test",
        ...(phases ? { phases } : {}),
      },
      hash: "hash",
      projectLocal: false,
    };
    const store = await JournalStore.create(dir, {
      workflow: {
        ...source.meta,
        source: source.source,
        scriptHash: source.hash,
      },
      invoking: {
        sessionId: "parent",
        sessionFile: "/tmp/parent.jsonl",
        cwd: dir,
      },
      limits,
      status: "running",
    });
    stores.push(store);
    const ctx = {
      cwd: dir,
      model: { provider: "test", id: "model", api: "test" },
      getSystemPrompt: () => "test system prompt",
    } as ExtensionContext;
    const progress: WorkflowProgress[] = [];
    return {
      store,
      progress,
      runtime: new WorkflowRuntime(
        source,
        { n: 2 },
        limits,
        store,
        "/tmp/parent.jsonl",
        ctx,
        signal,
        (update) => progress.push(update),
        spawn,
        spawnDirectRunner,
      ),
    };
  }

  const successSpawn: SpawnAgent = async ({ prompt, node }) => ({
    result: prompt,
    sessionId: node.nodeId,
    sessionFile: `/tmp/${node.nodeId}.jsonl`,
    usage: { ...ZERO_USAGE },
  });

  describe("workflow runtime", () => {
    it("shows the full draft phase route before execution and reconciles live phases", async () => {
      const { runtime, progress } = await harness(
        'return phase("inspect", () => phase("challenge", async () => "done"))',
        successSpawn,
        undefined,
        undefined,
        ["inspect", "challenge", "decide"],
      );
      await runtime.run();

      const initialPhases = progress[0]!.graph.filter(
        (node) => node.kind === "phase",
      );
      expect(initialPhases.map((node) => node.label)).toEqual([
        "inspect",
        "challenge",
        "decide",
      ]);
      expect(initialPhases.map((node) => node.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      expect(initialPhases.map((node) => node.parentId)).toEqual([
        "workflow",
        "draft:phase:0",
        "draft:phase:1",
      ]);

      const finalPhases = progress
        .at(-1)!
        .graph.filter((node) => node.kind === "phase");
      expect(finalPhases).toHaveLength(3);
      expect(finalPhases[0]).toMatchObject({
        label: "inspect",
        status: "completed",
        draft: false,
      });
      expect(finalPhases[1]).toMatchObject({
        label: "challenge",
        status: "completed",
        draft: false,
      });
      expect(finalPhases[2]).toMatchObject({
        label: "decide",
        status: "pending",
        draft: true,
      });
    });

    it("preserves live parents when runtime topology diverges from the draft", async () => {
      const { runtime } = await harness(
        'return phase("outer", () => parallel([() => phase("inner", async () => "done")]))',
        successSpawn,
        undefined,
        undefined,
        ["outer", "inner"],
      );
      const result = await runtime.run();
      const innerPhases = result.graph.filter(
        (node) => node.kind === "phase" && node.label === "inner",
      );
      expect(innerPhases).toHaveLength(2);
      expect(innerPhases.find((node) => node.draft)).toMatchObject({
        status: "pending",
        parentId: "draft:phase:0",
      });
      const live = innerPhases.find((node) => !node.draft)!;
      const parallel = result.graph.find((node) => node.id === live.parentId)!;
      expect(parallel.kind).toBe("parallel");
      const outer = result.graph.find(
        (node) => node.kind === "phase" && node.label === "outer",
      )!;
      const orderedChildren = result.graph
        .filter((node) => node.parentId === outer.id)
        .sort((left, right) => left.order - right.order);
      expect(orderedChildren.map((node) => node.kind)).toEqual([
        "parallel",
        "phase",
      ]);
    });

    it("joins every text block from the final assistant response", () => {
      expect(
        finalAssistantText([
          {
            role: "assistant",
            content: [
              { type: "text", text: "first" },
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: " second" },
            ],
          },
        ]),
      ).toBe("first second");
    });

    it("does not expose host capabilities", async () => {
      const { runtime } = await harness(
        "return [typeof process, typeof require, typeof fetch, typeof Buffer, typeof globalThis.process]",
        successSpawn,
      );
      expect((await runtime.run()).value).toEqual([
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ]);
    });

    it("preserves pipeline order while stages stay sequential per item", async () => {
      const { runtime } = await harness(
        "return pipeline([3, 1, 2], async x => x * 2, async x => x + 1)",
        successSpawn,
      );
      expect((await runtime.run()).value).toEqual([7, 3, 5]);
      const failed = await harness(
        "return pipeline([1], async () => { throw new Error('stage failed') }, async () => 2)",
        successSpawn,
      );
      await expect(failed.runtime.run()).rejects.toThrow("stage failed");
    });

    it("enforces concurrency and agent limits", async () => {
      let active = 0;
      let peak = 0;
      const spawn: SpawnAgent = async (request) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return successSpawn(request);
      };
      const { runtime } = await harness(
        "return parallel(Array.from({ length: 5 }, (_, i) => () => agent(String(i))))",
        spawn,
        { maxConcurrency: 2, maxAgents: 5 },
      );
      await runtime.run();
      expect(peak).toBe(2);
      const over = await harness(
        "return parallel([() => agent('a'), () => agent('b')])",
        spawn,
        { maxConcurrency: 1, maxAgents: 1 },
      );
      await expect(over.runtime.run()).rejects.toThrow("maxAgents");
      expect(() => normalizeLimits(17, 1)).toThrow("maxConcurrency");
      expect(() => normalizeLimits(1, 1001)).toThrow("maxAgents");
    });

    it("rejects tools that could escape workflow bounds", () => {
      expect(selectChildTools(undefined, false)).not.toContain("finder");
      expect(() => selectChildTools(["read", "delegate"], false)).toThrow(
        "not allowed",
      );
      expect(() => selectChildTools(["oracle"], false)).toThrow("not allowed");
      expect(() => selectChildTools(["bash"], false)).toThrow("not allowed");
      expect(selectChildTools(["read"], true)).toEqual([
        "read",
        "workflow_result",
      ]);
    });

    it("waits for detached agent promises before completing", async () => {
      let finished = false;
      const spawn: SpawnAgent = async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = true;
        return successSpawn(request);
      };
      const { runtime } = await harness(
        "agent('detached'); return 'script-result'",
        spawn,
      );
      expect((await runtime.run()).value).toBe("script-result");
      expect(finished).toBe(true);
    });

    it("propagates cancellation", async () => {
      const controller = new AbortController();
      const spawn: SpawnAgent = ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          }),
        );
      const { runtime } = await harness(
        "return agent('wait')",
        spawn,
        undefined,
        controller.signal,
      );
      const pending = runtime.run();
      setTimeout(() => controller.abort(), 5);
      await expect(pending).rejects.toThrow("workflow cancelled");
    });

    it("reuses only completed nodes with stable matching inputs", async () => {
      let calls = 0;
      const spawn: SpawnAgent = async (request) => {
        calls++;
        return successSpawn(request);
      };
      const first = await harness(
        "return agent('same', { cacheKey: 'key', tools: [] })",
        spawn,
      );
      expect((await first.runtime.run()).value).toBe("same");
      const source: WorkflowSource = {
        source: "inline",
        body: "return agent('same', { cacheKey: 'key', tools: [] })",
        meta: { name: "test", description: "test" },
        hash: "hash",
        projectLocal: false,
      };
      const resumed = new WorkflowRuntime(
        source,
        {},
        { maxConcurrency: 2, maxAgents: 10 },
        first.store,
        "/tmp/parent.jsonl",
        {
          cwd: first.store.journal.invoking.cwd,
          model: { provider: "test", id: "model", api: "test" },
          getSystemPrompt: () => "test system prompt",
        } as ExtensionContext,
        undefined,
        () => undefined,
        spawn,
        spawnDirectRunner,
      );
      expect((await resumed.run()).value).toBe("same");
      expect(calls).toBe(1);

      const exhaustedBudget = new WorkflowRuntime(
        source,
        {},
        { maxConcurrency: 1, maxAgents: 1 },
        first.store,
        "/tmp/parent.jsonl",
        {
          cwd: first.store.journal.invoking.cwd,
          model: { provider: "test", id: "other-model", api: "test" },
          getSystemPrompt: () => "test system prompt",
        } as ExtensionContext,
        undefined,
        () => undefined,
        spawn,
        spawnDirectRunner,
      );
      await expect(exhaustedBudget.run()).rejects.toThrow("maxAgents");
      expect(calls).toBe(1);

      const changedModel = new WorkflowRuntime(
        source,
        {},
        { maxConcurrency: 2, maxAgents: 10 },
        first.store,
        "/tmp/parent.jsonl",
        {
          cwd: first.store.journal.invoking.cwd,
          model: { provider: "test", id: "other-model", api: "test" },
          getSystemPrompt: () => "test system prompt",
        } as ExtensionContext,
        undefined,
        () => undefined,
        spawn,
        spawnDirectRunner,
      );
      expect((await changedModel.run()).value).toBe("same");
      expect(calls).toBe(2);
    });

    it("rejects cache replay for nodes with filesystem side effects", async () => {
      const { runtime } = await harness(
        'return agent("mutate", { cacheKey: "key", tools: ["edit"] })',
        successSpawn,
      );
      await expect(runtime.run()).rejects.toThrow(
        "side effects cannot be replayed",
      );
    });
  });
}
