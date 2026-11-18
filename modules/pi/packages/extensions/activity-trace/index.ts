import { randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SpawnObservation } from "../../core/pi-spawn/trace";

export const TRACE_ENTRY = "pi.activity-span.v1";
const MAX_SPANS = 2048;
const MAX_ACTIVE = 128;
type Outcome = "ok" | "error" | "cancelled" | "interrupted";
type Operation =
  | "activity"
  | "run"
  | "turn"
  | "generation"
  | "tool"
  | "compaction"
  | "ui_wait"
  | "child_session";
type Scalars = Record<string, string | number | boolean>;
type Link = { sessionId: string } | { traceId: string; spanId: string };
export interface Span {
  version: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;
  operation: Operation;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: Outcome;
  attributes: Scalars;
  references: Scalars;
  links: Link[];
}
type OpenSpan = Omit<Span, "endedAt" | "durationMs" | "outcome"> & {
  start: number;
  end?: { endedAt: string; durationMs: number; outcome: Outcome };
};

// Native references are opaque identifiers, not arbitrary strings to truncate into the journal.
function reference(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:|-]*(?:\/[0-9]+)*$/.test(value) &&
    !value.includes("..")
    ? value
    : undefined;
}
function number(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value))
    : 0;
}
const id = (bytes: number) => randomBytes(bytes).toString("hex");

/** Only completed operations enter the native journal. The transcript's parentId
 * orders entries; execution ownership lives in data.parentSpanId instead.
 */
export default function activityTrace(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let root: OpenSpan | undefined;
  let run: OpenSpan | undefined;
  let turn: OpenSpan | undefined;
  let generation: OpenSpan | undefined;
  let compaction: OpenSpan | undefined;
  let wait: OpenSpan | undefined;
  let outcome: Outcome = "ok";
  let allocated = 0;
  let dropped = 0;
  let sinkFailures = 0;
  let subscribed = false;
  const active = new Set<OpenSpan>();
  const tools = new Map<string, OpenSpan>();

  function bind(ctx: ExtensionContext) {
    const next = reference(ctx.sessionManager.getSessionId());
    if (next !== sessionId) {
      reset();
      sessionId = next;
    }
  }
  function reset() {
    active.clear();
    tools.clear();
    root = run = turn = generation = compaction = wait = undefined;
    allocated = dropped = sinkFailures = 0;
    outcome = "ok";
  }
  function open(operation: Operation, parent?: OpenSpan): OpenSpan | undefined {
    if (!sessionId) return;
    if (allocated >= MAX_SPANS || active.size >= MAX_ACTIVE) {
      dropped = number(dropped + 1);
      return;
    }
    allocated++;
    const span: OpenSpan = {
      version: 1,
      sessionId,
      traceId: parent?.traceId ?? id(16),
      spanId: id(8),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      operation,
      startedAt: new Date().toISOString(),
      start: performance.now(),
      attributes: {},
      references: {},
      links: [],
    };
    active.add(span);
    return span;
  }
  function end(span: OpenSpan | undefined, result: Outcome) {
    if (!span || span.end) return;
    span.end = {
      endedAt: new Date().toISOString(),
      durationMs: number(performance.now() - span.start),
      outcome: result,
    };
  }
  function persist(span: OpenSpan | undefined, result: Outcome = "ok") {
    if (!span || !active.delete(span)) return;
    end(span, result);
    const { start: _, end: terminal, ...data } = span;
    try {
      pi.appendEntry(TRACE_ENTRY, { ...data, ...terminal });
    } catch {
      sinkFailures = number(sinkFailures + 1);
    }
  }
  function activity(ctx: ExtensionContext) {
    bind(ctx);
    if (!root) {
      allocated = dropped = sinkFailures = 0;
      outcome = "ok";
      root = open("activity");
      const leaf = reference(ctx.sessionManager.getLeafId());
      if (root && leaf) root.references.startEntryId = leaf;
    }
  }
  function close(result: Outcome) {
    // Children complete before owners, even on shutdown. Never synthesize success.
    for (const span of [...active].reverse()) {
      if (span === root) continue;
      persist(span, result === "ok" ? "interrupted" : result);
    }
    if (root) {
      root.attributes.spansDropped = dropped;
      root.attributes.sinkFailures = sinkFailures;
      persist(root, result);
    }
    reset();
  }

  pi.on("session_start", (_event, ctx) => {
    bind(ctx);
    if (!subscribed) {
      spawnChannel.subscribe(onSpawn);
      subscribed = true;
    }
  });
  pi.on("session_shutdown", () => {
    close("interrupted");
    sessionId = undefined;
    unsubscribe();
  });
  // Navigation is normally idle. Discard stale state rather than append old work on a new branch.
  pi.on("session_tree", () => {
    reset();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    activity(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    activity(ctx);
    run = open("run", root);
  });
  pi.on("turn_start", (event, ctx) => {
    activity(ctx);
    if (!run) return;
    turn = open("turn", run);
    if (turn) {
      turn.attributes.turnIndex = number(event.turnIndex);
      generation = open("generation", turn);
      if (generation) {
        generation.attributes.scope = "turn_start_to_assistant_end";
        generation.attributes.activeTools = number(pi.getActiveTools().length);
      }
    }
  });
  pi.on("context", (event) => {
    if (generation)
      generation.attributes.contextMessages = number(event.messages.length);
  });
  pi.on("message_update", (event) => {
    if (!generation || generation.end || event.message.role !== "assistant")
      return;
    const update = event.assistantMessageEvent;
    // Normalized output is not provider first-token timing, and deltas are never journaled.
    if (
      (update.type === "text_delta" || update.type === "thinking_delta") &&
      update.delta.length > 0 &&
      generation.attributes.firstOutputMs === undefined
    ) {
      generation.attributes.firstOutputMs = number(
        performance.now() - generation.start,
      );
      generation.attributes.firstOutputKind =
        update.type === "text_delta" ? "text" : "thinking";
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !generation) return;
    const reason = event.message.stopReason;
    generation.attributes.stopReason = [
      "pending",
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
      "deferred",
    ].includes(reason)
      ? reason
      : "unknown";
    end(
      generation,
      reason === "aborted" ? "cancelled" : reason === "error" ? "error" : "ok",
    );
  });
  pi.on("tool_execution_start", (event) => {
    const call = reference(event.toolCallId);
    if (!call) {
      dropped = number(dropped + 1);
      return;
    }
    const parent = event.parentToolCallId
      ? tools.get(event.parentToolCallId)
      : turn;
    if (!parent) {
      dropped = number(dropped + 1);
      return;
    }
    const span = open("tool", parent);
    if (!span) return;
    span.references.toolCallId = call;
    if (/^[a-zA-Z0-9_.:-]{1,80}$/.test(event.toolName))
      span.attributes.toolName = event.toolName;
    if (!event.parentToolCallId && generation)
      span.links.push({
        traceId: generation.traceId,
        spanId: generation.spanId,
      });
    tools.set(event.toolCallId, span);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const span = tools.get(event.toolCallId);
    tools.delete(event.toolCallId);
    if (span && event.durationMs !== undefined)
      span.attributes.executeDurationMs = number(event.durationMs);
    persist(
      span,
      ctx.signal?.aborted ? "cancelled" : event.isError ? "error" : "ok",
    );
  });
  pi.on("turn_end", (event) => {
    const entry = reference(event.messageEntryId);
    if (generation && entry) generation.references.messageEntryId = entry;
    persist(generation, "interrupted");
    generation = undefined;
    if (turn) turn.attributes.toolResults = number(event.toolResults.length);
    persist(
      turn,
      event.outcome === "aborted"
        ? "cancelled"
        : event.outcome === "error"
          ? "error"
          : "ok",
    );
    turn = undefined;
  });
  pi.on("agent_end", (event) => {
    const last = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const result =
      last?.role === "assistant" && last.stopReason === "aborted"
        ? "cancelled"
        : last?.role === "assistant" && last.stopReason === "error"
          ? "error"
          : "ok";
    persist(run, result);
    run = undefined;
  });
  pi.on("agent_before_settle", (event) => {
    outcome =
      event.outcome === "aborted"
        ? "cancelled"
        : event.outcome === "error"
          ? "error"
          : "ok";
  });
  pi.on("agent_settled", (event) => {
    close(event.aborted ? "cancelled" : outcome);
  });
  pi.on("session_before_compact", (event, ctx) => {
    bind(ctx);
    compaction = open("compaction", root);
    if (compaction) {
      compaction.attributes.reason = event.reason;
      compaction.attributes.willRetry = event.willRetry;
      compaction.attributes.tokensBefore = number(
        event.preparation.tokensBefore,
      );
    }
  });
  pi.on("session_compact", (event) => {
    const entry = reference(event.compactionEntry.id);
    if (compaction && entry) compaction.references.compactionEntryId = entry;
    persist(compaction);
    compaction = undefined;
    if (!root) allocated = 0;
  });
  pi.on("session_compact_failed", (event) => {
    persist(compaction, event.aborted ? "cancelled" : "error");
    compaction = undefined;
    if (!root) allocated = 0;
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    bind(ctx);
    // The SDK reports one combined wait window, not prompt/tool ownership.
    wait = open("ui_wait", root);
    if (wait) wait.attributes.kind = event.kind;
  });
  pi.on("ui_prompt_end", () => {
    persist(wait);
    wait = undefined;
    if (!root) allocated = 0;
  });

  const spawnChannel = channel("bds.pi.spawn.completed.v1");
  const onSpawn = (raw: unknown) => {
    try {
      const observation = raw as SpawnObservation;
      if (observation.parentSessionId !== sessionId || !observation.toolCallId)
        return;
      const parent = tools.get(observation.toolCallId);
      if (!parent) return;
      if (
        !["ok", "error", "cancelled"].includes(observation.outcome) ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(observation.startedAt) ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(observation.endedAt)
      )
        return;
      const span = open("child_session", parent);
      if (!span) return;
      span.startedAt = observation.startedAt;
      span.end = {
        endedAt: observation.endedAt,
        durationMs: number(observation.durationMs),
        outcome: observation.outcome,
      };
      const child = reference(observation.childSessionId);
      if (child) span.links.push({ sessionId: child });
      const call = reference(observation.toolCallId);
      if (call) span.references.toolCallId = call;
      span.attributes.scope = "pi_spawn";
      persist(span);
    } catch {
      /* Observation must not change the caller's result. */
    }
  };
  const unsubscribe = () => {
    spawnChannel.unsubscribe(onSpawn);
    subscribed = false;
  };
}

if (import.meta.vitest) {
  const { it, expect, afterEach, vi } = import.meta.vitest;
  const { mkdtemp, readFile, rm, writeFile, chmod } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const sdk = await import("@earendil-works/pi-coding-agent");
  const {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
    InMemoryCredentialStore,
  } = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");
  const pause = (ms = 10) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });
  const variants = [
    "source",
    ...(process.env.PI_TEST_BUILT_TOOLS === "1" ? ["built"] : []),
  ];
  type FixtureOptions = {
    variant?: string;
    manager?: ReturnType<typeof sdk.SessionManager.create>;
    retry?: boolean;
    extra?: (pi: ExtensionAPI) => void;
  };
  async function fixture(options: FixtureOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), "pi-trace-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const manager = options.manager ?? sdk.SessionManager.create(root, root);
    const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      retry: {
        enabled: options.retry ?? false,
        maxRetries: 1,
        baseDelayMs: 10,
      },
    });
    const extensionPath =
      options.variant === "built"
        ? fileURLToPath(
            new URL(
              "../../../dist/extensions/activity-trace.js",
              import.meta.url,
            ),
          )
        : fileURLToPath(import.meta.url);
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: options.variant ? [extensionPath] : [],
      extensionFactories: [
        ...(options.variant ? [] : [activityTrace]),
        ...(options.extra ? [options.extra] : []),
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await sdk.createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model: faux.getModel(),
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
    });
    const errors: unknown[] = [];
    await session.bindExtensions({
      mode: "json",
      onError: (error) => errors.push(error),
    });
    cleanup.push(async () => {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    });
    async function journal() {
      const entries = (await readFile(manager.getSessionFile()!, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return {
        entries,
        spans: entries
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === TRACE_ENTRY,
          )
          .map((entry) => entry.data as Span),
      };
    }
    return { session, manager, runtime, faux, journal, errors, root };
  }
  function tool(
    pi: ExtensionAPI,
    name: string,
    execute: Parameters<ExtensionAPI["registerTool"]>[0]["execute"],
  ) {
    pi.registerTool({
      name,
      label: name,
      description: "trace fixture",
      parameters: Type.Object({}),
      execute,
    });
  }
  const ok = () => ({
    content: [{ type: "text" as const, text: "PRIVATE_RESULT" }],
    details: undefined,
  });

  it.each(variants)(
    "persists a causal multi-operation trace through the real %s SDK extension",
    async (variant) => {
      let firstStarted!: () => void;
      const first = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let release!: () => void;
      const second = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await fixture({
        variant,
        extra: (pi) => {
          tool(pi, "slow", async () => {
            firstStarted();
            await second;
            return ok();
          });
          tool(pi, "outer", async (_id, _args, _signal, _update, ctx) => {
            await first;
            const result = await ctx.executeTool("inner", {});
            release();
            return result.result;
          });
          tool(pi, "inner", async () => {
            await pause();
            return ok();
          });
        },
      });
      f.session.setActiveToolsByName(["slow", "outer", "inner"]);
      let requestContext = "";
      f.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("slow", {}, { id: "parallel-a" }),
            fauxToolCall("outer", {}, { id: "parallel-b" }),
          ],
          { stopReason: "toolUse" },
        ),
        (context) => {
          requestContext = JSON.stringify(context);
          return fauxAssistantMessage("PRIVATE_RESPONSE");
        },
      ]);
      await f.session.prompt("PRIVATE_PROMPT");
      const { spans, entries } = await f.journal();
      if (process.env.PI_TRACE_FIXTURE_EXAMPLE === "1")
        console.info(JSON.stringify(spans));
      expect(f.errors).toEqual([]);
      expect(spans.map((span) => span.operation).sort()).toEqual(
        [
          "activity",
          "run",
          "turn",
          "turn",
          "generation",
          "generation",
          "tool",
          "tool",
          "tool",
        ].sort(),
      );
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      for (const span of spans) {
        expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
        expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
        expect(span.durationMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(span.endedAt)).toBeGreaterThanOrEqual(
          Date.parse(span.startedAt),
        );
        if (span.parentSpanId) {
          const parent = byId.get(span.parentSpanId)!;
          expect(parent).toBeDefined();
          expect(parent.traceId).toBe(span.traceId);
          expect(Date.parse(span.startedAt)).toBeGreaterThanOrEqual(
            Date.parse(parent.startedAt),
          );
          expect(Date.parse(span.endedAt)).toBeLessThanOrEqual(
            Date.parse(parent.endedAt),
          );
        }
      }
      const a = spans.find(
        (span) => span.references.toolCallId === "parallel-a",
      )!;
      const b = spans.find(
        (span) => span.references.toolCallId === "parallel-b",
      )!;
      const nested = spans.find(
        (span) => span.references.toolCallId === "parallel-b/1",
      )!;
      expect(a.parentSpanId).toBe(b.parentSpanId);
      expect(nested.parentSpanId).toBe(b.spanId);
      expect(Date.parse(b.startedAt)).toBeLessThanOrEqual(
        Date.parse(a.endedAt),
      );
      expect(a.links).toHaveLength(1);
      expect(
        byId.get((a.links[0] as { spanId: string }).spanId)?.operation,
      ).toBe("generation");
      for (const generation of spans.filter(
        (span) => span.operation === "generation",
      )) {
        expect(
          entries.find(
            (entry) => entry.id === generation.references.messageEntryId,
          )?.message.role,
        ).toBe("assistant");
        expect(generation.attributes.scope).toBe("turn_start_to_assistant_end");
        expect(generation.attributes.contextMessages).toBeGreaterThan(0);
      }
      expect(
        spans.find((span) => span.attributes.firstOutputKind === "text")
          ?.attributes.firstOutputMs,
      ).toBeTypeOf("number");
      expect(JSON.stringify(spans)).not.toMatch(
        /PRIVATE_|errorMessage|headers|arguments|sessionFile/,
      );
      expect(requestContext).not.toContain(TRACE_ENTRY);
      expect(requestContext).not.toContain("traceId");
      expect(
        f.manager
          .buildSessionProjection()
          .messages.some(
            (message) =>
              (message as { customType?: string }).customType === TRACE_ENTRY,
          ),
      ).toBe(false);
      // Native entry order deliberately differs from execution parentage.
      expect(
        entries.some(
          (entry) =>
            entry.customType === TRACE_ENTRY &&
            entry.parentId !== entry.data.parentSpanId,
        ),
      ).toBe(true);
    },
  );

  it("marks first normalized thinking output and cancellation during tool execution", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "waits", async (_id, _args, signal) => {
          started();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return ok();
        });
      },
    });
    f.session.setActiveToolsByName(["waits"]);
    f.faux.setResponses([
      fauxAssistantMessage([
        { type: "thinking", thinking: "PRIVATE_THINKING" },
        { type: "text", text: "PRIVATE_TEXT" },
      ]),
    ]);
    await f.session.prompt("thinking fixture");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("waits", {}), {
        stopReason: "toolUse",
      }),
    ]);
    const prompt = f.session.prompt("cancel tool fixture");
    await ready;
    await f.session.abort();
    await prompt;
    const { spans } = await f.journal();
    const generation = spans.find((span) => span.operation === "generation")!;
    expect(generation.attributes.firstOutputKind).toBe("thinking");
    expect(generation.attributes.firstOutputMs).toBeLessThanOrEqual(
      generation.durationMs,
    );
    expect(spans.find((span) => span.operation === "tool")?.outcome).toBe(
      "cancelled",
    );
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_");
    expect(f.errors).toEqual([]);
  });

  it("groups automatic retry runs without persisting provider error text", async () => {
    const f = await fixture({ retry: true });
    const events: string[] = [];
    f.session.subscribe((event) => {
      events.push(event.type);
    });
    f.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "429 overloaded PRIVATE_ERROR /Users/private/secret",
      }),
      fauxAssistantMessage("recovered"),
    ]);
    await f.session.prompt("retry fixture");
    expect(events).toContain("auto_retry_start");
    const { spans } = await f.journal();
    expect(spans.filter((span) => span.operation === "activity")).toHaveLength(
      1,
    );
    expect(
      spans
        .filter((span) => span.operation === "run")
        .map((span) => span.outcome),
    ).toEqual(["error", "ok"]);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(spans.find((span) => span.operation === "activity")?.outcome).toBe(
      "ok",
    );
    expect(JSON.stringify(spans)).not.toMatch(
      /PRIVATE_ERROR|private|overloaded/,
    );
  });

  it("finishes cancelled streaming and failed tools without copying errors", async () => {
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "fails", async () => {
          throw new Error("PRIVATE_TOOL_ERROR /Users/private");
        });
      },
    });
    f.session.setActiveToolsByName(["fails"]);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fails", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("handled"),
    ]);
    await f.session.prompt("fail fixture");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.faux.setResponses([
      async (_context, options) => {
        started();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const prompt = f.session.prompt("cancel fixture");
    await ready;
    await f.session.abort();
    await prompt;
    const { spans } = await f.journal();
    expect(spans.find((span) => span.operation === "tool")?.outcome).toBe(
      "error",
    );
    expect(
      spans
        .filter((span) => span.operation === "activity")
        .map((span) => span.outcome),
    ).toEqual(["ok", "cancelled"]);
    expect(
      spans.filter((span) => span.operation === "generation").at(-1)?.outcome,
    ).toBe("cancelled");
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_TOOL_ERROR");
    expect(f.errors).toEqual([]);
  });

  it("records real manual compaction success, failure and cancellation separately", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
      fauxAssistantMessage("summary"),
      fauxAssistantMessage("prefix summary"),
    ]);
    await f.session.prompt("first");
    await f.session.prompt("second");
    await f.session.compact();
    let journal = await f.journal();
    const compact = journal.spans.find(
      (span) => span.operation === "compaction",
    )!;
    expect(compact.outcome).toBe("ok");
    expect(compact.parentSpanId).toBeUndefined();
    expect(
      journal.entries.find(
        (entry) => entry.id === compact.references.compactionEntryId,
      )?.type,
    ).toBe("compaction");
    f.faux.setResponses([
      fauxAssistantMessage("three"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "PRIVATE_COMPACTION_ERROR",
      }),
    ]);
    await f.session.prompt("third");
    await expect(f.session.compact()).rejects.toThrow();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.faux.setResponses([
      async (_context, options) => {
        started();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const cancelled = f.session.compact();
    const rejection = expect(cancelled).rejects.toThrow();
    await ready;
    f.session.abortCompaction();
    await rejection;
    journal = await f.journal();
    expect(
      journal.spans
        .filter((span) => span.operation === "compaction")
        .map((span) => span.outcome),
    ).toEqual(["ok", "error", "cancelled"]);
    expect(JSON.stringify(journal.spans)).not.toContain(
      "PRIVATE_COMPACTION_ERROR",
    );
    expect(f.errors).toEqual([]);
  });

  it("records the SDK's combined UI wait window without titles or answers", async () => {
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "asks", async (_id, _args, _signal, _update, ctx) => {
          await Promise.all([
            ctx.ui.confirm("PRIVATE_TITLE", "PRIVATE_BODY"),
            ctx.ui.confirm("PRIVATE_OTHER", "PRIVATE_BODY"),
          ]);
          return ok();
        });
      },
    });
    f.session.setActiveToolsByName(["asks"]);
    await f.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...f.session.extensionRunner.getUIContext(),
        confirm: async () => {
          await pause();
          return true;
        },
      },
    });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("asks", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("UI fixture");
    const { spans } = await f.journal();
    const waits = spans.filter((span) => span.operation === "ui_wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.attributes.kind).toBe("confirm");
    expect(
      spans.find((span) => span.spanId === waits[0]!.parentSpanId)?.operation,
    ).toBe("activity");
    expect(waits[0]!.durationMs).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_");
  });

  it("starts fresh trace ownership on resume and branch navigation", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("original")]);
    await f.session.prompt("branch fixture");
    const initial = await f.journal();
    const user = initial.entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    await f.session.navigateTree(user.id, { summarize: false });
    f.faux.setResponses([fauxAssistantMessage("new branch")]);
    await f.session.prompt("alternative");
    await f.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "resume",
    });
    f.session.dispose();
    const resumed = await fixture({
      manager: sdk.SessionManager.open(f.manager.getSessionFile()!),
    });
    resumed.faux.setResponses([fauxAssistantMessage("resumed")]);
    await resumed.session.prompt("resume fixture");
    const { spans } = await resumed.journal();
    expect(spans.filter((span) => span.operation === "activity")).toHaveLength(
      3,
    );
    expect(
      new Set(
        spans
          .filter((span) => span.operation === "activity")
          .map((span) => span.traceId),
      ).size,
    ).toBe(3);
    expect(new Set(spans.map((span) => span.sessionId))).toEqual(
      new Set([f.manager.getSessionId()]),
    );
    expect(resumed.errors).toEqual([]);
  });

  it("isolates ownership across native session replacement and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-trace-switch-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const faux = fauxProvider();
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const create: Parameters<typeof sdk.createAgentSessionRuntime>[0] = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [activityTrace],
        },
      });
      return {
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: faux.getModel(),
          tools: [],
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await sdk.createAgentSessionRuntime(create, {
      cwd: root,
      agentDir: root,
      sessionManager: sdk.SessionManager.create(root, root),
    });
    cleanup.push(() => runtime.dispose());
    runtime.setRebindSession(async (session) => {
      await session.bindExtensions({ mode: "json" });
    });
    await runtime.session.bindExtensions({ mode: "json" });
    faux.setResponses([
      fauxAssistantMessage("original"),
      fauxAssistantMessage("new"),
      fauxAssistantMessage("resumed"),
      fauxAssistantMessage("reloaded"),
    ]);
    await runtime.session.prompt("original fixture");
    const original = runtime.session.sessionFile!;
    await runtime.newSession();
    await runtime.session.prompt("new fixture");
    const replacement = runtime.session.sessionFile!;
    expect(replacement).not.toBe(original);
    await runtime.switchSession(original);
    await runtime.session.prompt("resumed fixture");
    await runtime.session.reload();
    await runtime.session.prompt("reloaded fixture");
    const readSpans = async (path: string) =>
      (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.customType === TRACE_ENTRY)
        .map((entry) => entry.data as Span);
    const a = await readSpans(original);
    const b = await readSpans(replacement);
    expect(a.filter((span) => span.operation === "activity")).toHaveLength(3);
    expect(b.filter((span) => span.operation === "activity")).toHaveLength(1);
    expect(new Set(a.map((span) => span.sessionId)).size).toBe(1);
    expect(new Set(b.map((span) => span.sessionId)).size).toBe(1);
    expect(a[0]!.sessionId).not.toBe(b[0]!.sessionId);
    expect(
      new Set(
        [...a, ...b]
          .filter((span) => span.operation === "activity")
          .map((span) => span.traceId),
      ).size,
    ).toBe(4);
  });

  it("links real piSpawn child work by its existing owner and child session identities", async () => {
    const { piSpawn } = await import("../../core/pi-spawn/index");
    let executable = "";
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "child", async (toolCallId, _args, signal, _update, ctx) => {
          const result = await piSpawn({
            cwd: ctx.cwd,
            task: "PRIVATE_CHILD_PROMPT",
            signal,
            owner: { sessionId: ctx.sessionManager.getSessionId(), toolCallId },
            session: { parentSession: ctx.sessionManager.getSessionFile() },
            env: {
              PI_BIN: executable,
              PI_CODING_AGENT_SESSION_DIR: join(ctx.cwd, "children"),
            },
          });
          expect(result.exitCode, result.stderr).toBe(0);
          expect(result.session?.sessionId).toBeDefined();
          return ok();
        });
      },
    });
    executable = join(f.root, "child.ts");
    const sdkUrl = pathToFileURL(
      join(sdk.getPackageDir(), "dist/index.js"),
    ).href;
    const aiUrl = pathToFileURL(
      fileURLToPath(
        new URL(
          "../../../node_modules/@earendil-works/pi-ai/dist/index.js",
          import.meta.url,
        ),
      ),
    ).href;
    await writeFile(
      executable,
      `#!${process.execPath} --experimental-strip-types
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from ${JSON.stringify(sdkUrl)};
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from ${JSON.stringify(aiUrl)};
const manager = SessionManager.open(process.argv[process.argv.indexOf("--session") + 1]!);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider(); modelRuntime.registerNativeProvider(faux.provider);
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), modelRuntime,
  model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: manager, tools: [] });
await session.bindExtensions({ mode: "json" });
session.subscribe(event => process.stdout.write(JSON.stringify(event) + "\\n"));
faux.setResponses([fauxAssistantMessage("PRIVATE_CHILD_RESPONSE")]);
await session.prompt("PRIVATE_CHILD_PROMPT");
session.dispose();
`,
    );
    await chmod(executable, 0o700);
    f.session.setActiveToolsByName(["child"]);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("child", {}, { id: "child-owner" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("child fixture");
    const { spans } = await f.journal();
    const spawn = spans.find((span) => span.operation === "child_session")!;
    expect(spawn).toBeDefined();
    expect(
      spans.find((span) => span.spanId === spawn.parentSpanId)?.references
        .toolCallId,
    ).toBe("child-owner");
    expect(spawn.links).toHaveLength(1);
    expect(spawn.links[0]).toHaveProperty("sessionId");
    expect(spawn.outcome).toBe("ok");
    expect(JSON.stringify(spans)).not.toMatch(
      /PRIVATE_|sessionFile|stderr|messages/,
    );
    expect(f.errors).toEqual([]);
  });

  it("closes unfinished work as interrupted on shutdown and tolerates repeated cleanup", async () => {
    const f = await fixture();
    // Flush the native initial journal before interrupting a later generation.
    f.faux.setResponses([fauxAssistantMessage("initial")]);
    await f.session.prompt("initial fixture");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.faux.setResponses([
      async (_context, options) => {
        started();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    const prompt = f.session.prompt("shutdown fixture");
    await ready;
    await f.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    const before = await f.journal();
    await f.session.abort();
    await prompt;
    await f.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    const after = await f.journal();
    expect(after.spans).toEqual(before.spans);
    const interrupted = after.spans.filter(
      (span) => span.traceId === after.spans.at(-1)!.traceId,
    );
    expect(interrupted.map((span) => span.operation).sort()).toEqual(
      ["activity", "run", "turn", "generation"].sort(),
    );
    expect(interrupted.every((span) => span.outcome === "interrupted")).toBe(
      true,
    );
    expect(f.errors).toEqual([]);
  });

  it.each(
    variants.flatMap((variant) =>
      [false, true].map((partial) => ({ variant, partial })),
    ),
  )(
    "contains native append failures ($variant, partial=$partial) without breaking resumed history",
    async ({ variant, partial }) => {
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const f = await fixture({ variant });
      f.faux.setResponses([fauxAssistantMessage("initial")]);
      await f.session.prompt("initial fixture");
      const original = fs.appendFileSync;
      let failed = false;
      const spy = vi
        .spyOn(fs, "appendFileSync")
        .mockImplementation((...args) => {
          if (!failed && String(args[1]).includes(TRACE_ENTRY)) {
            failed = true;
            if (partial) original(args[0], String(args[1]).slice(0, 27));
            throw new Error("PRIVATE_SINK_ERROR");
          }
          return original(...args);
        });
      syncBuiltinESMExports();
      try {
        f.faux.setResponses([fauxAssistantMessage("still works")]);
        await f.session.prompt("failure fixture");
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }
      expect(failed).toBe(true);
      const { spans } = await f.journal();
      expect(f.session.getLastAssistantText()).toBe("still works");
      expect(
        spans.filter((span) => span.operation === "activity").at(-1)?.attributes
          .sinkFailures,
      ).toBe(1);
      expect(JSON.stringify(spans)).not.toContain("PRIVATE_SINK_ERROR");
      const reopened = sdk.SessionManager.open(f.manager.getSessionFile()!);
      expect(reopened.buildSessionProjection().messages).toEqual(
        f.manager.buildSessionProjection().messages,
      );
      expect(
        reopened
          .buildSessionProjection()
          .messages.filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          ),
      ).toHaveLength(4);
      const persistedIds = new Set(
        reopened.getEntries().map((entry) => entry.id),
      );
      expect(
        reopened
          .getEntries()
          .every(
            (entry) =>
              entry.parentId === null || persistedIds.has(entry.parentId),
          ),
      ).toBe(true);
      expect(f.errors).toEqual([]);
    },
  );

  it("bounds simultaneously active nested spans without inventing parents for dropped work", async () => {
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "inner", async () => {
          await pause();
          return ok();
        });
        tool(pi, "fanout", async (_id, _args, _signal, _update, ctx) => {
          await Promise.all(
            Array.from({ length: MAX_ACTIVE + 20 }, () =>
              ctx.executeTool("inner", {}),
            ),
          );
          return ok();
        });
      },
    });
    f.session.setActiveToolsByName(["fanout", "inner"]);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fanout", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("fanout fixture");
    const { spans } = await f.journal();
    expect(
      spans.filter((span) => span.operation === "tool").length,
    ).toBeLessThanOrEqual(MAX_ACTIVE);
    expect(
      spans.find((span) => span.operation === "activity")?.attributes
        .spansDropped,
    ).toBeGreaterThan(0);
    for (const span of spans)
      if (span.parentSpanId)
        expect(
          spans.some((parent) => parent.spanId === span.parentSpanId),
        ).toBe(true);
    expect(f.session.getLastAssistantText()).toBe("done");
  });

  it("bounds nested-call aggregation and never emits per-token entries", async () => {
    const f = await fixture({
      extra: (pi) => {
        tool(pi, "inner", async () => ok());
        tool(pi, "many", async (_id, _args, _signal, _update, ctx) => {
          for (let n = 0; n < MAX_SPANS + 10; n++)
            await ctx.executeTool("inner", {});
          return ok();
        });
      },
    });
    f.session.setActiveToolsByName(["many", "inner"]);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("many", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("x".repeat(5000)),
    ]);
    await f.session.prompt("bounded fixture");
    const { spans } = await f.journal();
    expect(spans.length).toBeLessThanOrEqual(MAX_SPANS);
    const activity = spans.find((span) => span.operation === "activity")!;
    expect(activity.attributes.spansDropped).toBeGreaterThan(0);
    expect(activity.attributes.sinkFailures).toBe(0);
    expect(
      spans.filter((span) => span.operation === "generation").length,
    ).toBeLessThanOrEqual(2);
    expect(spans.every((span) => JSON.stringify(span).length < 2500)).toBe(
      true,
    );
    expect(f.session.getLastAssistantText()).toBe("x".repeat(5000));
    expect(f.errors).toEqual([]);
  });
}
