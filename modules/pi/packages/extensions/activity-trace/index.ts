import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { channel } from "node:diagnostics_channel";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
  type TelemetryCarrier,
  type SchemaTelemetrySpan,
  type TelemetrySchemaSpanEndAttributes,
  type StoredSpan,
} from "@earendil-works/pi-telemetry";
import {
  diagnosticId,
  parseSpawnTrace,
  SPAWN_TRACE_ENV,
  SPAWN_TRACE_CHANNEL,
  type SpawnTraceRequest,
  type InheritedActivity,
} from "../../core/pi-spawn/trace";
import { JournalTelemetry, MAX_ACTIVE, MAX_SPANS } from "./journal";
const text = (description: string) =>
  ({ type: "string", description }) as const;
const count = (description: string) =>
  ({ type: "number", description }) as const;
const common = {
  workflowName: text("Runtime workflow; never inferred from prompt prose"),
  workflowId: text(
    "Inherited workflow identity or fresh local activity identity",
  ),
  businessContext: text(
    "Unavailable: no issue or task metadata is supplied by the lifecycle",
  ),
  sessionId: text("Native session executing the operation"),
  activityId: text("Local activity identity"),
  runId: text("Local low-level run identity, or unavailable"),
  turnId: text("Local turn identity, or unavailable"),
  turnIndex: count("SDK turn index; -1 when unavailable"),
  nodeId: text("SHA-256 hostname pseudonym of this local execution node"),
  nodeKind: text(
    "Local process, not an assertion about downstream remote work",
  ),
  processId: count("Executing process ID"),
  platform: text("Executing OS"),
  architecture: text("Executing CPU architecture"),
  selectedProvider: text("Selected catalog provider, possibly virtual"),
  selectedModel: text("Selected catalog model, possibly virtual"),
  selectionProvenance: text("extension_context.model"),
  observedProvider: text(
    "Provider named by a completed assistant message, or unavailable",
  ),
  observedModel: text(
    "Model named by a completed assistant message, or unavailable",
  ),
  observationProvenance: text(
    "assistant_message_end or unavailable; not a transport assertion",
  ),
  observationScope: text("Current turn or latest assistant in this activity"),
  parentSessionId: text("Inherited diagnostic caller session"),
  parentActivityId: text("Inherited diagnostic caller activity"),
  parentRunId: text("Inherited diagnostic caller run"),
  parentTurnId: text("Inherited diagnostic caller turn"),
  parentStep: text("Inherited caller operation step"),
  parentToolName: text("Inherited caller tool identity"),
  parentSelectedProvider: text("Caller catalog selection"),
  parentSelectedModel: text("Caller catalog selection"),
  parentObservedProvider: text("Caller completed assistant provider"),
  parentObservedModel: text("Caller completed assistant model"),
};
const ACTIVITY_SCHEMA = defineTelemetrySchema({
  version: 2,
  spans: {
    "pi.activity.operation": {
      description:
        "A completed native lifecycle operation, with self-contained diagnostic context",
      parents: { kind: "any" },
      startAttributes: {
        operation: {
          ...text("Observable lifecycle boundary"),
          required: true,
          values: [
            "activity",
            "run",
            "turn",
            "generation",
            "tool",
            "compaction",
            "ui_wait",
          ],
        },
        step: {
          ...text(
            "Meaningful runtime operation, including tool identity where known",
          ),
          required: true,
        },
      },
      endAttributes: {
        ...common,
        outcome: {
          ...text("Safe terminal category"),
          values: ["ok", "error", "cancelled", "interrupted"],
        },
        failureCategory: {
          ...text("No error-message parsing or invented cause"),
          values: [
            "none",
            "tool_error",
            "not_executed",
            "model_error",
            "compaction_error",
            "cancelled",
            "interrupted",
          ],
        },
        toolName: text("Bounded tool identifier"),
        toolCallId: text("Native tool invocation identity"),
        parentToolCallId: text("Native nested invocation owner"),
        childSessionId: text(
          "Native child session targeted by this observed piSpawn owner",
        ),
        invocationKind: {
          ...text("Native execution origin"),
          values: ["assistant", "nested_tool"],
        },
        inputKind: text("Shallow input kind only; no field names or values"),
        inputLength: count(
          "String code units or array length when already available",
        ),
        outputKind: text("Shallow result kind only"),
        outputBlocks: count("Number of native content blocks"),
        outputInspectedBlocks: count("Number inspected, capped at 16"),
        outputTextUnits: count(
          "Code units in inspected text blocks, not encoded bytes",
        ),
        outputImageBlocks: count(
          "Image count among inspected blocks; no image data inspected",
        ),
        executeDurationMs: count(
          "SDK execute timing; absent if execution never ran",
        ),
        durationMs: count("Monotonic operation duration"),
        startEntryId: text("Native leaf at activity start"),
        messageEntryId: text("Native assistant entry"),
        compactionEntryId: text("Native compaction entry"),
        scope: text("Observable timing scope"),
        activeTools: count("Active tool count"),
        contextMessages: count(
          "Context message count, without inspecting bodies",
        ),
        firstOutputMs: count(
          "First normalized output delay, not provider first token latency",
        ),
        firstOutputKind: {
          ...text("First normalized output kind"),
          values: ["text", "thinking"],
        },
        stopReason: text("SDK stop reason"),
        toolResults: count("Turn tool-result count"),
        reason: text("SDK compaction reason"),
        willRetry: {
          type: "boolean",
          description: "SDK compaction retry decision",
        },
        tokensBefore: count("SDK pre-compaction token estimate"),
        kind: text("SDK combined UI wait kind"),
        spansDropped: count("Admission losses for this activity"),
        sinkFailures: count(
          "Failed native appends in this activity before root completion",
        ),
      },
      status: {
        default: "ok",
        errorWhen:
          "error, cancellation, or interruption; outcome preserves the distinction",
      },
    },
  },
} as const);

export const TRACE_ENTRY = "pi.activity-span.v2";
type EndAttributes = TelemetrySchemaSpanEndAttributes<
  typeof ACTIVITY_SCHEMA,
  "pi.activity.operation"
>;
type Attributes = {
  -readonly [Key in keyof EndAttributes]: EndAttributes[Key];
};
type Operation =
  | "activity"
  | "run"
  | "turn"
  | "generation"
  | "tool"
  | "compaction"
  | "ui_wait";
type Outcome = "ok" | "error" | "cancelled" | "interrupted";
type OpenOperation = {
  handle: SchemaTelemetrySpan<typeof ACTIVITY_SCHEMA, "pi.activity.operation">;
  attributes: Attributes;
  done: Promise<void>;
  finish: () => void;
  start: number;
  ended?: boolean;
};
const number = (value: number) =>
  Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value))
    : 0;
const identifier = (value: unknown) => diagnosticId(value) ?? "unavailable";
const nodeId = createHash("sha256")
  .update(hostname())
  .digest("hex")
  .slice(0, 16);

/** No enumeration, serialization, field names or recursion on arbitrary tool input. */
function inputShape(
  value: unknown,
): Pick<Attributes, "inputKind" | "inputLength"> {
  return value === null
    ? { inputKind: "null" }
    : Array.isArray(value)
      ? { inputKind: "array", inputLength: number(value.length) }
      : typeof value === "string"
        ? { inputKind: "string", inputLength: number(value.length) }
        : { inputKind: typeof value };
}
function outputShape(
  value: unknown,
): Pick<
  Attributes,
  | "outputKind"
  | "outputBlocks"
  | "outputInspectedBlocks"
  | "outputTextUnits"
  | "outputImageBlocks"
> {
  if (!value || typeof value !== "object") return { outputKind: typeof value };
  // Only the SDK's content envelope is inspected, never details/structuredContent.
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return { outputKind: "object" };
  let text = 0,
    images = 0;
  const inspected = Math.min(16, content.length);
  for (let i = 0; i < inspected; i++) {
    const block = content[i];
    if (block?.type === "text" && typeof block.text === "string")
      text += block.text.length;
    if (block?.type === "image") images++;
  }
  return {
    outputKind: "content_blocks",
    outputBlocks: number(content.length),
    outputInspectedBlocks: inspected,
    outputTextUnits: number(text),
    outputImageBlocks: images,
  };
}

/** Native JSONL orders entries; StoredSpan.parentId describes execution ownership. */
export default function activityTrace(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let recorder = newRecorder();
  let root: OpenOperation | undefined,
    run: OpenOperation | undefined,
    turn: OpenOperation | undefined;
  let generation: OpenOperation | undefined,
    compaction: OpenOperation | undefined,
    wait: OpenOperation | undefined;
  let outcome: Outcome = "ok";
  let activityId = "unavailable",
    runId = "unavailable",
    turnId = "unavailable",
    turnIndex = -1;
  let selection: Attributes = {};
  let observed: Attributes = {};
  let inherited: InheritedActivity = {};
  let remote: TelemetryCarrier | undefined;
  let firstChildActivity = true;
  let subscribed = false;
  const active = new Set<OpenOperation>();
  const tools = new Map<string, OpenOperation>();
  function newRecorder() {
    return new JournalTelemetry((span) => {
      // This is the sole persisted shape: no arbitrary exception strings.
      pi.appendEntry(TRACE_ENTRY, {
        ...span,
        status: { status: span.status.status },
      } satisfies StoredSpan);
    });
  }
  function bind(ctx: ExtensionContext) {
    const next = diagnosticId(ctx.sessionManager.getSessionId());
    if (next !== sessionId) {
      reset();
      inherited = {};
      remote = undefined;
      sessionId = next;
    }
    selection = {
      selectedProvider: identifier(ctx.model?.provider),
      selectedModel: identifier(ctx.model?.id),
      selectionProvenance: "extension_context.model",
    };
  }
  function reset() {
    active.clear();
    tools.clear();
    root = run = turn = generation = compaction = wait = undefined;
    recorder = newRecorder();
    activityId = runId = turnId = "unavailable";
    turnIndex = -1;
    observed = {};
    outcome = "ok";
  }
  function common(): Attributes {
    return {
      workflowName: "pi agent activity",
      workflowId: inherited.workflowId ?? activityId,
      businessContext: "unavailable",
      ...inherited,
      sessionId,
      activityId,
      runId,
      turnId,
      turnIndex,
      nodeId,
      nodeKind: "local_process",
      processId: process.pid,
      platform: process.platform,
      architecture: process.arch,
      ...selection,
      observedProvider: "unavailable",
      observedModel: "unavailable",
      observationProvenance: "unavailable",
      observationScope: "current_turn",
      ...observed,
    };
  }
  function open(
    operation: Operation,
    parent?: OpenOperation,
    step: string = operation,
  ): OpenOperation | undefined {
    if (!sessionId) return;
    let handle: OpenOperation["handle"] | undefined;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const context =
      parent?.handle ??
      (operation === "activity" && firstChildActivity && remote
        ? recorder.propagation.extract(remote)
        : undefined) ??
      recorder;
    const starter = createTypedSpanStarter(context, [ACTIVITY_SCHEMA]);
    const done = starter(
      "pi.activity.operation",
      { operation, step },
      (span) => {
        // Inert spans do not have a carrier. Admission limits never change tool behavior.
        if (recorder.propagation.inject(span)) handle = span;
        return handle ? gate : undefined;
      },
    );
    if (!handle) return;
    if (operation === "activity" && remote && !firstChildActivity)
      handle.addLink({ context: recorder.propagation.extract(remote) });
    const item = {
      handle,
      attributes: common(),
      done,
      finish,
      start: performance.now(),
    };
    active.add(item);
    return item;
  }
  function end(span: OpenOperation | undefined, result: Outcome) {
    if (!span || span.ended) return;
    span.ended = true;
    span.attributes.durationMs = number(performance.now() - span.start);
    span.attributes.outcome = result;
    span.attributes.failureCategory ??=
      result === "ok"
        ? "none"
        : result === "cancelled"
          ? "cancelled"
          : result === "interrupted"
            ? "interrupted"
            : "model_error";
    span.handle.setAttributes(span.attributes);
    if (result !== "ok") span.handle.setStatus({ status: "error" });
    span.finish();
  }
  async function persist(
    span: OpenOperation | undefined,
    result: Outcome = "ok",
  ) {
    if (!span || !active.delete(span)) return;
    if (!span.ended && (span === root || span === run)) {
      Object.assign(span.attributes, observed, {
        observationScope: "latest_assistant_in_activity",
      });
    }
    end(span, result);
    await span.done;
  }
  function activity(ctx: ExtensionContext) {
    bind(ctx);
    if (!root) {
      recorder = newRecorder();
      outcome = "ok";
      activityId = randomUUID();
      root = open("activity", undefined, "respond to agent input");
      const leaf = diagnosticId(ctx.sessionManager.getLeafId());
      if (root && leaf) root.attributes.startEntryId = leaf;
    }
  }
  async function close(result: Outcome) {
    for (const span of [...active].reverse()) {
      if (span !== root)
        await persist(span, result === "ok" ? "interrupted" : result);
    }
    if (root) {
      root.attributes.spansDropped = recorder.dropped;
      root.attributes.sinkFailures = recorder.sinkFailures;
      await persist(root, result);
      firstChildActivity = false;
    }
    reset();
  }

  const spawnChannel = channel(SPAWN_TRACE_CHANNEL);
  const onSpawn = (raw: unknown) => {
    const request = raw as SpawnTraceRequest;
    if (request.parentSessionId !== sessionId) return;
    const owner = tools.get(request.toolCallId);
    if (!owner || owner.ended) return;
    const carrier = recorder.propagation.inject(owner.handle);
    if (!carrier) return;
    owner.attributes.childSessionId = identifier(request.childSessionId);
    const a = owner.attributes;
    const inherited: InheritedActivity = {
      workflowName: "pi agent activity",
      workflowId: a.workflowId,
      businessContext: "unavailable",
      parentSessionId: sessionId,
      parentActivityId: a.activityId,
      parentRunId: a.runId,
      parentTurnId: a.turnId,
      parentStep: "execute_tool",
      parentToolName: a.toolName,
      parentSelectedProvider: a.selectedProvider,
      parentSelectedModel: a.selectedModel,
      parentObservedProvider: a.observedProvider,
      parentObservedModel: a.observedModel,
    };
    request.bootstrap = JSON.stringify({
      version: 1,
      targetSessionId: request.childSessionId,
      carrier,
      inherited,
    });
  };
  pi.on("session_start", (event, ctx) => {
    bind(ctx);
    const bootstrap = parseSpawnTrace(process.env[SPAWN_TRACE_ENV]);
    if (
      (event.reason === "startup" || event.reason === "reload") &&
      bootstrap &&
      bootstrap.targetSessionId === sessionId
    ) {
      inherited = bootstrap.inherited;
      remote = bootstrap.carrier;
      firstChildActivity = event.reason === "startup";
    }
    if (!subscribed) {
      spawnChannel.subscribe(onSpawn);
      subscribed = true;
    }
  });
  pi.on("session_shutdown", async () => {
    await close("interrupted");
    sessionId = undefined;
    spawnChannel.unsubscribe(onSpawn);
    subscribed = false;
  });
  pi.on("session_tree", () => {
    reset();
    firstChildActivity = false;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    activity(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    activity(ctx);
    runId = randomUUID();
    run = open("run", root, "run agent loop");
  });
  pi.on("turn_start", (event, ctx) => {
    activity(ctx);
    observed = {};
    turnIndex = number(event.turnIndex);
    turnId = randomUUID();
    if (!run) return;
    turn = open("turn", run, "generate response and execute tools");
    if (turn) {
      generation = open("generation", turn, "generate assistant response");
      if (generation)
        Object.assign(generation.attributes, {
          scope: "turn_start_to_assistant_end",
          activeTools: number(pi.getActiveTools().length),
        });
    }
  });
  pi.on("context", (event) => {
    if (generation)
      generation.attributes.contextMessages = number(event.messages.length);
  });
  pi.on("message_update", (event) => {
    if (!generation || generation.ended || event.message.role !== "assistant")
      return;
    const update = event.assistantMessageEvent;
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
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    observed = {
      observedProvider: identifier(event.message.provider),
      observedModel: identifier(event.message.model),
      observationProvenance: "assistant_message_end",
      observationScope: "current_turn",
    };
    if (!generation) return;
    Object.assign(generation.attributes, observed);
    const reason = event.message.stopReason;
    generation.attributes.stopReason = reason;
    if (reason === "error")
      generation.attributes.failureCategory = "model_error";
    await persist(
      generation,
      reason === "aborted" ? "cancelled" : reason === "error" ? "error" : "ok",
    );
  });
  pi.on("tool_execution_start", (event, ctx) => {
    bind(ctx);
    const call = diagnosticId(event.toolCallId);
    const parent = event.parentToolCallId
      ? tools.get(event.parentToolCallId)
      : turn;
    if (!call || !parent) return;
    const name = identifier(event.toolName);
    const span = open("tool", parent, `execute tool ${name}`);
    if (!span) return;
    Object.assign(span.attributes, {
      toolCallId: call,
      toolName: name,
      invocationKind: event.parentToolCallId ? "nested_tool" : "assistant",
      ...(event.parentToolCallId
        ? { parentToolCallId: identifier(event.parentToolCallId) }
        : {}),
      ...inputShape(event.args),
    });
    if (!event.parentToolCallId && generation)
      span.handle.addLink({ context: generation.handle });
    tools.set(event.toolCallId, span);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    const span = tools.get(event.toolCallId);
    tools.delete(event.toolCallId);
    if (!span) return;
    Object.assign(span.attributes, outputShape(event.result));
    if (event.durationMs !== undefined)
      span.attributes.executeDurationMs = number(event.durationMs);
    const result = ctx.signal?.aborted
      ? "cancelled"
      : event.isError
        ? "error"
        : "ok";
    span.attributes.failureCategory =
      result === "cancelled"
        ? "cancelled"
        : result === "ok"
          ? "none"
          : event.durationMs === undefined
            ? "not_executed"
            : "tool_error";
    await persist(span, result);
  });
  pi.on("turn_end", async (event) => {
    const entry = diagnosticId(event.messageEntryId);
    if (turn && entry) turn.attributes.messageEntryId = entry;
    await persist(generation, generation?.attributes.outcome ?? "interrupted");
    generation = undefined;
    if (turn) {
      Object.assign(turn.attributes, observed);
      turn.attributes.toolResults = number(event.toolResults.length);
    }
    await persist(
      turn,
      event.outcome === "aborted"
        ? "cancelled"
        : event.outcome === "error"
          ? "error"
          : "ok",
    );
    turn = undefined;
  });
  pi.on("agent_end", async (event) => {
    const last = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    await persist(
      run,
      last?.role === "assistant" && last.stopReason === "aborted"
        ? "cancelled"
        : last?.role === "assistant" && last.stopReason === "error"
          ? "error"
          : "ok",
    );
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
  pi.on("agent_settled", async (event) => {
    await close(event.aborted ? "cancelled" : outcome);
  });
  pi.on("session_before_compact", (event, ctx) => {
    bind(ctx);
    compaction = open("compaction", root, "compact conversation context");
    if (compaction)
      Object.assign(compaction.attributes, {
        reason: event.reason,
        willRetry: event.willRetry,
        tokensBefore: number(event.preparation.tokensBefore),
      });
  });
  pi.on("session_compact", async (event) => {
    const completed = compaction;
    compaction = undefined;
    const entry = diagnosticId(event.compactionEntry.id);
    if (completed && entry) completed.attributes.compactionEntryId = entry;
    await persist(completed);
    if (!root && active.size === 0) reset();
  });
  pi.on("session_compact_failed", async (event) => {
    const completed = compaction;
    compaction = undefined;
    if (completed)
      completed.attributes.failureCategory = event.aborted
        ? "cancelled"
        : "compaction_error";
    await persist(completed, event.aborted ? "cancelled" : "error");
    if (!root && active.size === 0) reset();
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    bind(ctx);
    wait = open("ui_wait", root, "wait for extension UI");
    if (wait) wait.attributes.kind = event.kind;
  });
  pi.on("ui_prompt_end", async () => {
    const completed = wait;
    wait = undefined;
    await persist(completed);
    if (!root && active.size === 0) reset();
  });
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
    vi.unstubAllEnvs();
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
    codemode?: boolean;
    mcp?: boolean;
    extra?: (pi: ExtensionAPI) => void;
  };
  function project(span: StoredSpan) {
    return {
      ...span,
      spanId: span.id,
      parentSpanId: span.parentId,
      sessionId: span.attributes.sessionId,
      operation: span.attributes.operation,
      startedAt: new Date(span.startedMs).toISOString(),
      endedAt: new Date(span.endedMs).toISOString(),
      durationMs: span.endedMs - span.startedMs,
      outcome: span.attributes.outcome,
      references: span.attributes,
    };
  }
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
        ...(options.codemode ? [sdk.createCodemodeExtension()] : []),
        ...(options.mcp ? [sdk.createMcpExtension()] : []),
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
          .map((entry) => project(entry.data as StoredSpan)),
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
        expect(span.traceId).toMatch(/^[a-f0-9-]+:\d+$/);
        expect(span.spanId).toMatch(/^[a-f0-9-]+:\d+$/);
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

  it.each(variants)(
    "automatically observes new %s tools directly, through codemode, and builtins with self-contained completions",
    async (variant) => {
      const f = await fixture({
        variant,
        codemode: true,
        extra: (pi) => {
          pi.on("session_start", () => {
            pi.registerTool({
              name: "unknown_probe",
              label: "fixture",
              description: "newly registered fixture",
              parameters: Type.Object({
                secret: Type.String(),
                items: Type.Array(Type.Number()),
              }),
              async execute() {
                return {
                  content: [
                    { type: "text", text: "PRIVATE_RESULT" },
                    {
                      type: "image",
                      data: "PRIVATE_BASE64",
                      mimeType: "image/png",
                    },
                  ],
                  details: {
                    credential: "PRIVATE_TOKEN",
                    path: "/private/secret",
                  },
                  structuredContent: { secret: "PRIVATE_STRUCTURED" },
                };
              },
            });
          });
        },
      });
      await f.runtime.setRuntimeApiKey(
        f.faux.getModel().provider,
        "fixture-only",
      );
      f.runtime.registerVirtualModel({
        provider: "fixture-router",
        id: "auto",
        name: "fixture router",
        route: () => ({ model: f.faux.getModel(), thinkingLevel: "off" }),
      });
      await f.session.setModel(f.runtime.getModel("fixture-router", "auto")!);
      await writeFile(join(f.root, "private.txt"), "PRIVATE_FILE");
      f.session.setActiveToolsByName(["unknown_probe", "codemode", "read"]);
      let modelContext = "";
      f.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall(
              "unknown_probe",
              { secret: "PRIVATE_INPUT", items: [1, 2] },
              { id: "direct-unknown" },
            ),
            fauxToolCall(
              "codemode",
              {
                code: 'const result = await tools.unknown_probe({ secret: "PRIVATE_NESTED", items: [3] }); text("PRIVATE_CODE_OUTPUT");',
              },
              { id: "code-owner" },
            ),
            fauxToolCall(
              "read",
              { path: join(f.root, "private.txt") },
              { id: "builtin-read" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        (context) => {
          modelContext = JSON.stringify(context);
          return fauxAssistantMessage("done");
        },
      ]);
      await f.session.prompt(
        "PRIVATE_PROMPT issue #999 must not become telemetry metadata",
      );
      const { entries } = await f.journal();
      const stored: StoredSpan[] = entries
        .filter((entry) => entry.customType === TRACE_ENTRY)
        .map((entry) => entry.data);
      const direct = stored.find(
        (span) => span.attributes.toolCallId === "direct-unknown",
      )!;
      const nested = stored.find(
        (span) => span.attributes.toolCallId === "code-owner/1",
      )!;
      const outer = stored.find(
        (span) => span.attributes.toolCallId === "code-owner",
      )!;
      expect(nested).toBeDefined();
      expect(nested.parentId).toBe(outer.id);
      expect(
        stored.find((span) => span.attributes.toolCallId === "builtin-read")
          ?.attributes.outcome,
      ).toBe("ok");
      for (const span of [direct, nested]) {
        expect(span.attributes).toMatchObject({
          operation: "tool",
          step: "execute tool unknown_probe",
          workflowName: "pi agent activity",
          businessContext: "unavailable",
          sessionId: f.manager.getSessionId(),
          nodeKind: "local_process",
          processId: process.pid,
          platform: process.platform,
          architecture: process.arch,
          selectedProvider: "fixture-router",
          selectedModel: "auto",
          selectionProvenance: "extension_context.model",
          observedProvider: f.faux.getModel().provider,
          observedModel: f.faux.getModel().id,
          observationProvenance: "assistant_message_end",
          toolName: "unknown_probe",
          inputKind: "object",
          outputKind: "content_blocks",
          outputBlocks: 2,
          outputInspectedBlocks: 2,
          outputTextUnits: 14,
          outputImageBlocks: 1,
          outcome: "ok",
          failureCategory: "none",
        });
        for (const field of [
          "workflowId",
          "activityId",
          "runId",
          "turnId",
          "nodeId",
        ])
          expect(span.attributes[field]).toBeTypeOf("string");
        expect(span.attributes.turnIndex).toBe(0);
        expect(span.attributes.durationMs).toBeGreaterThanOrEqual(0);
        expect(span.attributes.executeDurationMs).toBeGreaterThanOrEqual(0);
        expect(span.endedMs).toBeGreaterThanOrEqual(span.startedMs);
        expect(span.status).toEqual({ status: "ok" });
      }
      expect(direct.attributes.invocationKind).toBe("assistant");
      expect(nested.attributes.invocationKind).toBe("nested_tool");
      expect(nested.attributes.parentToolCallId).toBe("code-owner");
      expect(JSON.stringify(stored)).not.toMatch(
        /PRIVATE_|issue #999|secret|credential|\/private\//,
      );
      expect(modelContext).not.toContain(TRACE_ENTRY);
      const { renderTrace } =
        await import("@earendil-works/pi-telemetry/render");
      expect(renderTrace(stored)).toContain("unknown_probe");
      if (process.env.PI_TRACE_FIXTURE_EXAMPLE === "1")
        console.info("PERSISTED_COMPLETION " + JSON.stringify(direct));
      expect(f.errors).toEqual([]);
    },
  );

  it.each(variants)(
    "records finalized %s blocked, invalid and unknown calls without inspecting error bodies",
    async (variant) => {
      const f = await fixture({
        variant,
        extra: (pi) => {
          tool(pi, "blocked", async () => ok());
          pi.on("tool_call", (event) =>
            event.toolName === "blocked"
              ? { block: true, reason: "PRIVATE_DENIAL" }
              : undefined,
          );
        },
      });
      f.session.setActiveToolsByName(["blocked", "read"]);
      f.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("blocked", {}, { id: "blocked-call" }),
            fauxToolCall("read", {}, { id: "invalid-call" }),
            fauxToolCall("never_registered", {}, { id: "missing-call" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await f.session.prompt("failure categories");
      const { spans } = await f.journal();
      const tools = spans.filter((span) => span.operation === "tool");
      expect(tools).toHaveLength(3);
      expect(
        tools
          .map((span) => [
            span.attributes.toolCallId,
            span.attributes.failureCategory,
            span.outcome,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["blocked-call", "not_executed", "error"],
        ["invalid-call", "not_executed", "error"],
        ["missing-call", "not_executed", "error"],
      ]);
      expect(JSON.stringify(tools)).not.toContain("PRIVATE_DENIAL");
      expect(f.errors).toEqual([]);
    },
  );

  it.each(variants)(
    "observes %s MCP tools through the same boundary using a local stdio fixture",
    async (variant) => {
      const root = await mkdtemp(join(tmpdir(), "pi-trace-mcp-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const server = join(root, "server.ts");
      await writeFile(
        server,
        `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
    ? { tools: [{ name: "new_probe", description: "fixture", inputSchema: { type: "object", properties: {} } }] }
    : request.method === "tools/call"
    ? { content: [{ type: "text", text: "PRIVATE_MCP_RESULT" }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
      );
      const f = await fixture({
        variant,
        mcp: true,
        extra: (pi) => {
          pi.registerMcpServer("fixture", {
            command: process.execPath,
            args: ["--experimental-strip-types", server],
            exposure: "direct",
          });
        },
      });
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("mcp__fixture__new_probe", {}, { id: "mcp-probe" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await f.session.prompt("MCP fixture");
      const { spans } = await f.journal();
      const mcp = spans.find(
        (span) => span.attributes.toolCallId === "mcp-probe",
      )!;
      expect(mcp.attributes.toolName).toBe("mcp__fixture__new_probe");
      expect(mcp.outcome).toBe("ok");
      expect(mcp.attributes.outputBlocks).toBe(1);
      expect(JSON.stringify(spans)).not.toMatch(/PRIVATE_|server.ts/);
      expect(f.errors).toEqual([]);
    },
  );

  it("summarizes structures with constant bounded work and never reads arbitrary input values", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("enumerated input");
        },
        get() {
          throw new Error("read input");
        },
      },
    );
    expect(inputShape(hostile)).toEqual({ inputKind: "object" });
    const content = Array.from({ length: 17 }, () => ({
      type: "text",
      text: "PRIVATE",
    }));
    Object.defineProperty(content, 16, {
      get() {
        throw new Error("read beyond cap");
      },
    });
    expect(
      outputShape({
        content,
        get details() {
          throw new Error("read details");
        },
      }),
    ).toEqual({
      outputKind: "content_blocks",
      outputBlocks: 17,
      outputInspectedBlocks: 16,
      outputTextUnits: 16 * 7,
      outputImageBlocks: 0,
    });
  });

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

  it.each(variants)(
    "keeps sequential %s UI waits successful",
    async (variant) => {
      const f = await fixture({
        variant,
        extra: (pi) => {
          tool(pi, "asks", async (_id, _args, _signal, _update, ctx) => {
            await ctx.ui.confirm("PRIVATE_FIRST", "PRIVATE_BODY");
            await ctx.ui.confirm("PRIVATE_SECOND", "PRIVATE_BODY");
            return ok();
          });
        },
      });
      await f.session.bindExtensions({
        mode: "rpc",
        onError: (error) => f.errors.push(error),
        uiContext: {
          ...f.session.extensionRunner.getUIContext(),
          confirm: async () => {
            await pause();
            return true;
          },
        },
      });
      f.session.setActiveToolsByName(["asks"]);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("asks", {}), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await f.session.prompt("sequential UI fixture");
      const { spans } = await f.journal();
      expect(
        spans
          .filter((span) => span.operation === "ui_wait")
          .map((span) => span.outcome),
      ).toEqual(["ok", "ok"]);
      expect(f.errors).toEqual([]);
      expect(JSON.stringify(spans)).not.toContain("PRIVATE_");
    },
  );

  it.each(variants)(
    "retains %s manual compaction across its UI confirmation",
    async (variant) => {
      const f = await fixture({
        variant,
        extra: (pi) => {
          pi.on("session_before_compact", async (_event, ctx) => {
            await ctx.ui.confirm("PRIVATE_COMPACT", "PRIVATE_BODY");
          });
        },
      });
      await f.session.bindExtensions({
        mode: "rpc",
        onError: (error) => f.errors.push(error),
        uiContext: {
          ...f.session.extensionRunner.getUIContext(),
          confirm: async () => true,
        },
      });
      f.faux.setResponses([
        fauxAssistantMessage("one"),
        fauxAssistantMessage("two"),
        fauxAssistantMessage("summary"),
        fauxAssistantMessage("prefix summary"),
      ]);
      await f.session.prompt("first");
      await f.session.prompt("second");
      await f.session.compact();
      const { entries, spans } = await f.journal();
      const native = entries.filter((entry) => entry.type === "compaction");
      const compact = spans.filter((span) => span.operation === "compaction");
      expect(native).toHaveLength(1);
      expect(compact).toHaveLength(1);
      expect(compact[0]!.outcome).toBe("ok");
      expect(compact[0]!.references.compactionEntryId).toBe(native[0]!.id);
      expect(
        spans
          .filter((span) => span.operation === "ui_wait")
          .map((span) => span.outcome),
      ).toEqual(["ok"]);
      expect(f.errors).toEqual([]);
      expect(JSON.stringify(spans)).not.toContain("PRIVATE_");
    },
  );

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
        .map((entry) => project(entry.data as StoredSpan));
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

  it.each(variants)(
    "observes actual %s child execution with inherited context and a fresh native identity",
    async (variant) => {
      const { piSpawn } =
        variant === "built"
          ? await import("../../../dist/core/pi-spawn.js")
          : await import("../../core/pi-spawn/index");
      let childFile = "";
      const f = await fixture({
        variant,
        extra: (pi) => {
          tool(pi, "child", async (toolCallId, _args, signal, _update, ctx) => {
            const result = await piSpawn({
              cwd: ctx.cwd,
              task: "PRIVATE_CHILD_PROMPT",
              signal,
              owner: {
                sessionId: ctx.sessionManager.getSessionId(),
                toolCallId,
              },
              session: { parentSession: ctx.sessionManager.getSessionFile() },
              env: {
                // A fixture must not inherit account credentials, even if executable selection regresses.
                ...Object.fromEntries(
                  Object.keys(process.env).map((key) => [key, undefined]),
                ),
                PATH: process.env.PATH,
                HOME: ctx.cwd,
                XDG_CONFIG_HOME: ctx.cwd,
                XDG_DATA_HOME: ctx.cwd,
                PI_CODING_AGENT_DIR: ctx.cwd,
                PI_CODING_AGENT_SESSION_DIR: join(ctx.cwd, "children"),
                PI_OFFLINE: "1",
              },
              timeoutMs: 10000,
            });
            childFile = result.session?.sessionFile ?? "";
            if (result.exitCode !== 0) throw new Error(result.stderr);
            return ok();
          });
        },
      });
      const executable = join(f.root, "child.ts");
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
      const observer = fileURLToPath(
        variant === "built"
          ? new URL(
              "../../../dist/extensions/activity-trace.js",
              import.meta.url,
            )
          : new URL("./index.ts", import.meta.url),
      );
      await writeFile(
        executable,
        `#!${process.execPath} --experimental-strip-types
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from ${JSON.stringify(sdkUrl)};
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from ${JSON.stringify(aiUrl)};
const manager = SessionManager.open(process.argv[process.argv.indexOf("--session") + 1]!);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider(); modelRuntime.registerNativeProvider(faux.provider);
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: [${JSON.stringify(observer)}],
  extensionFactories: [pi => { pi.on("session_start", () => { pi.registerTool({
    name: "unknown_child_tool", label: "fixture", description: "fixture",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "PRIVATE_CHILD_RESULT" }], details: undefined })
  }); }); }] });
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.cwd(), modelRuntime,
  model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: manager, noTools: true });
const errors: unknown[] = [];
await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
if (errors.length) throw new Error(JSON.stringify(errors));
session.setActiveToolsByName(["unknown_child_tool"]);
if (!session.getActiveToolNames().includes("unknown_child_tool")) throw new Error("child fixture tool was not registered");
session.subscribe(event => process.stdout.write(JSON.stringify(event) + "\\n"));
faux.setResponses([fauxAssistantMessage(fauxToolCall("unknown_child_tool", {}, { id: "child-unknown" }), { stopReason: "toolUse" }), fauxAssistantMessage("PRIVATE_CHILD_RESPONSE")]);
await session.prompt("PRIVATE_CHILD_PROMPT");
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
`,
      );
      await chmod(executable, 0o700);
      // piSpawn resolves PI_BIN from the parent process, not config.env.
      vi.stubEnv("PI_BIN", executable);
      f.session.setActiveToolsByName(["child"]);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("child", {}, { id: "child-owner" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      await f.session.prompt("child fixture");
      const parent = await f.journal();
      const owner = parent.spans.find(
        (span) => span.references.toolCallId === "child-owner",
      )!;
      expect(
        owner.outcome,
        JSON.stringify(
          f.session.messages.filter((message) => message.role === "toolResult"),
        ),
      ).toBe("ok");
      expect(childFile).not.toBe("");
      const childManager = sdk.SessionManager.open(childFile);
      const childEntries = (await readFile(childFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const children: StoredSpan[] = childEntries
        .filter((entry) => entry.customType === TRACE_ENTRY)
        .map((entry) => entry.data);
      const childRoot = children.find(
        (span) => span.attributes.operation === "activity",
      )!;
      const unknown = children.find(
        (span) => span.attributes.toolName === "unknown_child_tool",
      )!;
      expect(unknown).toBeDefined();
      expect(unknown.attributes.outcome).toBe("ok");
      expect(unknown.attributes.executeDurationMs).toBeTypeOf("number");
      expect(
        childEntries.some(
          (entry) =>
            entry.message?.role === "toolResult" &&
            entry.message.content?.[0]?.text === "PRIVATE_CHILD_RESULT",
        ),
      ).toBe(true);
      expect(childRoot.parentId).toBe(owner.id);
      expect(childRoot.traceId).toBe(owner.traceId);
      expect(childManager.getSessionId()).not.toBe(f.manager.getSessionId());
      expect(owner.attributes.childSessionId).toBe(childManager.getSessionId());
      for (const span of children) {
        expect(span.traceId).toBe(owner.traceId);
        expect(span.attributes).toMatchObject({
          workflowName: "pi agent activity",
          workflowId: owner.attributes.workflowId,
          businessContext: "unavailable",
          sessionId: childManager.getSessionId(),
          parentSessionId: f.manager.getSessionId(),
          parentActivityId: owner.attributes.activityId,
          parentRunId: owner.attributes.runId,
          parentTurnId: owner.attributes.turnId,
          parentStep: "execute_tool",
          parentToolName: "child",
          parentSelectedProvider: owner.attributes.selectedProvider,
          parentSelectedModel: owner.attributes.selectedModel,
          parentObservedProvider: owner.attributes.observedProvider,
          parentObservedModel: owner.attributes.observedModel,
        });
        expect(span.attributes.nodeId).toBe(owner.attributes.nodeId);
        expect(span.attributes.processId).not.toBe(owner.attributes.processId);
      }
      expect(unknown.attributes.step).toBe("execute tool unknown_child_tool");
      if (process.env.PI_TRACE_FIXTURE_EXAMPLE === "1") {
        console.info("PERSISTED_CHILD_COMPLETION " + JSON.stringify(unknown));
        console.info(
          "CHILD_CAUSAL_PROOF " +
            JSON.stringify({
              parentToolSpanId: owner.id,
              childRootParentId: childRoot.parentId,
              parentTraceId: owner.traceId,
              childTraceId: childRoot.traceId,
              parentSessionId: f.manager.getSessionId(),
              childSessionId: childManager.getSessionId(),
            }),
        );
      }
      const { renderTrace } =
        await import("@earendil-works/pi-telemetry/render");
      expect(
        renderTrace([
          ...parent.entries
            .filter((entry) => entry.customType === TRACE_ENTRY)
            .map((entry) => entry.data),
          ...children,
        ]),
      ).toContain("unknown_child_tool");
      expect(JSON.stringify(children)).not.toMatch(
        /PRIVATE_|sessionFile|stderr|messages|\/Users\/|\/private\//,
      );
      expect(
        childManager
          .buildSessionProjection()
          .messages.some((message) =>
            JSON.stringify(message).includes(TRACE_ENTRY),
          ),
      ).toBe(false);
      expect(f.errors).toEqual([]);
    },
  );

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
    expect(spans.every((span) => JSON.stringify(span).length < 4500)).toBe(
      true,
    );
    expect(f.session.getLastAssistantText()).toBe("x".repeat(5000));
    expect(f.errors).toEqual([]);
  });
}
