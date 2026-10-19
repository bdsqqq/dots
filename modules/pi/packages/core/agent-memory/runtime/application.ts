import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolveGlobalSettingsPath } from "@bds_pi/config";
import {
  watchMemoryWork,
  type MemoryWakePolicy,
  type MemoryWakeEvent,
} from "./wakeup.js";
import type * as C from "./contracts.js";
import { memoryConfiguration, type MemoryConfiguration } from "./config.js";
import { FileMemoryStore } from "./store.js";
import { runtimeStoreConfiguration } from "./session-worker.js";
import { LinkedSearchIndex } from "./index.js";
import { capture } from "./capture.js";
import { sharedRecallHandler, sharedDispatchHandler } from "./recall.js";
import {
  runReconciliation,
  type ReconciliationRunResult,
} from "./reconcile.js";
import {
  nativeConsolidationModel,
  ReconciliationFailureError,
  type ReconciliationFailure,
} from "./model.js";
import { catchUpNativeSources, type CatchUpResult } from "./catch-up.js";
import {
  synchronizeReplica,
  type SynchronizeResult,
  type ReplicaPolicy,
} from "./replica.js";
import { sshReplicaTransport } from "./replica-transport.js";

export interface MemoryApplicationOptions {
  readonly configuration?: MemoryConfiguration;
  readonly model?: C.ConsolidationModel;
  readonly index?: C.SearchIndex;
  readonly transport?: (peer: string) => C.ReplicaTransport;
  readonly now?: () => string;
}
export type MemoryJob = "catch-up" | "reconcile" | "replicate";

export interface MaintenanceResult {
  readonly capture: CatchUpResult | null;
  readonly reconciliation: ReconciliationRunResult;
  readonly replication: readonly {
    peer: string;
    result?: SynchronizeResult;
    error?: string;
  }[];
}
/**
 * use openMemoryApplication in production so lock contention yields instead of
 * failing at construction. filesystem work still belongs in a worker or standalone
 * process, never the primary inference event loop. importing is inert.
 * supplied configuration/model/index own their data and bypass native discovery.
 */
export class MemoryApplication {
  readonly configuration: MemoryConfiguration;
  readonly store: FileMemoryStore;
  readonly index: C.SearchIndex;
  private readonly model: C.ConsolidationModel;
  private readonly now: () => string;
  constructor(
    private readonly options: MemoryApplicationOptions = {},
    openedStore?: FileMemoryStore,
  ) {
    this.configuration = options.configuration ?? memoryConfiguration();
    this.store =
      openedStore ??
      new FileMemoryStore(runtimeStoreConfiguration(this.configuration));
    this.index = options.index ?? new LinkedSearchIndex();
    this.model =
      options.model ??
      nativeConsolidationModel({
        cwd: process.cwd(),
        model: this.configuration.model,
      });
    this.now = options.now ?? (() => new Date().toISOString());
  }
  get scope(): C.MemoryScope {
    return { kind: "personal", ownerId: this.configuration.ownerId };
  }
  private authorize(scope: C.MemoryScope): void {
    if (
      scope.kind === "personal" &&
      scope.ownerId !== this.configuration.ownerId
    )
      throw new Error("wrong memory owner");
  }
  policy(): ReplicaPolicy {
    return {
      ownerId: this.configuration.ownerId,
      peerOwnerId: this.configuration.ownerId,
      personal: true,
      projects: "all-owned",
    };
  }
  async status(): Promise<{
    enabled: boolean;
    notes: number;
    suppressions: number;
    peers: readonly string[];
    paths: ReturnType<typeof runtimeStoreConfiguration>;
  }> {
    return {
      enabled: this.configuration.enabled,
      notes: (await this.store.listNotes(this.scope)).length,
      suppressions: (await this.store.readSuppressions(this.scope)).length,
      peers: this.configuration.peers,
      paths: runtimeStoreConfiguration(this.configuration),
    };
  }
  async capture(windows: readonly C.SourceWindow[]): Promise<C.CaptureOutcome> {
    for (const window of windows) this.authorize(window.scope);
    if (
      windows.some(
        (w) => JSON.stringify(w.scope) !== JSON.stringify(windows[0]!.scope),
      )
    )
      throw new Error("mixed capture scopes");
    return capture(
      {
        source: { kind: "provided", windows },
        scope: windows[0]?.scope ?? this.scope,
        now: this.now(),
        commitId: randomUUID() as C.CommitId,
      },
      { store: this.store },
    );
  }
  async catchUp(signal: AbortSignal): Promise<CatchUpResult> {
    if (!this.configuration.enabled)
      return { files: 0, windows: 0, bounded: false, errors: [] };
    return catchUpNativeSources({
      store: this.store,
      root: this.configuration.sessionRoot,
      checkpoint: join(
        this.configuration.state,
        "runtime",
        "source-progress.json",
      ),
      scope: this.scope,
      signal,
    });
  }
  async recall(
    intent: C.RecallIntent,
    signal: AbortSignal,
  ): Promise<C.RecallOutcome> {
    this.authorize(intent.target.scope);
    return sharedRecallHandler(intent, {
      store: this.store,
      index: this.index,
      signal,
      now: this.now,
    });
  }
  async dispatch(
    target: C.RecallTarget,
    inbox: C.NativeInbox,
  ): Promise<C.DispatchOutcome> {
    this.authorize(target.scope);
    return sharedDispatchHandler(
      { target, now: this.now },
      { store: this.store, inbox },
    );
  }
  async suppress(suppression: C.Suppression): Promise<C.CommitResult> {
    this.authorize(suppression.scope);
    return this.store.commit({
      commitId: randomUUID() as C.CommitId,
      now: this.now(),
      windows: [],
      edits: [],
      suppressions: [suppression],
      outcomes: [],
      lease: null,
    });
  }
  async replicate(
    signal: AbortSignal,
  ): Promise<MaintenanceResult["replication"]> {
    if (!this.configuration.enabled) return [];
    return Promise.all(
      this.configuration.peers.map(async (peer) => {
        try {
          signal.throwIfAborted();
          return {
            peer,
            result: await synchronizeReplica({
              store: this.store,
              peerId: peer,
              policy: this.policy(),
              signal,
              transport:
                this.options.transport?.(peer) ??
                sshReplicaTransport(peer, this.configuration.peers),
            }),
          };
        } catch (error) {
          return { peer, error: String(error) };
        }
      }),
    );
  }
  async reconcile(signal: AbortSignal): Promise<ReconciliationRunResult> {
    if (!this.configuration.enabled) return { results: [], idle: null };
    const scopes = await this.store.pendingScopes();
    const results: C.CommitResult[] = [];
    let idle: ReconciliationRunResult["idle"] = null;
    for (const scope of scopes.length ? scopes : [this.scope]) {
      signal.throwIfAborted();
      const run = await runReconciliation(
        {
          jobId: randomUUID() as C.JobId,
          owner: this.configuration.ownerId,
          scope,
          now: this.now(),
          policy: this.configuration.backlog,
        },
        { store: this.store, model: this.model, signal },
      );
      results.push(...run.results);
      idle = run.idle;
      if (run.failure) return { results, idle, failure: run.failure };
    }
    return { results, idle };
  }
  async watch(job: MemoryJob, signal: AbortSignal): Promise<void> {
    return watchMemoryApplication({ job, signal, application: this });
  }
  async maintain(signal: AbortSignal): Promise<MaintenanceResult> {
    if (!this.configuration.enabled)
      return {
        capture: null,
        reconciliation: { results: [], idle: null },
        replication: [],
      };
    // all owned phases settle before a CLI caller can close their shared store.
    const [capture, reconciliation, replication] = await Promise.allSettled([
      this.catchUp(signal),
      this.reconcile(signal),
      this.replicate(signal),
    ]);
    const errors: Error[] = [];
    for (const [name, phase] of [
      ["capture", capture],
      ["reconciliation", reconciliation],
      ["replication", replication],
    ] as const)
      if (phase.status === "rejected")
        errors.push(new Error(`${name} failed`, { cause: phase.reason }));
    if (capture.status === "fulfilled")
      for (const error of capture.value.errors)
        errors.push(new Error(`capture: ${error}`));
    if (reconciliation.status === "fulfilled" && reconciliation.value.failure)
      errors.push(new ReconciliationFailureError(reconciliation.value.failure));
    if (replication.status === "fulfilled")
      for (const peer of replication.value)
        if (peer.error)
          errors.push(new Error(`replication ${peer.peer}: ${peer.error}`));
    if (errors.length)
      throw new AggregateError(errors, errors.map((e) => e.message).join("; "));
    if (
      capture.status !== "fulfilled" ||
      reconciliation.status !== "fulfilled" ||
      replication.status !== "fulfilled"
    )
      throw new Error("maintenance phase unavailable");
    return {
      capture: capture.value,
      reconciliation: reconciliation.value,
      replication: replication.value,
    };
  }
  close(): void {
    this.store.close();
  }
}
export function createMemoryApplication(
  options: MemoryApplicationOptions = {},
): MemoryApplication {
  return new MemoryApplication(options);
}

/** Production opening yields during contention; provider work never owns a transaction. */
export async function openMemoryApplication(
  options: MemoryApplicationOptions = {},
  signal?: AbortSignal,
): Promise<MemoryApplication> {
  const configuration = options.configuration ?? memoryConfiguration();
  const store = await FileMemoryStore.open(
    runtimeStoreConfiguration(configuration),
    { signal },
  );
  try {
    signal?.throwIfAborted();
    return new MemoryApplication({ ...options, configuration }, store);
  } catch (error) {
    store.close();
    throw error;
  }
}

export type MemoryWatchEvent = MemoryWakeEvent & {
  readonly failure?: ReconciliationFailure;
};
export interface MemoryWatchInput {
  readonly job: MemoryJob;
  readonly signal: AbortSignal;
  /** supplied applications own configuration and lifetime; no native discovery. */
  readonly application?: MemoryApplication;
  /** an injected opener owns discovery; its returned application is closed here. */
  readonly open?: (signal: AbortSignal) => Promise<MemoryApplication>;
  readonly policy?: Partial<MemoryWakePolicy>;
  readonly report?: (event: MemoryWatchEvent) => void;
}

/**
 * Keep validated store caches between nudges, not between immutable deployments.
 * Native settings replacement rebuilds the application before further work;
 * supplied applications/openers remain caller-owned configuration boundaries.
 */
export async function watchMemoryApplication(
  input: MemoryWatchInput,
): Promise<void> {
  const native = !input.application && !input.open;
  const settings = native ? resolveGlobalSettingsPath() : null;
  const settingsIdentity = (): string => {
    if (!settings) return "provided";
    try {
      const s = statSync(settings, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  };
  do {
    input.signal.throwIfAborted();
    const identity = settingsIdentity();
    const configuration = native ? memoryConfiguration() : undefined;
    const app =
      input.application ??
      (await (input.open
        ? input.open(input.signal)
        : openMemoryApplication({ configuration }, input.signal)));
    const own = new AbortController();
    const signal = AbortSignal.any([input.signal, own.signal]);
    const paths = runtimeStoreConfiguration(app.configuration);
    let reload = false;
    let failure: ReconciliationFailure | undefined;
    try {
      await watchMemoryWork({
        roots: () => [
          ...(settings ? [settings] : []),
          ...(input.job === "catch-up"
            ? [app.configuration.sessionRoot]
            : [paths.root, join(paths.data, "commits")]),
        ],
        ignore: () => [paths.state, join(paths.data, "objects")],
        checkpoint: join(paths.state, `wakeup-${input.job}.json`),
        signal,
        policy: input.policy,
        report: (event) => {
          const detail = { ...event, ...(failure ? { failure } : {}) };
          if (input.report) input.report(detail);
          else
            console.error(
              JSON.stringify({
                operation: "memory.background",
                job: input.job,
                ...detail,
              }),
            );
        },
        run: async () => {
          failure = undefined;
          if (native) {
            // Invalid mutable settings must fail closed, not use stale authority.
            const next = memoryConfiguration();
            if (
              settingsIdentity() !== identity ||
              JSON.stringify(next) !== JSON.stringify(app.configuration)
            ) {
              reload = true;
              own.abort();
              return { progress: false };
            }
          }
          if (!app.configuration.enabled) return { progress: false };
          if (input.job === "catch-up") {
            const result = await app.catchUp(signal);
            return {
              progress: result.windows > 0,
              failed: result.errors.length > 0,
            };
          }
          if (input.job === "replicate") {
            const result = await app.replicate(signal);
            return {
              progress: result.some(
                (r) => (r.result?.sent ?? 0) + (r.result?.received ?? 0) > 0,
              ),
              // One unavailable peer must not impose its cooldown on healthy ones.
              failed:
                result.length > 0 &&
                result.every((r) => r.error || r.result?.kind === "backoff"),
            };
          }
          const result = await app.reconcile(signal);
          failure = result.failure;
          return {
            progress: result.results.length > 0 && !failure,
            failed: !!failure,
          };
        },
      });
    } catch (error) {
      if (!reload || input.signal.aborted) throw error;
    } finally {
      if (!input.application) app.close();
    }
    if (!reload) return;
  } while (!input.signal.aborted);
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { SessionManager, SettingsManager, ModelRuntime } =
    await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } =
    await import("@earendil-works/pi-ai");
  const { nativeSourceSnapshot, nativeSourceProducer } =
    await import("./pi-source.js");
  const { importLegacyMarkdown } = await import("./legacy-import.js");
  const { handleMemoryJSON } = await import("./cli.js");
  const { authenticateInboundPeer } = await import("./peer-auth.js");
  const now = "2026-01-01T00:00:00.000Z";
  const signal = () => new AbortController().signal;
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "memory-application-"));
    const configuration = memoryConfiguration({
      cwd: dir,
      home: dir,
      settings: {
        sessionDir: "sessions",
        "@bds_pi/agent-memory": {
          root: "notes",
          data: "data",
          state: "state",
          ownerId: "fixture",
          backlog: { minWindows: 1 },
        },
      },
      environment: {},
    });
    const model: C.ConsolidationModel = {
      reconcile: async () => {
        throw new Error("unexpected model work");
      },
    };
    return { dir, configuration, model };
  }
  it("native watchers reload replaced settings before working in a new namespace", async () => {
    const f = fixture();
    const { setGlobalSettingsPath } = await import("@bds_pi/config");
    const original = resolveGlobalSettingsPath();
    const file = join(f.dir, "native-settings.json");
    const controller = new AbortController();
    const keys = [
      "PI_MEMORY_ROOT",
      "PI_MEMORY_DATA_DIR",
      "PI_MEMORY_STATE_DIR",
      "PI_MEMORY_OWNER",
      "PI_MEMORY_MODEL",
      "PI_MEMORY_PEERS",
      "PI_MEMORY_DEFAULT_PEERS",
      "PI_CODING_AGENT_SESSION_DIR",
    ];
    for (const key of keys) vi.stubEnv(key, undefined);
    const config = (namespace: string) =>
      JSON.stringify({
        sessionDir: join(f.dir, "sessions"),
        "@bds_pi/agent-memory": {
          enabled: false,
          ownerId: "fixture",
          root: join(f.dir, namespace, "notes"),
          data: join(f.dir, namespace, "data"),
          state: join(f.dir, namespace, "state"),
          peers: [],
        },
      });
    writeFileSync(file, config("one"));
    setGlobalSettingsPath(file);
    let first!: () => void;
    const ready = new Promise<void>((resolve) => {
      first = resolve;
    });
    const { existsSync, renameSync } = await import("node:fs");
    const task = watchMemoryApplication({
      job: "reconcile",
      signal: controller.signal,
      policy: {
        debounceMs: 5,
        idleInitialMs: 60_000,
        idleMaxMs: 60_000,
        jitterRatio: 0,
      },
      report: (event) => {
        if (event.kind === "run") {
          first();
          if (
            existsSync(
              join(f.dir, "two", "state", "runtime", "coordination.sqlite"),
            )
          )
            controller.abort();
        }
      },
    });
    try {
      await ready;
      writeFileSync(file + ".new", config("two"));
      renameSync(file + ".new", file);
      await Promise.race([
        task,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("native settings replacement was not applied")),
            5000,
          ).unref(),
        ),
      ]);
      expect(
        existsSync(
          join(f.dir, "two", "state", "runtime", "coordination.sqlite"),
        ),
      ).toBe(true);
    } finally {
      controller.abort();
      await task;
      setGlobalSettingsPath(original);
      vi.unstubAllEnvs();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  async function captureWatchFixture(
    app: MemoryApplication,
    dir: string,
    text: string,
  ): Promise<void> {
    const manager = SessionManager.inMemory(dir);
    const entry = manager.appendMessage({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });
    const snapshot = nativeSourceSnapshot(manager);
    const page = await nativeSourceProducer(
      { kind: "provided", snapshot },
      { capturedAt: new Date().toISOString() },
    ).read(
      {
        source: {
          sourceId: snapshot.header.id as C.SourceId,
          producer: "pi-native",
          origin: {
            kind: "session",
            sessionId: snapshot.header.id as C.SessionId,
          },
        },
        scope: app.scope,
        throughEntryId: entry as C.EntryId,
        after: null,
        maxWindows: 1,
        maxWindowBytes: 8192,
      },
      signal(),
    );
    expect((await app.capture(page.windows)).kind).toBe("locally-committed");
  }
  it("a durable native capture nudges reconciliation without waiting for the idle sweep", async () => {
    const f = fixture();
    const { adaptConsolidationProposal } = await import("./model.js");
    let calls = 0;
    const app = await openMemoryApplication({
      configuration: f.configuration,
      model: {
        reconcile: async (input) => {
          calls++;
          return adaptConsolidationProposal(
            {
              notes: [],
              outcomes: input.batch.windows.map(({ window }) => ({
                windowId: window.windowId,
                decision: { kind: "no-change", reason: "fixture retained" },
              })),
            },
            input,
          );
        },
      },
    });
    const controller = new AbortController();
    let ready!: () => void;
    const initial = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const task = watchMemoryApplication({
      application: app,
      job: "reconcile",
      signal: controller.signal,
      policy: {
        debounceMs: 10,
        idleInitialMs: 60_000,
        idleMaxMs: 60_000,
        jitterRatio: 0,
      },
      report: (event) => {
        if (event.kind === "run") {
          ready();
          if (event.progress) controller.abort();
        }
      },
    });
    try {
      await initial;
      await captureWatchFixture(app, f.dir, "the quiet room helps me sleep");
      await Promise.race([
        task,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("capture nudge did not reconcile")),
            5000,
          ).unref(),
        ),
      ]);
      expect(calls).toBe(1);
      expect(await app.store.pendingScopes()).toEqual([]);
    } finally {
      controller.abort();
      await task;
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("fresh captured work cannot bypass a failed model's cooldown or leak its error", async () => {
    const f = fixture();
    let calls = 0;
    const app = await openMemoryApplication({
      configuration: f.configuration,
      model: {
        reconcile: async () => {
          calls++;
          throw new Error("PRIVATE_PROVIDER_ERROR_MARKER");
        },
      },
    });
    const controller = new AbortController();
    const events: MemoryWatchEvent[] = [];
    let failed!: () => void;
    const firstFailure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    await captureWatchFixture(app, f.dir, "first enrolled observation");
    const task = watchMemoryApplication({
      application: app,
      job: "reconcile",
      signal: controller.signal,
      policy: {
        debounceMs: 5,
        failureInitialMs: 1000,
        failureMaxMs: 1000,
        jitterRatio: 0,
      },
      report: (event) => {
        events.push(event);
        if (event.kind === "run" && event.failed) failed();
      },
    });
    try {
      await firstFailure;
      await captureWatchFixture(
        app,
        f.dir,
        "new independent observation while the provider is unavailable",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(1);
      expect(events.some((e) => e.failure?.phase === "provider")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(
        "PRIVATE_PROVIDER_ERROR_MARKER",
      );
      const checkpoint = JSON.parse(
        readFileSync(
          join(
            runtimeStoreConfiguration(f.configuration).state,
            "wakeup-reconcile.json",
          ),
          "utf8",
        ),
      );
      expect(checkpoint.cooldownUntil).toBeGreaterThan(Date.now());
    } finally {
      controller.abort();
      await task;
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("capture and real replica exchange progress past former deadlines while consolidation is pending", async () => {
    const f = fixture(),
      remote = fixture();
    const peer = await openMemoryApplication({
      configuration: remote.configuration,
      model: remote.model,
    });
    const { exchangeReplica } = await import("./replica.js");
    const { adaptConsolidationProposal } = await import("./model.js");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const app = await openMemoryApplication(
      {
        configuration: { ...f.configuration, peers: ["fixture-peer"] },
        transport: () => ({
          exchange: (input, signal) =>
            exchangeReplica(input, {
              store: peer.store,
              peerId: "fixture-source",
              policy: peer.policy(),
              signal,
            }),
        }),
        model: {
          reconcile: async (input) => {
            entered();
            await gate;
            return adaptConsolidationProposal(
              {
                notes: [],
                outcomes: input.batch.windows.map((p) => ({
                  windowId: p.window.windowId,
                  decision: {
                    kind: "no-change",
                    reason: "fixture observation retained",
                  },
                })),
              },
              input,
            );
          },
        },
      },
      controller.signal,
    );
    let other: MemoryApplication | undefined;
    let maintenance: Promise<MaintenanceResult> | undefined;
    const source = async (text: string) => {
      const manager = SessionManager.inMemory(f.dir);
      const entry = manager.appendMessage({
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
      const snapshot = nativeSourceSnapshot(manager);
      return (
        await nativeSourceProducer(
          { kind: "provided", snapshot },
          { capturedAt: new Date().toISOString() },
        ).read(
          {
            source: {
              sourceId: snapshot.header.id as C.SourceId,
              producer: "pi-native",
              origin: {
                kind: "session",
                sessionId: snapshot.header.id as C.SessionId,
              },
            },
            scope: app.scope,
            throughEntryId: entry as C.EntryId,
            after: null,
            maxWindows: 1,
            maxWindowBytes: 8192,
          },
          controller.signal,
        )
      ).windows;
    };
    try {
      const first = await source("i keep my grandfather's green kettle");
      expect((await app.capture(first)).kind).toBe("locally-committed");
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      maintenance = app.maintain(controller.signal);
      await Promise.race([
        started,
        maintenance.then(() => {
          throw new Error("maintenance did not reach the model");
        }),
      ]);
      other = await openMemoryApplication(
        { configuration: f.configuration, model: f.model },
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(200_000);
      const second = await source(
        "i prefer repairing the handle rather than replacing the kettle",
      );
      expect((await other.capture(second)).kind).toBe("locally-committed");
      const retained = (
        await other.store.forPeer("audit").scan(null, 100)
      ).flatMap((c) => c.windows.map((w) => w.windowId));
      expect(retained).toEqual(
        expect.arrayContaining([...first, ...second].map((w) => w.windowId)),
      );
      expect((await app.replicate(controller.signal))[0]?.result?.kind).toBe(
        "complete",
      );
      const replicated = (
        await peer.store.forPeer("audit").scan(null, 100)
      ).flatMap((c) => c.windows.map((w) => w.windowId));
      expect(replicated).toEqual(
        expect.arrayContaining([...first, ...second].map((w) => w.windowId)),
      );
      release();
      expect((await maintenance).reconciliation.results[0]?.kind).toBe(
        "locally-committed",
      );
    } finally {
      release();
      controller.abort();
      await maintenance?.catch(() => {});
      other?.close();
      app.close();
      peer.close();
      vi.useRealTimers();
      rmSync(remote.dir, { recursive: true, force: true });
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("a failed phase waits for owned reconciliation and JSON reports the failed peer", async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await openMemoryApplication({
      configuration: { ...f.configuration, peers: ["fixture-down"] },
      transport: () => {
        throw new Error("fixture transport unavailable");
      },
      model: {
        reconcile: async (input) => {
          entered();
          await gate;
          const outcomes = input.batch.windows.map((p) => ({
            windowId: p.window.windowId,
            decision: {
              kind: "no-change" as const,
              reason: "fixture retained",
            },
          }));
          return { edits: [], outcomes: [outcomes[0]!, ...outcomes.slice(1)] };
        },
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      const manager = SessionManager.inMemory(f.dir);
      manager.appendMessage({
        role: "user",
        content: "meaningful fixture experience",
        timestamp: Date.now(),
      });
      mkdirSync(f.configuration.sessionRoot, { recursive: true });
      writeFileSync(
        join(f.configuration.sessionRoot, "fixture.jsonl"),
        [manager.getHeader(), ...manager.getEntries()]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      await app.catchUp(signal());
      let settled = false;
      running = app.maintain(signal()).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started;
      await new Promise(setImmediate);
      expect(settled).toBe(false);
      release();
      const failure = await running;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String(failure)).toContain("replication fixture-down");
      expect(
        (await app.store.forPeer("audit").scan(null, 100))
          .flatMap((c) => c.outcomes)
          .some((o) => o.decision.kind === "no-change"),
      ).toBe(true);
      await expect(
        handleMemoryJSON({ command: "replicate" }, app, signal()),
      ).rejects.toThrow("fixture-down");
    } finally {
      release();
      await running;
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("finished native session catches up after exit; restart resumes early UTF-8 spans and provided snapshots never reread", async () => {
    const f = fixture();
    const manager = SessionManager.inMemory(f.dir);
    const first = manager.appendMessage({
      role: "user",
      content: "early personal experience 🌿 ".repeat(1100),
      timestamp: Date.parse(now),
    });
    manager.branch(first);
    manager.appendMessage({
      role: "user",
      content: "branch one",
      timestamp: Date.parse(now),
    });
    manager.branch(first);
    manager.appendMessage({
      role: "user",
      content: "branch two",
      timestamp: Date.parse(now),
    });
    const snapshot = nativeSourceSnapshot(manager);
    mkdirSync(f.configuration.sessionRoot, { recursive: true });
    const file = join(f.configuration.sessionRoot, "finished.jsonl");
    writeFileSync(
      file,
      [snapshot.header, ...snapshot.entries]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const bytes = readFileSync(file);
    let app = createMemoryApplication({
      configuration: f.configuration,
      model: f.model,
    });
    const checkpoint = join(
      f.configuration.state,
      "runtime",
      "fixture-progress.json",
    );
    try {
      let bounded = true;
      for (let n = 0; bounded && n < 30; n++) {
        const result = await catchUpNativeSources({
          store: app.store,
          root: f.configuration.sessionRoot,
          checkpoint,
          scope: app.scope,
          signal: signal(),
          maxWindows: 1,
        });
        bounded = result.bounded;
        app.close();
        app = createMemoryApplication({
          configuration: f.configuration,
          model: f.model,
        });
      }
      expect(bounded).toBe(false);
      const changes = await app.store.forPeer("audit").scan(null, 100);
      const windows = [
        ...new Map(
          changes.flatMap((c) => c.windows).map((w) => [w.windowId, w]),
        ).values(),
      ];
      const early = windows
        .filter((w) => w.excerpts[0].span.entryId === first)
        .sort((a, b) => a.excerpts[0].span.start - b.excerpts[0].span.start);
      expect(early.map((w) => w.excerpts[0].text).join("")).toBe(
        "early personal experience 🌿 ".repeat(1100),
      );
      expect(
        windows.flatMap((w) => w.excerpts).map((e) => e.producerRole),
      ).not.toContain("legacy-derived");
      expect(windows.some((w) => w.excerpts[0].text === "branch one")).toBe(
        true,
      );
      expect(windows.some((w) => w.excerpts[0].text === "branch two")).toBe(
        true,
      );
      expect(readFileSync(file)).toEqual(bytes);
      expect((await app.catchUp(signal())).errors).toEqual([]);
      writeFileSync(file, "corrupt");
      const supplied = await catchUpNativeSources({
        store: app.store,
        root: "/must-not-read",
        checkpoint: join(f.dir, "supplied.json"),
        scope: app.scope,
        signal: signal(),
        snapshots: [snapshot],
      });
      expect(supplied.windows).toBeGreaterThan(0);
      await expect(
        handleMemoryJSON(
          { command: "exchange", owner: "injected", outgoing: [] },
          app,
          signal(),
        ),
      ).rejects.toThrow("invalid memory request");
      await expect(
        handleMemoryJSON(
          { command: "status", root: "/injected" },
          app,
          signal(),
        ),
      ).rejects.toThrow("invalid memory request");
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);
  it("maintenance drains JSON-accepted restricted project experience and retains coverage after reopen", async () => {
    const f = fixture();
    const project: C.MemoryScope = {
      kind: "project",
      repositoryId: "fixture-project",
    };
    const { adaptConsolidationProposal } = await import("./model.js");
    const model: C.ConsolidationModel = {
      reconcile: async (input) => {
        const window = input.batch.windows[0].window;
        const text = window.excerpts[0].text;
        return adaptConsolidationProposal(
          {
            notes: [
              {
                key: "decision",
                noteId: null,
                title: "offline project decision",
                body: text,
                scope: project,
                links: [],
                claims: [
                  {
                    kind: "producer-statement",
                    text,
                    evidence: [
                      { windowId: window.windowId, excerptIndexes: [0] },
                    ],
                    derivedFrom: [],
                  },
                ],
              },
            ],
            outcomes: input.batch.windows.map((p) => ({
              windowId: p.window.windowId,
              decision: { kind: "changed", noteKeys: ["decision"] },
            })),
          },
          input,
        );
      },
    };
    let app = createMemoryApplication({
      configuration: f.configuration,
      model,
    });
    try {
      const manager = SessionManager.inMemory(f.dir);
      const entry = manager.appendMessage({
        role: "user",
        content: "i chose offline reconciliation for this project",
        timestamp: Date.now(),
      });
      const snapshot = nativeSourceSnapshot(manager);
      const page = await nativeSourceProducer(
        { kind: "provided", snapshot },
        { capturedAt: new Date().toISOString() },
      ).read(
        {
          source: {
            sourceId: snapshot.header.id as C.SourceId,
            producer: "pi-native",
            origin: {
              kind: "session",
              sessionId: snapshot.header.id as C.SessionId,
            },
          },
          scope: project,
          throughEntryId: entry as C.EntryId,
          after: null,
          maxWindows: 1,
          maxWindowBytes: 8192,
        },
        signal(),
      );
      expect(
        await handleMemoryJSON(
          { command: "capture", windows: page.windows },
          app,
          signal(),
        ),
      ).toMatchObject({ kind: "locally-committed" });
      const accepted = (await app.store.forPeer("audit").scan(null, 1))[0]!;
      expect(await app.store.hasAcceptedCommit(accepted.commitId)).toBe(true);
      expect(await app.store.hasAcceptedCommit("absent" as C.CommitId)).toBe(
        false,
      );
      expect(await app.store.pendingScopes()).toEqual([project]);
      expect(
        (await app.maintain(signal())).reconciliation.results[0],
      ).toMatchObject({ kind: "locally-committed" });
      app.close();
      app = createMemoryApplication({
        configuration: f.configuration,
        model: f.model,
      });
      expect(await app.store.pendingScopes()).toEqual([]);
      const notes = await app.store.listNotes(project);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.markdown).toContain(
        "i chose offline reconciliation for this project",
      );
      expect((await app.maintain(signal())).reconciliation.idle?.reason).toBe(
        "empty",
      );
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("disabled automatic maintenance neither thinks nor exports existing knowledge", async () => {
    const f = fixture();
    const app = createMemoryApplication({
      configuration: {
        ...f.configuration,
        enabled: false,
        peers: ["unreachable-fixture"],
      },
      model: f.model,
      transport: () => {
        throw new Error("automatic transport must remain paused");
      },
    });
    try {
      expect(await app.maintain(signal())).toEqual({
        capture: null,
        reconciliation: { results: [], idle: null },
        replication: [],
      });
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("appended native history resumes its durable span without recapturing the early prefix", async () => {
    const f = fixture();
    const app = createMemoryApplication({
      configuration: f.configuration,
      model: f.model,
    });
    const manager = SessionManager.inMemory(f.dir);
    const checkpoint = join(f.dir, "appending.json");
    const read = () =>
      catchUpNativeSources({
        store: app.store,
        root: "/unused",
        checkpoint,
        scope: app.scope,
        signal: signal(),
        maxWindows: 1,
        snapshots: [nativeSourceSnapshot(manager)],
      });
    try {
      manager.appendMessage({
        role: "user",
        content: "early ".repeat(2000),
        timestamp: Date.parse(now),
      });
      expect((await read()).windows).toBe(1);
      manager.appendMessage({
        role: "user",
        content: "later particular experience",
        timestamp: Date.parse(now),
      });
      expect((await read()).windows).toBe(1);
      expect((await read()).windows).toBe(1);
      expect((await read()).windows).toBe(0);
      const windows = (
        await app.store.forPeer("audit").scan(null, 100)
      ).flatMap((c) => c.windows);
      expect(windows).toHaveLength(3);
      expect(windows.at(-1)?.excerpts[0].text).toBe(
        "later particular experience",
      );
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("a healthy peer durably receives knowledge while another transport remains stalled", async () => {
    const f = fixture(),
      remote = fixture();
    const peer = await openMemoryApplication({
      configuration: remote.configuration,
      model: remote.model,
    });
    const { exchangeReplica } = await import("./replica.js");
    let release!: () => void, received!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const durable = new Promise<void>((resolve) => {
      received = resolve;
    });
    const app = await openMemoryApplication({
      configuration: {
        ...f.configuration,
        peers: ["fixture-stalled", "fixture-healthy"],
      },
      model: f.model,
      transport: (name) =>
        name === "fixture-stalled"
          ? {
              exchange: async () => {
                await gate;
                throw new Error("fixture transport unavailable");
              },
            }
          : {
              exchange: async (input, signal) => {
                const result = await exchangeReplica(input, {
                  store: peer.store,
                  peerId: "fixture-source",
                  policy: peer.policy(),
                  signal,
                });
                if (
                  (await peer.store.listNotes(peer.scope)).some((n) =>
                    n.markdown.includes("my green kettle travels with me"),
                  )
                )
                  received();
                return result;
              },
            },
    });
    let running: Promise<MaintenanceResult["replication"]> | undefined;
    try {
      const path = join(f.dir, "offline.md");
      writeFileSync(path, "my green kettle travels with me");
      await importLegacyMarkdown({
        paths: [path],
        store: app.store,
        scope: app.scope,
        archive: join(f.dir, "archive"),
      });
      let settled = false;
      running = app.replicate(signal()).then((result) => {
        settled = true;
        return result;
      });
      await durable;
      expect((await peer.store.listNotes(peer.scope))[0]?.markdown).toContain(
        "my green kettle travels with me",
      );
      expect(settled).toBe(false);
      release();
      expect(await running).toMatchObject([
        {
          peer: "fixture-stalled",
          error: expect.stringContaining("fixture transport unavailable"),
        },
        { peer: "fixture-healthy", result: { kind: "complete" } },
      ]);
    } finally {
      release();
      await running;
      app.close();
      peer.close();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(remote.dir, { recursive: true, force: true });
    }
  });
  it("application replication converges offline local imports through the same exchange handler", async () => {
    const a = fixture(),
      b = fixture();
    const peer = createMemoryApplication({
      configuration: b.configuration,
      model: b.model,
    });
    const { exchangeReplica } = await import("./replica.js");
    const app = createMemoryApplication({
      configuration: { ...a.configuration, peers: ["fixture-peer"] },
      model: a.model,
      transport: () => ({
        exchange: (input, signal) =>
          exchangeReplica(input, {
            store: peer.store,
            peerId: "fixture-source",
            policy: peer.policy(),
            signal,
          }),
      }),
    });
    try {
      const path = join(a.dir, "offline.md");
      writeFileSync(path, "my green kettle travels with me");
      await importLegacyMarkdown({
        paths: [path],
        store: app.store,
        scope: app.scope,
        archive: join(a.dir, "archive"),
      });
      expect(await peer.store.listNotes(peer.scope)).toHaveLength(0);
      expect((await app.replicate(signal()))[0]?.result?.kind).toBe("complete");
      expect((await peer.store.listNotes(peer.scope))[0]?.markdown).toContain(
        "green kettle",
      );
      expect((await app.replicate(signal()))[0]?.result?.kind).toBe("complete");
      expect(await peer.store.listNotes(peer.scope)).toHaveLength(1);
    } finally {
      app.close();
      peer.close();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
  it("empty/below-threshold stay silent; native SDK provider runs only eligible backlog and no-change survives restart", async () => {
    const f = fixture();
    const clock = new Date(Date.now() + 60_000).toISOString();
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "fixture",
          check: async () => ({ type: "api_key" as const }),
          resolve: async () => ({ auth: { apiKey: "fixture-only" } }),
        },
      },
    });
    const selected = faux.getModel();
    await runtime.setRuntimeApiKey(selected.provider, "fixture-only");
    const model = nativeConsolidationModel({
      cwd: f.dir,
      modelRuntime: runtime,
      model: `${selected.provider}/${selected.id}`,
      settingsManager: SettingsManager.inMemory({
        defaultProvider: selected.provider,
        defaultModel: selected.id,
        retry: { enabled: false },
      }),
    });
    let app = createMemoryApplication({
      configuration: f.configuration,
      model,
      now: () => clock,
    });
    try {
      expect((await app.maintain(signal())).reconciliation.idle?.reason).toBe(
        "empty",
      );
      const { spawnSync } = await import("node:child_process");
      const producer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import { SessionManager } from "@earendil-works/pi-coding-agent";
        import { mkdirSync, writeFileSync } from "node:fs";
        const manager = SessionManager.inMemory(${JSON.stringify(f.dir)});
        manager.appendMessage({ role: "user", content: "i like the quiet room because i sleep better", timestamp: Date.now() });
        mkdirSync(${JSON.stringify(f.configuration.sessionRoot)}, {recursive:true});
        writeFileSync(${JSON.stringify(join(f.configuration.sessionRoot, "exited.jsonl"))}, [manager.getHeader(), ...manager.getEntries().map(e => ({...e, timestamp: "2020-01-01T00:00:00.000Z"}))].map(e=>JSON.stringify(e)).join("\\n") + "\\n");
      `,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: join(f.dir, "agent"),
            PI_OFFLINE: "1",
          },
        },
      );
      expect(producer.status, producer.stderr).toBe(0);
      const original = readFileSync(
        join(f.configuration.sessionRoot, "exited.jsonl"),
      );
      expect((await app.catchUp(signal())).windows).toBe(1);
      expect(
        readFileSync(join(f.configuration.sessionRoot, "exited.jsonl")),
      ).toEqual(original);
      const windows = (await app.store.forPeer("audit").scan(null, 10)).flatMap(
        (c) => c.windows,
      );
      const below = await runReconciliation(
        {
          jobId: "below" as C.JobId,
          owner: "fixture",
          scope: app.scope,
          now: clock,
          policy: { ...f.configuration.backlog, minWindows: 4 },
          maxRunMs: 500,
        },
        { store: app.store, model: f.model, signal: signal() },
      );
      expect(below.idle?.reason).toBe("below-threshold");
      faux.setResponses([
        fauxAssistantMessage(
          JSON.stringify({
            notes: [],
            outcomes: windows.map((w) => ({
              windowId: w.windowId,
              decision: {
                kind: "no-change",
                reason:
                  "fixture evidence intentionally retained without a note",
              },
            })),
          }),
        ),
      ]);
      expect(
        (await app.maintain(signal())).reconciliation.results[0]?.kind,
      ).toBe("locally-committed");
      app.close();
      app = createMemoryApplication({
        configuration: f.configuration,
        model: f.model,
        now: () => clock,
      });
      expect((await app.maintain(signal())).reconciliation.idle?.reason).toBe(
        "empty",
      );
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("explicit legacy imports replay, preserve source bytes, links and derived attribution; suppression blocks recall", async () => {
    const f = fixture();
    const app = createMemoryApplication({
      configuration: f.configuration,
      model: f.model,
    });
    try {
      const a = join(f.dir, "green-kettle.md"),
        b = join(f.dir, "quiet-room.md");
      writeFileSync(
        a,
        "\uFEFFgreen kettle [room](quiet-room.md)\n" + "🌿 ".repeat(3000),
      );
      writeFileSync(b, "quiet room is useful for sleeping\n");
      const bytes = readFileSync(a);
      const input = {
        paths: [a, b],
        store: app.store,
        scope: app.scope,
        archive: join(f.dir, "archive"),
      };
      expect(
        (await importLegacyMarkdown(input)).every(
          (r) => r.kind === "locally-committed",
        ),
      ).toBe(true);
      expect(
        (await importLegacyMarkdown(input)).every(
          (r) => r.kind === "locally-committed" && r.replay,
        ),
      ).toBe(true);
      const notes = await app.store.listNotes(app.scope);
      expect(notes).toHaveLength(2);
      expect(notes.some((n) => n.links.length === 1)).toBe(true);
      expect(
        notes.every((n) =>
          n.markdown.includes("historical derived attribution"),
        ),
      ).toBe(true);
      expect(readFileSync(a)).toEqual(bytes);
      const note = notes.find((n) => n.links.length === 1)!;
      await app.suppress({
        suppressionId: "fixture" as C.SuppressionId,
        scope: app.scope,
        target: { kind: "note", noteId: note.noteId },
        reason: "owner request",
        createdAt: now,
      });
      expect(
        await app.recall(
          {
            intentId: "query" as C.IntentId,
            entryId: "entry" as C.EntryId,
            target: {
              consumerId: "fixture",
              sessionId: "fixture" as C.SessionId,
              scope: app.scope,
            },
            query: "green kettle",
            expiresAt: "2099-01-01T00:00:00.000Z",
            maxChars: 2000,
            maxNotes: 2,
          },
          signal(),
        ),
      ).toEqual({ kind: "discarded", reason: "suppressed" });
    } finally {
      app.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("SSH identity is roster/address bound; forged payloads/non-SSH/unknown/ambiguous connections fail closed", async () => {
    const resolve = async (peer: string) =>
      peer === "alias-a" ? ["192.0.2.1"] : ["192.0.2.2"];
    expect(
      await authenticateInboundPeer({
        connection: "192.0.2.1 1234 192.0.2.9 22",
        peers: ["alias-a", "alias-b"],
        resolve,
      }),
    ).toBe("alias-a");
    for (const connection of [
      undefined,
      "forged",
      "192.0.2.8 1234 192.0.2.9 22",
    ])
      await expect(
        authenticateInboundPeer({ connection, peers: ["alias-a"], resolve }),
      ).rejects.toThrow();
    await expect(
      authenticateInboundPeer({
        connection: "192.0.2.1 1234 192.0.2.9 22",
        peers: ["alias-a", "alias-b"],
        resolve: async () => ["192.0.2.1"],
      }),
    ).rejects.toThrow("ambiguous");
  });
}
