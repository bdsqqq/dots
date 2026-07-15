import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  createCodeReviewTool,
  resolveCodeReviewConfig,
  type CodeReviewParams,
} from "@bds_pi/code-review";
import {
  createDelegateTool,
  resolveDelegateConfig,
  type DelegateParams,
} from "@bds_pi/delegate";
import {
  createFinderTool,
  resolveFinderConfig,
  type FinderParams,
} from "@bds_pi/finder";
import {
  createLookAtTool,
  resolveLookAtConfig,
  type LookAtParams,
} from "@bds_pi/look-at";
import {
  createLibrarianTool,
  resolveLibrarianConfig,
  type LibrarianParams,
} from "@bds_pi/librarian";
import {
  createOracleTool,
  resolveOracleConfig,
  type OracleParams,
} from "@bds_pi/oracle";
import {
  createReadSessionTool,
  resolveReadSessionConfig,
  type ReadSessionParams,
} from "@bds_pi/read-session";
import {
  createReadWebPageTool,
  resolveReadWebPageConfig,
  type ReadWebPageParams,
} from "@bds_pi/read-web-page";
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
  type WorkflowAgentOptions,
  type WorkflowRecipe,
} from "./process-runner.js";
import type { WorkflowSource } from "./source.js";

export const HARD_MAX_CONCURRENCY = 16;
export const HARD_MAX_AGENTS = 1000;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_AGENTS = 64;
const MAX_GRAPH_NODES = 2000;
const GRAPH_PROGRESS_INTERVAL_MS = 50;

type RecipeKind = WorkflowRecipe["kind"];

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

interface RecipeExecution {
  value: unknown;
  cached: false;
}

export interface SpawnRecipeRequest {
  recipe: WorkflowRecipe;
  options: WorkflowAgentOptions;
  node: WorkflowNodeRecord;
  source: WorkflowSource;
  cwd: string;
  signal?: AbortSignal;
  ctx: ExtensionContext;
  onUsage: (usage: WorkflowUsage) => void;
  onSession: (sessionId?: string, sessionFile?: string) => Promise<void>;
}

export interface SpawnRecipeResult {
  result: unknown;
  sessionId?: string;
  sessionFile?: string;
  usage: WorkflowUsage;
}

export type SpawnRecipe = (
  request: SpawnRecipeRequest,
) => Promise<SpawnRecipeResult>;

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
  )
    throw new Error(
      `maxConcurrency must be an integer from 1 to ${HARD_MAX_CONCURRENCY}`,
    );
  if (!Number.isInteger(agents) || agents < 1 || agents > HARD_MAX_AGENTS)
    throw new Error(
      `maxAgents must be an integer from 1 to ${HARD_MAX_AGENTS}`,
    );
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

function inputObject(recipe: WorkflowRecipe): Record<string, unknown> {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe))
    throw new Error("workflow recipe must be an object");
  if (
    !new Set([
      "delegate",
      "oracle",
      "librarian",
      "finder",
      "codeReview",
      "lookAt",
      "readSession",
      "readWebPage",
    ]).has(recipe.kind)
  )
    throw new Error(`unknown workflow recipe kind: ${String(recipe.kind)}`);
  if (
    !recipe.input ||
    typeof recipe.input !== "object" ||
    Array.isArray(recipe.input)
  )
    throw new Error(`${recipe.kind} recipe input must be an object`);
  return recipe.input;
}

function requiredString(
  kind: RecipeKind,
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string")
    throw new Error(`${kind} recipe input.${key} must be a string`);
  return value;
}

function optionalString(
  kind: RecipeKind,
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(`${kind} recipe input.${key} must be a string`);
  return value;
}

function validateRecipeInput(
  recipe: WorkflowRecipe,
):
  | DelegateParams
  | OracleParams
  | LibrarianParams
  | FinderParams
  | CodeReviewParams
  | LookAtParams
  | ReadSessionParams
  | ReadWebPageParams {
  const input = inputObject(recipe);
  switch (recipe.kind) {
    case "delegate":
      return {
        prompt: requiredString(recipe.kind, input, "prompt"),
        description: requiredString(recipe.kind, input, "description"),
        ...(input.continueId === undefined
          ? {}
          : { continueId: optionalString(recipe.kind, input, "continueId") }),
        ...(input.leafId === undefined
          ? {}
          : { leafId: optionalString(recipe.kind, input, "leafId") }),
      };
    case "oracle": {
      const files = input.files;
      if (
        files !== undefined &&
        (!Array.isArray(files) ||
          files.some((file) => typeof file !== "string"))
      )
        throw new Error(
          "oracle recipe input.files must be an array of strings",
        );
      return {
        task: requiredString(recipe.kind, input, "task"),
        ...(input.context === undefined
          ? {}
          : { context: optionalString(recipe.kind, input, "context") }),
        ...(files ? { files: [...files] as string[] } : {}),
      };
    }
    case "librarian":
      return {
        query: requiredString(recipe.kind, input, "query"),
        ...(input.context === undefined
          ? {}
          : { context: optionalString(recipe.kind, input, "context") }),
      };
    case "finder":
      return { query: requiredString(recipe.kind, input, "query") };
    case "codeReview": {
      const files = input.files;
      if (
        files !== undefined &&
        (!Array.isArray(files) ||
          files.some((file) => typeof file !== "string"))
      )
        throw new Error(
          "codeReview recipe input.files must be an array of strings",
        );
      return {
        diff_description: requiredString(
          recipe.kind,
          input,
          "diff_description",
        ),
        ...(files ? { files: [...files] as string[] } : {}),
        ...(input.instructions === undefined
          ? {}
          : {
              instructions: optionalString(recipe.kind, input, "instructions"),
            }),
      };
    }
    case "lookAt": {
      const referenceFiles = input.referenceFiles;
      if (
        referenceFiles !== undefined &&
        (!Array.isArray(referenceFiles) ||
          referenceFiles.some((file) => typeof file !== "string"))
      )
        throw new Error(
          "lookAt recipe input.referenceFiles must be an array of strings",
        );
      return {
        path: requiredString(recipe.kind, input, "path"),
        objective: requiredString(recipe.kind, input, "objective"),
        context: requiredString(recipe.kind, input, "context"),
        ...(referenceFiles
          ? { referenceFiles: [...referenceFiles] as string[] }
          : {}),
      };
    }
    case "readSession":
      return {
        session_id: requiredString(recipe.kind, input, "session_id"),
        goal: requiredString(recipe.kind, input, "goal"),
        ...(input.leaf_id === undefined
          ? {}
          : { leaf_id: optionalString(recipe.kind, input, "leaf_id") }),
      };
    case "readWebPage": {
      for (const key of ["start_index", "max_length"] as const) {
        const value = input[key];
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isFinite(value))
        )
          throw new Error(
            `readWebPage recipe input.${key} must be a finite number`,
          );
      }
      for (const key of ["raw", "forceRefetch"] as const) {
        const value = input[key];
        if (value !== undefined && typeof value !== "boolean")
          throw new Error(`readWebPage recipe input.${key} must be a boolean`);
      }
      return {
        url: requiredString(recipe.kind, input, "url"),
        ...(input.objective === undefined
          ? {}
          : { objective: optionalString(recipe.kind, input, "objective") }),
        ...(input.prompt === undefined
          ? {}
          : { prompt: optionalString(recipe.kind, input, "prompt") }),
        ...(input.start_index === undefined
          ? {}
          : { start_index: input.start_index as number }),
        ...(input.max_length === undefined
          ? {}
          : { max_length: input.max_length as number }),
        ...(input.raw === undefined ? {} : { raw: input.raw as boolean }),
        ...(input.forceRefetch === undefined
          ? {}
          : { forceRefetch: input.forceRefetch as boolean }),
      };
    }
  }
}

function resultUsage(details: unknown): WorkflowUsage {
  if (!details || typeof details !== "object") return { ...ZERO_USAGE };
  const usage = (details as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return { ...ZERO_USAGE };
  const value = usage as Record<string, unknown>;
  return {
    input: Number(value.input ?? 0),
    output: Number(value.output ?? 0),
    cacheRead: Number(value.cacheRead ?? 0),
    cacheWrite: Number(value.cacheWrite ?? 0),
    cost: Number(value.cost ?? 0),
    turns: Number(value.turns ?? 0),
  };
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
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

function sessionMetadata(details: unknown): {
  sessionId?: string;
  sessionFile?: string;
} {
  if (!details || typeof details !== "object") return {};
  const value = details as Record<string, unknown>;
  return {
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
    ...(typeof value.sessionFile === "string"
      ? { sessionFile: value.sessionFile }
      : {}),
  };
}

export const spawnRecipeTool: SpawnRecipe = async (request) => {
  if (request.signal?.aborted) throw abortError();
  const params = validateRecipeInput(request.recipe);
  let tool;
  switch (request.recipe.kind) {
    case "delegate": {
      const resolved = resolveDelegateConfig();
      if (!resolved.enabled) throw new Error("delegate recipe is disabled");
      tool = createDelegateTool(resolved.config);
      break;
    }
    case "oracle": {
      const resolved = resolveOracleConfig();
      if (!resolved.enabled) throw new Error("oracle recipe is disabled");
      tool = createOracleTool(resolved.config);
      break;
    }
    case "librarian": {
      const resolved = resolveLibrarianConfig();
      if (!resolved.enabled) throw new Error("librarian recipe is disabled");
      tool = createLibrarianTool(resolved.config);
      break;
    }
    case "finder": {
      const resolved = resolveFinderConfig();
      if (!resolved.enabled) throw new Error("finder recipe is disabled");
      tool = createFinderTool(resolved.config);
      break;
    }
    case "codeReview": {
      const resolved = resolveCodeReviewConfig();
      if (!resolved.enabled) throw new Error("codeReview recipe is disabled");
      tool = createCodeReviewTool(resolved.config);
      break;
    }
    case "lookAt": {
      const resolved = resolveLookAtConfig();
      if (!resolved.enabled) throw new Error("lookAt recipe is disabled");
      tool = createLookAtTool(resolved.config);
      break;
    }
    case "readSession": {
      const resolved = resolveReadSessionConfig();
      if (!resolved.enabled) throw new Error("readSession recipe is disabled");
      tool = createReadSessionTool(resolved.config);
      break;
    }
    case "readWebPage": {
      const resolved = resolveReadWebPageConfig();
      if (!resolved.enabled) throw new Error("readWebPage recipe is disabled");
      tool = createReadWebPageTool(resolved.config);
      break;
    }
  }
  if (!Value.Check(tool.parameters, params))
    throw new Error(
      `${request.recipe.kind} recipe input does not match its tool schema`,
    );
  if (!tool.execute)
    throw new Error(`${request.recipe.kind} tool is not executable`);

  let updateQueue = Promise.resolve();
  const update = (partial: unknown) => {
    if (!partial || typeof partial !== "object") return;
    const details = (partial as { details?: unknown }).details;
    request.onUsage(resultUsage(details));
    const session = sessionMetadata(details);
    if (session.sessionId || session.sessionFile)
      updateQueue = updateQueue.then(async () =>
        request.onSession(session.sessionId, session.sessionFile),
      );
  };
  const result = await tool.execute(
    request.node.nodeId,
    params,
    request.signal,
    update,
    request.ctx,
  );
  await updateQueue;
  if (request.signal?.aborted) throw abortError();
  const details =
    result && typeof result === "object" ? result.details : undefined;
  const usage = resultUsage(details);
  const session = sessionMetadata(details);
  request.onUsage(usage);
  if (session.sessionId || session.sessionFile)
    await request.onSession(session.sessionId, session.sessionFile);
  const text = resultText(result);
  return { result: text, ...session, usage };
};

export class WorkflowRuntime {
  private readonly semaphore: Semaphore;
  private agentSequence = 0;
  private launched = 0;
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
    private readonly ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    private readonly onProgress: (progress: WorkflowProgress) => void,
    private readonly spawnRecipe: SpawnRecipe = spawnRecipeTool,
    private readonly runnerLauncher: RunnerLauncher | undefined = undefined,
  ) {
    this.semaphore = new Semaphore(limits.maxConcurrency);
    this.agentSequence = store.journal.nodes.length;
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
      if (!this.source.code)
        throw new Error("workflow source has no compiled code");
      const value = await runWorkflowScript(
        {
          code: this.source.code,
          meta: this.source.meta,
          args: this.args,
          filename: this.source.path,
          signal: this.runSignal,
          onFatal: (error) => this.controller.abort(error),
          onGraphEvent: (event) => this.applyGraphEvent(event),
          agent: async ({ recipe, options, phase }) => {
            const outcome = await this.trackRecipe(recipe, {
              ...options,
              ...(phase === undefined ? {} : { phase }),
            });
            return workflowAgentOutcome(outcome.value, false);
          },
        },
        this.runnerLauncher,
      );
      await this.drainAgents();
      this.setGraphTerminalStatus("completed");
      return {
        value,
        cached: 0,
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

  private trackRecipe(
    recipe: WorkflowRecipe,
    options: WorkflowAgentOptions,
  ): Promise<RecipeExecution> {
    const invocation = this.recipe(recipe, options);
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

  private async recipe(
    recipe: WorkflowRecipe,
    options: WorkflowAgentOptions,
  ): Promise<RecipeExecution> {
    const params = validateRecipeInput(recipe);
    if (!this.source.meta.agents?.includes(recipe.kind))
      throw new Error(
        `${recipe.kind} recipe is not declared in workflow meta.agents`,
      );
    if (this.runSignal.aborted) throw abortError();
    const sequence = ++this.agentSequence;
    if (++this.launched > this.limits.maxAgents)
      throw new Error(`workflow exceeded maxAgents (${this.limits.maxAgents})`);

    const node: WorkflowNodeRecord = {
      nodeId: `${this.store.journal.runId}:${randomUUID()}`,
      key: `recipe-${sequence}`,
      inputHash: this.source.hash,
      status: "running",
      phase: options.phase,
      label: options.label ?? recipe.kind,
      recipe: recipe.kind,
      usage: { ...ZERO_USAGE },
      startedAt: new Date().toISOString(),
    };
    await this.store.mutate((journal) => journal.nodes.push(node));
    this.emitProgress();

    try {
      return await this.semaphore.run(async () => {
        const result = await this.spawnRecipe({
          recipe: { kind: recipe.kind, input: { ...params } },
          options,
          node,
          source: this.source,
          cwd: this.ctx.cwd,
          signal: this.runSignal,
          ctx: this.ctx,
          onUsage: (usage) => {
            node.usage = usage;
            this.emitProgress();
          },
          onSession: async (sessionId, sessionFile) => {
            await this.store.mutate(() => {
              if (sessionId) node.childSessionId = sessionId;
              if (sessionFile) node.childSessionFile = sessionFile;
            });
          },
        });
        await this.store.mutate(() => {
          Object.assign(node, {
            status: "completed",
            result: result.result,
            ...(result.sessionId ? { childSessionId: result.sessionId } : {}),
            ...(result.sessionFile
              ? { childSessionFile: result.sessionFile }
              : {}),
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
      if (!this.graph.some((node) => node.id === "workflow:overflow"))
        this.graph.push({
          id: "workflow:overflow",
          parentId: "workflow",
          kind: "item",
          label: "additional control-flow nodes hidden",
          status: "running",
          order: Number.MAX_SAFE_INTEGER,
        });
    } else applyWorkflowGraphEvent(this.graph, normalized);
    this.scheduleGraphProgress();
  }

  private resolveDraftGraphEvent(
    event: WorkflowGraphEvent,
  ): WorkflowGraphEvent {
    if (event.type === "status")
      return { ...event, id: this.graphAliases.get(event.id) ?? event.id };

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
    return { type: "node", node: { ...event.node, parentId } };
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
    for (const node of this.graph)
      if (node.status === "running") node.status = status;
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
      cached: 0,
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
  const { parseWorkflowSource } = await import("./source.js");
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

  function workflowSource(
    body: string,
    agents: RecipeKind[] = [],
    phases: string[] = [],
  ): string {
    return `
      import { codeReview, defineWorkflow, delegate, finder, librarian, lookAt, oracle, readSession, readWebPage } from "@bds_pi/workflow";
      export const meta = {
        name: "test",
        description: "test",
        phases: ${JSON.stringify(phases)} as const,
        agents: ${JSON.stringify(agents)} as const,
      } as const;
      export default defineWorkflow(meta, {
        async run({ agent, phase, parallel, pipeline }, args) { ${body} }
      });
    `;
  }

  async function harness(
    body: string,
    spawn: SpawnRecipe,
    limits = { maxConcurrency: 2, maxAgents: 10 },
    signal?: AbortSignal,
    agents: RecipeKind[] = [],
    phases: string[] = [],
  ) {
    const dir = await mkdtemp(join(tmpdir(), "workflow-runtime-"));
    dirs.push(dir);
    const text = workflowSource(body, agents, phases);
    const parsed = parseWorkflowSource(text);
    const source: WorkflowSource = {
      ...parsed,
      source: "inline",
      text,
      projectLocal: false,
    };
    const store = await JournalStore.create(dir, {
      workflow: {
        name: source.meta.name,
        description: source.meta.description,
        phases: source.meta.phases,
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
    const progress: WorkflowProgress[] = [];
    return {
      source,
      store,
      progress,
      runtime: new WorkflowRuntime(
        source,
        { n: 2 },
        limits,
        store,
        { cwd: dir } as ExtensionContext,
        signal,
        (update) => progress.push(update),
        spawn,
        spawnDirectRunner,
      ),
    };
  }

  const successSpawn: SpawnRecipe = async ({ recipe, node }) => ({
    result:
      Object.values(recipe.input).find(
        (value): value is string => typeof value === "string",
      ) ?? recipe.kind,
    sessionId: node.nodeId,
    sessionFile: `/tmp/${node.nodeId}.jsonl`,
    usage: { ...ZERO_USAGE },
  });

  describe("workflow runtime", () => {
    it("runs compiled recipes and records child sessions", async () => {
      const { runtime, store } = await harness(
        'return agent(finder({ query: "needle" }), { label: "search" });',
        successSpawn,
        undefined,
        undefined,
        ["finder"],
      );
      expect((await runtime.run()).value).toBe("needle");
      expect(store.journal.nodes[0]).toMatchObject({
        label: "search",
        status: "completed",
        childSessionId: expect.any(String),
      });
    });

    it("runs every specialized agent recipe through the typed broker", async () => {
      const { runtime, store } = await harness(
        `const reviewInput = { diff_description: "review", instructions: "", ignored: true };
        return parallel([
          () => agent(codeReview(reviewInput)),
          () => agent(lookAt({ path: "diagram.png", objective: "inspect", context: "demo" })),
          () => agent(readSession({ session_id: "session", goal: "extract" })),
          () => agent(readWebPage({ url: "https://example.com", prompt: "answer" })),
        ]);`,
        successSpawn,
        { maxConcurrency: 4, maxAgents: 4 },
        undefined,
        ["codeReview", "lookAt", "readSession", "readWebPage"],
      );
      expect((await runtime.run()).value).toEqual([
        "review",
        "diagram.png",
        "session",
        "https://example.com",
      ]);
      expect(store.journal.nodes.map((node) => node.recipe)).toEqual([
        "codeReview",
        "lookAt",
        "readSession",
        "readWebPage",
      ]);
    });

    it("rejects undeclared and malformed recipes", async () => {
      const undeclared = await harness(
        'const makeRecipe = finder; return (agent as any)(makeRecipe({ query: "needle" }));',
        successSpawn,
      );
      await expect(undeclared.runtime.run()).rejects.toThrow("not declared");

      const malformed = await harness(
        "return agent((finder as any)({ query: 42 })) as Promise<string>;",
        successSpawn,
        undefined,
        undefined,
        ["finder"],
      );
      await expect(malformed.runtime.run()).rejects.toThrow("must be a string");
    });

    it("preserves typed control-flow graphs from compiled workflows", async () => {
      const { runtime, progress } = await harness(
        'return phase("inspect", () => phase("challenge", async () => "done"));',
        successSpawn,
        undefined,
        undefined,
        [],
        ["inspect", "challenge", "decide"],
      );
      await runtime.run();
      const initial = progress[0]!.graph.filter(
        (node) => node.kind === "phase",
      );
      expect(initial.map((node) => node.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      const final = progress
        .at(-1)!
        .graph.filter((node) => node.kind === "phase");
      expect(final.map((node) => node.status)).toEqual([
        "completed",
        "completed",
        "pending",
      ]);
    });

    it("enforces concurrency and maxAgents without caching recipes", async () => {
      let active = 0;
      let peak = 0;
      let calls = 0;
      const spawn: SpawnRecipe = async (request) => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return successSpawn(request);
      };
      const { runtime } = await harness(
        `return parallel([
          () => agent(finder({ query: "a" })),
          () => agent(finder({ query: "a" })),
        ]);`,
        spawn,
        { maxConcurrency: 1, maxAgents: 2 },
        undefined,
        ["finder"],
      );
      expect((await runtime.run()).value).toEqual(["a", "a"]);
      expect(peak).toBe(1);
      expect(calls).toBe(2);

      const over = await harness(
        `return parallel([
          () => agent(finder({ query: "a" })),
          () => agent(finder({ query: "b" })),
        ]);`,
        spawn,
        { maxConcurrency: 1, maxAgents: 1 },
        undefined,
        ["finder"],
      );
      await expect(over.runtime.run()).rejects.toThrow("maxAgents");
    });

    it("propagates cancellation to recipe execution", async () => {
      const controller = new AbortController();
      const spawn: SpawnRecipe = ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          }),
        );
      const { runtime } = await harness(
        'return agent(finder({ query: "wait" }));',
        spawn,
        undefined,
        controller.signal,
        ["finder"],
      );
      const pending = runtime.run();
      setTimeout(() => controller.abort(), 5);
      await expect(pending).rejects.toThrow("workflow cancelled");
    });

    it("validates limits", () => {
      expect(() => normalizeLimits(17, 1)).toThrow("maxConcurrency");
      expect(() => normalizeLimits(1, 1001)).toThrow("maxAgents");
    });
  });
}
