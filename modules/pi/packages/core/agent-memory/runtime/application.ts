import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { nativeConsolidationModel } from "./model.js";
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
 * explicit creation opens the synchronous filesystem store. call from a worker or
 * standalone process, never the primary inference event loop. importing is inert.
 * supplied configuration/model/index own their data and bypass native discovery.
 */
export class MemoryApplication {
  readonly configuration: MemoryConfiguration;
  readonly store: FileMemoryStore;
  readonly index: C.SearchIndex;
  private readonly model: C.ConsolidationModel;
  private readonly now: () => string;
  constructor(private readonly options: MemoryApplicationOptions = {}) {
    this.configuration = options.configuration ?? memoryConfiguration();
    this.store = new FileMemoryStore(
      runtimeStoreConfiguration(this.configuration),
    );
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
    const results: {
      peer: string;
      result?: SynchronizeResult;
      error?: string;
    }[] = [];
    for (const peer of this.configuration.peers) {
      signal.throwIfAborted();
      try {
        results.push({
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
        });
      } catch (error) {
        results.push({ peer, error: String(error) });
      }
    }
    return results;
  }
  async maintain(signal: AbortSignal): Promise<MaintenanceResult> {
    const captured = this.configuration.enabled
      ? await this.catchUp(signal)
      : null;
    const reconciliation = this.configuration.enabled
      ? await runReconciliation(
          {
            jobId: randomUUID() as C.JobId,
            owner: this.configuration.ownerId,
            scope: this.scope,
            now: this.now(),
            policy: this.configuration.backlog,
            maxBatches: 1,
            maxRunMs: 90_000,
          },
          { store: this.store, model: this.model, signal },
        )
      : { results: [], idle: null };
    // transport failure/backoff does not undo local acceptance or stop the next peer.
    const replication = await this.replicate(signal);
    return { capture: captured, reconciliation, replication };
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

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { SessionManager, SettingsManager, ModelRuntime } =
    await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } =
    await import("@earendil-works/pi-ai");
  const { nativeSourceSnapshot } = await import("./pi-source.js");
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
        writeFileSync(${JSON.stringify(join(f.configuration.sessionRoot, "exited.jsonl"))}, [manager.getHeader(), ...manager.getEntries()].map(e=>JSON.stringify(e)).join("\\n") + "\\n");
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
