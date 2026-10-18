import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  linkSync,
  lstatSync,
  openSync,
  closeSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type * as C from "./contracts.js";
import { permitsSourceScope } from "./scope.js";
import {
  canonicalJSON,
  hashSourceWindow,
  revisionId,
  sameProducerSource,
  sameValue,
  sha256,
} from "./identity.js";
import {
  durableCreate,
  confirmDurability,
  cleanupDurableStages,
  prepareDurableCreate,
  physicalIdentity,
  durableDirectory,
  flushDirectory,
  flushFile,
  IntegrityError,
} from "./durability.js";
import {
  markdownIdentity,
  readMarkdownRevision,
  reviseMarkdown,
} from "./markdown.js";
import {
  parseChange,
  parseDelivery,
  parseLease,
  parseReplicaChange,
} from "./wire.js";

export interface FileMemoryStoreConfig {
  readonly root: string;
  readonly data: string;
  readonly state: string;
  readonly replicaId: C.ReplicaId;
  readonly owner: string;
  /** fixture instrumentation at actual durable publication boundaries. */
  readonly publicationBoundary?: (
    boundary:
      | "objects"
      | "manifest"
      | "manifest-linked"
      | "stash"
      | "prepared"
      | "confirming"
      | "fencing"
      | "placement-prepared"
      | "placed"
      | "placement-durable",
    commitId: string,
  ) => void;
}
/** contention budgets exclude synchronous filesystem work already admitted. */
export interface FileMemoryStoreOptions extends C.StoreOperationOptions {
  /** default 5000ms per call; zero attempts once without waiting. */
  readonly contentionTimeoutMs?: number;
}
export class StoreContentionError extends Error {
  readonly code = "MEMORY_STORE_CONTENTION_TIMEOUT";
  constructor() {
    super("memory store contention deadline exceeded");
    this.name = "StoreContentionError";
  }
}
/** only acquisition failures may replay; callbacks and COMMIT must never replay. */
class LockUnavailable extends Error {
  readonly errcode = 5;
  constructor(cause: unknown) {
    super("database is locked", { cause });
  }
}
/** only raised before a transaction callback; no admitted effects are replayed. */
class SnapshotChanged extends LockUnavailable {
  constructor() {
    super(new Error("retained-history snapshot changed"));
  }
}
class LeaseLostBeforePublication extends Error {}
class EditableRepair extends Error {}
class RefreshApplied extends Error {}
function contentionBudget(
  options: FileMemoryStoreOptions,
  fallback: number,
): number {
  const budget = options.contentionTimeoutMs ?? fallback;
  if (!Number.isFinite(budget) || budget < 0)
    throw new Error("contentionTimeoutMs must be finite and nonnegative");
  return budget;
}
async function contend<T>(
  run: () => T,
  options: FileMemoryStoreOptions,
  fallback: number,
): Promise<T> {
  let deadline = performance.now() + contentionBudget(options, fallback);
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    try {
      return run();
    } catch (error) {
      if (!(error instanceof LockUnavailable)) throw error;
      // Retained preparation can be arbitrarily large; only time waiting for
      // coordination consumes this acquisition budget, never accepted evidence.
      deadline += performance.now() - started;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new StoreContentionError();
      // Jitter keeps native worker cohorts from repeatedly waking together.
      try {
        await delay(
          Math.min(
            remaining,
            10 + Math.random() * Math.min(90, 10 * 2 ** Math.min(attempt++, 4)),
          ),
          undefined,
          { signal: options.signal },
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        throw error;
      }
      options.signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new StoreContentionError();
    }
  }
}
interface Manifest {
  version: 1;
  hash: string;
  dependencies: string[];
  replica: string;
  local: string | null;
}
interface Accepted {
  manifest: Manifest;
  replica: C.ReplicaChange;
  local: C.LocalChangeSet | null;
}
interface View {
  accepted: Map<C.CommitId, Accepted>;
  revisions: Map<C.RevisionId, C.NoteRevision>;
  heads: Map<C.NoteId, C.NoteRevision[]>;
  windows: Map<C.WindowId, C.SourceWindow>;
  terminal: Set<C.WindowId>;
  retry: Map<C.WindowId, C.WindowOutcome>;
  suppressions: C.Suppression[];
}
interface Placement {
  path: string;
  revisionId: C.RevisionId;
  candidate: string;
  stash: string;
  snapshot: string | null;
  basis: string | null;
}
interface PreparedPublication extends Accepted {
  stage: string;
}
interface PreparedObject {
  value: unknown;
  bytes: string;
  hash: string;
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new IntegrityError("expected object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new IntegrityError("expected string");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new IntegrityError("expected array");
  return value.map(string);
}
function headsEqual(a: readonly string[], b: readonly string[]): boolean {
  return sameValue([...a].sort(), [...b].sort());
}
function scopeEqual(a: C.MemoryScope, b: C.MemoryScope): boolean {
  return sameValue(a, b);
}
function millis(time: string): number {
  const n = Date.parse(time);
  if (!Number.isFinite(n)) throw new Error("invalid timestamp");
  return n;
}
function iso(n: number): C.Timestamp {
  return new Date(n).toISOString();
}
function operationClock(): { wall: number; monotonic: number } {
  return { wall: Date.now(), monotonic: performance.now() };
}
/** caller clocks remain authoritative; elapsed acceptance time cannot run backward. */
function elapsed(clock: ReturnType<typeof operationClock>): number {
  return Math.max(
    0,
    Date.now() - clock.wall,
    performance.now() - clock.monotonic,
  );
}
function matchesEvidence(a: C.EvidenceRef, b: C.EvidenceRef): boolean {
  return (
    sameProducerSource(a.source, b.source) &&
    a.spans.some((x) =>
      b.spans.some(
        (y) =>
          x.entryId === y.entryId &&
          x.partId === y.partId &&
          (sameValue(x, y) || (x.start < y.end && y.start < x.end)),
      ),
    )
  );
}
interface SuppressionIndex {
  byRevision: Map<C.RevisionId, C.Suppression[]>;
  evidence: {
    scope: C.MemoryScope;
    evidence: C.EvidenceRef;
    rule: C.Suppression;
  }[];
}
const suppressionIndexes = new WeakMap<
  View,
  { revisions: number; rules: number; index: SuppressionIndex }
>();
/** one retained-history closure governs admission, recall and pre-provider filtering. */
function suppressionIndex(view: View): SuppressionIndex {
  const cached = suppressionIndexes.get(view);
  if (
    cached?.revisions === view.revisions.size &&
    cached.rules === view.suppressions.length
  )
    return cached.index;
  const byRevision = new Map<C.RevisionId, C.Suppression[]>();
  const byNote = new Map<C.NoteId, Map<C.SuppressionId, C.Suppression>>();
  const evidence = new Map<string, SuppressionIndex["evidence"][number]>();
  const addEvidence = (
    scope: C.MemoryScope,
    ref: C.EvidenceRef,
    rule: C.Suppression,
  ): void => {
    evidence.set(canonicalJSON({ scope, ref, rule: rule.suppressionId }), {
      scope,
      evidence: ref,
      rule,
    });
  };
  for (const rule of view.suppressions)
    if (rule.target.kind === "evidence")
      addEvidence(rule.scope, rule.target.evidence, rule);
  let changed = view.suppressions.length > 0;
  while (changed) {
    changed = false;
    for (const note of view.revisions.values()) {
      const reasons = new Map<C.SuppressionId, C.Suppression>(
        byNote.get(note.noteId),
      );
      for (const rule of view.suppressions)
        if (
          scopeEqual(rule.scope, note.scope) &&
          rule.target.kind === "note" &&
          rule.target.noteId === note.noteId
        )
          reasons.set(rule.suppressionId, rule);
      const ancestors = [
        ...(note.ancestry.kind === "known" ? note.ancestry.parents : []),
        ...note.claims.flatMap((c) =>
          c.derivedFrom.map((ref) => ref.revisionId),
        ),
      ];
      for (const id of ancestors)
        for (const rule of byRevision.get(id) ?? [])
          reasons.set(rule.suppressionId, rule);
      for (const denied of evidence.values()) {
        const window = view.windows.get(denied.evidence.windowId);
        const relevant =
          scopeEqual(denied.scope, note.scope) ||
          (denied.scope.kind === "personal" &&
            note.scope.kind === "project" &&
            window &&
            scopeEqual(window.scope, denied.scope) &&
            permitsSourceScope(window, note.scope));
        if (
          relevant &&
          note.claims.some((c) =>
            c.evidence.some((ref) => matchesEvidence(ref, denied.evidence)),
          )
        )
          reasons.set(denied.rule.suppressionId, denied.rule);
      }
      if (
        !reasons.size ||
        reasons.size === byRevision.get(note.revisionId)?.length
      )
        continue;
      byRevision.set(note.revisionId, [...reasons.values()]);
      byNote.set(note.noteId, reasons);
      for (const claim of note.claims)
        for (const ref of claim.evidence)
          for (const rule of reasons.values())
            addEvidence(note.scope, ref, rule);
      changed = true;
    }
  }
  const index = { byRevision, evidence: [...evidence.values()] };
  suppressionIndexes.set(view, {
    revisions: view.revisions.size,
    rules: view.suppressions.length,
    index,
  });
  return index;
}
function suppressionsFor(view: View, note: C.NoteRevision): C.Suppression[] {
  return suppressionIndex(view).byRevision.get(note.revisionId) ?? [];
}

/** retry contention asynchronously; never stretch the event-loop blocking timeout. */
export function isStoreBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    (Number(error.errcode) & 0xff) === 5
  );
}

/** local filesystems only. close all instances before rebuilding coordination state. */
export class FileMemoryStore implements C.MemoryStore {
  readonly config: FileMemoryStoreConfig;
  private readonly db: DatabaseSync;
  private watcher: FSWatcher | null = null;
  private readonly confirmed = new Map<string, string>();
  private preparingFiles: Map<string, string> | null = null;
  private preparationGuard: (() => void) | null = null;
  private finalizations: (() => void)[] | null = null;
  private readonly invalidEditable = new Map<string, string>();
  private closed = false;
  /**
   * signal owns acquisition/initialization only; finalization may outlive it.
   * pass an explicit method signal to cancel an operation after opening.
   * failed attempts close their connection before yielding.
   */
  static async open(
    config: FileMemoryStoreConfig,
    options: FileMemoryStoreOptions = {},
  ): Promise<FileMemoryStore> {
    return contend(
      () => {
        const store = new FileMemoryStore(config, options);
        try {
          options.signal?.throwIfAborted();
          const { signal: _acquisitionSignal, ...defaults } = options;
          store.options = defaults;
          return store;
        } catch (error) {
          store.close();
          throw error;
        }
      },
      options,
      5000,
    );
  }
  constructor(
    config: FileMemoryStoreConfig,
    private options: FileMemoryStoreOptions = {},
  ) {
    contentionBudget(options, 5000);
    options.signal?.throwIfAborted();
    this.config = {
      ...config,
      root: resolve(config.root),
      data: resolve(config.data),
      state: resolve(config.state),
    };
    if (
      this.config.root === this.config.data ||
      this.config.root === this.config.state
    )
      throw new Error("root, data and state must be distinct");
    for (const dir of [
      this.config.root,
      this.config.data,
      this.config.state,
      this.objects,
      this.commits,
      this.journals,
      this.recovery,
      this.outbox,
      this.receipts,
    ])
      durableDirectory(dir);
    try {
      this.db = new DatabaseSync(
        join(this.config.state, "coordination.sqlite"),
      );
    } catch (error) {
      if (isStoreBusy(error)) throw new LockUnavailable(error);
      throw error;
    }
    try {
      try {
        this.db
          .exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS leases (window TEXT PRIMARY KEY, token TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_ack (peer TEXT NOT NULL, commit_id TEXT NOT NULL, PRIMARY KEY(peer,commit_id));
      CREATE TABLE IF NOT EXISTS peer_cursor (peer TEXT PRIMARY KEY, cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_epoch (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_payload (commit_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL);`);
      } catch (error) {
        if (isStoreBusy(error)) throw new LockUnavailable(error);
        throw error;
      }
      this.refreshedSync(() => undefined, false);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    this.db.close();
  }
  /** unavailable files stay untouched; distinguish degradation from an empty vault. */
  editableProblems(): readonly { path: string; reason: string }[] {
    return [...this.invalidEditable].map(([path, reason]) => ({
      path,
      reason,
    }));
  }
  /** hints reduce latency; operations still rescan after missing every event. */
  watch(onHint: () => void): void {
    if (this.closed) throw new Error("memory store is closed");
    this.watcher?.close();
    this.watcher = watch(this.config.root, { recursive: true }, () => onHint());
  }
  private get objects(): string {
    return join(this.config.data, "objects");
  }
  private get commits(): string {
    return join(this.config.data, "commits");
  }
  private get journals(): string {
    return join(this.config.data, "materialization");
  }
  private get recovery(): string {
    return join(this.config.root, ".pi-memory-recovery");
  }
  private get outbox(): string {
    return join(this.config.data, "local-outbox");
  }
  private get receipts(): string {
    return join(this.config.data, "local-dispatch");
  }
  private localValue(path: string): unknown {
    const envelope = record(json(path));
    const value = envelope.value;
    if (string(envelope.hash) !== sha256(canonicalJSON(value)))
      throw new IntegrityError("corrupt local ledger");
    return value;
  }
  private localCreate(path: string, value: unknown): void {
    durableCreate(
      path,
      canonicalJSON({ value, hash: sha256(canonicalJSON(value)) }),
    );
  }
  private prepareLocalPublication(path: string, value: unknown): () => void {
    const bytes = canonicalJSON({ value, hash: sha256(canonicalJSON(value)) });
    const existing = existsSync(path);
    if (existing && readFileSync(path, "utf8") !== bytes)
      throw new IntegrityError("immutable local ledger collision");
    const stage = join(dirname(path), `.prepared-${sha256(bytes)}`);
    durableCreate(stage, bytes);
    this.observe(stage);
    if (existing) this.observe(path);
    return () => {
      if (!existing) {
        linkSync(stage, path);
        this.db
          .prepare(
            "INSERT INTO publication_generation(id,generation) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1",
          )
          .run();
      }
      if (!this.finalizations)
        throw new IntegrityError("missing ledger finalization owner");
      this.finalizations.push(() => confirmDurability(path));
    };
  }
  private dispatched(id: C.DeliveryId): boolean {
    const path = join(this.receipts, sha256(id));
    if (!existsSync(path)) return false;
    const value = record(this.localValue(path));
    if (
      value.deliveryId !== id ||
      (value.kind !== "queued" && value.kind !== "discarded")
    )
      throw new IntegrityError("invalid dispatch receipt");
    return true;
  }
  private transaction<T>(
    run: (view: View) => T,
    options = this.options,
  ): Promise<T> {
    return contend(() => this.transactionSync(run), options, 5000);
  }
  private transactionSync<T>(
    run: (view: View) => T,
    write = true,
    objects: readonly PreparedObject[] = [],
    refresh = false,
    prepare?: (view: View) => (view: View) => T,
  ): T {
    if (this.closed) throw new Error("memory store is closed");
    const prepared = new Map<string, string>();
    for (const object of objects) {
      const path = join(this.objects, object.hash);
      const identity = prepareDurableCreate(path, object.bytes);
      if (identity === null) throw new SnapshotChanged();
      prepared.set(path, identity);
      this.confirmed.set(path, identity);
    }
    const generation = this.publicationGeneration();
    const files = new Map<string, string>();
    this.preparingFiles = files;
    let view: View;
    try {
      if (write)
        for (const dir of [this.objects, this.commits])
          for (const file of readdirSync(dir)) {
            const match = /^\.pi-memory-stage-([a-f0-9]{64})-/.exec(file);
            if (
              match &&
              !prepared.has(join(dir, match[1]!)) &&
              existsSync(join(dir, match[1]!))
            )
              cleanupDurableStages(join(dir, match[1]!));
          }
      this.observe(this.commits);
      for (const [path, identity] of prepared) {
        if (this.observe(path) !== identity) throw new SnapshotChanged();
      }
      // Immutable bytes and physical durability are prepared without reserving
      // the database writer. The acceptance check below fences this exact read.
      view = this.recover(write);
      this.preparationGuard = () => {
        this.validatePreparation(generation, files);
      };
      if (refresh) {
        if (this.scan(view, write) || this.materialize(view, write)) {
          if (!write) throw new EditableRepair();
          throw new RefreshApplied();
        }
      }
      if (prepare) run = prepare(view);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new SnapshotChanged();
      throw error;
    } finally {
      this.preparationGuard = null;
      this.preparingFiles = null;
    }
    this.config.publicationBoundary?.("prepared", String(generation));
    const finalizations: (() => void)[] = [];
    this.finalizations = finalizations;
    try {
      return this.coordinateSync(
        () => {
          if (write) this.synchronizeContinuity(view);
          return run(view);
        },
        write,
        () => this.validatePreparation(generation, files),
      );
    } finally {
      this.finalizations = null;
      for (const finish of finalizations) finish();
    }
  }
  private publicationGeneration(): number {
    const row = this.db
      .prepare("SELECT generation FROM publication_generation WHERE id=1")
      .get();
    return row ? Number(row.generation) : 0;
  }
  private observe(path: string): string {
    const identity = physicalIdentity(path);
    const previous = this.preparingFiles?.get(path);
    if (previous !== undefined && previous !== identity)
      throw new SnapshotChanged();
    this.preparingFiles?.set(path, identity);
    return identity;
  }
  private validatePreparation(
    generation: number,
    files: ReadonlyMap<string, string>,
  ): void {
    if (generation !== this.publicationGeneration())
      throw new SnapshotChanged();
    this.config.publicationBoundary?.("fencing", String(generation));
    // These metadata comparisons fence replaced physical files and editable
    // inodes under a WAL reader, before acquiring the writer reservation.
    for (const [path, identity] of files) {
      try {
        if (physicalIdentity(path) === identity) continue;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      throw new SnapshotChanged();
    }
  }
  private requirePreparation(): void {
    if (!this.preparationGuard)
      throw new IntegrityError("missing preparation fence");
    this.preparationGuard();
  }
  private confirmPhysical(path: string): void {
    const identity = this.observe(path);
    if (this.confirmed.get(path) === identity) return;
    this.config.publicationBoundary?.("confirming", path);
    confirmDurability(path);
    if (this.observe(path) !== identity) throw new SnapshotChanged();
    this.confirmed.set(path, identity);
  }
  private coordinateSync<T>(
    run: () => T,
    write = true,
    validate?: () => void,
  ): T {
    if (this.closed) throw new Error("memory store is closed");
    try {
      this.db.exec(validate ? "BEGIN" : write ? "BEGIN IMMEDIATE" : "BEGIN");
    } catch (error) {
      if (isStoreBusy(error)) throw new LockUnavailable(error);
      throw error;
    }
    let entered = false;
    try {
      // WAL readers do not reserve a writer. Pin the generation while checking
      // physical metadata, then upgrade this SAME snapshot before any effects.
      // A concurrent capture/renewal makes the upgrade fail with BUSY_SNAPSHOT;
      // only this pre-callback acquisition may replay preparation.
      validate?.();
      if (validate && write)
        this.db.exec(
          "UPDATE publication_generation SET generation=generation WHERE id=1",
        );
      entered = true;
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if ((!entered || !write) && isStoreBusy(error))
        throw new LockUnavailable(error);
      throw error;
    }
  }
  /** operational proofs never certify a different or rolled-back immutable history. */
  private synchronizeContinuity(view: View, initialize = false): string | null {
    const row = this.db
      .prepare("SELECT token FROM repository_epoch WHERE id=1")
      .get();
    if (!row && !initialize) return null;
    let token = row ? string(row.token) : randomUUID();
    const retained = this.db
      .prepare("SELECT commit_id,payload_hash FROM repository_payload")
      .all();
    const changed = retained.some(
      (item) =>
        view.accepted.get(string(item.commit_id) as C.CommitId)?.manifest
          .replica !== string(item.payload_hash),
    );
    if (changed) {
      token = randomUUID();
      this.db.exec("DELETE FROM repository_payload");
    }
    if (!row || changed)
      this.db
        .prepare(
          "INSERT OR REPLACE INTO repository_epoch(id,token) VALUES(1,?)",
        )
        .run(token);
    const known = changed
      ? new Set<string>()
      : new Set(retained.map((item) => string(item.commit_id)));
    const insert = this.db.prepare(
      "INSERT INTO repository_payload(commit_id,payload_hash) VALUES(?,?)",
    );
    for (const [id, accepted] of view.accepted)
      if (!known.has(id)) insert.run(id, accepted.manifest.replica);
    return token;
  }
  private refreshed<T>(
    run: (view: View) => T,
    write = true,
    options = this.options,
    objects: readonly PreparedObject[] = [],
    prepare?: (view: View) => (view: View) => T,
  ): Promise<T> {
    return contend(
      () => this.refreshedSync(run, write, objects, prepare),
      options,
      5000,
    );
  }
  private refreshedSync<T>(
    run: (view: View) => T,
    write: boolean,
    objects: readonly PreparedObject[] = [],
    prepare?: (view: View) => (view: View) => T,
  ): T {
    // Editable traversal, revision derivation and placement preparation reserve
    // no writer. Every effect rechecks this exact snapshot before acceptance.
    const previousProblems = new Map(this.invalidEditable);
    for (;;) {
      try {
        return this.transactionSync(run, write, objects, true, prepare);
      } catch (error) {
        if (error instanceof RefreshApplied) {
          write = true;
          continue;
        }
        this.invalidEditable.clear();
        for (const [path, reason] of previousProblems)
          this.invalidEditable.set(path, reason);
        if (error instanceof EditableRepair) {
          write = true;
          continue;
        }
        throw error;
      }
    }
  }
  private put(value: unknown): string {
    const bytes = canonicalJSON(value);
    const hash = sha256(bytes);
    const path = join(this.objects, hash);
    const identity = prepareDurableCreate(path, bytes);
    if (identity === null) throw new SnapshotChanged();
    this.confirmed.set(path, identity);
    this.observe(path);
    return hash;
  }
  private get(hash: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new IntegrityError("invalid object hash");
    const path = join(this.objects, hash);
    if (!existsSync(path))
      throw new IntegrityError(`missing dependency ${hash}`);
    this.observe(path);
    const bytes = readFileSync(path, "utf8");
    if (sha256(bytes) !== hash)
      throw new IntegrityError(`corrupt dependency ${hash}`);
    return JSON.parse(bytes);
  }
  private recover(confirm = true): View {
    const view: View = {
      accepted: new Map(),
      revisions: new Map(),
      heads: new Map(),
      windows: new Map(),
      terminal: new Set(),
      retry: new Map(),
      suppressions: [],
    };
    const suppressionIds = new Map<string, string>();
    const retained = this.readAccepted();
    for (const accepted of retained) {
      const { replica } = accepted;
      view.accepted.set(replica.commitId, accepted);
      for (const r of replica.revisions) {
        const old = view.revisions.get(r.revisionId);
        if (old && !sameValue(old, r))
          throw new IntegrityError("revision collision");
        view.revisions.set(r.revisionId, r);
      }
      for (const w of replica.windows) {
        const old = view.windows.get(w.windowId);
        if (old && hashSourceWindow(old) !== hashSourceWindow(w))
          throw new IntegrityError("window collision");
        if (!old || w.capturedAt < old.capturedAt)
          view.windows.set(w.windowId, w);
      }
      for (const s of replica.suppressions) {
        const old = suppressionIds.get(s.suppressionId);
        if (old && old !== canonicalJSON(s))
          throw new IntegrityError("suppression collision");
        if (!old) {
          suppressionIds.set(s.suppressionId, canonicalJSON(s));
          view.suppressions.push(s);
        }
      }
    }
    return this.deriveView(view, confirm);
  }
  private readAccepted(): Accepted[] {
    const retained: Accepted[] = [];
    for (const file of readdirSync(this.commits).filter(
      (f) => !f.startsWith("."),
    )) {
      const path = join(this.commits, file);
      this.observe(path);
      const m = record(json(path));
      if (m.version !== 1) throw new IntegrityError("unsupported manifest");
      const manifest: Manifest = {
        version: 1,
        hash: string(m.hash),
        dependencies: strings(m.dependencies),
        replica: string(m.replica),
        local: m.local === null ? null : string(m.local),
      };
      const { hash, ...payload } = manifest;
      if (sha256(canonicalJSON(payload)) !== hash)
        throw new IntegrityError("manifest hash mismatch");
      for (const dep of manifest.dependencies) this.get(dep);
      if (
        !manifest.dependencies.includes(manifest.replica) ||
        (manifest.local !== null &&
          !manifest.dependencies.includes(manifest.local))
      )
        throw new IntegrityError("undeclared manifest dependency");
      const replica = parseReplicaChange(this.get(manifest.replica));
      if (sha256(replica.commitId) !== file)
        throw new IntegrityError("manifest identity mismatch");
      for (const object of [...replica.revisions, ...replica.windows])
        if (!manifest.dependencies.includes(sha256(canonicalJSON(object))))
          throw new IntegrityError("missing exact object dependency");
      const local =
        manifest.local === null ? null : parseChange(this.get(manifest.local));
      if (
        local &&
        (!sameValue(
          local.edits.map((e) => e.revision),
          replica.revisions,
        ) ||
          !replica.windows.every((w) =>
            local.windows.some((x) => sameValue(x, w)),
          ) ||
          !sameValue(local.suppressions, replica.suppressions))
      )
        throw new IntegrityError("local manifest disagreement");
      if (local && local.commitId !== replica.commitId)
        throw new IntegrityError("local identity mismatch");
      retained.push({ manifest, replica, local });
    }
    return retained;
  }
  private deriveView(view: View, confirm: boolean): View {
    const causal = this.orderedChanges(view).map((c) =>
      view.accepted.get(c.commitId)!,
    );
    view.windows.clear();
    for (const a of causal)
      for (const w of a.replica.windows)
        if (!view.windows.has(w.windowId)) view.windows.set(w.windowId, w);
    for (const a of causal) {
      for (const w of a.local?.windows ?? [])
        if (view.windows.get(w.windowId)?.sourceHash !== w.sourceHash)
          throw new IntegrityError("missing replayed window");
      for (const p of a.replica.parents)
        if (!view.accepted.has(p))
          throw new IntegrityError(`missing parent commit ${p}`);
      for (const r of a.replica.revisions) {
        if (r.ancestry.kind === "known")
          for (const p of r.ancestry.parents) {
            const parent = view.revisions.get(p);
            if (!parent || parent.noteId !== r.noteId)
              throw new IntegrityError(`missing revision parent ${p}`);
          }
        this.validateEvidence(view, r);
      }
      for (const s of a.replica.suppressions)
        if (s.target.kind === "evidence")
          this.validateEvidenceRef(view, s.scope, s.target.evidence);
      for (const o of a.replica.outcomes) {
        this.validateOutcome(view, o);
        view.terminal.add(o.windowId);
      }
      for (const o of a.local?.outcomes ?? [])
        if (o.decision.kind === "retry") {
          this.validateOutcome(view, o);
          view.retry.set(o.windowId, o);
        }
    }
    if (confirm)
      for (const a of causal) {
        for (const dependency of a.manifest.dependencies)
          this.confirmPhysical(join(this.objects, dependency));
        this.confirmPhysical(join(this.commits, sha256(a.replica.commitId)));
      }
    const retired = new Set<C.RevisionId>();
    for (const r of view.revisions.values())
      if (r.ancestry.kind === "known")
        r.ancestry.parents.forEach((p) => retired.add(p));
    for (const r of view.revisions.values())
      if (!retired.has(r.revisionId)) {
        const heads = view.heads.get(r.noteId) ?? [];
        heads.push(r);
        view.heads.set(r.noteId, heads);
      }
    return view;
  }
  private validateEvidence(view: View, r: C.NoteRevision): void {
    const editable = markdownIdentity(r.markdown);
    if (!editable || editable.noteId !== r.noteId)
      throw new IntegrityError(
        "missing/mismatched permanent markdown identity; use createNoteRevision",
      );
    for (const claim of r.claims) {
      for (const e of claim.evidence)
        this.validateEvidenceRef(view, r.scope, e);
      for (const ref of claim.derivedFrom) {
        const ancestor = view.revisions.get(ref.revisionId);
        if (
          ancestor?.noteId !== ref.noteId ||
          (!scopeEqual(ancestor.scope, r.scope) &&
            !ancestor.claims.some((parentClaim) =>
              parentClaim.evidence.some((evidence) => {
                const window = view.windows.get(evidence.windowId);
                return window && this.permitsEvidenceScope(window, r.scope);
              }),
            ))
        )
          throw new IntegrityError("missing/wrong-scope claim lineage");
      }
    }
  }
  /** personal source access may narrow to its producer-observed project, never widen. */
  private permitsEvidenceScope(
    window: C.SourceWindow,
    target: C.MemoryScope,
  ): boolean {
    return permitsSourceScope(window, target, this.config.owner);
  }
  private validateEvidenceRef(
    view: View,
    scope: C.MemoryScope,
    e: C.EvidenceRef,
  ): void {
    const w = view.windows.get(e.windowId);
    if (
      !w ||
      w.sourceHash !== e.sourceHash ||
      !sameValue(w.source, e.source) ||
      !this.permitsEvidenceScope(w, scope)
    )
      throw new IntegrityError("evidence identity/scope mismatch");
    for (const s of e.spans)
      if (!w.excerpts.some((x) => sameValue(x.span, s)))
        throw new IntegrityError("evidence span mismatch");
  }
  private validateOutcome(view: View, o: C.WindowOutcome): void {
    if (view.windows.get(o.windowId)?.sourceHash !== o.sourceHash)
      throw new IntegrityError("outcome source mismatch");
    if (o.decision.kind === "changed")
      for (const n of o.decision.notes)
        if (view.revisions.get(n.revisionId)?.noteId !== n.noteId)
          throw new IntegrityError("outcome note mismatch");
  }
  private verifyDependencies(dependencies: readonly string[]): void {
    dependencies.forEach((hash) => this.get(hash));
  }
  private preparePublication(
    replica: C.ReplicaChange,
    local: C.LocalChangeSet | null,
  ): PreparedPublication {
    const dependencies = [...replica.revisions, ...replica.windows].map((x) =>
      this.put(x),
    );
    const replicaHash = this.put(replica);
    dependencies.push(replicaHash);
    const localHash = local ? this.put(local) : null;
    if (localHash) dependencies.push(localHash);
    this.config.publicationBoundary?.("objects", replica.commitId);
    this.verifyDependencies(dependencies);
    const payload = {
      version: 1 as const,
      dependencies: [...new Set(dependencies)].sort(),
      replica: replicaHash,
      local: localHash,
    };
    const manifest: Manifest = {
      ...payload,
      hash: sha256(canonicalJSON(payload)),
    };
    // The prepared inode is durable before its name can grant acceptance.
    const stage = join(this.journals, `.manifest-${manifest.hash}`);
    durableCreate(stage, canonicalJSON(manifest));
    this.observe(stage);
    for (const hash of dependencies) this.observe(join(this.objects, hash));
    return { manifest, replica, local, stage };
  }
  private acceptPublication(
    prepared: PreparedPublication,
    beforePublication?: () => void,
  ): void {
    const { replica, manifest } = prepared;
    const path = join(this.commits, sha256(replica.commitId));
    beforePublication?.();
    linkSync(prepared.stage, path);
    this.config.publicationBoundary?.("manifest-linked", replica.commitId);
    this.db
      .prepare(
        "INSERT INTO publication_generation(id,generation) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1",
      )
      .run();
    const finish = () => {
      confirmDurability(path);
      this.confirmed.set(path, physicalIdentity(path));
      this.config.publicationBoundary?.("manifest", replica.commitId);
    };
    if (this.finalizations) this.finalizations.push(finish);
    else throw new IntegrityError("publication requires a finalization owner");
  }
  private publish(
    replica: C.ReplicaChange,
    local: C.LocalChangeSet | null,
  ): void {
    const prepared = this.preparePublication(replica, local);
    const finalizations: (() => void)[] = [];
    this.finalizations = finalizations;
    try {
      this.coordinateSync(
        () => {
          this.acceptPublication(prepared);
        },
        true,
        () => this.requirePreparation(),
      );
    } finally {
      this.finalizations = null;
      for (const finish of finalizations) finish();
    }
  }
  async commit(
    value: C.LocalChangeSet,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.CommitResult> {
    const clock = operationClock();
    options = { ...this.options, ...options };
    // Preparation must own its bytes across asynchronous contention. A caller
    // mutating its request cannot change which payload a prepared hash names.
    const change = parseChange(structuredClone(value));
    const objects = [
      ...change.edits.map((edit) => edit.revision),
      ...change.windows,
      change,
    ].map((value) => {
      const bytes = canonicalJSON(value);
      return { value, bytes, hash: sha256(bytes) };
    });
    return this.refreshed<C.CommitResult>(
      () => {
        throw new Error("missing prepared acceptance");
      },
      true,
      options,
      objects,
      (view) => {
        const prepare = ():
          | C.CommitResult
          | { kind: "prepared"; publication: PreparedPublication } => {
          const previous = view.accepted.get(change.commitId);
          if (previous)
            return previous.local && sameValue(previous.local, change)
              ? {
                  kind: "locally-committed",
                  commitId: change.commitId,
                  replay: true,
                }
              : { kind: "identity-conflict", commitId: change.commitId };
          options.signal?.throwIfAborted();
          const now = millis(change.now) + elapsed(clock);
          if (change.lease) {
            const rows = this.db
              .prepare("SELECT window,payload FROM leases WHERE token=?")
              .all(change.lease.leaseId);
            if (
              !rows.length ||
              millis(change.lease.expiresAt) <= now ||
              rows.some(
                (r) =>
                  !sameValue(
                    parseLease(JSON.parse(string(r.payload))),
                    change.lease,
                  ),
              )
            )
              return { kind: "lease-lost" };
            if (
              !headsEqual(
                rows.map((r) => string(r.window)),
                change.outcomes.map((o) => o.windowId),
              )
            )
              throw new Error("every leased window needs exactly one outcome");
            const leasedScope = view.windows.get(
              string(rows[0]!.window) as C.WindowId,
            )?.scope;
            if (
              !leasedScope ||
              rows.some(
                (r) =>
                  !scopeEqual(
                    view.windows.get(string(r.window) as C.WindowId)!.scope,
                    leasedScope,
                  ),
              ) ||
              change.edits.some(
                (edit) =>
                  !scopeEqual(edit.revision.scope, leasedScope) &&
                  !edit.revision.claims.some((claim) =>
                    claim.evidence.some(
                      (evidence) =>
                        rows.some(
                          (row) => string(row.window) === evidence.windowId,
                        ) &&
                        this.permitsEvidenceScope(
                          view.windows.get(evidence.windowId)!,
                          edit.revision.scope,
                        ),
                    ),
                  ),
              ) ||
              change.suppressions.some((s) => !scopeEqual(s.scope, leasedScope))
            )
              throw new Error("lease scope mismatch");
          } else if (change.outcomes.length)
            throw new Error("outcomes require a fenced lease");
          if (
            new Set(change.edits.map((e) => e.revision.noteId)).size !==
            change.edits.length
          )
            throw new Error("one edit per note per batch");
          if (
            new Set(change.outcomes.map((o) => o.windowId)).size !==
            change.outcomes.length
          )
            throw new Error("duplicate window outcome");
          const suppressionIds = new Map(
            view.suppressions.map((s) => [s.suppressionId, s]),
          );
          for (const s of change.suppressions) {
            const old = suppressionIds.get(s.suppressionId);
            if (old && !sameValue(old, s))
              throw new IntegrityError("suppression collision");
            suppressionIds.set(s.suppressionId, s);
          }
          const next = this.preview(
            view,
            change.windows,
            change.edits.map((e) => e.revision),
            change.suppressions,
          );
          for (const s of change.suppressions)
            if (s.target.kind === "evidence")
              this.validateEvidenceRef(next, s.scope, s.target.evidence);
          for (const e of change.edits) {
            this.safePath(e.revision.path);
            const current = view.heads.get(e.revision.noteId) ?? [];
            if (
              !headsEqual(
                e.expectedHeads,
                current.map((n) => n.revisionId),
              )
            )
              return { kind: "conflict", current };
            if (current.some((r) => !scopeEqual(r.scope, e.revision.scope)))
              throw new Error("note scope cannot change");
            if (
              e.revision.ancestry.kind === "known" &&
              !headsEqual(e.revision.ancestry.parents, e.expectedHeads)
            )
              throw new Error("edit ancestry must name expected heads");
            this.validateEvidence(next, e.revision);
            const suppressed = suppressionsFor(next, e.revision);
            if (suppressed.length && e.revision.exposure.kind !== "deleted")
              return {
                kind: "suppressed",
                suppressions: [suppressed[0]!, ...suppressed.slice(1)],
              };
          }
          for (const o of change.outcomes) {
            this.validateOutcome(next, o);
            if (view.terminal.has(o.windowId))
              throw new Error("window already consumed");
            if (o.decision.kind === "changed")
              for (const ref of o.decision.notes) {
                const r = next.revisions.get(ref.revisionId)!;
                if (
                  !this.permitsEvidenceScope(
                    next.windows.get(o.windowId)!,
                    r.scope,
                  )
                )
                  throw new Error("outcome scope mismatch");
                const suppressed = suppressionsFor(next, r);
                if (suppressed.length)
                  return {
                    kind: "suppressed",
                    suppressions: [suppressed[0]!, ...suppressed.slice(1)],
                  };
              }
          }
          const newWindows = [
            ...new Map(
              change.windows
                .filter((w) => !view.windows.has(w.windowId))
                .map((w) => [w.windowId, w]),
            ).values(),
          ];
          const replica: C.ReplicaChange = {
            commitId: change.commitId,
            replicaId: this.config.replicaId,
            parents: this.commitHeads(view),
            revisions: change.edits.map((e) => e.revision),
            windows: newWindows,
            suppressions: change.suppressions,
            outcomes: change.outcomes.flatMap((o) =>
              o.decision.kind === "retry"
                ? []
                : [{ ...o, decision: o.decision }],
            ),
          };
          options.signal?.throwIfAborted();
          // Validation above may itself be substantial for a retained batch.
          if (
            change.lease &&
            millis(change.lease.expiresAt) <=
              millis(change.now) + elapsed(clock)
          )
            return { kind: "lease-lost" };
          return {
            kind: "prepared",
            publication: this.preparePublication(replica, change),
          };
        };
        const result = prepare();
        return () => {
          if (result.kind !== "prepared") return result;
          // Renewal/reclaim can occur during file preparation. Recheck the exact
          // lease payload at acceptance, as well as elapsed expiry/cancellation.
          const checkLease = () => {
            options.signal?.throwIfAborted();
            if (change.lease) {
              const rows = this.db
                .prepare("SELECT payload FROM leases WHERE token=?")
                .all(change.lease.leaseId);
              if (
                !rows.length ||
                rows.some(
                  (row) =>
                    !sameValue(
                      parseLease(JSON.parse(string(row.payload))),
                      change.lease,
                    ),
                ) ||
                millis(change.lease.expiresAt) <=
                  millis(change.now) + elapsed(clock)
              )
                throw new LeaseLostBeforePublication();
            }
          };
          try {
            this.acceptPublication(result.publication, checkLease);
          } catch (error) {
            if (error instanceof LeaseLostBeforePublication)
              return { kind: "lease-lost" };
            throw error;
          }
          if (change.lease)
            this.db
              .prepare("DELETE FROM leases WHERE token=?")
              .run(change.lease.leaseId);
          return {
            kind: "locally-committed",
            commitId: change.commitId,
            replay: false,
          };
        };
      },
    ).then(async (result) => {
      if (result.kind === "locally-committed")
        await this.refreshed(() => undefined, true, {
          ...options,
          signal: undefined,
        });
      return result;
    });
  }
  private preview(
    view: View,
    windows: readonly C.SourceWindow[],
    revisions: readonly C.NoteRevision[],
    suppressions: readonly C.Suppression[],
  ): View {
    const next: View = {
      ...view,
      windows: new Map(view.windows),
      revisions: new Map(view.revisions),
      suppressions: [...view.suppressions, ...suppressions],
    };
    for (const w of windows) next.windows.set(w.windowId, w);
    for (const r of revisions) next.revisions.set(r.revisionId, r);
    return next;
  }
  private commitHeads(view: View): C.CommitId[] {
    const parents = new Set(
      [...view.accepted.values()].flatMap((a) => a.replica.parents),
    );
    return [...view.accepted.keys()].filter((id) => !parents.has(id)).sort();
  }
  async listNotes(
    scope: C.MemoryScope,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<readonly C.NoteRevision[]> {
    return this.refreshed(
      (v) =>
        [...v.heads.values()]
          .flat()
          .filter(
            (r) =>
              scopeEqual(r.scope, scope) && !this.invalidEditable.has(r.path),
          ),
      false,
      options,
    );
  }
  async readNotes(
    scope: C.MemoryScope,
    ids: readonly C.NoteId[],
    options: FileMemoryStoreOptions = this.options,
  ): Promise<readonly C.NoteRevision[]> {
    const wanted = new Set(ids);
    return (await this.listNotes(scope, options)).filter((n) =>
      wanted.has(n.noteId),
    );
  }
  async readSuppressions(
    scope: C.MemoryScope,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<readonly C.Suppression[]> {
    return this.refreshed(
      (v) => v.suppressions.filter((s) => scopeEqual(s.scope, scope)),
      false,
      options,
    );
  }
  async readSuppressionClosure(
    scope: C.MemoryScope,
    restrictions: readonly C.Suppression[] = [],
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.SuppressionClosure> {
    return this.refreshed(
      (retained) => {
        for (const rule of restrictions) {
          const existing = retained.suppressions.find(
            (candidate) => candidate.suppressionId === rule.suppressionId,
          );
          if (existing && !sameValue(existing, rule))
            throw new IntegrityError("suppression collision");
        }
        const view = restrictions.length
          ? this.preview(retained, [], [], restrictions)
          : retained;
        const index = suppressionIndex(view);
        const noteIds = new Set(
          view.suppressions.flatMap((rule) =>
            scopeEqual(rule.scope, scope) && rule.target.kind === "note"
              ? [rule.target.noteId]
              : [],
          ),
        );
        for (const note of view.revisions.values())
          if (
            scopeEqual(note.scope, scope) &&
            index.byRevision.has(note.revisionId)
          )
            noteIds.add(note.noteId);
        return {
          noteIds: [...noteIds].sort(),
          evidence: [
            ...new Map(
              index.evidence
                .filter((item) => scopeEqual(item.scope, scope))
                .map((item) => [canonicalJSON(item.evidence), item.evidence]),
            ).values(),
          ],
        };
      },
      false,
      options,
    );
  }
  async hasAcceptedCommit(
    id: C.CommitId,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<boolean> {
    return this.refreshed((view) => view.accepted.has(id), false, options);
  }
  async pendingScopes(
    options: FileMemoryStoreOptions = this.options,
  ): Promise<readonly C.MemoryScope[]> {
    return this.refreshed(
      (view) => {
        const scopes = new Map<
          string,
          { scope: C.MemoryScope; oldest: string }
        >();
        for (const window of view.windows.values()) {
          if (
            view.terminal.has(window.windowId) ||
            (window.scope.kind === "personal" &&
              window.scope.ownerId !== this.config.owner)
          )
            continue;
          const key = canonicalJSON(window.scope);
          const prior = scopes.get(key);
          if (!prior || prior.oldest > window.capturedAt)
            scopes.set(key, { scope: window.scope, oldest: window.capturedAt });
        }
        return [...scopes.values()]
          .sort(
            (a, b) =>
              a.oldest.localeCompare(b.oldest) ||
              canonicalJSON(a.scope).localeCompare(canonicalJSON(b.scope)),
          )
          .map((item) => item.scope);
      },
      false,
      options,
    );
  }
  async plan(
    input: C.PlanInput,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.BacklogPlan> {
    return this.refreshed<C.BacklogPlan>(
      () => {
        throw new Error("missing prepared backlog");
      },
      true,
      options,
      [],
      (view) => {
        const now = millis(input.now);
        const p = input.policy;
        if (
          !Object.values(p).every(Number.isSafeInteger) ||
          p.minWindows < 0 ||
          p.maxPendingAgeMs < 0 ||
          p.maxBatchWindows < 1 ||
          p.maxBatchBytes < 1 ||
          p.leaseMs <= 0
        )
          throw new Error("invalid backlog policy");
        const pending: C.PendingWindow[] = [...view.windows.values()]
          .filter(
            (w) =>
              scopeEqual(w.scope, input.scope) &&
              !view.terminal.has(w.windowId),
          )
          .map((window) => {
            const retry = view.retry.get(window.windowId);
            const attempts = [...view.accepted.values()].filter((a) =>
              a.local?.outcomes.some(
                (o) =>
                  o.windowId === window.windowId && o.decision.kind === "retry",
              ),
            ).length;
            return {
              window,
              pendingSince: window.capturedAt,
              attempts,
              notBefore:
                retry?.decision.kind === "retry"
                  ? retry.decision.retryAt
                  : window.capturedAt,
            };
          })
          .sort(
            (a, b) =>
              a.pendingSince.localeCompare(b.pendingSince) ||
              a.window.windowId.localeCompare(b.window.windowId),
          );
        const sizes = new Map(
          pending.map((item) => [
            item.window.windowId,
            Buffer.byteLength(canonicalJSON(item.window)),
          ]),
        );
        return () => {
          if (!pending.length)
            return { kind: "idle", reason: "empty", nextCheckAt: null };
          this.db
            .prepare(
              "DELETE FROM leases WHERE json_extract(payload,'$.expiresAt')<=?",
            )
            .run(input.now);
          const free = pending.filter(
            (w) =>
              !this.db
                .prepare("SELECT 1 FROM leases WHERE window=?")
                .get(w.window.windowId),
          );
          if (!free.length)
            return {
              kind: "idle",
              reason: "leased",
              nextCheckAt: iso(now + p.leaseMs),
            };
          const ready = free.filter((w) => millis(w.notBefore) <= now);
          if (!ready.length)
            return {
              kind: "idle",
              reason: "backoff",
              nextCheckAt: free.map((w) => w.notBefore).sort()[0]!,
            };
          const reason = ready.some((w) => w.attempts > 0)
            ? "recovery"
            : ready.some((w) => w.window.importance === "correction")
              ? "correction"
              : now - millis(ready[0]!.pendingSince) >= p.maxPendingAgeMs
                ? "age"
                : ready.length >= p.minWindows
                  ? "threshold"
                  : null;
          if (!reason)
            return {
              kind: "idle",
              reason: "below-threshold",
              nextCheckAt: iso(
                millis(ready[0]!.pendingSince) + p.maxPendingAgeMs,
              ),
            };
          const selected: C.PendingWindow[] = [];
          let bytes = 0;
          for (const w of ready) {
            const size = sizes.get(w.window.windowId)!;
            if (
              bytes + size > p.maxBatchBytes ||
              selected.length >= p.maxBatchWindows
            )
              break;
            selected.push(w);
            bytes += size;
          }
          if (!selected.length)
            throw new Error(
              "pending window exceeds maxBatchBytes; increase policy or split producer windows",
            );
          const lease: C.LocalLease = {
            leaseId: randomUUID() as C.LeaseId,
            jobId: input.jobId,
            owner: input.owner,
            expiresAt: iso(now + p.leaseMs),
          };
          for (const w of selected)
            this.db
              .prepare("INSERT INTO leases VALUES (?,?,?)")
              .run(w.window.windowId, lease.leaseId, canonicalJSON(lease));
          return {
            kind: "eligible",
            reason,
            batch: { lease, windows: [selected[0]!, ...selected.slice(1)] },
          };
        };
      },
    );
  }
  async renewLease(
    input: C.RenewLeaseInput,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.RenewLeaseResult> {
    const clock = operationClock();
    const lease = parseLease(structuredClone(input.lease));
    const suppliedNow = millis(input.now),
      leaseMs = input.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
      throw new Error("invalid lease duration");
    // Renewal must remain available while retained-history preparation stalls.
    // Exact payload comparison also fences an older heartbeat of this token.
    return contend(
      () =>
        this.coordinateSync(() => {
          options.signal?.throwIfAborted();
          const now = suppliedNow + elapsed(clock);
          const rows = this.db
            .prepare("SELECT payload FROM leases WHERE token=?")
            .all(lease.leaseId);
          if (
            millis(lease.expiresAt) <= now ||
            !rows.length ||
            rows.some(
              (row) =>
                !sameValue(parseLease(JSON.parse(string(row.payload))), lease),
            )
          )
            return { kind: "lease-lost" } as const;
          const renewed = {
            ...lease,
            expiresAt: iso(Math.max(millis(lease.expiresAt), now + leaseMs)),
          };
          this.db
            .prepare("UPDATE leases SET payload=? WHERE token=?")
            .run(canonicalJSON(renewed), lease.leaseId);
          return { kind: "renewed", lease: renewed } as const;
        }),
      options,
      5000,
    );
  }
  async checkDelivery(
    delivery: C.RecallDelivery,
    now: C.Timestamp,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.DeliveryEligibility> {
    return this.refreshed(
      (v) => this.eligibility(v, parseDelivery(delivery), now),
      false,
      options,
    );
  }
  private eligibility(
    view: View,
    d: C.RecallDelivery,
    now: C.Timestamp,
  ): C.DeliveryEligibility {
    const discard = (
      reason: Extract<C.DeliveryEligibility, { kind: "discard" }>["reason"],
    ): C.DeliveryEligibility => ({ kind: "discard", reason });
    if (millis(d.intent.expiresAt) <= millis(now)) return discard("expired");
    if (this.dispatched(d.deliveryId)) return discard("duplicate");
    if (
      d.context.notes.length > d.intent.maxNotes ||
      d.context.text.length > d.intent.maxChars
    )
      return discard("obsolete");
    for (const ref of d.context.notes) {
      const heads = view.heads.get(ref.noteId) ?? [];
      const r = view.revisions.get(ref.revisionId);
      if (r && !scopeEqual(r.scope, d.intent.target.scope))
        return discard("wrong-scope");
      if (r && suppressionsFor(view, r).length) return discard("suppressed");
      if (
        !r ||
        heads.length !== 1 ||
        heads[0]!.revisionId !== ref.revisionId ||
        r.exposure.kind !== "active" ||
        this.invalidEditable.has(r.path)
      )
        return discard("obsolete");
    }
    for (const e of d.context.evidence) {
      try {
        this.validateEvidenceRef(view, d.intent.target.scope, e);
      } catch {
        return discard("wrong-scope");
      }
      if (
        view.suppressions.some(
          (s) =>
            scopeEqual(s.scope, d.intent.target.scope) &&
            s.target.kind === "evidence" &&
            matchesEvidence(s.target.evidence, e),
        )
      )
        return discard("suppressed");
    }
    return { kind: "eligible" };
  }
  async queueDelivery(
    input: C.RecallDelivery,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<"queued" | "duplicate"> {
    const d = parseDelivery(structuredClone(input));
    return this.refreshed<"queued" | "duplicate">(
      () => {
        throw new Error("missing prepared delivery");
      },
      true,
      options,
      [],
      (view) => {
        const path = join(this.outbox, sha256(d.deliveryId));
        if (existsSync(path)) {
          this.observe(path);
          if (!sameValue(this.localValue(path), d))
            throw new IntegrityError("delivery identity collision");
          return () => "duplicate";
        }
        const eligibility = this.eligibility(view, d, new Date().toISOString());
        if (eligibility.kind === "discard")
          throw new Error(`delivery rejected: ${eligibility.reason}`);
        const accept = this.prepareLocalPublication(path, d);
        return () => {
          accept();
          return "queued";
        };
      },
    );
  }
  async readDelivery(
    id: C.DeliveryId,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.RecallDelivery | null> {
    return contend(
      () => {
        if (this.closed) throw new Error("memory store is closed");
        const path = join(this.outbox, sha256(id));
        if (!existsSync(path)) return null;
        const delivery = parseDelivery(this.localValue(path));
        if (delivery.deliveryId !== id)
          throw new IntegrityError("outbox identity mismatch");
        return delivery;
      },
      options,
      5000,
    );
  }
  async nextDelivery(
    target: C.RecallTarget,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<C.RecallDelivery | null> {
    return this.refreshed(
      () => {
        for (const file of readdirSync(this.outbox)
          .filter((f) => !f.startsWith("."))
          .sort()) {
          const d = parseDelivery(this.localValue(join(this.outbox, file)));
          if (sha256(d.deliveryId) !== file)
            throw new IntegrityError("outbox identity mismatch");
          if (
            sameValue(target, d.intent.target) &&
            !this.dispatched(d.deliveryId)
          )
            return d;
        }
        return null;
      },
      false,
      options,
    );
  }
  async recordDispatch(
    id: C.DeliveryId,
    outcome: C.DispatchOutcome,
    options: FileMemoryStoreOptions = this.options,
  ): Promise<void> {
    const owned = structuredClone(outcome);
    return contend(
      () =>
        this.transactionSync<void>(
          () => {
            throw new Error("missing prepared dispatch");
          },
          true,
          [],
          false,
          () => {
            if (owned.kind === "empty") return () => undefined;
            const path = join(this.outbox, sha256(id));
            if (owned.deliveryId !== id || !existsSync(path))
              throw new Error("unknown delivery");
            this.observe(path);
            return this.prepareLocalPublication(
              join(this.receipts, sha256(id)),
              owned,
            );
          },
        ),
      options,
      5000,
    );
  }
  private dependenciesReady(
    c: C.ReplicaChange,
    commits: ReadonlySet<C.CommitId>,
    revisions: ReadonlySet<C.RevisionId>,
    windows: ReadonlySet<C.WindowId>,
  ): boolean {
    const rs = new Set([...revisions, ...c.revisions.map((r) => r.revisionId)]),
      ws = new Set([...windows, ...c.windows.map((w) => w.windowId)]);
    return (
      c.parents.every((p) => commits.has(p)) &&
      c.revisions.every(
        (r) =>
          (r.ancestry.kind !== "known" ||
            r.ancestry.parents.every((p) => rs.has(p))) &&
          r.claims.every(
            (claim) =>
              claim.evidence.every((e) => ws.has(e.windowId)) &&
              claim.derivedFrom.every((ref) => rs.has(ref.revisionId)),
          ),
      ) &&
      c.suppressions.every(
        (s) =>
          s.target.kind !== "evidence" || ws.has(s.target.evidence.windowId),
      ) &&
      c.outcomes.every(
        (o) =>
          ws.has(o.windowId) &&
          (o.decision.kind !== "changed" ||
            o.decision.notes.every((ref) => rs.has(ref.revisionId))),
      )
    );
  }
  private orderedChanges(view: View): C.ReplicaChange[] {
    const waiting = [...view.accepted.values()]
      .map((a) => a.replica)
      .sort((a, b) => a.commitId.localeCompare(b.commitId));
    const ordered: C.ReplicaChange[] = [];
    const done = new Set<C.CommitId>(),
      revisions = new Set<C.RevisionId>(),
      windows = new Set<C.WindowId>();
    while (waiting.length) {
      const index = waiting.findIndex((c) =>
        this.dependenciesReady(c, done, revisions, windows),
      );
      if (index < 0)
        throw new IntegrityError(
          "missing/cyclic published commit dependencies",
        );
      const c = waiting.splice(index, 1)[0]!;
      ordered.push(c);
      done.add(c.commitId);
      c.revisions.forEach((r) => revisions.add(r.revisionId));
      c.windows.forEach((w) => windows.add(w.windowId));
    }
    return ordered;
  }
  /** adapters close over one authenticated configured peer; acknowledgments never leak. */
  forPeer(
    peer: string,
    options: FileMemoryStoreOptions = this.options,
  ): C.ReplicaStore {
    if (!peer) throw new Error("peer required");
    const read = <T>(run: (view: View) => T) =>
      this.refreshed(run, false, options);
    const write = <T>(run: (view: View) => T) =>
      this.refreshed(run, true, options);
    return {
      continuityToken: async () =>
        write((view) => {
          const token = this.synchronizeContinuity(view, true);
          if (!token) throw new IntegrityError("missing repository continuity");
          return token;
        }),
      scan: async (after, limit) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
          throw new Error("replica scan limit must be 1..4096");
        return read((view) => {
          const changes = this.orderedChanges(view);
          const start =
            after === null
              ? 0
              : changes.findIndex((c) => c.commitId === after) + 1;
          return changes.slice(start, start + limit);
        });
      },
      dependencyCommits: async (input, incoming = []) =>
        this.refreshed<C.CommitId[]>(
          () => {
            throw new Error("missing prepared dependencies");
          },
          true,
          options,
          [],
          (view) => {
            if (incoming.length > 4096)
              throw new Error("replica dependency lookup exceeds 4096 commits");
            const target = parseReplicaChange(input);
            const candidates = new Map(
              [...view.accepted].map(([id, accepted]) => [
                id,
                accepted.replica,
              ]),
            );
            for (const value of [...incoming, target]) {
              const change = parseReplicaChange(value);
              const retained = candidates.get(change.commitId);
              if (retained && !sameValue(retained, change))
                throw new IntegrityError("replica identity collision");
              candidates.set(change.commitId, change);
            }
            const revisions = new Set<C.RevisionId>([
              ...target.revisions.flatMap((revision) => [
                ...(revision.ancestry.kind === "known"
                  ? revision.ancestry.parents
                  : []),
                ...revision.claims.flatMap((claim) =>
                  claim.derivedFrom.map((ref) => ref.revisionId),
                ),
              ]),
              ...target.outcomes.flatMap((outcome) =>
                outcome.decision.kind === "changed"
                  ? outcome.decision.notes.map((ref) => ref.revisionId)
                  : [],
              ),
            ]);
            const windows = new Set<C.WindowId>([
              ...target.revisions.flatMap((revision) =>
                revision.claims.flatMap((claim) =>
                  claim.evidence.map((ref) => ref.windowId),
                ),
              ),
              ...target.suppressions.flatMap((rule) =>
                rule.target.kind === "evidence"
                  ? [rule.target.evidence.windowId]
                  : [],
              ),
              ...target.outcomes.map((outcome) => outcome.windowId),
            ]);
            for (const revision of target.revisions)
              revisions.delete(revision.revisionId);
            for (const window of target.windows)
              windows.delete(window.windowId);
            // A later duplicate must not retroactively change a cached dependency.
            // The epoch resets these ordinals whenever retained history changes.
            this.coordinateSync(
              () => {
                this.synchronizeContinuity(view, true);
              },
              true,
              () => this.requirePreparation(),
            );
            const ordinals = new Map(
              this.db
                .prepare(
                  "SELECT commit_id,rowid AS ordinal FROM repository_payload",
                )
                .all()
                .map((row) => [string(row.commit_id), Number(row.ordinal)]),
            );
            const ordered = [...candidates.values()].sort(
              (a, b) =>
                (ordinals.get(a.commitId) ?? Number.MAX_SAFE_INTEGER) -
                  (ordinals.get(b.commitId) ?? Number.MAX_SAFE_INTEGER) ||
                a.commitId.localeCompare(b.commitId),
            );
            const owners = new Set<C.CommitId>();
            const foundRevisions = new Set<C.RevisionId>(),
              foundWindows = new Set<C.WindowId>();
            for (const candidate of ordered) {
              for (const revision of candidate.revisions)
                if (
                  revisions.has(revision.revisionId) &&
                  !foundRevisions.has(revision.revisionId)
                ) {
                  owners.add(candidate.commitId);
                  foundRevisions.add(revision.revisionId);
                }
              for (const window of candidate.windows)
                if (
                  windows.has(window.windowId) &&
                  !foundWindows.has(window.windowId)
                ) {
                  owners.add(candidate.commitId);
                  foundWindows.add(window.windowId);
                }
            }
            if (
              foundRevisions.size !== revisions.size ||
              foundWindows.size !== windows.size
            )
              throw new IntegrityError("missing replica evidence dependency");
            const result = [...owners].sort();
            return () => result;
          },
        ),
      readChanges: async (ids) => {
        if (ids.length === 0) return [];
        if (ids.length > 4096)
          throw new Error("replica lookup exceeds 4096 commits");
        return read((view) =>
          ids.map((id) => {
            const change = view.accepted.get(id)?.replica;
            if (!change) throw new IntegrityError("missing replica commit");
            return change;
          }),
        );
      },
      pending: async (limit) =>
        read((v) =>
          this.orderedChanges(v)
            .filter(
              (c) =>
                !this.db
                  .prepare(
                    "SELECT 1 FROM peer_ack WHERE peer=? AND commit_id=?",
                  )
                  .get(peer, c.commitId),
            )
            .slice(0, Math.max(0, limit)),
        ),
      readCursor: async () =>
        contend(
          () => {
            if (this.closed) throw new Error("memory store is closed");
            try {
              const row = this.db
                .prepare("SELECT cursor FROM peer_cursor WHERE peer=?")
                .get(peer);
              return row ? string(row.cursor) : null;
            } catch (error) {
              if (isStoreBusy(error)) throw new LockUnavailable(error);
              throw error;
            }
          },
          options,
          5000,
        ),
      integrate: async (incoming) => {
        const changes = structuredClone(incoming).map(parseReplicaChange);
        return this.refreshed<void>(
          () => {
            throw new Error("missing prepared integration");
          },
          true,
          options,
          [],
          (view) => {
            const publications: PreparedPublication[] = [];
            const next = this.preview(
              view,
              changes.flatMap((c) => c.windows),
              changes.flatMap((c) => c.revisions),
              changes.flatMap((c) => c.suppressions),
            );
            const available = new Set([
              ...view.accepted.keys(),
              ...changes.map((c) => c.commitId),
            ]);
            const suppressions = new Map(
              view.suppressions.map((s) => [s.suppressionId, s]),
            );
            const identities = new Map<C.CommitId, C.ReplicaChange>();
            for (const c of changes) {
              const old = identities.get(c.commitId);
              if (old && !sameValue(old, c))
                throw new IntegrityError(
                  "duplicate incoming identity collision",
                );
              identities.set(c.commitId, c);
              for (const s of c.suppressions) {
                if (s.target.kind === "evidence")
                  this.validateEvidenceRef(next, s.scope, s.target.evidence);
                const previous = suppressions.get(s.suppressionId);
                if (previous && !sameValue(previous, s))
                  throw new IntegrityError("incoming suppression collision");
                suppressions.set(s.suppressionId, s);
              }
            }
            for (const c of changes) {
              const old = view.accepted.get(c.commitId);
              if (old && !sameValue(old.replica, c))
                throw new IntegrityError("replica commit identity collision");
              for (const p of c.parents)
                if (!available.has(p))
                  throw new IntegrityError("missing incoming parent");
              for (const r of c.revisions) {
                this.safePath(r.path);
                this.validateEvidence(next, r);
                if (r.ancestry.kind === "known")
                  for (const p of r.ancestry.parents)
                    if (next.revisions.get(p)?.noteId !== r.noteId)
                      throw new IntegrityError("missing incoming ancestry");
              }
              for (const o of c.outcomes) this.validateOutcome(next, o);
            }
            const pending = [...identities.values()].filter(
              (c) => !view.accepted.has(c.commitId),
            );
            const done = new Set(view.accepted.keys());
            const revisions = new Set(view.revisions.keys()),
              windows = new Set(view.windows.keys());
            while (pending.length) {
              const index = pending.findIndex((c) =>
                this.dependenciesReady(c, done, revisions, windows),
              );
              if (index < 0)
                throw new IntegrityError("cyclic incoming ancestry");
              const c = pending.splice(index, 1)[0]!;
              publications.push(this.preparePublication(c, null));
              done.add(c.commitId);
              c.revisions.forEach((r) => revisions.add(r.revisionId));
              c.windows.forEach((w) => windows.add(w.windowId));
            }
            return () => {
              for (const publication of publications)
                this.acceptPublication(publication);
            };
          },
        ).then(() => this.refreshed(() => undefined, true, options));
      },
      acknowledge: async (commits, cursor) =>
        this.transaction((v) => {
          for (const id of commits) {
            if (!v.accepted.has(id))
              throw new Error("acknowledgment of unknown commit");
            this.db
              .prepare("INSERT OR IGNORE INTO peer_ack VALUES (?,?)")
              .run(peer, id);
          }
          this.db
            .prepare(
              "INSERT INTO peer_cursor VALUES (?,?) ON CONFLICT(peer) DO UPDATE SET cursor=excluded.cursor",
            )
            .run(peer, cursor);
        }, options),
    };
  }
  private placements(): Placement[] {
    return readdirSync(this.journals)
      .filter((f) => !f.startsWith(".") && f.endsWith(".intent"))
      .map((file) => {
        const p = record(this.localValue(join(this.journals, file)));
        const token = file.slice(0, -".intent".length);
        const placement: Placement = {
          path: string(p.path),
          revisionId: string(p.revisionId) as C.RevisionId,
          candidate: string(p.candidate),
          stash: string(p.stash),
          snapshot: p.snapshot === null ? null : string(p.snapshot),
          basis: p.basis === null ? null : string(p.basis),
        };
        this.safePath(placement.path);
        // old absolute prefixes are provenance, never read/write authority on restore.
        // Only a UUID-named artifact under one recovery directory may be rebound.
        const previous = dirname(placement.candidate);
        if (
          !/^[a-f0-9-]{36}$/.test(token) ||
          !previous.endsWith("/.pi-memory-recovery") ||
          placement.candidate !== join(previous, `${token}.candidate.md`) ||
          placement.stash !== join(previous, `${token}.stash.md`) ||
          (placement.snapshot !== null &&
            placement.snapshot !== join(previous, `${token}.basis.md`)) ||
          (placement.basis !== null && !/^[a-f0-9]{64}$/.test(placement.basis))
        )
          throw new IntegrityError("invalid materialization journal");
        return {
          ...placement,
          candidate: join(this.recovery, `${token}.candidate.md`),
          stash: join(this.recovery, `${token}.stash.md`),
          snapshot:
            placement.snapshot === null
              ? null
              : join(this.recovery, `${token}.basis.md`),
        };
      });
  }
  private placementDone(p: Placement): boolean {
    const path = `${p.candidate}.done`;
    if (!existsSync(path)) return false;
    const done = record(this.localValue(path));
    if (done.path !== p.path || done.revisionId !== p.revisionId)
      throw new IntegrityError("invalid materialization completion");
    return true;
  }
  private safePath(path: string): string {
    const full = resolve(this.config.root, path);
    const rel = relative(this.config.root, full);
    if (
      !rel ||
      rel.startsWith("..") ||
      rel.startsWith("/") ||
      rel.split("/").includes(".pi-memory-recovery")
    )
      throw new IntegrityError("unsafe editable path");
    let parent = dirname(full);
    while (parent !== this.config.root) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new IntegrityError("symlinked editable directory");
      parent = dirname(parent);
    }
    return full;
  }
  private scan(view: View, apply = true): boolean {
    this.invalidEditable.clear();
    const placements = this.placements();
    const files: { path: string; logical: string; bytes: string }[] = [];
    const walk = (dir: string): void => {
      if (!dir.startsWith(this.recovery)) this.observe(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink())
          throw new IntegrityError("symlink in editable root");
        if (
          entry.isDirectory() &&
          full !== this.config.data &&
          full !== this.config.state &&
          entry.name !== ".git"
        )
          walk(full);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const placement = placements.find(
            (p) =>
              p.candidate === full || p.stash === full || p.snapshot === full,
          );
          if (full.startsWith(`${this.recovery}/`) && !placement) continue;
          this.observe(full);
          files.push({
            path: full,
            logical: placement?.path ?? relative(this.config.root, full),
            bytes: readFileSync(full, "utf8"),
          });
        }
      }
    };
    // an exception aborts the scan, so partial traversal never implies deletion.
    walk(this.config.root);
    const parsed = new Map<string, ReturnType<typeof readMarkdownRevision>>();
    for (const file of files) {
      try {
        parsed.set(
          file.path,
          readMarkdownRevision(file.bytes, file.logical, false),
        );
      } catch {
        this.invalidEditable.set(file.logical, "invalid editable metadata");
      }
    }
    const edits: C.NoteRevision[] = [];
    for (const file of files) {
      if (!parsed.has(file.path)) continue;
      const embedded = parsed.get(file.path) ?? null;
      const marker = embedded && {
        noteId: embedded.noteId,
        base:
          embedded.ancestry.kind === "known" &&
          embedded.ancestry.parents.length === 1
            ? embedded.ancestry.parents[0]!
            : null,
      };
      const known = [...view.revisions.values()].find(
        (r) =>
          r.markdown === file.bytes &&
          (r.path === file.logical ||
            placements.some(
              (p) =>
                p.revisionId === r.revisionId &&
                (p.path === file.logical ||
                  p.candidate === file.path ||
                  p.stash === file.path ||
                  p.snapshot === file.path),
            )),
      );
      if (known) continue;
      const history = placements.filter((p) => p.path === file.logical);
      const basis = marker
        ? ([...view.revisions.values()].find(
            (r) => r.noteId === marker.noteId && r.revisionId === marker.base,
          ) ?? view.heads.get(marker.noteId)?.[0])
        : history.map((p) => view.revisions.get(p.revisionId)).find(Boolean);
      if (!basis) {
        if (embedded)
          edits.push(
            reviseMarkdown(embedded, file.bytes, file.logical, [], false),
          );
        continue;
      }
      const heads = (view.heads.get(basis.noteId) ?? []).map(
        (r) => r.revisionId,
      );
      const identical = [...view.revisions.values()].find(
        (r) => r.noteId === basis.noteId && r.markdown === file.bytes,
      );
      const pureRename =
        identical &&
        !files.some(
          (f) =>
            !f.path.startsWith(`${this.recovery}/`) &&
            f.logical === identical.path,
        ) &&
        files.filter(
          (f) =>
            !f.path.startsWith(`${this.recovery}/`) &&
            parsed.get(f.path)?.noteId === basis.noteId,
        ).length === 1;
      const r = reviseMarkdown(
        identical ?? embedded ?? basis,
        file.bytes,
        file.logical,
        heads,
        Boolean(pureRename),
      );
      if (
        !view.revisions.has(r.revisionId) &&
        !edits.some((x) => x.revisionId === r.revisionId)
      )
        edits.push(r);
    }
    for (const [noteId, heads] of view.heads) {
      if (heads.length !== 1 || heads[0]!.exposure.kind === "deleted") continue;
      const head = heads[0]!;
      const done = placements.some(
        (p) => p.revisionId === head.revisionId && this.placementDone(p),
      );
      if (
        !done ||
        files.some(
          (f) =>
            !f.path.startsWith(`${this.recovery}/`) &&
            (parsed.get(f.path)?.noteId === noteId || f.logical === head.path),
        )
      )
        continue;
      const { revisionId: _id, ...old } = head;
      const envelope = {
        ...old,
        ancestry: { kind: "known" as const, parents: [head.revisionId] },
        exposure: {
          kind: "deleted" as const,
          reason: "external file deletion",
        },
      };
      edits.push({ ...envelope, revisionId: revisionId(envelope) });
    }
    if (edits.length && apply)
      this.publish(
        {
          commitId: `external-${sha256(canonicalJSON(edits))}` as C.CommitId,
          replicaId: this.config.replicaId,
          parents: this.commitHeads(view),
          revisions: edits,
          windows: [],
          suppressions: [],
          outcomes: [],
        },
        null,
      );
    return edits.length > 0;
  }
  private materialize(view: View, apply = true): boolean {
    const placements = this.placements();
    const desired = new Map<string, C.NoteRevision>();
    const pathOwners = new Map<string, Set<C.NoteId>>();
    for (const heads of view.heads.values())
      for (const r of heads) {
        const owners = pathOwners.get(r.path) ?? new Set<C.NoteId>();
        owners.add(r.noteId);
        pathOwners.set(r.path, owners);
      }
    for (const heads of view.heads.values())
      for (const r of heads) {
        if (this.invalidEditable.has(r.path)) continue;
        let path = r.path;
        if (heads.length > 1 || pathOwners.get(r.path)!.size > 1) {
          const suffix = `-${encodeURIComponent(r.noteId)}`;
          const stem = r.path.slice(0, -3);
          const descriptive = stem.endsWith(suffix)
            ? stem.slice(0, -suffix.length)
            : stem;
          path = `${descriptive}${heads.length > 1 ? `~${r.revisionId.slice(0, 12)}` : ""}${suffix}.md`;
        }
        desired.set(path, r);
      }
    for (const p of placements) {
      if (this.invalidEditable.has(p.path) || this.placementDone(p)) continue;
      if (!apply) return true;
      // An obsolete intent can retain recovery bytes, but may never move the
      // current target. In particular a delayed P1 cannot stash P2's newer B.
      if (desired.get(p.path)?.revisionId !== p.revisionId) {
        this.localCreate(`${p.candidate}.done`, {
          path: p.path,
          revisionId: p.revisionId,
        });
        continue;
      }
      this.finishPlacement(p);
      return true;
    }
    for (const [path, r] of desired) {
      const target = this.safePath(path);
      if (existsSync(target) && lstatSync(target).isSymbolicLink())
        throw new IntegrityError("symlinked editable file");
      if (
        placements.some(
          (p) =>
            p.path === path &&
            p.revisionId === r.revisionId &&
            this.placementDone(p),
        )
      )
        continue;
      if (!apply) return true;
      const token = randomUUID();
      const candidate = join(this.recovery, `${token}.candidate.md`);
      const stash = join(this.recovery, `${token}.stash.md`);
      if (r.exposure.kind !== "deleted") durableCreate(candidate, r.markdown);
      const captured = existsSync(target) ? readFileSync(target) : null;
      const snapshot =
        captured === null ? null : join(this.recovery, `${token}.basis.md`);
      if (snapshot && captured) durableCreate(snapshot, captured);
      const p: Placement = {
        path,
        revisionId: r.revisionId,
        candidate,
        stash,
        snapshot,
        basis: captured === null ? null : sha256(captured),
      };
      const stage = join(this.journals, `.${token}.intent`);
      this.localCreate(stage, p);
      durableDirectory(dirname(target));
      this.config.publicationBoundary?.("placement-prepared", p.revisionId);
      this.finishPlacement(p, () =>
        linkSync(stage, join(this.journals, `${token}.intent`)),
      );
      return true;
    }
    return false;
  }
  private finishPlacement(p: Placement, acceptIntent?: () => void): void {
    const target = this.safePath(p.path);
    durableDirectory(dirname(target));
    this.coordinateSync(
      () => {
        acceptIntent?.();
        if (!existsSync(p.stash) && existsSync(target)) {
          renameSync(target, p.stash);
          this.config.publicationBoundary?.("stash", p.revisionId);
        }
        if (existsSync(p.candidate)) {
          try {
            linkSync(p.candidate, target);
          } catch (error) {
            if (!existsSync(target)) throw error;
          }
        }
        this.db
          .prepare(
            "INSERT INTO publication_generation(id,generation) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1",
          )
          .run();
      },
      true,
      () => this.requirePreparation(),
    );
    this.config.publicationBoundary?.("placed", p.revisionId);
    // No target mutation follows this point. A newer placement may finish while
    // these barriers wait; completing this old receipt cannot replace its bytes.
    flushDirectory(this.journals);
    flushDirectory(dirname(target));
    flushDirectory(this.recovery);
    if (existsSync(p.stash)) {
      const fd = openSync(p.stash, "r");
      try {
        flushFile(fd);
      } finally {
        closeSync(fd);
      }
      const bytes = readFileSync(p.stash);
      if (!existsSync(`${p.candidate}.captured`))
        durableCreate(
          `${p.candidate}.captured`,
          canonicalJSON({
            hash: sha256(bytes),
            basisMatched: p.basis === sha256(bytes),
          }),
        );
    }
    this.localCreate(`${p.candidate}.done`, {
      path: p.path,
      revisionId: p.revisionId,
    });
    this.config.publicationBoundary?.("placement-durable", p.revisionId);
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const {
    mkdtempSync,
    rmSync,
    writeFileSync,
    openSync,
    writeSync,
    closeSync,
    unlinkSync,
    cpSync,
    symlinkSync,
    chmodSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync, spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { createNoteRevision, readMarkdownRevision } =
    await import("./markdown.js");
  const { hashSourceWindow, windowId } = await import("./identity.js");
  const scope: C.MemoryScope = { kind: "personal", ownerId: "fixture-owner" };
  const now = "2026-01-01T00:00:00.000Z";
  const later = "2026-01-01T00:01:00.000Z";
  const policy: C.BacklogPolicy = {
    minWindows: 2,
    maxPendingAgeMs: 30000,
    maxBatchWindows: 10,
    maxBatchBytes: 100000,
    leaseMs: 10000,
  };
  function fixture(replicaId = "replica-a"): {
    dir: string;
    config: FileMemoryStoreConfig;
    store: FileMemoryStore;
  } {
    const dir = mkdtempSync(join(tmpdir(), "memory-m1-"));
    const config = {
      root: join(dir, "notes"),
      data: join(dir, "data"),
      state: join(dir, "state"),
      replicaId: replicaId as C.ReplicaId,
      owner: "fixture-owner",
    };
    return { dir, config, store: new FileMemoryStore(config) };
  }
  function note(
    id: string,
    body = "original",
    parents: readonly C.RevisionId[] = [],
  ): C.NoteRevision {
    return createNoteRevision({
      noteId: id as C.NoteId,
      ancestry: { kind: "known", parents },
      scope,
      path: `topic-${id}.md`,
      body,
      links: [],
      claims: [],
      exposure: { kind: "active" },
      authoredAt: now,
    });
  }
  function change(
    id: string,
    edits: readonly C.NoteRevision[] = [],
    windows: readonly C.SourceWindow[] = [],
  ): C.LocalChangeSet {
    return {
      commitId: id as C.CommitId,
      now,
      edits: edits.map((revision) => ({
        revision,
        expectedHeads:
          revision.ancestry.kind === "known" ? revision.ancestry.parents : [],
      })),
      windows,
      outcomes: [],
      suppressions: [],
      lease: null,
    };
  }
  function window(entry = "entry-a", capturedAt = now): C.SourceWindow {
    const payload: Pick<C.SourceWindow, "source" | "scope" | "excerpts"> = {
      source: {
        sourceId: "source-a" as C.SourceId,
        producer: "fixture",
        origin: { kind: "session", sessionId: "native-a" as C.SessionId },
      },
      scope,
      excerpts: [
        {
          span: {
            entryId: entry as C.EntryId,
            partId: "text",
            start: 0,
            end: 5,
          },
          parentEntryId: null,
          producerRole: "user",
          occurredAt: now,
          text: "hello",
        },
      ],
    };
    return {
      ...payload,
      sourceHash: hashSourceWindow(payload),
      windowId: windowId(payload),
      capturedAt,
      importance: "ordinary",
    };
  }
  function delivery(n: C.NoteRevision): C.RecallDelivery {
    return {
      deliveryId: "delivery-a" as C.DeliveryId,
      intent: {
        intentId: "intent-a" as C.IntentId,
        target: {
          consumerId: "consumer",
          sessionId: "native-a" as C.SessionId,
          scope,
        },
        entryId: "entry-a" as C.EntryId,
        query: "topic",
        expiresAt: "2099-01-01T00:00:00.000Z",
        maxChars: 10000,
        maxNotes: 10,
      },
      context: {
        text: n.markdown,
        notes: [{ noteId: n.noteId, revisionId: n.revisionId }],
        evidence: [],
      },
    };
  }
  const sourcePath = fileURLToPath(import.meta.url);
  const childPrelude = `import { createJiti } from 'jiti'; const jiti = createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false}); const {FileMemoryStore,isStoreBusy}=await jiti.import(${JSON.stringify(sourcePath)});`;
  function child(
    config: FileMemoryStoreConfig,
    code: string,
  ): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${childPrelude} const config=${JSON.stringify(config)}; ${code}`,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
    );
  }
  it("narrows owner-authorized experience to its observed project without widening restricted evidence", async () => {
    const f = fixture();
    const project: C.MemoryScope = { kind: "project", repositoryId: "repo/a" };
    const scopedWindow = (scope: C.MemoryScope): C.SourceWindow => {
      const raw = window();
      const source = {
        ...raw.source,
        origin: {
          kind: "session" as const,
          sessionId: "native-a" as C.SessionId,
          project: { repositoryId: "repo/a", revision: "fixture-revision" },
        },
      };
      const identity = { source, scope, excerpts: raw.excerpts };
      return {
        ...raw,
        ...identity,
        sourceHash: hashSourceWindow(identity),
        windowId: windowId(identity),
      };
    };
    const backedNote = (
      id: string,
      target: C.MemoryScope,
      w: C.SourceWindow,
    ): C.NoteRevision =>
      createNoteRevision({
        noteId: id as C.NoteId,
        ancestry: { kind: "known", parents: [] },
        scope: target,
        path: `rationale-${id}.md`,
        body: "dated experience, not current implementation authority",
        links: [],
        claims: [
          {
            kind: "model-inference",
            markdownSpan: { start: 0, end: 1 },
            evidence: [
              {
                windowId: w.windowId,
                source: w.source,
                sourceHash: w.sourceHash,
                spans: [w.excerpts[0].span],
              },
            ],
            derivedFrom: [],
          },
        ],
        exposure: { kind: "active" },
        authoredAt: now,
      });
    try {
      const personal = scopedWindow(scope);
      await f.store.commit(change("source", [], [personal]));
      const decision = backedNote("decision", project, personal);
      expect(await f.store.commit(change("narrow", [decision]))).toMatchObject({
        kind: "locally-committed",
      });
      expect((await f.store.listNotes(project)).map((n) => n.noteId)).toEqual([
        decision.noteId,
      ]);
      const wrongProject = backedNote(
        "wrong-project",
        { kind: "project", repositoryId: "repo/b" },
        personal,
      );
      await expect(
        f.store.commit(change("wrong-project", [wrongProject])),
      ).rejects.toThrow("evidence identity/scope mismatch");
      const restricted = scopedWindow(project);
      await f.store.commit(change("restricted", [], [restricted]));
      const widened = backedNote("widened", scope, restricted);
      await expect(f.store.commit(change("widen", [widened]))).rejects.toThrow(
        "evidence identity/scope mismatch",
      );
      const foreign = scopedWindow({
        kind: "personal",
        ownerId: "other-owner",
      });
      await f.store.commit(change("foreign-source", [], [foreign]));
      await expect(
        f.store.commit(
          change("foreign-narrow", [backedNote("foreign", project, foreign)]),
        ),
      ).rejects.toThrow("evidence identity/scope mismatch");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("isolates malformed editable metadata without replacing it or stopping unrelated work", async () => {
    const f = fixture();
    const broken = note("broken");
    const healthy = note("healthy");
    let store: FileMemoryStore | null = f.store;
    try {
      await store.commit(change("initial", [broken, healthy]));
      const invalid = "<!-- pi-memory {broken-json} -->\nmy edit must survive";
      writeFileSync(join(f.config.root, broken.path), invalid);
      store.close();
      store = null;
      store = new FileMemoryStore(f.config);
      expect((await store.listNotes(scope)).map((n) => n.noteId)).toEqual([
        healthy.noteId,
      ]);
      expect(store.editableProblems()).toEqual([
        { path: broken.path, reason: "invalid editable metadata" },
      ]);
      expect(
        await store.commit(change("unrelated-capture", [], [window()])),
      ).toMatchObject({ kind: "locally-committed" });
      expect(await store.checkDelivery(delivery(broken), now)).toMatchObject({
        kind: "discard",
        reason: "obsolete",
      });
      expect(readFileSync(join(f.config.root, broken.path), "utf8")).toBe(
        invalid,
      );
      writeFileSync(join(f.config.root, broken.path), broken.markdown);
      expect(
        (await store.listNotes(scope)).map((n) => n.noteId).sort(),
      ).toEqual([broken.noteId, healthy.noteId].sort());
      expect(store.editableProblems()).toEqual([]);
    } finally {
      store?.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("repository continuity survives append/restart but changes after same-path rollback or payload replacement", async () => {
    const f = fixture(),
      replacement = fixture();
    try {
      await f.store.commit(change("a"));
      const token = await f.store.forPeer("proof").continuityToken();
      f.store.close();
      const backup = join(f.dir, "data-before-append");
      cpSync(f.config.data, backup, { recursive: true });
      f.store = new FileMemoryStore(f.config);
      await f.store.commit(change("b"));
      expect(await f.store.forPeer("proof").continuityToken()).toBe(token);
      f.store.close();
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.forPeer("proof").continuityToken()).toBe(token);
      f.store.close();
      rmSync(f.config.data, { recursive: true });
      cpSync(backup, f.config.data, { recursive: true });
      f.store = new FileMemoryStore(f.config);
      const rolledBack = await f.store.forPeer("proof").continuityToken();
      expect(rolledBack).not.toBe(token);
      await f.store.commit(change("c"));
      expect(await f.store.forPeer("proof").continuityToken()).toBe(rolledBack);
      await replacement.store.commit(change("a", [note("replacement")]));
      await replacement.store.commit(change("c"));
      replacement.store.close();
      f.store.close();
      rmSync(f.config.data, { recursive: true });
      cpSync(replacement.config.data, f.config.data, { recursive: true });
      f.store = new FileMemoryStore(f.config);
      const changed = await f.store.forPeer("proof").continuityToken();
      expect(changed).not.toBe(rolledBack);
      f.store.close();
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.forPeer("proof").continuityToken()).toBe(changed);
    } finally {
      try {
        f.store.close();
      } catch {}
      try {
        replacement.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(replacement.dir, { recursive: true, force: true });
    }
  });
  it("resolves evidence owners independently of declared commit parents", async () => {
    const f = fixture(),
      receiver = fixture();
    try {
      const w = window();
      await f.store.commit(change("source-owner", [], [w]));
      const original = (
        await f.store
          .forPeer("inspect")
          .readChanges(["source-owner" as C.CommitId])
      )[0]!;
      const target: C.ReplicaChange = {
        ...original,
        commitId: "untrusted" as C.CommitId,
        parents: [],
        windows: [],
        suppressions: [
          {
            suppressionId: "evidence-rule" as C.SuppressionId,
            scope,
            createdAt: now,
            reason: "fixture",
            target: {
              kind: "evidence",
              evidence: {
                source: w.source,
                windowId: w.windowId,
                sourceHash: w.sourceHash,
                spans: [w.excerpts[0].span],
              },
            },
          },
        ],
      };
      expect(
        await f.store.forPeer("inspect").dependencyCommits(target),
      ).toEqual([original.commitId]);
      expect(
        await receiver.store
          .forPeer("inspect")
          .dependencyCommits(target, [original]),
      ).toEqual([original.commitId]);
      await expect(
        receiver.store.forPeer("inspect").dependencyCommits(target),
      ).rejects.toThrow("missing replica evidence dependency");
      const token = await f.store.forPeer("inspect").continuityToken();
      await f.store.forPeer("duplicate").integrate([
        {
          ...original,
          commitId: "later-owner" as C.CommitId,
          parents: [original.commitId],
          revisions: [note("later")],
        },
      ]);
      expect(await f.store.forPeer("inspect").continuityToken()).toBe(token);
      expect(
        await f.store.forPeer("inspect").dependencyCommits(target),
      ).toEqual([original.commitId]);
    } finally {
      f.store.close();
      receiver.store.close();
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(receiver.dir, { recursive: true, force: true });
    }
  });
  it("scans ACK-independent causal pages and reads exact dependency ids", async () => {
    const f = fixture();
    try {
      await f.store.commit(change("first", [note("first")]));
      await f.store.commit(change("second", [note("second")]));
      const peer = f.store.forPeer("remote");
      const all = await peer.scan(null, 100);
      await peer.acknowledge(
        all.map((c) => c.commitId),
        "already-acked",
      );
      expect(await peer.pending(100)).toEqual([]);
      expect(await peer.scan(null, 1)).toEqual(all.slice(0, 1));
      expect(await peer.scan(all[0]!.commitId, 1)).toEqual(all.slice(1));
      expect(await peer.scan(all[1]!.commitId, 1)).toEqual([]);
      expect(await peer.scan("unknown-checkpoint" as C.CommitId, 1)).toEqual(
        all.slice(0, 1),
      );
      expect(await peer.readChanges([])).toEqual([]);
      expect(
        await peer.readChanges([all[1]!.commitId, all[0]!.commitId]),
      ).toEqual([all[1], all[0]]);
      await expect(
        peer.readChanges([all[0]!.commitId, "missing" as C.CommitId]),
      ).rejects.toThrow("missing replica commit");
      await expect(peer.scan(null, 0)).rejects.toThrow("scan limit");
      await expect(peer.scan(null, 4097)).rejects.toThrow("scan limit");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("a restored receiver drives replay beyond its own checkpoint despite stale sender ACKs", async () => {
    const sender = fixture("sender");
    const receiver = fixture("receiver");
    let restored: FileMemoryStore | null = receiver.store;
    try {
      await sender.store.commit(change("before-backup", [note("before")]));
      const outgoing = sender.store.forPeer("receiver");
      const first = (await outgoing.scan(null, 1))[0]!;
      await restored.forPeer("sender").integrate([first]);
      await restored.forPeer("sender").acknowledge([], first.commitId);
      restored.close();
      restored = null;
      const backup = join(receiver.dir, "backup");
      for (const [name, path] of Object.entries({
        notes: receiver.config.root,
        data: receiver.config.data,
        state: receiver.config.state,
      }))
        cpSync(path, join(backup, name), { recursive: true });
      restored = new FileMemoryStore(receiver.config);
      await sender.store.commit(change("after-backup", [note("after")]));
      const second = (await outgoing.scan(first.commitId, 1))[0]!;
      await restored.forPeer("sender").integrate([second]);
      await restored.forPeer("sender").acknowledge([], second.commitId);
      await outgoing.acknowledge(
        [first.commitId, second.commitId],
        second.commitId,
      );
      expect(await outgoing.pending(10)).toEqual([]);
      restored.close();
      restored = null;
      for (const [name, path] of Object.entries({
        notes: receiver.config.root,
        data: receiver.config.data,
        state: receiver.config.state,
      })) {
        rmSync(path, { recursive: true });
        cpSync(join(backup, name), path, { recursive: true });
      }
      restored = new FileMemoryStore(receiver.config);
      const checkpoint = await restored.forPeer("sender").readCursor();
      expect(checkpoint).toBe(first.commitId);
      const repair = await outgoing.scan(checkpoint as C.CommitId, 1);
      expect(repair.map((c) => c.commitId)).toEqual([second.commitId]);
      await restored.forPeer("sender").integrate(repair);
      expect(
        (await restored.listNotes(scope)).map((n) => n.noteId).sort(),
      ).toEqual(["after", "before"]);
    } finally {
      sender.store.close();
      restored?.close();
      rmSync(sender.dir, { recursive: true });
      rmSync(receiver.dir, { recursive: true });
    }
  });
  it("restores a closed snapshot at different paths without following old materialization locations", async () => {
    const original = fixture();
    const destination = fixture("restored-host");
    let restored: FileMemoryStore | null = null;
    let originalOpen = true;
    let destinationOpen = true;
    try {
      const remembered = note("portable", "portable experience");
      await original.store.commit(
        change("portable-commit", [remembered], [window()]),
      );
      original.store.close();
      originalOpen = false;
      destination.store.close();
      destinationOpen = false;
      for (const name of ["root", "data", "state"] as const) {
        rmSync(destination.config[name], { recursive: true });
        cpSync(original.config[name], destination.config[name], {
          recursive: true,
        });
      }
      const sourceBytes = readFileSync(
        join(original.config.root, remembered.path),
        "utf8",
      );
      restored = new FileMemoryStore(destination.config);
      expect((await restored.listNotes(scope)).map((n) => n.noteId)).toEqual([
        remembered.noteId,
      ]);
      expect(
        readFileSync(join(destination.config.root, remembered.path), "utf8"),
      ).toBe(remembered.markdown);
      const another = note("fresh", "new host can keep learning");
      expect(
        await restored.commit(change("fresh-host-commit", [another])),
      ).toMatchObject({ kind: "locally-committed" });
      expect(
        readFileSync(join(original.config.root, remembered.path), "utf8"),
      ).toBe(sourceBytes);
      expect(existsSync(join(original.config.root, another.path))).toBe(false);
      const page = await restored.forPeer("other").scan(null, 20);
      expect(page.map((c) => c.commitId)).toContain("portable-commit");
      expect(page.map((c) => c.commitId)).toContain("fresh-host-commit");
    } finally {
      if (originalOpen) original.store.close();
      if (destinationOpen) destination.store.close();
      restored?.close();
      rmSync(original.dir, { recursive: true });
      rmSync(destination.dir, { recursive: true });
    }
  });
  it("accepts a multi-note batch, replays exactly, and rejects identity reuse", async () => {
    const f = fixture();
    try {
      const a = note("a"),
        b = note("b");
      const c = change("batch", [a, b]);
      expect(await f.store.commit(c)).toMatchObject({
        kind: "locally-committed",
        replay: false,
      });
      expect(await f.store.commit(c)).toMatchObject({ replay: true });
      expect(await f.store.commit({ ...c, now: later })).toMatchObject({
        kind: "identity-conflict",
      });
      expect(
        (await f.store.listNotes(scope)).map((n) => n.noteId).sort(),
      ).toEqual(["a", "b"]);
      expect(await f.store.readNotes(scope, [])).toEqual([]);
      const differentAncestry = {
        ...a,
        ancestry: { kind: "unknown-base" as const, observedHeads: [] },
      };
      const { revisionId: _id, ...envelope } = differentAncestry;
      expect(revisionId(envelope)).not.toBe(a.revisionId);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("deduplicates capture clocks and retains early windows with terminal/retry outcomes", async () => {
    const f = fixture();
    try {
      const a = window(),
        replay = {
          ...window("entry-a", "2025-01-01T00:00:00.000Z"),
          importance: "correction" as const,
        },
        b = window("entry-b");
      await f.store.commit(change("capture", [], [a, b]));
      await f.store.commit(change("recapture", [], [replay]));
      const plan = await f.store.plan({
        jobId: "job" as C.JobId,
        owner: "worker",
        scope,
        now,
        policy,
      });
      expect(plan.kind).toBe("eligible");
      if (plan.kind !== "eligible") throw new Error("no batch");
      expect(plan.batch.windows).toHaveLength(2);
      expect(
        plan.batch.windows.find((p) => p.window.windowId === a.windowId)!
          .window,
      ).toEqual(a);
      const outcomes: C.WindowOutcome[] = plan.batch.windows.map((p, i) => ({
        windowId: p.window.windowId,
        sourceHash: p.window.sourceHash,
        recordedAt: now,
        decision:
          i === 0
            ? { kind: "no-change", reason: "same" }
            : { kind: "retry", reason: "later", retryAt: later },
      }));
      expect(
        await f.store.commit({
          ...change("outcomes"),
          lease: plan.batch.lease,
          outcomes,
        }),
      ).toMatchObject({ kind: "locally-committed" });
      expect(
        await f.store.plan({
          jobId: "job" as C.JobId,
          owner: "worker",
          scope,
          now,
          policy,
        }),
      ).toMatchObject({ kind: "idle", reason: "backoff" });
      expect(
        await f.store.plan({
          jobId: "job" as C.JobId,
          owner: "worker",
          scope,
          now: later,
          policy,
        }),
      ).toMatchObject({ kind: "eligible", reason: "recovery" });
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("fences expired leases and avoids threshold work until pending age", async () => {
    const f = fixture();
    try {
      const w = window();
      await f.store.commit(change("capture", [], [w]));
      expect(
        await f.store.plan({
          jobId: "j" as C.JobId,
          owner: "one",
          scope,
          now,
          policy,
        }),
      ).toMatchObject({ kind: "idle", reason: "below-threshold" });
      const old = await f.store.plan({
        jobId: "j" as C.JobId,
        owner: "one",
        scope,
        now: later,
        policy,
      });
      if (old.kind !== "eligible") throw new Error("no aged batch");
      const current = await f.store.plan({
        jobId: "j2" as C.JobId,
        owner: "two",
        scope,
        now: "2026-01-01T00:02:00.000Z",
        policy,
      });
      expect(current.kind).toBe("eligible");
      expect(
        await f.store.commit({
          ...change("stale"),
          now: "2026-01-01T00:02:00.000Z",
          lease: old.batch.lease,
          outcomes: [
            {
              windowId: w.windowId,
              sourceHash: w.sourceHash,
              recordedAt: later,
              decision: { kind: "ineligible", reason: "fixture" },
            },
          ],
        }),
      ).toMatchObject({ kind: "lease-lost" });
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("renews current ownership without accepting evidence and fences stale, expired and reclaimed tokens", async () => {
    const f = fixture();
    try {
      const windows = [window(), window("renew-b")];
      await f.store.commit(change("renew-capture", [], windows));
      const plan = await f.store.plan({
        jobId: "renew" as C.JobId,
        owner: "one",
        scope,
        now,
        policy,
      });
      if (plan.kind !== "eligible") throw new Error("expected batch");
      const tick = "2026-01-01T00:00:05.000Z";
      const renewed = await f.store.renewLease({
        lease: plan.batch.lease,
        now: tick,
        leaseMs: 20000,
      });
      expect(renewed).toMatchObject({
        kind: "renewed",
        lease: {
          leaseId: plan.batch.lease.leaseId,
          jobId: plan.batch.lease.jobId,
          owner: plan.batch.lease.owner,
        },
      });
      if (renewed.kind !== "renewed") throw Error("expected renewal");
      expect(millis(renewed.lease.expiresAt)).toBeGreaterThanOrEqual(
        millis("2026-01-01T00:00:25.000Z"),
      );
      expect(millis(renewed.lease.expiresAt)).toBeLessThan(
        millis("2026-01-01T00:00:26.000Z"),
      );
      expect(
        await f.store.renewLease({
          lease: plan.batch.lease,
          now: tick,
          leaseMs: 20000,
        }),
      ).toEqual({ kind: "lease-lost" });
      expect(
        await f.store.plan({
          jobId: "other" as C.JobId,
          owner: "two",
          scope,
          now: "2026-01-01T00:00:15.000Z",
          policy,
        }),
      ).toMatchObject({ kind: "idle", reason: "leased" });
      if (renewed.kind !== "renewed") throw new Error("renewal failed");
      expect(
        await f.store.renewLease({
          lease: renewed.lease,
          now: renewed.lease.expiresAt,
          leaseMs: 20000,
        }),
      ).toEqual({ kind: "lease-lost" });
      const reclaimed = await f.store.plan({
        jobId: "other" as C.JobId,
        owner: "two",
        scope,
        now: later,
        policy,
      });
      expect(reclaimed.kind).toBe("eligible");
      expect(
        await f.store.renewLease({
          lease: renewed.lease,
          now: later,
          leaseMs: 20000,
        }),
      ).toEqual({ kind: "lease-lost" });
      expect(
        await f.store.commit({
          ...change("late-renew-output"),
          now: later,
          lease: renewed.lease,
          outcomes: windows.map((w) => ({
            windowId: w.windowId,
            sourceHash: w.sourceHash,
            recordedAt: later,
            decision: { kind: "no-change" as const, reason: "late" },
          })),
        }),
      ).toEqual({ kind: "lease-lost" });
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("preserves external unknown-base edits, duplicate ids and stale program edits", async () => {
    const f = fixture();
    try {
      const a = note("a");
      await f.store.commit(change("seed", [a]));
      writeFileSync(join(f.config.root, a.path), a.markdown + "\nexternal");
      writeFileSync(
        join(f.config.root, "duplicate-a.md"),
        a.markdown + "\nduplicate",
      );
      const heads = await f.store.listNotes(scope);
      expect(heads.some((n) => n.markdown.endsWith("external"))).toBe(true);
      expect(heads.some((n) => n.markdown.endsWith("duplicate"))).toBe(true);
      expect(heads.some((n) => n.revisionId === a.revisionId)).toBe(true);
      expect(
        await f.store.commit(
          change("stale-edit", [note("a", "stale", [a.revisionId])]),
        ),
      ).toMatchObject({ kind: "conflict" });
      expect((await f.store.listNotes(scope)).length).toBe(heads.length);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("retains racing writes through the old open inode and refuses occupied publication", async () => {
    const f = fixture();
    let fd: number | undefined;
    try {
      const a = note("a");
      await f.store.commit(change("seed", [a]));
      f.store.close();
      fd = openSync(join(f.config.root, a.path), "a");
      let raced = false;
      const store = new FileMemoryStore({
        ...f.config,
        publicationBoundary: (boundary) => {
          if (boundary === "stash" && !raced) {
            raced = true;
            writeSync(fd!, "\nlate inode");
            writeFileSync(
              join(f.config.root, a.path),
              a.markdown + "\ncompeting path",
            );
          }
        },
      });
      f.store = store;
      await store.commit(
        change("edit", [note("a", "program", [a.revisionId])]),
      );
      writeSync(fd!, "\nwritten after acceptance");
      const heads = await store.listNotes(scope);
      expect(
        heads.some((n) => n.markdown.includes("written after acceptance")),
      ).toBe(true);
      expect(heads.some((n) => n.markdown.includes("late inode"))).toBe(true);
      expect(heads.some((n) => n.markdown.includes("competing path"))).toBe(
        true,
      );
      expect(readFileSync(join(f.config.root, a.path), "utf8")).toContain(
        "competing path",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("round-trips peer changes, preserves concurrent delete/edit and scopes acknowledgments", async () => {
    const a = fixture(),
      b = fixture("replica-b");
    try {
      const n = note("a");
      await a.store.commit(change("base", [n]));
      await b.store
        .forPeer("a")
        .integrate(await a.store.forPeer("b").pending(100));
      const edit = note("a", "offline edit", [n.revisionId]);
      await a.store.commit(change("edit", [edit]));
      const { revisionId: _old, ...envelope } = n;
      const deletedEnvelope = {
        ...envelope,
        ancestry: { kind: "known" as const, parents: [n.revisionId] },
        exposure: { kind: "deleted" as const, reason: "fixture" },
      };
      const deleted = {
        ...deletedEnvelope,
        revisionId: revisionId(deletedEnvelope),
      };
      await b.store.commit(change("delete", [deleted]));
      const incoming = await b.store.forPeer("a").pending(100);
      await a.store.forPeer("b").integrate([...incoming].reverse());
      expect(await a.store.listNotes(scope)).toHaveLength(2);
      expect(await a.store.checkDelivery(delivery(edit), now)).toMatchObject({
        kind: "discard",
        reason: "obsolete",
      });
      await a.store
        .forPeer("b")
        .acknowledge(["base" as C.CommitId], "cursor-b");
      expect(
        (await a.store.forPeer("b").pending(100)).some(
          (c) => c.commitId === "base",
        ),
      ).toBe(false);
      expect(
        (await a.store.forPeer("c").pending(100)).some(
          (c) => c.commitId === "base",
        ),
      ).toBe(true);
      expect(await a.store.forPeer("c").readCursor()).toBeNull();
    } finally {
      a.store.close();
      b.store.close();
      rmSync(a.dir, { recursive: true });
      rmSync(b.dir, { recursive: true });
    }
  });
  it("rejects suppressed admission and dispatch, keeps outbox dedup across restart", async () => {
    const f = fixture();
    try {
      const a = note("a");
      await f.store.commit(change("seed", [a]));
      const d = delivery(a);
      expect(await f.store.queueDelivery(d)).toBe("queued");
      f.store.close();
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.queueDelivery(d)).toBe("duplicate");
      expect(await f.store.readDelivery(d.deliveryId)).toEqual(d);
      expect(await f.store.readDelivery("unknown" as C.DeliveryId)).toBeNull();
      expect(await f.store.nextDelivery(d.intent.target)).toEqual(d);
      await f.store.commit({
        ...change("suppress"),
        suppressions: [
          {
            suppressionId: "s1" as C.SuppressionId,
            scope,
            target: { kind: "note", noteId: a.noteId },
            reason: "fixture",
            createdAt: now,
          },
        ],
      });
      expect(await f.store.checkDelivery(d, now)).toMatchObject({
        kind: "discard",
        reason: "suppressed",
      });
      expect(
        await f.store.commit(
          change("relearn", [note("a", "relearn", [a.revisionId])]),
        ),
      ).toMatchObject({ kind: "suppressed" });
      await expect(
        f.store.queueDelivery({ ...d, deliveryId: "d2" as C.DeliveryId }),
      ).rejects.toThrow("suppressed");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  for (const boundary of [
    "objects",
    "manifest-linked",
    "manifest",
    "placement-prepared",
    "placed",
    "placement-durable",
  ] as const)
    it(`SIGKILL at ${boundary} recovers whole batches in a fresh process`, async () => {
      const f = fixture();
      try {
        f.store.close();
        const c = change(
          "kill-batch",
          [note("a"), note("b")],
          [window(), window("entry-b")],
        );
        const killed = child(
          f.config,
          `const store=new FileMemoryStore({...config,publicationBoundary:b=>{if(b===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL')}}); await store.commit(${JSON.stringify(c)});`,
        );
        expect(killed.signal, String(killed.stderr)).toBe("SIGKILL");
        const reopened = child(
          f.config,
          `const store=new FileMemoryStore(config); const notes=await store.listNotes(${JSON.stringify(scope)}); const p=await store.plan(${JSON.stringify({ jobId: "fresh", owner: "fresh", scope, now, policy })}); console.log(JSON.stringify({notes:notes.length,plan:p.kind,count:p.kind==='eligible'?p.batch.windows.length:0})); store.close();`,
        );
        expect(reopened.status, String(reopened.stderr)).toBe(0);
        expect(JSON.parse(String(reopened.stdout).trim())).toEqual(
          boundary !== "objects"
            ? { notes: 2, plan: "eligible", count: 2 }
            : { notes: 0, plan: "idle", count: 0 },
        );
        f.store = new FileMemoryStore(f.config);
        expect(await f.store.commit(c)).toMatchObject({
          kind: "locally-committed",
          replay: boundary !== "objects",
        });
      } finally {
        try {
          f.store.close();
        } catch {}
        rmSync(f.dir, { recursive: true });
      }
    }, 30000);
  it("reconstructs knowledge, coverage and suppressions after closed operational DB loss", async () => {
    const f = fixture();
    try {
      const a = note("a"),
        w = window();
      await f.store.commit(change("seed", [a], [w]));
      const p = await f.store.plan({
        jobId: "j" as C.JobId,
        owner: "o",
        scope,
        now: later,
        policy,
      });
      if (p.kind !== "eligible") throw new Error("no batch");
      await f.store.commit({
        ...change("consume"),
        now: later,
        lease: p.batch.lease,
        outcomes: [
          {
            windowId: w.windowId,
            sourceHash: w.sourceHash,
            recordedAt: later,
            decision: { kind: "ineligible", reason: "fixture" },
          },
        ],
        suppressions: [
          {
            suppressionId: "s" as C.SuppressionId,
            scope,
            target: { kind: "note", noteId: a.noteId },
            reason: "fixture",
            createdAt: now,
          },
        ],
      });
      f.store.close();
      rmSync(f.config.state, { recursive: true });
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.listNotes(scope)).toHaveLength(1);
      expect(await f.store.readSuppressions(scope)).toHaveLength(1);
      expect(
        await f.store.plan({
          jobId: "j" as C.JobId,
          owner: "o",
          scope,
          now: later,
          policy,
        }),
      ).toMatchObject({ kind: "idle", reason: "empty" });
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("fails explicitly on missing published dependencies; ignored staging cannot imply acceptance", async () => {
    const f = fixture();
    try {
      await f.store.commit(change("seed", [note("a")]));
      f.store.close();
      const manifest = record(
        json(join(f.config.data, "commits", sha256("seed"))),
      );
      const dependency = strings(manifest.dependencies)[0]!;
      unlinkSync(join(f.config.data, "objects", dependency));
      expect(() => new FileMemoryStore(f.config)).toThrow(/missing dependency/);
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  });
  it("recognizes a rename by permanent identity, then records deletion without erasing history", async () => {
    const f = fixture();
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      renameSync(
        join(f.config.root, n.path),
        join(f.config.root, "renamed-a.md"),
      );
      const renamed = await f.store.listNotes(scope);
      expect(renamed).toHaveLength(1);
      expect(renamed[0]!.noteId).toBe(n.noteId);
      expect(renamed[0]!.path).toBe("renamed-a.md");
      unlinkSync(join(f.config.root, "renamed-a.md"));
      expect(await f.store.listNotes(scope)).toMatchObject([
        { exposure: { kind: "deleted" } },
      ]);
      expect(
        (await f.store.forPeer("new").pending(100))
          .flatMap((c) => c.revisions)
          .some((r) => r.revisionId === n.revisionId),
      ).toBe(true);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("an incomplete unsafe traversal cannot synthesize a deletion", async () => {
    const f = fixture();
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      unlinkSync(join(f.config.root, n.path));
      symlinkSync(f.config.data, join(f.config.root, "unsafe"));
      await expect(f.store.listNotes(scope)).rejects.toThrow("symlink");
      unlinkSync(join(f.config.root, "unsafe"));
      writeFileSync(join(f.config.root, n.path), n.markdown);
      expect(await f.store.listNotes(scope)).toHaveLength(1);
      expect((await f.store.listNotes(scope))[0]!.exposure.kind).toBe("active");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("retains terminal dispatch receipts when the operational DB is rebuilt", async () => {
    const f = fixture();
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      const d = delivery(n);
      await f.store.queueDelivery(d);
      await f.store.recordDispatch(d.deliveryId, {
        kind: "queued",
        deliveryId: d.deliveryId,
      });
      f.store.close();
      rmSync(f.config.state, { recursive: true });
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.nextDelivery(d.intent.target)).toBeNull();
      expect(await f.store.checkDelivery(d, now)).toMatchObject({
        kind: "discard",
        reason: "duplicate",
      });
      expect(await f.store.queueDelivery(d)).toBe("duplicate");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  /** A separate native connection owns the lock; tests never retry SQLITE_BUSY. */
  async function holdWriter(
    config: FileMemoryStoreConfig,
  ): Promise<{ release(): Promise<void> }> {
    const proc = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(join(config.state, "coordination.sqlite"))});
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      process.on('message', () => { db.exec('COMMIT'); db.close(); process.disconnect(); });
      process.send('locked');
    `,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    proc.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) =>
      proc.on("exit", resolve),
    );
    await new Promise<void>((resolve, reject) => {
      proc.once("message", () => resolve());
      proc.once("error", reject);
      proc.once("exit", (code) =>
        reject(new Error(`lock holder exited ${code}: ${stderr}`)),
      );
    });
    return {
      release: async () => {
        if (proc.connected) proc.send("release");
        expect(await exited, stderr).toBe(0);
      },
    };
  }
  /** Valid retained fixtures have payloads, ancestry and editable notes, not empty manifests. */
  function retainedPayloads(f: ReturnType<typeof fixture>, count = 96): void {
    for (let i = 0; i < count; i++) {
      const original = window(`retained-${i}`);
      const text =
        `retained producer experience ${i}: ` +
        "meaningful detail αβγ\n".repeat(3000);
      const payload: Pick<C.SourceWindow, "source" | "scope" | "excerpts"> = {
        source: original.source,
        scope,
        excerpts: [
          {
            ...original.excerpts[0]!,
            text,
            span: {
              ...original.excerpts[0]!.span,
              end: Buffer.byteLength(text),
            },
          },
        ],
      };
      const w: C.SourceWindow = {
        ...payload,
        sourceHash: hashSourceWindow(payload),
        windowId: windowId(payload),
        capturedAt: now,
        importance: "ordinary",
      };
      const replica: C.ReplicaChange = {
        commitId: `retained-${i}` as C.CommitId,
        replicaId: f.config.replicaId,
        parents: [
          i ? (`retained-${i - 1}` as C.CommitId) : ("seed" as C.CommitId),
        ],
        revisions: [],
        windows: [w],
        suppressions: [],
        outcomes: [],
      };
      const dependencies: string[] = [];
      for (const object of [
        ...replica.revisions,
        ...replica.windows,
        replica,
      ]) {
        const bytes = canonicalJSON(object),
          hash = sha256(bytes);
        writeFileSync(join(f.config.data, "objects", hash), bytes);
        dependencies.push(hash);
      }
      const manifest = {
        version: 1,
        dependencies: dependencies.sort(),
        replica: sha256(canonicalJSON(replica)),
        local: null,
      };
      writeFileSync(
        join(f.config.data, "commits", sha256(replica.commitId)),
        canonicalJSON({ ...manifest, hash: sha256(canonicalJSON(manifest)) }),
      );
    }
  }
  function gatedProcess(
    config: FileMemoryStoreConfig,
    code: string,
    gate: "prepared" | "confirming" | "fencing",
    source = sourcePath,
  ) {
    const dir = dirname(config.root),
      ready = join(dir, "preparation-ready"),
      release = join(dir, "preparation-release");
    const proc = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createJiti} from 'jiti'; import {writeFileSync,existsSync} from 'node:fs';
      const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false});
      const {FileMemoryStore}=await jiti.import(${JSON.stringify(source)});
      const config=${JSON.stringify(config)}; let armed=false,stalled=false;
      const store=await FileMemoryStore.open({...config,publicationBoundary:(b)=>{
        if(armed&&!stalled&&b===${JSON.stringify(gate)}){
          stalled=true;writeFileSync(${JSON.stringify(ready)},'ready');
          const wait=new Int32Array(new SharedArrayBuffer(4));
          const deadline=Date.now()+45000;
          while(!existsSync(${JSON.stringify(release)})){
            if(Date.now()>deadline)throw Error('fixture gate not released');
            Atomics.wait(wait,0,0,10);
          }
        }
      }}); armed=true; try{${code}}finally{store.close();}
    `,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      ended = false;
    proc.stdout.on("data", (c) => {
      stdout += c;
    });
    proc.stderr.on("data", (c) => {
      stderr += c;
    });
    const done = new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) =>
      proc.on("close", (status) => {
        ended = true;
        resolve({ status, stdout, stderr });
      }),
    );
    return {
      async ready() {
        const deadline = performance.now() + 30000;
        while (!existsSync(ready)) {
          if (ended || performance.now() > deadline)
            throw Error(`preparation gate unavailable: ${stderr}`);
          await delay(10);
        }
      },
      release() {
        writeFileSync(release, "release");
      },
      done,
    };
  }
  it("keeps another process capturing, reading and importing edits while representative cold durability preparation stalls", async () => {
    const f = fixture();
    let stalled: ReturnType<typeof gatedProcess> | undefined;
    try {
      const n = note("editable", "retained editable particulars\n".repeat(600));
      await f.store.commit(change("seed", [n]));
      retainedPayloads(f);
      const stale = change(
        "stale-preparation",
        [
          note("editable", "stale agent", [n.revisionId]),
          note("partial-must-not-appear"),
        ],
        [window("partial-window")],
      );
      stalled = gatedProcess(
        f.config,
        `console.log(JSON.stringify(await store.commit(${JSON.stringify(stale)})));`,
        "confirming",
      );
      await stalled.ready();
      // This process does not retry: preparatory barriers must reserve no writer.
      const probe = child(
        f.config,
        `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(config.state+'/coordination.sqlite');db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE;COMMIT');db.close();`,
      );
      expect(probe.status, String(probe.stderr)).toBe(0);
      writeFileSync(
        join(f.config.root, n.path),
        n.markdown + "\nconcurrent external particulars",
      );
      const other = child(
        f.config,
        `const store=await FileMemoryStore.open(config);try{const receipt=await store.commit(${JSON.stringify(change("concurrent-capture", [], [window("concurrent-window")]))});const notes=await store.listNotes(${JSON.stringify(scope)});console.log(JSON.stringify({receipt,edited:notes.some(n=>n.markdown.includes('concurrent external particulars')&&n.ancestry.kind==='unknown-base')}));}finally{store.close();}`,
      );
      expect(other.status, String(other.stderr)).toBe(0);
      expect(JSON.parse(String(other.stdout))).toMatchObject({
        receipt: { kind: "locally-committed" },
        edited: true,
      });
      expect(
        existsSync(join(f.config.data, "commits", sha256(stale.commitId))),
      ).toBe(false);
      stalled.release();
      const result = await stalled.done;
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "conflict" });
      expect(await f.store.hasAcceptedCommit(stale.commitId)).toBe(false);
      expect(
        (await f.store.listNotes(scope)).some(
          (n) => n.noteId === "partial-must-not-appear",
        ),
      ).toBe(false);
      const all = await f.store.forPeer("fixture").scan(null, 256);
      expect(
        all
          .flatMap((c) => c.windows)
          .some((w) => w.windowId === stale.windows[0]!.windowId),
      ).toBe(false);
      expect(all.flatMap((c) => c.windows)).toHaveLength(97);
    } finally {
      stalled?.release();
      await stalled?.done;
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 60000);
  it("refuses a prepared multi-note batch after a concurrent edit without accepting its unrelated edit", async () => {
    const f = fixture();
    let stalled: ReturnType<typeof gatedProcess> | undefined;
    try {
      const a = note("batch-a"),
        b = note("batch-b");
      await f.store.commit(change("seed", [a, b]));
      const nextA = note("batch-a", "stale program A", [a.revisionId]);
      const nextB = note("batch-b", "unrelated program B", [b.revisionId]);
      const batch = change("stale-whole-batch", [nextA, nextB]);
      stalled = gatedProcess(
        f.config,
        `console.log(JSON.stringify(await store.commit(${JSON.stringify(batch)})));`,
        "prepared",
      );
      await stalled.ready();
      const editable = a.markdown + "\nunpublished concurrent user particulars";
      writeFileSync(join(f.config.root, a.path), editable);
      await f.store.commit(
        change("independent-capture", [], [window("batch-capture")]),
      );
      stalled.release();
      const result = await stalled.done;
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        kind: "conflict",
      });
      expect(await f.store.hasAcceptedCommit(batch.commitId)).toBe(false);
      expect(readFileSync(join(f.config.root, b.path), "utf8")).toBe(
        b.markdown,
      );
      const notes = await f.store.listNotes(scope);
      expect(
        notes.some(
          (n) =>
            n.noteId === a.noteId &&
            n.ancestry.kind === "unknown-base" &&
            n.markdown.includes("unpublished concurrent user particulars"),
        ),
      ).toBe(true);
      expect(notes.some((n) => n.revisionId === nextB.revisionId)).toBe(false);
    } finally {
      stalled?.release();
      await stalled?.done;
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  it("fences physical metadata under a WAL reader and detects a writer-held validation negative control", async () => {
    for (const reader of [true, false]) {
      const f = fixture();
      let stalled: ReturnType<typeof gatedProcess> | undefined;
      try {
        await f.store.commit(change("seed", [note("metadata")], [window()]));
        const plan = await f.store.plan({
          jobId: "metadata" as C.JobId,
          owner: "fixture",
          scope,
          now,
          policy: { ...policy, minWindows: 1 },
        });
        if (plan.kind !== "eligible") throw Error("expected lease");
        let source = sourcePath;
        if (!reader) {
          const isolated = join(f.dir, "runtime");
          cpSync(dirname(sourcePath), isolated, { recursive: true });
          symlinkSync(
            join(process.cwd(), "node_modules"),
            join(f.dir, "node_modules"),
          );
          source = join(isolated, "store.ts");
          const original = readFileSync(source, "utf8");
          const expression =
            'validate ? "BEGIN" : write ? "BEGIN IMMEDIATE" : "BEGIN"';
          expect(original).toContain(expression);
          writeFileSync(
            source,
            original.replace(expression, 'write ? "BEGIN IMMEDIATE" : "BEGIN"'),
          );
        }
        stalled = gatedProcess(
          f.config,
          `console.log(JSON.stringify(await store.commit(${JSON.stringify(change("after-metadata-fence"))})));`,
          "fencing",
          source,
        );
        await stalled.ready();
        const probe = child(
          f.config,
          `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(config.state+'/coordination.sqlite');db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE;COMMIT');db.close();`,
        );
        if (reader) {
          expect(probe.status, String(probe.stderr)).toBe(0);
          // This changes only the SQLite snapshot, not any physical history.
          // Acceptance must upgrade/retry rather than publish from the old read.
          expect(
            await f.store.renewLease({
              lease: plan.batch.lease,
              now: "2026-01-01T00:00:02.000Z",
              leaseMs: 30000,
            }),
          ).toMatchObject({ kind: "renewed" });
        } else {
          expect(probe.status).not.toBe(0);
          expect(String(probe.stderr)).toContain("database is locked");
        }
        stalled.release();
        const result = await stalled.done;
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          kind: "locally-committed",
          replay: false,
        });
      } finally {
        stalled?.release();
        await stalled?.done;
        f.store.close();
        rmSync(f.dir, { recursive: true });
      }
    }
  }, 45000);
  it("detects a writer-held recovery regression in an isolated source copy", async () => {
    const f = fixture();
    let stalled: ReturnType<typeof gatedProcess> | undefined;
    try {
      await f.store.commit(change("seed", [note("seed")]));
      f.store.close();
      const isolated = join(f.dir, "runtime");
      cpSync(dirname(sourcePath), isolated, { recursive: true });
      symlinkSync(
        join(process.cwd(), "node_modules"),
        join(f.dir, "node_modules"),
      );
      const copy = join(isolated, "store.ts"),
        original = readFileSync(copy, "utf8");
      expect(original).toContain("view = this.recover(write);");
      writeFileSync(
        copy,
        original.replace(
          "view = this.recover(write);",
          "view = this.coordinateSync(() => this.recover(write), write);",
        ),
      );
      stalled = gatedProcess(
        f.config,
        `await store.commit(${JSON.stringify(change("negative-recovery"))});`,
        "confirming",
        copy,
      );
      await stalled.ready();
      const probe = child(
        f.config,
        `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(config.state+'/coordination.sqlite');db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE;COMMIT');db.close();`,
      );
      expect(probe.status).not.toBe(0);
      expect(String(probe.stderr)).toContain("database is locked");
      stalled.release();
      const result = await stalled.done;
      expect(result.status, result.stderr).toBe(0);
    } finally {
      stalled?.release();
      await stalled?.done;
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  it("refuses newly suppressed prepared acceptance, and its isolated negative control admits it", async () => {
    for (const fenced of [true, false]) {
      const f = fixture();
      let stalled: ReturnType<typeof gatedProcess> | undefined;
      try {
        const n = note("stale-candidate");
        await f.store.commit(change("seed", [note("seed")]));
        let source = sourcePath;
        if (!fenced) {
          const isolated = join(f.dir, "runtime");
          cpSync(dirname(sourcePath), isolated, { recursive: true });
          symlinkSync(
            join(process.cwd(), "node_modules"),
            join(f.dir, "node_modules"),
          );
          source = join(isolated, "store.ts");
          const original = readFileSync(source, "utf8");
          expect(original).toContain(
            "this.validatePreparation(generation, files);",
          );
          writeFileSync(
            source,
            original.replaceAll(
              "this.validatePreparation(generation, files)",
              "undefined /* isolated negative control: stale snapshot accepted */",
            ),
          );
        }
        stalled = gatedProcess(
          f.config,
          `console.log(JSON.stringify(await store.commit(${JSON.stringify(change("stale-candidate", [n], [window("stale-window")]))})));`,
          "prepared",
          source,
        );
        await stalled.ready();
        expect(
          await f.store.commit({
            ...change("competing"),
            suppressions: [
              {
                suppressionId: "during-preparation" as C.SuppressionId,
                scope,
                target: { kind: "note", noteId: n.noteId },
                createdAt: now,
                reason: "concurrent denial",
              },
            ],
          }),
        ).toMatchObject({ kind: "locally-committed" });
        stalled.release();
        const result = await stalled.done;
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          kind: fenced ? "suppressed" : "locally-committed",
        });
      } finally {
        stalled?.release();
        await stalled?.done;
        f.store.close();
        rmSync(f.dir, { recursive: true });
      }
    }
  }, 30000);
  it.runIf(process.platform === "darwin")(
    "reconfirms physically replaced same-byte history before commit ACK, with a path-only cache negative control",
    async () => {
      for (const physical of [true, false]) {
        const f = fixture();
        try {
          f.store.close();
          const isolated = join(f.dir, "runtime");
          cpSync(dirname(sourcePath), isolated, { recursive: true });
          symlinkSync(
            join(process.cwd(), "node_modules"),
            join(f.dir, "node_modules"),
          );
          const copy = join(isolated, "store.ts"),
            original = readFileSync(copy, "utf8");
          if (!physical) {
            expect(original).toContain("this.confirmed.get(path) === identity");
            writeFileSync(
              copy,
              original.replace(
                "this.confirmed.get(path) === identity",
                "this.confirmed.has(path)",
              ),
            );
          }
          const c = change("replacement-replay", [note("replacement")]);
          const targetHash = sha256(canonicalJSON(c.edits[0]!.revision));
          const helper = join(f.dir, "python3");
          writeFileSync(
            helper,
            `#!/usr/bin/python3
import os,fcntl
p=fcntl.fcntl(3,50,b'\\0'*1024).split(b'\\0')[0].decode()
if os.environ.get('PI_MEMORY_FIXTURE_FAIL_BARRIER') == '1' and os.path.basename(p) == ${JSON.stringify(targetHash)}:
 fcntl.fcntl(3,2147483646)
fcntl.fcntl(3,51)
`,
          );
          chmodSync(helper, 0o700);
          const result = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
          import assert from 'node:assert/strict';import {createJiti} from 'jiti';import {readFileSync,writeFileSync,renameSync} from 'node:fs';
          const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false});const {FileMemoryStore}=await jiti.import(${JSON.stringify(copy)});
          const config=${JSON.stringify(f.config)},c=${JSON.stringify(c)};const store=await FileMemoryStore.open(config);
          await store.commit(c);await store.commit(c);
          const path=config.data+'/objects/'+${JSON.stringify(sha256(canonicalJSON(c.edits[0]!.revision)))};
          writeFileSync(path+'.replacement',readFileSync(path));renameSync(path+'.replacement',path);
          process.env.PI_MEMORY_FIXTURE_FAIL_BARRIER='1';let failed=false;
          try{await store.commit(${JSON.stringify(change("post-replacement"))});}catch(error){failed=String(error).includes('F_FULLFSYNC');}
          store.close();assert.equal(failed,true,'same-byte replacement inherited old physical ACK');
        `,
            ],
            {
              cwd: process.cwd(),
              env: { ...process.env, PATH: f.dir + ":" + process.env.PATH },
              encoding: "utf8",
              timeout: 15000,
            },
          );
          if (physical) expect(result.status, String(result.stderr)).toBe(0);
          else {
            expect(result.status).not.toBe(0);
            expect(String(result.stderr)).toContain(
              "same-byte replacement inherited old physical ACK",
            );
          }
        } finally {
          f.store.close();
          rmSync(f.dir, { recursive: true });
        }
      }
    },
    30000,
  );
  it.runIf(process.platform === "darwin")(
    "keeps the writer and renewal available during a stalled external F_FULLFSYNC",
    async () => {
      const f = fixture(),
        ready = join(f.dir, "native-barrier-ready"),
        release = join(f.dir, "native-barrier-release");
      let done: Promise<{ status: number | null; stderr: string }> | undefined;
      try {
        await f.store.commit(
          change("seed", [note("native-barrier")], [window()]),
        );
        const plan = await f.store.plan({
          jobId: "barrier" as C.JobId,
          owner: "fixture",
          scope,
          now,
          policy: { ...policy, minWindows: 1 },
        });
        if (plan.kind !== "eligible") throw Error("expected lease");
        const helper = join(f.dir, "python3");
        writeFileSync(
          helper,
          `#!/usr/bin/python3
import os,time,fcntl
if os.environ.get('PI_MEMORY_FIXTURE_STALL_BARRIER') == '1' and not os.path.exists(${JSON.stringify(release)}):
 open(${JSON.stringify(ready)},'w').write('native F_FULLFSYNC waiting')
 while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)
fcntl.fcntl(3,51)
`,
        );
        chmodSync(helper, 0o700);
        const proc = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `${childPrelude}const store=await FileMemoryStore.open(${JSON.stringify(f.config)});try{await store.commit(${JSON.stringify(change("after-native-barrier"))});}finally{store.close();}`,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PATH: f.dir + ":" + process.env.PATH,
              PI_MEMORY_FIXTURE_STALL_BARRIER: "1",
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "",
          ended = false;
        proc.stderr!.on("data", (c) => {
          stderr += c;
        });
        done = new Promise((resolve) =>
          proc.on("close", (status) => {
            ended = true;
            resolve({ status, stderr });
          }),
        );
        const deadline = performance.now() + 8000;
        while (!existsSync(ready)) {
          if (ended || performance.now() > deadline)
            throw Error(`native barrier unavailable: ${stderr}`);
          await delay(10);
        }
        const held = await holdWriter(f.config);
        await held.release();
        expect(
          await f.store.renewLease({
            lease: plan.batch.lease,
            now: "2026-01-01T00:00:05.000Z",
            leaseMs: 20000,
          }),
        ).toMatchObject({ kind: "renewed" });
        writeFileSync(release, "release");
        const result = await done;
        expect(result.status, result.stderr).toBe(0);
        expect(
          await f.store.hasAcceptedCommit("after-native-barrier" as C.CommitId),
        ).toBe(true);
      } finally {
        writeFileSync(release, "release");
        await done;
        f.store.close();
        rmSync(f.dir, { recursive: true });
      }
    },
    20000,
  );
  async function placementBarrierProbe(
    phase: string,
    guarded = true,
  ): Promise<void> {
    const f = fixture(),
      ready = join(f.dir, "placement-barrier-ready"),
      release = join(f.dir, "placement-barrier-release");
    let done:
      | Promise<{ status: number | null; stdout: string; stderr: string }>
      | undefined;
    let fd: number | undefined;
    try {
      const initial = note("placement", "original inode bytes");
      await f.store.commit(change("seed", [initial], [window()]));
      const plan = await f.store.plan({
        jobId: "lease" as C.JobId,
        owner: "fixture",
        scope,
        now,
        policy: { ...policy, minWindows: 1 },
      });
      if (plan.kind !== "eligible") throw Error("expected lease");
      const a = note("placement", "prepared A", [initial.revisionId]);
      let b = note("placement", "newer B", [
        phase === "envelope" ? initial.revisionId : a.revisionId,
      ]);
      const helper = join(f.dir, "python3");
      writeFileSync(
        helper,
        `#!/usr/bin/python3
import os,time,fcntl
p=fcntl.fcntl(3,50,b'\\0'*1024).split(b'\\0')[0].decode()
n=os.path.basename(p)
phase=${JSON.stringify(phase)}
match=(phase=='manifest' and n==${JSON.stringify(sha256("old-A"))}) or (phase=='envelope' and n.startswith('.manifest-')) or (phase=='candidate' and n.endswith('.candidate.md')) or (phase=='basis' and n.endswith('.basis.md')) or (phase=='intent' and n.endswith('.intent')) or (phase=='stash' and n.endswith('.stash.md')) or (phase=='completion' and n.endswith('.candidate.md.done'))
if os.environ.get('PI_MEMORY_PLACEMENT_GATE')=='1' and match and not os.path.exists(${JSON.stringify(release)}):
 open(${JSON.stringify(ready)},'w').write(p)
 while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)
fcntl.fcntl(3,51)
`,
      );
      chmodSync(helper, 0o700);
      let source = sourcePath;
      if (!guarded) {
        const isolated = join(f.dir, "runtime");
        cpSync(dirname(sourcePath), isolated, { recursive: true });
        symlinkSync(
          join(process.cwd(), "node_modules"),
          join(f.dir, "node_modules"),
        );
        source = join(isolated, "store.ts");
        const original = readFileSync(source, "utf8");
        const at = original.indexOf("  private finishPlacement(");
        const end = original.indexOf("\n}\n\nif (import.meta.vitest)", at);
        const tail = original.slice(at, end);
        expect(tail).toContain("this.requirePreparation()");
        writeFileSync(
          source,
          original.slice(0, at) +
            tail.replace(
              "this.requirePreparation()",
              "undefined /* isolated negative control: placement fence disabled */",
            ) +
            original.slice(end),
        );
      }
      if (phase === "stash")
        fd = openSync(join(f.config.root, initial.path), "a");
      const proc = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {createJiti} from 'jiti';
        const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false});
        const {FileMemoryStore}=await jiti.import(${JSON.stringify(source)});
        const store=await FileMemoryStore.open(${JSON.stringify(f.config)});
        process.env.PI_MEMORY_PLACEMENT_GATE='1';
        try{console.log(JSON.stringify(await store.commit(${JSON.stringify(change("old-A", [a]))})));}finally{store.close();}
      `,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, PATH: f.dir + ":" + process.env.PATH },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        ended = false;
      proc.stdout.on("data", (c) => {
        stdout += c;
      });
      proc.stderr.on("data", (c) => {
        stderr += c;
      });
      done = new Promise((resolve) =>
        proc.on("close", (status) => {
          ended = true;
          resolve({ status, stdout, stderr });
        }),
      );
      const deadline = performance.now() + 8000;
      while (!existsSync(ready)) {
        if (ended || performance.now() > deadline)
          throw Error(`native ${phase} barrier unavailable: ${stderr}`);
        await delay(10);
      }
      // The real native writer and renewable evidence lease remain available
      // while a separate process is inside F_FULLFSYNC preparation/finalization.
      const probe = child(
        f.config,
        `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(config.state+'/coordination.sqlite');db.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE;COMMIT');db.close();`,
      );
      expect(probe.status, String(probe.stderr)).toBe(0);
      expect(
        await f.store.renewLease({
          lease: plan.batch.lease,
          now: "2026-01-01T00:00:02.000Z",
          leaseMs: 30000,
        }),
      ).toMatchObject({ kind: "renewed" });
      if (fd !== undefined) {
        writeSync(fd, "\nunpublished inode particulars");
        const current = (await f.store.listNotes(scope)).filter(
          (n) => n.noteId === initial.noteId,
        );
        expect(
          current.some(
            (n) =>
              n.ancestry.kind === "unknown-base" &&
              n.markdown.includes("unpublished inode particulars"),
          ),
        ).toBe(true);
        b = note(
          "placement",
          "newer B",
          current.map((n) => n.revisionId),
        );
      }
      expect(
        await f.store.commit(
          change("new-B", [b], [window("concurrent-capture")]),
        ),
      ).toMatchObject({ kind: "locally-committed" });
      expect(readFileSync(join(f.config.root, b.path), "utf8")).toBe(
        b.markdown,
      );
      writeFileSync(release, "release");
      const result = await done;
      expect(result.status, result.stderr).toBe(0);
      const finalBytes = readFileSync(join(f.config.root, b.path), "utf8");
      expect(finalBytes, "delayed old placement replaced newer B").toBe(
        b.markdown,
      );
      if (fd !== undefined) {
        expect(
          readdirSync(join(f.config.root, ".pi-memory-recovery"))
            .filter((n) => n.endsWith(".stash.md"))
            .some((n) =>
              readFileSync(
                join(f.config.root, ".pi-memory-recovery", n),
                "utf8",
              ).includes("unpublished inode particulars"),
            ),
        ).toBe(true);
      }
      const receipt = JSON.parse(result.stdout.trim());
      expect(receipt.kind).toBe(
        phase === "envelope" ? "conflict" : "locally-committed",
      );
    } finally {
      writeFileSync(release, "release");
      await done;
      if (fd !== undefined) closeSync(fd);
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }
  for (const phase of [
    "envelope",
    "manifest",
    "candidate",
    "basis",
    "intent",
    "stash",
    "completion",
  ])
    it.runIf(process.platform === "darwin")(
      `keeps capture and renewal independent of native ${phase} barriers without replacing newer placement`,
      async () => {
        await placementBarrierProbe(phase);
      },
      45000,
    );
  it.runIf(process.platform === "darwin")(
    "detects stale placement replacement with its fence disabled in isolated real files",
    async () => {
      await expect(placementBarrierProbe("candidate", false)).rejects.toThrow(
        "delayed old placement replaced newer B",
      );
    },
    45000,
  );
  it("keeps publication generation distinct from append-stable replica continuity and lease renewal", async () => {
    const f = fixture();
    const db = new DatabaseSync(join(f.config.state, "coordination.sqlite"));
    const generation = () =>
      Number(
        db
          .prepare("SELECT generation FROM publication_generation WHERE id=1")
          .get()?.generation ?? 0,
      );
    try {
      await f.store.commit(change("seed", [], [window()]));
      const peer = f.store.forPeer("fixture"),
        epoch = await peer.continuityToken(),
        before = generation();
      const plan = await f.store.plan({
        jobId: "generation" as C.JobId,
        owner: "fixture",
        scope,
        now,
        policy: { ...policy, minWindows: 1 },
      });
      if (plan.kind !== "eligible") throw Error("expected lease");
      expect(
        await f.store.renewLease({
          lease: plan.batch.lease,
          now,
          leaseMs: 20000,
        }),
      ).toMatchObject({ kind: "renewed" });
      expect(generation()).toBe(before);
      expect(await peer.continuityToken()).toBe(epoch);
      await f.store.commit(change("append", [], [window("appended")]));
      expect(generation()).toBe(before + 1);
      expect(await peer.continuityToken()).toBe(epoch);
    } finally {
      db.close();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("opens asynchronously across a >250ms native writer lock (sync opener is the negative control)", async () => {
    const f = fixture();
    const n = note("opening");
    await f.store.commit(change("seed-open", [n]));
    writeFileSync(
      join(f.config.root, n.path),
      n.markdown.replace("original", "pending native edit"),
    );
    const held = await holdWriter(f.config);
    let opened: FileMemoryStore | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(() => new FileMemoryStore(f.config)).toThrow("database is locked");
      let timerRan = false;
      const tick = setTimeout(() => {
        timerRan = true;
      }, 20);
      const released = new Promise<void>((resolve) => {
        release = setTimeout(() => {
          void held.release().then(resolve);
        }, 700);
      });
      opened = await FileMemoryStore.open(f.config, {
        contentionTimeoutMs: 2000,
      });
      await released;
      clearTimeout(tick);
      expect(timerRan).toBe(true);
      expect(
        await opened.commit(change("opened", [note("opened")])),
      ).toMatchObject({ kind: "locally-committed" });
      expect(
        (await opened.listNotes(scope)).some((n) =>
          n.markdown.includes("pending native edit"),
        ),
      ).toBe(true);
    } finally {
      clearTimeout(release);
      await held.release();
      opened?.close();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 10000);
  it("retries production capture, editable import and fenced commit without locking the model phase", async () => {
    const f = fixture();
    let held: Awaited<ReturnType<typeof holdWriter>> | undefined;
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      held = await holdWriter(f.config);
      // Unchanged views and authenticated outbox reads need no writer reservation.
      expect(
        await f.store.listNotes(scope, { contentionTimeoutMs: 0 }),
      ).toEqual([n]);
      expect(
        await f.store.forPeer("test", { contentionTimeoutMs: 0 }).readCursor(),
      ).toBeNull();
      const capture = f.store.commit(
        change("capture-contention", [], [window()]),
        { contentionTimeoutMs: 2000 },
      );
      await delay(700);
      await held.release();
      held = undefined;
      expect(await capture).toMatchObject({ kind: "locally-committed" });
      held = await holdWriter(f.config);
      writeFileSync(
        join(f.config.root, n.path),
        n.markdown.replace("original", "native edit"),
      );
      const reading = f.store.listNotes(scope, { contentionTimeoutMs: 2000 });
      await delay(700);
      await held.release();
      held = undefined;
      const imported = (await reading).find((n) =>
        n.markdown.includes("native edit"),
      )!;
      expect(imported.markdown).toContain("native edit");
      expect(imported.ancestry.kind).toBe("unknown-base");
      const plan = await f.store.plan({
        jobId: "model" as C.JobId,
        owner: "model",
        scope,
        now,
        policy: { ...policy, minWindows: 1 },
      });
      if (plan.kind !== "eligible") throw new Error("expected lease");
      // A real second process acquires IMMEDIATE while the caller does model work.
      held = await holdWriter(f.config);
      const commit = f.store.commit(
        {
          ...change("consolidated", [note("result")]),
          lease: plan.batch.lease,
          outcomes: plan.batch.windows.map(({ window: w }) => ({
            windowId: w.windowId,
            sourceHash: w.sourceHash,
            recordedAt: now,
            decision: { kind: "no-change", reason: "fixture" },
          })),
        },
        { contentionTimeoutMs: 2000 },
      );
      await delay(700);
      await held.release();
      held = undefined;
      expect(await commit).toMatchObject({ kind: "locally-committed" });
      expect(await f.store.pendingScopes()).toEqual([]);
      expect(
        [
          ...new Set((await f.store.listNotes(scope)).map((n) => n.noteId)),
        ].sort(),
      ).toEqual(["a", "result"]);
    } finally {
      await held?.release();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 15000);
  it("opens fresh retained-history readers while another process owns the writer lock, without durability acknowledgment", async () => {
    const f = fixture();
    let held: Awaited<ReturnType<typeof holdWriter>> | undefined;
    try {
      for (let i = 0; i < 6; i++)
        await f.store.commit(
          change(
            `history-${i}`,
            [note(`history-${i}`)],
            [window(`history-${i}`)],
          ),
        );
      // Include 109 retained manifests without paying 109 seed acknowledgments.
      // These valid fixture appends deliberately have no durability acknowledgment;
      // readers may inspect them, but a subsequent writer must confirm them.
      for (let i = 6; i < 109; i++) {
        const replica: C.ReplicaChange = {
          commitId: `history-${i}` as C.CommitId,
          replicaId: f.config.replicaId,
          parents: [`history-${i - 1}` as C.CommitId],
          revisions: [],
          windows: [],
          suppressions: [],
          outcomes: [],
        };
        const bytes = canonicalJSON(replica),
          hash = sha256(bytes);
        writeFileSync(join(f.config.data, "objects", hash), bytes);
        const payload = {
          version: 1,
          dependencies: [hash],
          replica: hash,
          local: null,
        };
        writeFileSync(
          join(f.config.data, "commits", sha256(replica.commitId)),
          canonicalJSON({ ...payload, hash: sha256(canonicalJSON(payload)) }),
        );
      }
      held = await holdWriter(f.config);
      // Any accidental Darwin confirmation would execute this real failing helper.
      const helpers = join(f.dir, "helpers");
      durableDirectory(helpers);
      writeFileSync(join(helpers, "python3"), "#!/bin/sh\nexit 93\n");
      chmodSync(join(helpers, "python3"), 0o700);
      const run = () =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolve) => {
            const proc = spawn(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `${childPrelude}
          const store=await FileMemoryStore.open(${JSON.stringify(f.config)},{contentionTimeoutMs:0});
          try {console.log(JSON.stringify({notes:(await store.listNotes(${JSON.stringify(scope)})).length,commits:(await store.forPeer('reader').scan(null,256)).length}));} finally {store.close();}
        `,
              ],
              {
                cwd: process.cwd(),
                env: { ...process.env, PATH: helpers + ":" + process.env.PATH },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "",
              stderr = "";
            proc.stdout.on("data", (c) => {
              stdout += c;
            });
            proc.stderr.on("data", (c) => {
              stderr += c;
            });
            proc.on("close", (status) => resolve({ status, stdout, stderr }));
          },
        );
      for (const result of await Promise.all([run(), run(), run()])) {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ notes: 6, commits: 109 });
      }
    } finally {
      await held?.release();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 20000);
  it("discards preflight diagnostics when import cannot obtain a writer reservation", async () => {
    const f = fixture();
    let held: Awaited<ReturnType<typeof holdWriter>> | undefined;
    try {
      const n = note("diagnostic");
      await f.store.commit(change("seed", [n]));
      const path = join(f.config.root, n.path);
      writeFileSync(path, "<!-- pi-memory {broken-json} -->\nkeep");
      await f.store.listNotes(scope);
      const before = f.store.editableProblems();
      expect(before).toHaveLength(1);
      held = await holdWriter(f.config);
      writeFileSync(path, n.markdown.replace("original", "changed"));
      await expect(
        f.store.listNotes(scope, { contentionTimeoutMs: 20 }),
      ).rejects.toBeInstanceOf(StoreContentionError);
      expect(f.store.editableProblems()).toEqual(before);
    } finally {
      await held?.release();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("detects missing production retries in a disposable source negative control", async () => {
    const f = fixture();
    try {
      f.store.close();
      const isolated = join(f.dir, "runtime");
      cpSync(dirname(sourcePath), isolated, { recursive: true });
      symlinkSync(
        join(process.cwd(), "node_modules"),
        join(f.dir, "node_modules"),
      );
      const copy = join(isolated, "store.ts"),
        original = readFileSync(copy, "utf8");
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import {DatabaseSync} from 'node:sqlite'; import {createJiti} from 'jiti';
        const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false});
        const {FileMemoryStore}=await jiti.import(${JSON.stringify(copy)});
        const lock=new DatabaseSync(${JSON.stringify(join(f.config.state, "coordination.sqlite"))});
        lock.exec('BEGIN IMMEDIATE'); let locked=true;
        const release=()=>{if(locked){locked=false;lock.exec('COMMIT');lock.close();}};
        const timer=setTimeout(release,350);
        let store;try{store=await FileMemoryStore.open(${JSON.stringify(f.config)},{contentionTimeoutMs:1200});}
        catch(error){console.error(JSON.stringify({message:error.message,errcode:error.errcode}));process.exitCode=1;}
        finally{clearTimeout(timer);release();store?.close();}
      `,
          ],
          { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
        );
      writeFileSync(
        join(f.config.root, "positive.md"),
        note("positive").markdown,
      );
      const positive = run();
      expect(positive.status, String(positive.stderr)).toBe(0);
      const needle = "if (!(error instanceof LockUnavailable)) throw error;";
      expect(original).toContain(needle);
      writeFileSync(
        copy,
        original.replace(
          needle,
          "throw error; /* isolated negative control: retries removed */",
        ),
      );
      writeFileSync(
        join(f.config.root, "negative.md"),
        note("negative").markdown,
      );
      const negative = run();
      expect(negative.status).not.toBe(0);
      expect(String(negative.stderr)).toContain("database is locked");
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 20000);
  it("fences elapsed lease expiry during writer contention without a reclaimer or changing receipt identity", async () => {
    for (const operation of ["commit", "renew"] as const) {
      const f = fixture();
      let held: Awaited<ReturnType<typeof holdWriter>> | undefined;
      try {
        const w = window();
        await f.store.commit(change("expiry-capture", [], [w]));
        const plan = await f.store.plan({
          jobId: "expiry" as C.JobId,
          owner: "worker",
          scope,
          now,
          policy: { ...policy, minWindows: 1, leaseMs: 100 },
        });
        if (plan.kind !== "eligible") throw Error("expected lease");
        held = await holdWriter(f.config);
        const pending =
          operation === "renew"
            ? f.store.renewLease({
                lease: plan.batch.lease,
                now,
                leaseMs: 10000,
              })
            : f.store.commit({
                ...change("elapsed-provider", [note("elapsed-provider")]),
                lease: plan.batch.lease,
                outcomes: [
                  {
                    windowId: w.windowId,
                    sourceHash: w.sourceHash,
                    recordedAt: now,
                    decision: { kind: "no-change", reason: "fixture" },
                  },
                ],
              });
        await delay(180);
        await held.release();
        held = undefined;
        expect(await pending).toEqual({ kind: "lease-lost" });
        expect(
          await f.store.hasAcceptedCommit("elapsed-provider" as C.CommitId),
        ).toBe(false);
      } finally {
        await held?.release();
        f.store.close();
        rmSync(f.dir, { recursive: true });
      }
    }
  });
  it("fences cancellation after real preparation and immediately before manifest publication, without undoing accepted receipts", async () => {
    for (const boundary of ["prepared", "objects", "manifest"] as const) {
      const f = fixture(),
        controller = new AbortController(),
        reason = new Error("provider owner cancelled");
      let armed = false;
      try {
        f.store.close();
        f.store = await FileMemoryStore.open({
          ...f.config,
          publicationBoundary: (b) => {
            if (armed && b === boundary) controller.abort(reason);
          },
        });
        armed = true;
        const c = change(`cancel-${boundary}`, [note(`cancel-${boundary}`)]);
        if (boundary === "manifest")
          expect(
            await f.store.commit(c, { signal: controller.signal }),
          ).toMatchObject({ kind: "locally-committed", replay: false });
        else
          await expect(
            f.store.commit(c, { signal: controller.signal }),
          ).rejects.toBe(reason);
        armed = false;
        expect(await f.store.hasAcceptedCommit(c.commitId)).toBe(
          boundary === "manifest",
        );
        if (boundary === "manifest")
          expect(await f.store.commit(c)).toMatchObject({
            kind: "locally-committed",
            replay: true,
          });
        else
          expect(
            await f.store.commit(change(`cleanup-${boundary}`)),
          ).toMatchObject({ kind: "locally-committed" });
      } finally {
        f.store.close();
        rmSync(f.dir, { recursive: true });
      }
    }
  });
  it("accepts the supplied snapshot even if its caller mutates the request during coordination contention", async () => {
    const f = fixture();
    let held: Awaited<ReturnType<typeof holdWriter>> | undefined;
    try {
      const n = note("owned-snapshot"),
        request = change("owned-snapshot", [n], [window("owned-snapshot")]);
      held = await holdWriter(f.config);
      const committing = f.store.commit(request, { contentionTimeoutMs: 2000 });
      Reflect.set(request, "commitId", "caller-retargeted");
      Reflect.set(
        n,
        "markdown",
        n.markdown + "\ncaller changed after submission",
      );
      await held.release();
      held = undefined;
      expect(await committing).toMatchObject({
        kind: "locally-committed",
        commitId: "owned-snapshot",
      });
      const accepted = (await f.store.forPeer("fixture").scan(null, 10))[0]!;
      expect(accepted.commitId).toBe("owned-snapshot");
      expect(accepted.revisions[0]!.markdown).not.toContain(
        "caller changed after submission",
      );
      f.store.close();
      f.store = await FileMemoryStore.open(f.config);
      expect(
        await f.store.hasAcceptedCommit("owned-snapshot" as C.CommitId),
      ).toBe(true);
      expect(
        await f.store.hasAcceptedCommit("caller-retargeted" as C.CommitId),
      ).toBe(false);
    } finally {
      await held?.release();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("scopes a successful opener's signal to initialization and retains explicit operation cancellation", async () => {
    const f = fixture(),
      acquisition = new AbortController();
    try {
      f.store.close();
      f.store = await FileMemoryStore.open(f.config, {
        signal: acquisition.signal,
        contentionTimeoutMs: 0,
      });
      acquisition.abort(new Error("native shutdown"));
      expect(
        await f.store.commit(change("finalization", [note("finalized")])),
      ).toMatchObject({ kind: "locally-committed" });
      await expect(
        f.store.commit(change("cancelled-operation", [note("cancelled")]), {
          signal: acquisition.signal,
        }),
      ).rejects.toBe(acquisition.signal.reason);
      const held = await holdWriter(f.config);
      try {
        const cancellation = new AbortController(),
          timer = setTimeout(
            () => cancellation.abort(new Error("budget was replaced")),
            150,
          );
        try {
          await expect(
            f.store.commit(change("retained-zero-budget"), {
              signal: cancellation.signal,
            }),
          ).rejects.toBeInstanceOf(StoreContentionError);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        await held.release();
      }
      f.store.close();
      const reopened = child(
        f.config,
        `const store=await FileMemoryStore.open(config);try{console.log(JSON.stringify({accepted:await store.hasAcceptedCommit('finalization'),cancelled:await store.hasAcceptedCommit('cancelled-operation'),notes:(await store.listNotes(${JSON.stringify(scope)})).map(n=>n.noteId)}));}finally{store.close();}`,
      );
      expect(reopened.status, String(reopened.stderr)).toBe(0);
      expect(JSON.parse(String(reopened.stdout))).toEqual({
        accepted: true,
        cancelled: false,
        notes: ["finalized"],
      });
      const init = new AbortController(),
        reason = new Error("initialization cancelled");
      await expect(
        FileMemoryStore.open(
          {
            ...f.config,
            publicationBoundary: (b) => {
              if (b === "prepared") init.abort(reason);
            },
          },
          { signal: init.signal },
        ),
      ).rejects.toBe(reason);
      f.store = await FileMemoryStore.open(f.config);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("bounds contention, cancels opening and methods, and closes failed open connections", async () => {
    const f = fixture();
    const held = await holdWriter(f.config);
    writeFileSync(join(f.config.root, "pending.md"), note("pending").markdown);
    const { vi } = await import("vitest");
    const closed = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      await expect(
        FileMemoryStore.open(f.config, { contentionTimeoutMs: 30 }),
      ).rejects.toMatchObject({ code: "MEMORY_STORE_CONTENTION_TIMEOUT" });
      expect(closed.mock.calls.length).toBeGreaterThan(0);
      // Every failed constructor connection really is closed, not just scheduled.
      for (const db of closed.mock.contexts)
        expect(() => (db as DatabaseSync).prepare("SELECT 1")).toThrow();
      const abort = new AbortController();
      const reason = new Error("fixture cancellation");
      const opening = FileMemoryStore.open(f.config, { signal: abort.signal });
      const writing = f.store.commit(change("cancelled", [note("cancelled")]), {
        signal: abort.signal,
      });
      const cancelled = Promise.all([
        expect(opening).rejects.toBe(reason),
        expect(writing).rejects.toBe(reason),
      ]);
      setTimeout(() => abort.abort(reason), 20);
      await cancelled;
      await expect(
        f.store.readDelivery("absent" as C.DeliveryId, {
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      await expect(
        f.store.commit(change("budget", [note("budget")]), {
          contentionTimeoutMs: 30,
        }),
      ).rejects.toBeInstanceOf(StoreContentionError);
      await expect(
        f.store.forPeer("test", { contentionTimeoutMs: 30 }).continuityToken(),
      ).rejects.toBeInstanceOf(StoreContentionError);
      const waiting = f.store.commit(change("closed", [note("closed")]), {
        contentionTimeoutMs: 1000,
      });
      f.store.close();
      await expect(waiting).rejects.toThrow("memory store is closed");
      await held.release();
      unlinkSync(join(f.config.root, "pending.md"));
      f.store = await FileMemoryStore.open(f.config);
      expect(await f.store.listNotes(scope)).toEqual([]);
      expect(await f.store.forPeer("test").scan(null, 10)).toEqual([]);
    } finally {
      closed.mockRestore();
      await held.release();
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  }, 10000);
  it("serializes independent writers and leases one pending window only once", async () => {
    const f = fixture();
    try {
      await f.store.commit(change("capture", [], [window()]));
      f.store.close();
      const run = (
        id: string,
      ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const script = `${childPrelude} const store=await FileMemoryStore.open(${JSON.stringify(f.config)}); try { await store.commit(${JSON.stringify(change(id, [note(id)]))});console.log(JSON.stringify(await store.plan(${JSON.stringify({ jobId: id, owner: id, scope, now: later, policy })}))); } finally {store.close();}`;
          const process = spawn(
            globalThis.process.execPath,
            ["--input-type=module", "-e", script],
            {
              cwd: globalThis.process.cwd(),
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          process.stdout.on("data", (c) => {
            stdout += c;
          });
          process.stderr.on("data", (c) => {
            stderr += c;
          });
          process.on("close", (status) => resolve({ status, stdout, stderr }));
        });
      const results = await Promise.all([run("writer-one"), run("writer-two")]);
      for (const r of results) expect(r.status, r.stderr).toBe(0);
      expect(
        results
          .map((r) => JSON.parse(r.stdout).kind)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["eligible", "idle"]);
      f.store = new FileMemoryStore(f.config);
      expect(await f.store.listNotes(scope)).toHaveLength(2);
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  it("a manifest-published killed reconciliation retains all per-window outcomes and note edits", async () => {
    const f = fixture();
    try {
      await f.store.commit(
        change("capture", [], [window(), window("entry-b"), window("entry-c")]),
      );
      f.store.close();
      const edits = change("reconcile", [note("a"), note("b")]);
      const killed = child(
        f.config,
        `const store=new FileMemoryStore({...config,publicationBoundary:(b,id)=>{if(b==='manifest'&&id==='reconcile')process.kill(process.pid,'SIGKILL')}}); const p=await store.plan(${JSON.stringify({ jobId: "worker", owner: "worker", scope, now, policy })}); const decisions=[{kind:'no-change',reason:'same'},{kind:'ineligible',reason:'private'},{kind:'retry',reason:'later',retryAt:${JSON.stringify(later)}}]; await store.commit({...${JSON.stringify(edits)},lease:p.batch.lease,outcomes:p.batch.windows.map((p,i)=>({windowId:p.window.windowId,sourceHash:p.window.sourceHash,recordedAt:${JSON.stringify(now)},decision:decisions[i]}))});`,
      );
      expect(killed.signal, String(killed.stderr)).toBe("SIGKILL");
      const reopened = child(
        f.config,
        `const store=new FileMemoryStore(config); const p=await store.plan(${JSON.stringify({ jobId: "fresh", owner: "fresh", scope, now: later, policy })}); console.log(JSON.stringify({notes:(await store.listNotes(${JSON.stringify(scope)})).length,windows:p.batch.windows.length,attempts:p.batch.windows[0].attempts})); store.close();`,
      );
      expect(reopened.status, String(reopened.stderr)).toBe(0);
      expect(JSON.parse(String(reopened.stdout))).toEqual({
        notes: 2,
        windows: 1,
        attempts: 1,
      });
      f.store = new FileMemoryStore(f.config);
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  it("dependency-order verifier fails when its publication check is removed in an isolated source copy", () => {
    const f = fixture();
    try {
      f.store.close();
      const isolated = join(f.dir, "runtime");
      cpSync(dirname(sourcePath), isolated, { recursive: true });
      symlinkSync(
        join(process.cwd(), "node_modules"),
        join(f.dir, "node_modules"),
      );
      const copy = join(isolated, "store.ts");
      const original = readFileSync(copy, "utf8");
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import assert from 'node:assert/strict'; import {createJiti} from 'jiti'; import {readdirSync,unlinkSync,existsSync} from 'node:fs'; const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false}); const {FileMemoryStore,isStoreBusy}=await jiti.import(${JSON.stringify(copy)}); const config=${JSON.stringify(f.config)}; const store=new FileMemoryStore({...config,publicationBoundary:b=>{if(b==='objects'){const files=readdirSync(config.data+'/objects').filter(f=>!f.startsWith('.')); unlinkSync(config.data+'/objects/'+files[0]);}}}); try { await store.commit(${JSON.stringify(change("order", [note("a")]))}); } catch {} store.close(); assert.equal(existsSync(config.data+'/commits/'+${JSON.stringify(sha256("order"))}),false,'manifest published without all durable dependencies');`,
          ],
          { cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
        );
      const positive = run();
      expect(positive.status, String(positive.stderr)).toBe(0);
      writeFileSync(
        copy,
        original
          .replace(
            "this.verifyDependencies(dependencies);",
            "/* isolated negative control: verification removed */",
          )
          .replace(
            "for (const hash of dependencies) this.observe(join(this.objects, hash));",
            "",
          )
          .replaceAll(
            "this.validatePreparation(generation, files)",
            "undefined /* isolated negative control: physical fence removed */",
          ),
      );
      const negative = run();
      expect(negative.status).not.toBe(0);
      expect(String(negative.stderr)).toContain(
        "manifest published without all durable dependencies",
      );
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  for (const failure of ["object", "manifest"] as const)
    it.runIf(process.platform === "darwin")(
      `retries a real external ${failure} full-flush failure before acknowledgment`,
      async () => {
        const f = fixture();
        const oldPath = process.env.PATH;
        try {
          f.store.close();
          const target = join(
            f.config.data,
            failure === "object" ? "objects" : "commits",
            failure === "object"
              ? sha256(canonicalJSON(note("a")))
              : sha256("flush-retry"),
          );
          const helper = join(f.dir, "python3"),
            failed = join(f.dir, "failed"),
            completed = join(f.dir, "completed");
          writeFileSync(
            helper,
            `#!/usr/bin/python3
import os,sys,fcntl
p=fcntl.fcntl(3,50,b'\\0'*1024).split(b'\\0')[0].decode()
if os.path.basename(p) == os.path.basename(${JSON.stringify(target)}) and not os.path.exists(${JSON.stringify(failed)}):
 open(${JSON.stringify(failed)},'w').write(p)
 fcntl.fcntl(3,2147483646)
fcntl.fcntl(3,51)
if os.path.basename(p) == os.path.basename(${JSON.stringify(target)}):
 open(${JSON.stringify(completed)},'w').write(p)
`,
          );
          chmodSync(helper, 0o700);
          process.env.PATH = `${f.dir}:${oldPath}`;
          f.store = new FileMemoryStore(f.config);
          const c = change("flush-retry", [note("a")]);
          await expect(f.store.commit(c)).rejects.toThrow("F_FULLFSYNC");
          expect(
            existsSync(join(f.config.data, "commits", sha256("flush-retry"))),
          ).toBe(failure === "manifest");
          expect(existsSync(target)).toBe(true);
          expect(existsSync(completed)).toBe(false);
          f.store.close();
          f.store = new FileMemoryStore(f.config);
          expect(await f.store.commit(c)).toMatchObject({
            kind: "locally-committed",
            replay: failure === "manifest",
          });
          expect(readFileSync(completed, "utf8").split("/").pop()).toBe(
            target.split("/").pop(),
          );
          expect(
            readdirSync(join(f.config.data, "objects")).some((p) =>
              p.startsWith(".pi-memory-stage-"),
            ),
          ).toBe(false);
        } finally {
          process.env.PATH = oldPath;
          try {
            f.store.close();
          } catch {}
          rmSync(f.dir, { recursive: true });
        }
      },
      30000,
    );
  it("binds evidence roles/spans and rejects suppressed evidence or derived relearning", async () => {
    const f = fixture();
    try {
      const a = window(),
        b = window("other-entry");
      const evidence: C.EvidenceRef = {
        windowId: a.windowId,
        source: a.source,
        sourceHash: a.sourceHash,
        spans: [a.excerpts[0].span],
      };
      const otherEvidence: C.EvidenceRef = {
        windowId: b.windowId,
        source: b.source,
        sourceHash: b.sourceHash,
        spans: [b.excerpts[0].span],
      };
      const original = note("a");
      const { markdown: _md, revisionId: _id, ...metadata } = original;
      const attributed = createNoteRevision({
        ...metadata,
        body: "an attributed observation",
        claims: [
          {
            kind: "producer-statement",
            markdownSpan: { start: 0, end: 1 },
            evidence: [evidence],
            derivedFrom: [],
          },
        ],
      });
      expect(readMarkdownRevision(attributed.markdown)).toEqual(attributed);
      await f.store.commit(change("attributed", [attributed], [a, b]));
      const tampered: C.SourceWindow = {
        ...a,
        excerpts: [{ ...a.excerpts[0], producerRole: "assistant" }],
      };
      await expect(
        f.store.commit(change("tampered", [], [tampered])),
      ).rejects.toThrow("hash mismatch");
      await f.store.commit({
        ...change("suppress-evidence"),
        suppressions: [
          {
            suppressionId: "suppressed-evidence" as C.SuppressionId,
            scope,
            target: { kind: "evidence", evidence },
            reason: "fixture",
            createdAt: now,
          },
        ],
      });
      const candidate = createNoteRevision({
        ...metadata,
        noteId: "different-note" as C.NoteId,
        path: "topic-different-note.md",
        body: "relearn",
        claims: attributed.claims,
      });
      expect(
        await f.store.commit(change("relearn-evidence", [candidate])),
      ).toMatchObject({ kind: "suppressed" });
      const derived = createNoteRevision({
        ...metadata,
        noteId: "derived-note" as C.NoteId,
        path: "topic-derived-note.md",
        body: "derived",
        claims: [
          {
            kind: "model-inference",
            markdownSpan: { start: 0, end: 1 },
            evidence: [otherEvidence],
            derivedFrom: [
              { noteId: attributed.noteId, revisionId: attributed.revisionId },
            ],
          },
        ],
      });
      expect(
        await f.store.commit(change("relearn-lineage", [derived])),
      ).toMatchObject({ kind: "suppressed" });
      expect(
        await f.store.checkDelivery(
          {
            ...delivery(attributed),
            context: { ...delivery(attributed).context, evidence: [evidence] },
          },
          now,
        ),
      ).toMatchObject({ kind: "discard", reason: "suppressed" });
      expect(
        (await f.store.forPeer("fixture-peer").pending(1))[0]!.windows[0],
      ).toEqual(a);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("recovers a SIGKILL between stashing an editable inode and exclusive publication", async () => {
    const f = fixture();
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      f.store.close();
      const edit = note("a", "program update", [n.revisionId]);
      const killed = child(
        f.config,
        `const store=new FileMemoryStore({...config,publicationBoundary:b=>{if(b==='stash')process.kill(process.pid,'SIGKILL')}}); await store.commit(${JSON.stringify(change("edit", [edit]))});`,
      );
      expect(killed.signal, String(killed.stderr)).toBe("SIGKILL");
      const reopened = child(
        f.config,
        `const store=new FileMemoryStore(config); const notes=await store.listNotes(${JSON.stringify(scope)}); console.log(JSON.stringify(notes.map(n=>({body:n.markdown,exposure:n.exposure.kind}))));store.close();`,
      );
      expect(reopened.status, String(reopened.stderr)).toBe(0);
      expect(JSON.parse(String(reopened.stdout))).toEqual([
        { body: edit.markdown, exposure: "active" },
      ]);
      const recovery = join(f.config.root, ".pi-memory-recovery");
      expect(
        readdirSync(recovery)
          .filter((p) => p.endsWith(".stash.md"))
          .some((p) => readFileSync(join(recovery, p), "utf8") === n.markdown),
      ).toBe(true);
      f.store = new FileMemoryStore(f.config);
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  }, 30000);
  it("detects changed immutable bytes and rejects unsafe edits before publication", async () => {
    const f = fixture();
    try {
      const n = note("a");
      const { revisionId: _id, ...metadata } = n;
      const unsafe = { ...metadata, path: ".pi-memory-recovery/invalid-a.md" };
      await expect(
        f.store.commit(
          change("unsafe", [{ ...unsafe, revisionId: revisionId(unsafe) }]),
        ),
      ).rejects.toThrow("unsafe editable path");
      expect(
        readdirSync(join(f.config.data, "commits")).filter(
          (f) => !f.startsWith("."),
        ),
      ).toHaveLength(0);
      await f.store.commit(change("seed", [n]));
      f.store.close();
      const manifest = record(
        json(join(f.config.data, "commits", sha256("seed"))),
      );
      const path = join(f.config.data, "objects", string(manifest.replica));
      writeFileSync(path, readFileSync(path, "utf8") + " ");
      expect(() => new FileMemoryStore(f.config)).toThrow("corrupt dependency");
    } finally {
      try {
        f.store.close();
      } catch {}
      rmSync(f.dir, { recursive: true });
    }
  });
  it("keeps distinct notes editable when replicas choose the same descriptive path", async () => {
    const f = fixture();
    try {
      const first = note("a"),
        second = note("b");
      const { revisionId: _first, markdown: _one, ...a } = first;
      const { revisionId: _second, markdown: _two, ...b } = second;
      const one = createNoteRevision({
        ...a,
        path: "shared.md",
        body: "first",
      });
      const two = createNoteRevision({
        ...b,
        path: "shared.md",
        body: "second",
      });
      await f.store.commit(change("same-path", [one, two]));
      const texts = readdirSync(f.config.root)
        .filter((p) => p.endsWith(".md"))
        .map((p) => readFileSync(join(f.config.root, p), "utf8"));
      expect(texts).toContain(one.markdown);
      expect(texts).toContain(two.markdown);
      expect(await f.store.listNotes(scope)).toHaveLength(2);
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
  it("checks delivery expiry, scope and current causal heads", async () => {
    const f = fixture();
    try {
      const n = note("a");
      await f.store.commit(change("seed", [n]));
      const d = delivery(n);
      expect(await f.store.checkDelivery(d, now)).toEqual({ kind: "eligible" });
      expect(
        await f.store.checkDelivery(
          { ...d, intent: { ...d.intent, expiresAt: now } },
          now,
        ),
      ).toEqual({ kind: "discard", reason: "expired" });
      expect(
        await f.store.checkDelivery(
          {
            ...d,
            intent: {
              ...d.intent,
              target: {
                ...d.intent.target,
                scope: { kind: "project", repositoryId: "other" },
              },
            },
          },
          now,
        ),
      ).toEqual({ kind: "discard", reason: "wrong-scope" });
      await f.store.commit(
        change("edit", [note("a", "updated", [n.revisionId])]),
      );
      expect(await f.store.checkDelivery(d, now)).toEqual({
        kind: "discard",
        reason: "obsolete",
      });
    } finally {
      f.store.close();
      rmSync(f.dir, { recursive: true });
    }
  });
}
