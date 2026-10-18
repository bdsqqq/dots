import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type * as C from "../../core/agent-memory/runtime/contracts.js";
import { parseDelivery } from "../../core/agent-memory/runtime/wire.js";
import {
  memoryConfiguration,
  type MemoryConfiguration,
} from "../../core/agent-memory/runtime/config.js";
import { nativeSourceSnapshot } from "../../core/agent-memory/runtime/pi-source.js";
import {
  canonicalJSON,
  sha256,
  sameValue,
} from "../../core/agent-memory/runtime/identity.js";
import {
  runtimeStoreConfiguration,
  SessionMemoryWorker,
  type SessionWorkerOptions,
} from "../../core/agent-memory/runtime/session-worker.js";

export const MEMORY_MESSAGE_TYPE: string = "pi-memory-recall";
export interface NativeMemoryOptions {
  readonly configuration?: MemoryConfiguration;
  readonly worker?: Omit<SessionWorkerOptions, "store">;
  /** exact repository identity is producer-owned; absence never blocks personal capture. */
  readonly project?: { readonly repositoryId: string };
  readonly onError?: (error: unknown) => void;
}
function details(value: unknown): C.RecallDelivery | null {
  if (!value || typeof value !== "object" || !("delivery" in value))
    return null;
  try {
    return parseDelivery(value.delivery);
  } catch {
    return null;
  }
}
function latestUser(
  entries: readonly SessionEntry[],
): Extract<SessionEntry, { type: "message" }> | undefined {
  return [...entries]
    .reverse()
    .find((e) => e.type === "message" && e.message.role === "user") as
    | Extract<SessionEntry, { type: "message" }>
    | undefined;
}
function text(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      : "";
}

/** native lifecycle and inbox only; all storage and retrieval run off the inference event loop. */
export function createAgentMemoryExtension(
  options: NativeMemoryOptions = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let config: MemoryConfiguration;
    let worker: SessionMemoryWorker | undefined;
    let captureWorker: SessionMemoryWorker | undefined;
    let closed = true;
    let generation = 0;
    let sessionId: C.SessionId;
    let intents: C.RecallIntent[] = [];
    let pendingPrompt: string | null = null;
    let previousUserEntry: string | undefined;
    let boundEntry: string | undefined;
    let continuation = false;
    let readySinceRequest = false;
    const queued = new Set<string>();
    const captures = new Set<Promise<unknown>>();
    const error = (e: unknown): void => {
      if (!closed) options.onError?.(e);
    };
    const getWorker = (): SessionMemoryWorker =>
      (worker ??= new SessionMemoryWorker({
        ...options.worker,
        store: runtimeStoreConfiguration(config),
      }));
    const request = async (
      input: Parameters<SessionMemoryWorker["request"]>[0],
      timeout?: number,
    ): ReturnType<SessionMemoryWorker["request"]> => {
      const current =
        input.kind === "capture"
          ? (captureWorker ??= new SessionMemoryWorker({
              ...options.worker,
              store: runtimeStoreConfiguration(config),
            }))
          : getWorker();
      try {
        return await current.request(input, timeout);
      } catch (e) {
        if (input.kind !== "check") {
          current.close();
          if (worker === current) worker = undefined;
          if (captureWorker === current) captureWorker = undefined;
        }
        throw e;
      }
    };
    const live = (d: C.RecallDelivery, ctx: ExtensionContext): boolean =>
      !closed &&
      ctx.sessionManager.getSessionId() === sessionId &&
      latestUser(ctx.sessionManager.getBranch())?.id === d.intent.entryId &&
      intents.some(
        (i) =>
          i.intentId === d.intent.intentId &&
          i.entryId === d.intent.entryId &&
          sameValue(i.target, d.intent.target) &&
          i.query === d.intent.query,
      ) &&
      Date.parse(d.intent.expiresAt) > Date.now();
    const persisted = (ctx: ExtensionContext): C.RecallDelivery[] =>
      ctx.sessionManager
        .getBranch()
        .flatMap((e) =>
          e.type === "custom_message" && e.customType === MEMORY_MESSAGE_TYPE
            ? [details(e.details)].filter(
                (d): d is C.RecallDelivery => d !== null,
              )
            : [],
        );
    const recover = async (
      ctx: ExtensionContext,
      intent: C.RecallIntent,
      token: number,
    ): Promise<void> => {
      // drain only a bounded outbox; stale heads get discarded by shared dispatch.
      for (let n = 0; n < 16 && !closed && generation === token; n++) {
        const result = await request({
          kind: "recover",
          target: intent.target,
          intent,
        });
        if (!result || typeof result !== "object" || !("context" in result))
          break;
        const d = result;
        if (!live(d, ctx)) {
          // no inbox for an old intent. leave recoverable work for the right consumer.
          break;
        }
        if (persisted(ctx).some((p) => p.deliveryId === d.deliveryId)) {
          await request({ kind: "ack", deliveries: [d] });
          continue;
        }
        if (queued.has(d.deliveryId)) break;
        const checks = await request({ kind: "check", deliveries: [d] }, 250);
        if (
          !Array.isArray(checks) ||
          checks[0]?.kind !== "eligible" ||
          !live(d, ctx) ||
          generation !== token
        )
          break;
        queued.add(d.deliveryId);
        pi.sendMessage(
          {
            customType: MEMORY_MESSAGE_TYPE,
            content: d.context.text,
            display: false,
            details: { delivery: d },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
        readySinceRequest = true;
        break;
      }
    };
    const bindIntent = (ctx: ExtensionContext): void => {
      const user = latestUser(ctx.sessionManager.getBranch());
      if (
        !user ||
        user.id === boundEntry ||
        closed ||
        ctx.sessionManager.getSessionId() !== sessionId
      )
        return;
      if (pendingPrompt !== null && user.id === previousUserEntry) return;
      generation++;
      continuation = false;
      readySinceRequest = false;
      boundEntry = user.id;
      const query =
        pendingPrompt ??
        text("content" in user.message ? user.message.content : "");
      pendingPrompt = null;
      const scopes: C.MemoryScope[] = [
        { kind: "personal", ownerId: config.ownerId },
        ...(options.project
          ? [
              {
                kind: "project" as const,
                repositoryId: options.project.repositoryId,
              },
            ]
          : []),
      ];
      const expiry = new Date(Date.now() + 5 * 60_000).toISOString();
      intents = scopes.map((scope) => {
        const target: C.RecallTarget = {
          consumerId: "pi-native-memory",
          sessionId,
          scope,
        };
        const recovered = persisted(ctx).find(
          (d) =>
            d.intent.entryId === user.id &&
            sameValue(d.intent.target, target) &&
            Date.parse(d.intent.expiresAt) > Date.now(),
        );
        if (recovered) return recovered.intent;
        return {
          intentId: sha256(
            canonicalJSON({ target, entryId: user.id }),
          ) as C.IntentId,
          target,
          entryId: user.id as C.EntryId,
          query: query.slice(0, 4000),
          expiresAt: expiry,
          maxChars: 6000,
          maxNotes: 4,
        };
      });
      const token = generation;
      for (const intent of intents)
        void (async () => {
          await recover(ctx, intent, token);
          if (closed || generation !== token) return;
          await request({ kind: "recall", intent });
          await recover(ctx, intent, token);
        })().catch(error);
    };
    pi.on("session_start", (_event, ctx) => {
      worker?.close();
      captureWorker?.close();
      worker = undefined;
      captureWorker = undefined;
      closed = false;
      generation++;
      queued.clear();
      config =
        options.configuration ??
        memoryConfiguration({ cwd: ctx.cwd, settings: pi.getSettings() });
      sessionId = ctx.sessionManager.getSessionId() as C.SessionId;
      intents = [];
      boundEntry = undefined;
      pendingPrompt = null;
      if (!config.enabled) {
        closed = true;
        return;
      }
      bindIntent(ctx);
    });
    pi.on("before_agent_start", (event, ctx) => {
      if (closed) return;
      generation++;
      previousUserEntry = latestUser(ctx.sessionManager.getBranch())?.id;
      pendingPrompt = event.prompt;
      boundEntry = undefined;
      intents = [];
      continuation = false;
      readySinceRequest = false;
      // the SDK persists the new user after this hook. bind to that native id,
      // never to the assistant/tool leaf or a fabricated prompt id.
      const token = generation;
      setImmediate(() => {
        if (!closed && token === generation) {
          try {
            bindIntent(ctx);
          } catch (e) {
            error(e);
          }
        }
      });
    });
    pi.on("context", async (event, ctx) => {
      if (!closed) bindIntent(ctx);
      const candidates = event.messages.flatMap((m) =>
        m.role === "custom" && m.customType === MEMORY_MESSAGE_TYPE
          ? [details(m.details)].filter(
              (d): d is C.RecallDelivery => d !== null,
            )
          : [],
      );
      const eligible = candidates.filter((d) => live(d, ctx));
      let checks: readonly C.DeliveryEligibility[] = [];
      if (eligible.length)
        try {
          const result = await request(
            { kind: "check", deliveries: eligible },
            250,
          );
          if (Array.isArray(result)) checks = result;
        } catch (e) {
          error(e);
        }
      const allowed = new Set(
        eligible
          .filter((d, i) => checks[i]?.kind === "eligible" && live(d, ctx))
          .map((d) => d.deliveryId),
      );
      const seen = new Set<string>();
      // summaries are opaque: when this session has memory, a summary cannot
      // safely retain copied memory after suppression or a scope/intent change.
      const hasMemory = ctx.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom_message" && e.customType === MEMORY_MESSAGE_TYPE,
        );
      const messages = event.messages.filter((m) => {
        if (
          hasMemory &&
          (m.role === "compactionSummary" || m.role === "branchSummary")
        )
          return false;
        if (m.role !== "custom" || m.customType !== MEMORY_MESSAGE_TYPE)
          return true;
        const d = details(m.details);
        if (
          !d ||
          !allowed.has(d.deliveryId) ||
          seen.has(d.deliveryId) ||
          text(m.content) !== d.context.text
        )
          return false;
        seen.add(d.deliveryId);
        return true;
      });
      readySinceRequest = false;
      const accepted = persisted(ctx).filter((d) => allowed.has(d.deliveryId));
      if (accepted.length)
        void request({ kind: "ack", deliveries: accepted }).catch(error);
      return { messages };
    });
    pi.on("turn_end", (event, ctx) => {
      if (closed) return;
      const through = event.toolResultEntryIds.at(-1) ?? event.messageEntryId;
      const capture = request({
        kind: "capture",
        snapshot: nativeSourceSnapshot(ctx.sessionManager),
        through: through as C.EntryId,
        scope: { kind: "personal", ownerId: config.ownerId },
        ...(options.project ? { project: options.project } : {}),
      }).catch(error);
      captures.add(capture);
      void capture.finally(() => captures.delete(capture));
    });
    pi.on("agent_before_settle", async (event, ctx) => {
      if (
        closed ||
        continuation ||
        !readySinceRequest ||
        event.outcome !== "completed"
      )
        return;
      const candidates = persisted(ctx).filter((d) => live(d, ctx));
      if (!candidates.length) return;
      try {
        const result = await request(
          { kind: "check", deliveries: candidates },
          250,
        );
        if (
          Array.isArray(result) &&
          result.some(
            (r, i) => r.kind === "eligible" && live(candidates[i]!, ctx),
          )
        ) {
          continuation = true;
          readySinceRequest = false;
          return { continue: true };
        }
      } catch (e) {
        error(e);
      }
    });
    pi.on("session_shutdown", async () => {
      closed = true;
      generation++;
      intents = [];
      queued.clear();
      worker?.close();
      worker = undefined;
      const closingCapture = captureWorker;
      captureWorker = undefined;
      // shutdown may drain already-submitted capture, bounded by worker deadlines.
      // primary inference never waits for these durable acknowledgments.
      await Promise.allSettled([...captures]);
      closingCapture?.close();
    });
  };
}
export default function agentMemoryExtension(pi: ExtensionAPI): void {
  createAgentMemoryExtension()(pi);
}

if (import.meta.vitest) {
  const { beforeAll, afterAll, it, expect } = import.meta.vitest;
  const fs = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { build } = await import("tsdown");
  const { FileMemoryStore, isStoreBusy } =
    await import("../../core/agent-memory/runtime/store.js");
  const { createNoteRevision } =
    await import("../../core/agent-memory/runtime/markdown.js");
  const { DEFAULT_BACKLOG_POLICY } =
    await import("../../core/agent-memory/runtime/config.js");
  const {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const {
    InMemoryCredentialStore,
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
  } = await import("@earendil-works/pi-ai");
  let artifact: string;
  beforeAll(async () => {
    artifact = await fs.mkdtemp(join(process.cwd(), ".m3-worker-fixture-"));
    await build({
      config: false,
      entry: {
        "core/agent-memory-session-worker": resolve(
          "packages/core/agent-memory/runtime/session-worker.ts",
        ),
        "extensions/agent-memory": resolve(
          "packages/extensions/agent-memory/index.ts",
        ),
      },
      outDir: join(artifact, "dist"),
      fixedExtension: false,
      format: "esm",
      dts: false,
      clean: false,
      tsconfig: resolve("tsconfig.build.json"),
      alias: {
        "@bds_pi/sessions": resolve("packages/core/sessions/index.ts"),
        "@bds_pi/config": resolve("packages/core/config/index.ts"),
      },
      deps: {
        alwaysBundle: [/^@letta-ai\//],
        neverBundle: [/^@earendil-works\//, /^typebox(?:\/|$)/],
      },
      define: { "import.meta.vitest": "undefined" },
    });
  }, 30_000);
  afterAll(async () => {
    if (artifact) await fs.rm(artifact, { recursive: true, force: true });
  });
  const wait = async (
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("fixture condition timed out");
  };
  async function fixture(
    gate?: SharedArrayBuffer,
    factory: typeof createAgentMemoryExtension = createAgentMemoryExtension,
    restore?: { dir: string; config: MemoryConfiguration; sessionFile: string },
    persistent = false,
    defaultWorker = false,
    project?: { repositoryId: string },
  ) {
    const dir = restore?.dir ?? (await fs.mkdtemp(join(artifact, "session-")));
    const config: MemoryConfiguration = restore?.config ?? {
      enabled: true,
      root: join(dir, "notes"),
      data: join(dir, "data"),
      state: join(dir, "state"),
      ownerId: "fixture",
      model: null,
      peers: [],
      sessionRoot: join(dir, "sessions"),
      backlog: DEFAULT_BACKLOG_POLICY,
    };
    const storeConfig = runtimeStoreConfiguration(config);
    const store = new FileMemoryStore(storeConfig);
    const note = createNoteRevision({
      noteId: "quiet-room" as C.NoteId,
      ancestry: { kind: "known", parents: [] },
      scope: { kind: "personal", ownerId: "fixture" },
      path: "quiet-room.md",
      body: "zephyr prefers the violet lamp in a quiet room",
      links: [],
      claims: [],
      exposure: { kind: "active" },
      authoredAt: "2026-01-02T00:00:00.000Z",
    });
    if (!restore)
      await store.commit({
        commitId: "seed" as C.CommitId,
        now: new Date().toISOString(),
        windows: [],
        edits: [{ revision: note, expectedHeads: [] }],
        suppressions: [],
        outcomes: [],
        lease: null,
      });
    const indexModule = join(dir, "retrieval.mjs");
    await fs.writeFile(
      indexModule,
      `export function createSearchIndex(gate) { let notes=[]; return { async project(n){ notes=n; },async readiness(){ return {kind:'unavailable',reason:'fixture lexical'}; },async search(intent){ if(gate) { const a=new Int32Array(gate);Atomics.store(a,1,1);Atomics.notify(a,1);Atomics.wait(a,0,0,10000); } return notes.filter(n=>n.markdown.includes(intent.query)).map(n=>({noteId:n.noteId,revisionId:n.revisionId})); } }; }`,
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({
      defaultTools: ["read", "codemode"],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const manager = restore
      ? SessionManager.open(restore.sessionFile)
      : persistent
        ? SessionManager.create(dir, join(dir, "sessions"), {
            id: "native-fixture",
          })
        : SessionManager.inMemory(dir, { id: "native-fixture" });
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        factory({
          configuration: config,
          ...(project ? { project } : {}),
          worker: {
            ...(defaultWorker
              ? {}
              : {
                  entry: pathToFileURL(
                    join(artifact, "dist/core/agent-memory-session-worker.js"),
                  ),
                }),
            indexModule: pathToFileURL(indexModule).href,
            indexOptions: gate,
          },
          onError: (e) => errors.push(e),
        }),
        createCodemodeExtension({ models: false }),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      settingsManager: settings,
      modelRuntime: runtime,
      model: faux.getModel(),
      sessionManager: manager,
    });
    await session.bindExtensions({});
    return {
      dir,
      config,
      store,
      note,
      manager,
      session,
      faux,
      errors,
      async close() {
        await session.abort();
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
        store.close();
      },
    };
  }
  it("the real SDK completes primary inference while synchronous retrieval is blocked on another thread", async () => {
    const gate = new SharedArrayBuffer(8);
    const a = new Int32Array(gate);
    const f = await fixture(gate);
    try {
      const contexts: string[] = [];
      f.faux.setResponses([
        async (ctx) => {
          await wait(() => Atomics.load(a, 1) === 1);
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("primary finished");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(f.errors.map(String)).toEqual([]);
      expect(Atomics.load(a, 0)).toBe(0);
      expect(f.session.getLastAssistantText()).toBe("primary finished");
      expect(contexts.join("")).not.toContain("violet lamp");
      // negative control: waiting for recall could not pass the same progress predicate.
      expect(Atomics.load(a, 1)).toBe(1);
      Atomics.store(a, 0, 1);
      Atomics.notify(a, 0);
    } finally {
      Atomics.store(a, 0, 1);
      Atomics.notify(a, 0);
      await f.close();
    }
  });
  it("native provider requests receive actual memory and source without search tools; new intents filter persisted context and capture no-session experience", async () => {
    const f = await fixture();
    const contexts: string[] = [];
    const branchRoot = f.manager.appendMessage({
      role: "user",
      content: "selected root",
      timestamp: 1,
    });
    f.manager.appendMessage({
      role: "user",
      content: "excluded sibling",
      timestamp: 2,
    });
    f.manager.branch(branchRoot);
    try {
      f.faux.setResponses([
        async (ctx) => {
          contexts.push(JSON.stringify(ctx));
          await wait(
            async () =>
              !!(await f.store.nextDelivery({
                consumerId: "pi-native-memory",
                sessionId: f.manager.getSessionId() as C.SessionId,
                scope: { kind: "personal", ownerId: "fixture" },
              })),
          );
          await new Promise((r) => setTimeout(r, 100));
          return fauxAssistantMessage("primary response");
        },
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("memory-informed response");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(f.errors.map(String)).toEqual([]);
      expect(contexts[0]).not.toContain("violet lamp");
      expect(contexts[1]).toContain("violet lamp");
      expect(contexts[1]).toContain("quiet-room.md");
      expect(f.session.getActiveToolNames()).not.toContain("memory_search");
      expect(f.manager.getSessionFile()).toBeUndefined();
      let captured: C.BacklogPlan | undefined;
      await wait(async () => {
        try {
          captured = await f.store.plan({
            jobId: "probe" as C.JobId,
            owner: "probe",
            scope: { kind: "personal", ownerId: "fixture" },
            now: new Date().toISOString(),
            policy: { ...DEFAULT_BACKLOG_POLICY, minWindows: 1 },
          });
          return captured.kind === "eligible";
        } catch (e) {
          if (isStoreBusy(e)) return false;
          throw e;
        }
      });
      if (captured?.kind !== "eligible") throw new Error("no captured source");
      const excerpts = captured.batch.windows.flatMap((w) => w.window.excerpts);
      expect(
        excerpts.some((e) => e.producerRole === "user" && e.text === "zephyr"),
      ).toBe(true);
      expect(
        excerpts.some(
          (e) =>
            e.producerRole === "assistant" && e.text === "primary response",
        ),
      ).toBe(true);
      expect(
        excerpts.some(
          (e) =>
            e.text.includes("violet lamp") ||
            e.text.includes("excluded sibling"),
        ),
      ).toBe(false);
      expect(excerpts.some((e) => e.text === "selected root")).toBe(true);
      expect(
        captured.batch.windows.every(
          (w) =>
            w.window.source.origin.kind === "session" &&
            w.window.source.origin.sessionId === f.manager.getSessionId(),
        ),
      ).toBe(true);
      expect(
        f.manager
          .getEntries()
          .filter(
            (e) =>
              e.type === "custom_message" &&
              e.customType === MEMORY_MESSAGE_TYPE,
          ),
      ).toHaveLength(1);
      f.faux.setResponses([
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("unrelated done");
        },
      ]);
      await f.session.prompt("platypus");
      expect(contexts.at(-1)).not.toContain("violet lamp");
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("suppression after native queueing is rechecked before the next actual provider request", async () => {
    const f = await fixture();
    const contexts: string[] = [];
    try {
      f.faux.setResponses([
        async (ctx) => {
          contexts.push(JSON.stringify(ctx));
          await wait(
            async () =>
              !!(await f.store.nextDelivery({
                consumerId: "pi-native-memory",
                sessionId: f.manager.getSessionId() as C.SessionId,
                scope: { kind: "personal", ownerId: "fixture" },
              })),
          );
          await new Promise((r) => setTimeout(r, 100));
          await f.store.commit({
            commitId: "deny" as C.CommitId,
            now: new Date().toISOString(),
            windows: [],
            edits: [],
            outcomes: [],
            lease: null,
            suppressions: [
              {
                suppressionId: "deny" as C.SuppressionId,
                scope: f.note.scope,
                target: { kind: "note", noteId: f.note.noteId },
                reason: "fixture",
                createdAt: new Date().toISOString(),
              },
            ],
          });
          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: 'text("ordinary continuation");',
            }),
            { stopReason: "toolUse" },
          );
        },
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("second");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(f.errors.map(String)).toEqual([]);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]).toContain("ordinary continuation");
      expect(contexts.join("")).not.toContain("violet lamp");
      // without the context gate, the persisted native inbox still contains this body.
      expect(
        f.manager
          .getEntries()
          .some(
            (e) =>
              e.type === "custom_message" &&
              text(e.content).includes("violet lamp"),
          ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("ordinary codemode file investigation remains usable", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.dir, "fixture.txt"), "ordinary file evidence");
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `text(await tools.read({path:${JSON.stringify(join(f.dir, "fixture.txt"))}}));`,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await f.session.prompt("platypus");
      expect(JSON.stringify(f.session.messages)).toContain(
        "ordinary file evidence",
      );
    } finally {
      await f.close();
    }
  });
  async function seedPersistedOutbox(
    f: Awaited<ReturnType<typeof fixture>>,
    scope: C.MemoryScope = { kind: "personal", ownerId: "fixture" },
  ): Promise<C.RecallDelivery> {
    const { sharedRecallHandler } =
      await import("../../core/agent-memory/runtime/recall.js");
    const { LinkedSearchIndex } =
      await import("../../core/agent-memory/runtime/index.js");
    const entryId = f.manager.appendMessage({
      role: "user",
      content: "zephyr",
      timestamp: Date.now(),
    }) as C.EntryId;
    const target: C.RecallTarget = {
      consumerId: "pi-native-memory",
      sessionId: f.manager.getSessionId() as C.SessionId,
      scope: { kind: "personal", ownerId: "fixture" },
    };
    const intent: C.RecallIntent = {
      intentId: sha256(canonicalJSON({ target, entryId })) as C.IntentId,
      target,
      entryId,
      query: "zephyr",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxChars: 6000,
      maxNotes: 4,
    };
    await sharedRecallHandler(intent, {
      store: f.store,
      index: new LinkedSearchIndex(),
      now: () => new Date().toISOString(),
      signal: new AbortController().signal,
    });
    const delivery = (await f.store.nextDelivery(target))!;
    f.manager.appendMessage(fauxAssistantMessage("prior completed response"));
    const persisted = {
      ...delivery,
      intent: { ...delivery.intent, target: { ...target, scope } },
    };
    f.manager.appendCustomMessageEntry(
      MEMORY_MESSAGE_TYPE,
      persisted.context.text,
      false,
      { delivery: persisted },
    );
    f.manager.appendCustomMessageEntry(
      MEMORY_MESSAGE_TYPE,
      persisted.context.text,
      false,
      { delivery: persisted },
    );
    f.session.refreshContext();
    return delivery;
  }
  it("persist-before-ACK recovery contributes once after real session/store reopen and durably drains the outbox", async () => {
    const first = await fixture(
      undefined,
      createAgentMemoryExtension,
      undefined,
      true,
    );
    const d = await seedPersistedOutbox(first);
    const sessionFile = first.manager.getSessionFile()!;
    expect(await first.store.nextDelivery(d.intent.target)).not.toBeNull();
    await first.close();
    const f = await fixture(undefined, createAgentMemoryExtension, {
      dir: first.dir,
      config: first.config,
      sessionFile,
    });
    try {
      await wait(async () => {
        try {
          return (await f.store.nextDelivery(d.intent.target)) === null;
        } catch (e) {
          if (isStoreBusy(e)) return false;
          throw e;
        }
      });
      let received = "";
      f.faux.setResponses([
        (ctx) => {
          received = JSON.stringify(ctx);
          return fauxAssistantMessage("resumed");
        },
      ]);
      await f.session.agent.continue();
      expect(received.split("violet lamp")).toHaveLength(2);
      const reopened = new FileMemoryStore(runtimeStoreConfiguration(f.config));
      try {
        expect(await reopened.nextDelivery(d.intent.target)).toBeNull();
      } finally {
        reopened.close();
      }
    } finally {
      await f.close();
    }
  });
  it("wrong-scope persisted memory is excluded; an isolated broken context gate makes the same verifier fail", async () => {
    const assertScope = async (
      factory: typeof createAgentMemoryExtension,
    ): Promise<void> => {
      const f = await fixture(undefined, factory);
      try {
        await seedPersistedOutbox(f, {
          kind: "project",
          repositoryId: "wrong-repository",
        });
        f.manager.appendCompaction(
          "summary copied violet lamp",
          f.manager.getBranch()[0]!.id,
          100,
        );
        f.session.refreshContext();
        let received = "";
        f.faux.setResponses([
          (ctx) => {
            received = JSON.stringify(ctx);
            return fauxAssistantMessage("scope checked");
          },
        ]);
        await f.session.agent.continue();
        expect(received).not.toContain("violet lamp");
      } finally {
        await f.close();
      }
    };
    await assertScope(createAgentMemoryExtension);
    const built = await fs.readFile(
      join(artifact, "dist/extensions/agent-memory.js"),
      "utf8",
    );
    // mutate only a disposable built artifact, leaving the real extension/store intact.
    const broken = built.replace("!allowed.has(d.deliveryId)", "false");
    expect(broken).not.toBe(built);
    const path = join(artifact, "dist/extensions/negative-scope.js");
    await fs.writeFile(path, broken);
    const control = (await import(pathToFileURL(path).href)) as {
      createAgentMemoryExtension: typeof createAgentMemoryExtension;
    };
    await expect(
      assertScope(control.createAgentMemoryExtension),
    ).rejects.toThrow("violet lamp");
  });

  it("the built native adapter finds its actual worker after bundler splitting and consumes the shared recall implementation", async () => {
    const built = (await import(
      pathToFileURL(join(artifact, "dist/extensions/agent-memory.js")).href
    )) as { createAgentMemoryExtension: typeof createAgentMemoryExtension };
    const f = await fixture(
      undefined,
      built.createAgentMemoryExtension,
      undefined,
      false,
      true,
    );
    const contexts: string[] = [];
    try {
      f.faux.setResponses([
        async (ctx) => {
          contexts.push(JSON.stringify(ctx));
          await wait(
            async () =>
              !!(await f.store.nextDelivery({
                consumerId: "pi-native-memory",
                sessionId: f.manager.getSessionId() as C.SessionId,
                scope: { kind: "personal", ownerId: "fixture" },
              })),
          );
          await new Promise((r) => setTimeout(r, 100));
          return fauxAssistantMessage("first");
        },
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("second");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(contexts[1]).toContain("violet lamp");
      expect(f.errors.map(String)).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("shutdown cancels held recall and drains no-session capture before closing; a fresh session can recall again", async () => {
    const gate = new SharedArrayBuffer(8);
    const a = new Int32Array(gate);
    const f = await fixture(gate);
    try {
      f.faux.setResponses([
        async () => {
          await wait(() => Atomics.load(a, 1) === 1);
          return fauxAssistantMessage("primary completed before shutdown");
        },
      ]);
      await f.session.prompt("zephyr");
      await f.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      Atomics.store(a, 0, 1);
      Atomics.notify(a, 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(
        f.manager
          .getEntries()
          .some(
            (e) =>
              e.type === "custom_message" &&
              e.customType === MEMORY_MESSAGE_TYPE,
          ),
      ).toBe(false);
      const pending = await f.store.plan({
        jobId: "shutdown-probe" as C.JobId,
        owner: "fixture",
        scope: { kind: "personal", ownerId: "fixture" },
        now: new Date().toISOString(),
        policy: { ...DEFAULT_BACKLOG_POLICY, minWindows: 1 },
      });
      if (pending.kind !== "eligible") throw new Error("shutdown lost capture");
      expect(
        pending.batch.windows.some((w) =>
          w.window.excerpts.some(
            (e) => e.text === "primary completed before shutdown",
          ),
        ),
      ).toBe(true);
      await f.session.extensionRunner.emit({
        type: "session_start",
        reason: "reload",
      });
      const contexts: string[] = [];
      f.faux.setResponses([
        async (ctx) => {
          contexts.push(JSON.stringify(ctx));
          await wait(
            async () =>
              (
                await f.store.nextDelivery({
                  consumerId: "pi-native-memory",
                  sessionId: f.manager.getSessionId() as C.SessionId,
                  scope: { kind: "personal", ownerId: "fixture" },
                })
              )?.intent.entryId === latestUser(f.manager.getBranch())?.id,
          );
          await new Promise((r) => setTimeout(r, 100));
          return fauxAssistantMessage("fresh primary");
        },
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("fresh recall");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(f.errors.map(String)).toEqual([]);
      expect(
        f.session.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.stopReason),
      ).not.toContain("error");
      expect(contexts[1]).toContain("violet lamp");
    } finally {
      Atomics.store(a, 0, 1);
      Atomics.notify(a, 0);
      await f.close();
    }
  });
  it("personal and exact-project recall are independent scopes while capture remains one personal source pass", async () => {
    const project = { repositoryId: "fixture-repository" };
    const f = await fixture(
      undefined,
      createAgentMemoryExtension,
      undefined,
      false,
      false,
      project,
    );
    try {
      const note = createNoteRevision({
        noteId: "project-note" as C.NoteId,
        ancestry: { kind: "known", parents: [] },
        scope: { kind: "project", repositoryId: project.repositoryId },
        path: "project-note.md",
        body: "zephyr used an sqlite queue in revision one",
        links: [],
        claims: [],
        exposure: { kind: "active" },
        authoredAt: "2025-01-01T00:00:00.000Z",
      });
      await f.store.commit({
        commitId: "project" as C.CommitId,
        now: new Date().toISOString(),
        windows: [],
        edits: [{ revision: note, expectedHeads: [] }],
        suppressions: [],
        outcomes: [],
        lease: null,
      });
      const contexts: string[] = [];
      f.faux.setResponses([
        async (ctx) => {
          contexts.push(JSON.stringify(ctx));
          await wait(async () => {
            const personal = await f.store.nextDelivery({
              consumerId: "pi-native-memory",
              sessionId: f.manager.getSessionId() as C.SessionId,
              scope: { kind: "personal", ownerId: "fixture" },
            });
            const narrow = await f.store.nextDelivery({
              consumerId: "pi-native-memory",
              sessionId: f.manager.getSessionId() as C.SessionId,
              scope: note.scope,
            });
            return (
              !!personal &&
              !!narrow &&
              personal.intent.entryId ===
                latestUser(f.manager.getBranch())?.id &&
              narrow.intent.entryId === latestUser(f.manager.getBranch())?.id
            );
          });
          await new Promise((r) => setTimeout(r, 100));
          return fauxAssistantMessage("first");
        },
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("second");
        },
      ]);
      await f.session.prompt("zephyr");
      expect(contexts[1]).toContain("violet lamp");
      expect(contexts[1]).toContain("sqlite queue");
      expect(contexts[1]).toContain("project historical fact");
      await f.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      const plan = await f.store.plan({
        jobId: "scope-probe" as C.JobId,
        owner: "fixture",
        scope: { kind: "personal", ownerId: "fixture" },
        now: new Date().toISOString(),
        policy: { ...DEFAULT_BACKLOG_POLICY, minWindows: 1 },
      });
      if (plan.kind !== "eligible") throw new Error("missing personal capture");
      expect(
        new Set(plan.batch.windows.map((w) => w.window.windowId)).size,
      ).toBe(plan.batch.windows.length);
      expect(
        plan.batch.windows.every(
          (w) =>
            w.window.source.origin.kind === "session" &&
            w.window.source.origin.project?.repositoryId ===
              project.repositoryId,
        ),
      ).toBe(true);
      expect(
        await f.store.plan({
          jobId: "no-duplicate" as C.JobId,
          owner: "fixture",
          scope: note.scope,
          now: new Date().toISOString(),
          policy: { ...DEFAULT_BACKLOG_POLICY, minWindows: 1 },
        }),
      ).toMatchObject({ kind: "idle", reason: "empty" });
    } finally {
      await f.close();
    }
  });
}
