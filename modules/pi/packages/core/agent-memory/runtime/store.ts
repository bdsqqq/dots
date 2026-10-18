import { DatabaseSync } from "node:sqlite";
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
import {
  canonicalJSON,
  hashSourceWindow,
  revisionId,
  sameValue,
  sha256,
} from "./identity.js";
import {
  durableCreate,
  confirmDurable,
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
    boundary: "objects" | "manifest" | "stash",
    commitId: string,
  ) => void;
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
function matchesEvidence(a: C.EvidenceRef, b: C.EvidenceRef): boolean {
  return (
    a.sourceHash === b.sourceHash &&
    sameValue(a.source, b.source) &&
    a.spans.some((x) =>
      b.spans.some(
        (y) =>
          x.entryId === y.entryId &&
          x.partId === y.partId &&
          x.start < y.end &&
          y.start < x.end,
      ),
    )
  );
}
function suppressionsFor(
  view: View,
  note: C.NoteRevision,
  seen = new Set<C.RevisionId>(),
): C.Suppression[] {
  if (seen.has(note.revisionId)) return [];
  seen.add(note.revisionId);
  const direct = view.suppressions.filter(
    (s) =>
      scopeEqual(s.scope, note.scope) &&
      (s.target.kind === "note"
        ? s.target.noteId === note.noteId
        : note.claims.some((c) =>
            c.evidence.some(
              (e) =>
                s.target.kind === "evidence" &&
                matchesEvidence(s.target.evidence, e),
            ),
          )),
  );
  for (const claim of note.claims)
    for (const ref of claim.derivedFrom) {
      const ancestor = view.revisions.get(ref.revisionId);
      if (ancestor) direct.push(...suppressionsFor(view, ancestor, seen));
    }
  return [...new Map(direct.map((s) => [s.suppressionId, s])).values()];
}

/** retry contention asynchronously; never stretch the event-loop blocking timeout. */
export function isStoreBusy(error: unknown): boolean {
  return error instanceof Error && "errcode" in error && error.errcode === 5;
}

/** local filesystems only. close all instances before rebuilding coordination state. */
export class FileMemoryStore implements C.MemoryStore {
  readonly config: FileMemoryStoreConfig;
  private readonly db: DatabaseSync;
  private watcher: FSWatcher | null = null;
  private readonly confirmed = new Set<string>();
  constructor(config: FileMemoryStoreConfig) {
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
    this.db = new DatabaseSync(join(this.config.state, "coordination.sqlite"));
    try {
      this.db
        .exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS leases (window TEXT PRIMARY KEY, token TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_ack (peer TEXT NOT NULL, commit_id TEXT NOT NULL, PRIMARY KEY(peer,commit_id));
      CREATE TABLE IF NOT EXISTS peer_cursor (peer TEXT PRIMARY KEY, cursor TEXT NOT NULL);`);
      this.transaction((view) => {
        this.scan(view);
        this.materialize(this.recover());
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.watcher?.close();
    this.db.close();
  }
  /** hints reduce latency; operations still rescan after missing every event. */
  watch(onHint: () => void): void {
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
  private transaction<T>(run: (view: View) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run(this.recover());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private refreshed<T>(run: (view: View) => T): T {
    return this.transaction((view) => {
      this.scan(view);
      const fresh = this.recover();
      this.materialize(fresh);
      return run(this.recover());
    });
  }
  private put(value: unknown): string {
    const bytes = canonicalJSON(value);
    const hash = sha256(bytes);
    durableCreate(join(this.objects, hash), bytes);
    return hash;
  }
  private get(hash: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new IntegrityError("invalid object hash");
    const path = join(this.objects, hash);
    if (!existsSync(path))
      throw new IntegrityError(`missing dependency ${hash}`);
    const bytes = readFileSync(path, "utf8");
    if (sha256(bytes) !== hash)
      throw new IntegrityError(`corrupt dependency ${hash}`);
    return JSON.parse(bytes);
  }
  private recover(): View {
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
    for (const file of readdirSync(this.commits).filter(
      (f) => !f.startsWith("."),
    )) {
      const m = record(json(join(this.commits, file)));
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
      const accepted = { manifest, replica, local };
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
    for (const a of causal)
      if (!this.confirmed.has(a.manifest.hash)) {
        for (const dependency of a.manifest.dependencies)
          confirmDurable(join(this.objects, dependency));
        confirmDurable(join(this.commits, sha256(a.replica.commitId)));
        this.confirmed.add(a.manifest.hash);
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
          !scopeEqual(ancestor.scope, r.scope)
        )
          throw new IntegrityError("missing/wrong-scope claim lineage");
      }
    }
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
      !scopeEqual(scope, w.scope)
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
  private publish(
    replica: C.ReplicaChange,
    local: C.LocalChangeSet | null,
  ): void {
    const dependencies = [...replica.revisions, ...replica.windows].map((x) =>
      this.put(x),
    );
    const replicaHash = this.put(replica);
    dependencies.push(replicaHash);
    const localHash = local ? this.put(local) : null;
    if (localHash) dependencies.push(localHash);
    dependencies.forEach((hash) => this.get(hash));
    flushDirectory(this.objects);
    this.config.publicationBoundary?.("objects", replica.commitId);
    this.verifyDependencies(dependencies);
    const payload = {
      version: 1 as const,
      dependencies: [...new Set(dependencies)].sort(),
      replica: replicaHash,
      local: localHash,
    };
    durableCreate(
      join(this.commits, sha256(replica.commitId)),
      canonicalJSON({ ...payload, hash: sha256(canonicalJSON(payload)) }),
    );
    this.confirmed.add(sha256(canonicalJSON(payload)));
    this.config.publicationBoundary?.("manifest", replica.commitId);
  }
  async commit(value: C.LocalChangeSet): Promise<C.CommitResult> {
    const change = parseChange(value);
    return this.refreshed((view) => {
      const previous = view.accepted.get(change.commitId);
      if (previous)
        return previous.local && sameValue(previous.local, change)
          ? {
              kind: "locally-committed",
              commitId: change.commitId,
              replay: true,
            }
          : { kind: "identity-conflict", commitId: change.commitId };
      const now = millis(change.now);
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
            (e) => !scopeEqual(e.revision.scope, leasedScope),
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
            if (!scopeEqual(r.scope, next.windows.get(o.windowId)!.scope))
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
          o.decision.kind === "retry" ? [] : [{ ...o, decision: o.decision }],
        ),
      };
      this.publish(replica, change);
      if (change.lease)
        this.db
          .prepare("DELETE FROM leases WHERE token=?")
          .run(change.lease.leaseId);
      this.materialize(this.recover());
      return {
        kind: "locally-committed",
        commitId: change.commitId,
        replay: false,
      };
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
  async listNotes(scope: C.MemoryScope): Promise<readonly C.NoteRevision[]> {
    return this.refreshed((v) =>
      [...v.heads.values()].flat().filter((r) => scopeEqual(r.scope, scope)),
    );
  }
  async readNotes(
    scope: C.MemoryScope,
    ids: readonly C.NoteId[],
  ): Promise<readonly C.NoteRevision[]> {
    const wanted = new Set(ids);
    return (await this.listNotes(scope)).filter((n) => wanted.has(n.noteId));
  }
  async readSuppressions(
    scope: C.MemoryScope,
  ): Promise<readonly C.Suppression[]> {
    return this.refreshed((v) =>
      v.suppressions.filter((s) => scopeEqual(s.scope, scope)),
    );
  }
  async plan(input: C.PlanInput): Promise<C.BacklogPlan> {
    return this.refreshed((view) => {
      const now = millis(input.now);
      const p = input.policy;
      if (
        p.minWindows < 1 ||
        p.maxBatchWindows < 1 ||
        p.maxBatchBytes < 1 ||
        p.leaseMs <= 0
      )
        throw new Error("invalid backlog policy");
      const pending: C.PendingWindow[] = [...view.windows.values()]
        .filter(
          (w) =>
            scopeEqual(w.scope, input.scope) && !view.terminal.has(w.windowId),
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
          nextCheckAt: iso(millis(ready[0]!.pendingSince) + p.maxPendingAgeMs),
        };
      const selected: C.PendingWindow[] = [];
      let bytes = 0;
      for (const w of ready) {
        const size = Buffer.byteLength(canonicalJSON(w.window));
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
    });
  }
  async checkDelivery(
    delivery: C.RecallDelivery,
    now: C.Timestamp,
  ): Promise<C.DeliveryEligibility> {
    return this.refreshed((v) =>
      this.eligibility(v, parseDelivery(delivery), now),
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
        r.exposure.kind !== "active"
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
  ): Promise<"queued" | "duplicate"> {
    const d = parseDelivery(input);
    return this.refreshed((view) => {
      const path = join(this.outbox, sha256(d.deliveryId));
      if (existsSync(path)) {
        if (!sameValue(this.localValue(path), d))
          throw new IntegrityError("delivery identity collision");
        return "duplicate";
      }
      const eligibility = this.eligibility(view, d, new Date().toISOString());
      if (eligibility.kind === "discard")
        throw new Error(`delivery rejected: ${eligibility.reason}`);
      this.localCreate(path, d);
      return "queued";
    });
  }
  async nextDelivery(target: C.RecallTarget): Promise<C.RecallDelivery | null> {
    return this.refreshed(() => {
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
    });
  }
  async recordDispatch(
    id: C.DeliveryId,
    outcome: C.DispatchOutcome,
  ): Promise<void> {
    this.transaction(() => {
      if (outcome.kind === "empty") return;
      if (
        outcome.deliveryId !== id ||
        !existsSync(join(this.outbox, sha256(id)))
      )
        throw new Error("unknown delivery");
      this.localCreate(join(this.receipts, sha256(id)), outcome);
    });
  }
  private orderedChanges(view: View): C.ReplicaChange[] {
    const waiting = [...view.accepted.values()]
      .map((a) => a.replica)
      .sort((a, b) => a.commitId.localeCompare(b.commitId));
    const ordered: C.ReplicaChange[] = [];
    const done = new Set<C.CommitId>();
    while (waiting.length) {
      const index = waiting.findIndex((c) =>
        c.parents.every((p) => done.has(p)),
      );
      if (index < 0) throw new IntegrityError("cyclic commit ancestry");
      const c = waiting.splice(index, 1)[0]!;
      ordered.push(c);
      done.add(c.commitId);
    }
    return ordered;
  }
  /** adapters close over one authenticated configured peer; acknowledgments never leak. */
  forPeer(peer: string): C.ReplicaStore {
    if (!peer) throw new Error("peer required");
    return {
      pending: async (limit) =>
        this.refreshed((v) =>
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
        this.transaction(() => {
          const row = this.db
            .prepare("SELECT cursor FROM peer_cursor WHERE peer=?")
            .get(peer);
          return row ? string(row.cursor) : null;
        }),
      integrate: async (incoming) =>
        this.refreshed((view) => {
          const changes = incoming.map(parseReplicaChange);
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
              throw new IntegrityError("duplicate incoming identity collision");
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
            const index = pending.findIndex((c) => {
              const rs = new Set([
                  ...revisions,
                  ...c.revisions.map((r) => r.revisionId),
                ]),
                ws = new Set([...windows, ...c.windows.map((w) => w.windowId)]);
              return (
                c.parents.every((p) => done.has(p)) &&
                c.revisions.every(
                  (r) =>
                    (r.ancestry.kind !== "known" ||
                      r.ancestry.parents.every((p) => rs.has(p))) &&
                    r.claims.every(
                      (claim) =>
                        claim.evidence.every((e) => ws.has(e.windowId)) &&
                        claim.derivedFrom.every((ref) =>
                          rs.has(ref.revisionId),
                        ),
                    ),
                ) &&
                c.outcomes.every(
                  (o) =>
                    ws.has(o.windowId) &&
                    (o.decision.kind !== "changed" ||
                      o.decision.notes.every((ref) => rs.has(ref.revisionId))),
                )
              );
            });
            if (index < 0) throw new IntegrityError("cyclic incoming ancestry");
            const c = pending.splice(index, 1)[0]!;
            this.publish(c, null);
            done.add(c.commitId);
            c.revisions.forEach((r) => revisions.add(r.revisionId));
            c.windows.forEach((w) => windows.add(w.windowId));
          }
          this.materialize(this.recover());
        }),
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
        }),
    };
  }
  private placements(): Placement[] {
    return readdirSync(this.journals)
      .filter((f) => f.endsWith(".intent"))
      .map((file) => {
        const p = record(json(join(this.journals, file)));
        return {
          path: string(p.path),
          revisionId: string(p.revisionId) as C.RevisionId,
          candidate: string(p.candidate),
          stash: string(p.stash),
          snapshot: p.snapshot === null ? null : string(p.snapshot),
          basis: p.basis === null ? null : string(p.basis),
        };
      });
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
  private scan(view: View): void {
    const placements = this.placements();
    const files: { path: string; logical: string; bytes: string }[] = [];
    const walk = (dir: string): void => {
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
    const edits: C.NoteRevision[] = [];
    for (const file of files) {
      const marker = markdownIdentity(file.bytes);
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
      const embedded = readMarkdownRevision(file.bytes, file.logical, false);
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
            markdownIdentity(f.bytes)?.noteId === basis.noteId,
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
        (p) =>
          p.revisionId === head.revisionId && existsSync(`${p.candidate}.done`),
      );
      if (
        !done ||
        files.some(
          (f) =>
            !f.path.startsWith(`${this.recovery}/`) &&
            (markdownIdentity(f.bytes)?.noteId === noteId ||
              f.logical === head.path),
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
    if (edits.length)
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
  }
  private materialize(view: View): void {
    for (const p of this.placements())
      if (!existsSync(`${p.candidate}.done`)) this.finishPlacement(p);
    const placements = this.placements();
    for (const heads of view.heads.values())
      for (const r of heads) {
        const path =
          heads.length > 1
            ? r.path.replace(/\.md$/, `~${r.revisionId.slice(0, 12)}.md`)
            : r.path;
        const target = this.safePath(path);
        if (existsSync(target) && lstatSync(target).isSymbolicLink())
          throw new IntegrityError("symlinked editable file");
        if (
          placements.some(
            (p) =>
              p.path === path &&
              p.revisionId === r.revisionId &&
              existsSync(`${p.candidate}.done`),
          )
        )
          continue;
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
        durableCreate(join(this.journals, `${token}.intent`), canonicalJSON(p));
        this.finishPlacement(p);
      }
  }
  private finishPlacement(p: Placement): void {
    const target = this.safePath(p.path);
    durableDirectory(dirname(target));
    if (!existsSync(p.stash) && existsSync(target)) {
      renameSync(target, p.stash);
      flushDirectory(dirname(target));
      flushDirectory(this.recovery);
      this.config.publicationBoundary?.("stash", p.revisionId);
      const fd = openSync(p.stash, "r");
      try {
        flushFile(fd);
      } finally {
        closeSync(fd);
      }
      durableCreate(
        `${p.candidate}.captured`,
        canonicalJSON({
          hash: sha256(readFileSync(p.stash)),
          basisMatched: p.basis === sha256(readFileSync(p.stash)),
        }),
      );
    }
    if (existsSync(p.candidate)) {
      try {
        linkSync(p.candidate, target);
      } catch (e) {
        if (!existsSync(target)) throw e;
      }
      flushDirectory(dirname(target));
    }
    durableCreate(
      `${p.candidate}.done`,
      canonicalJSON({ path: p.path, revisionId: p.revisionId }),
    );
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
  const { createNoteRevision } = await import("./markdown.js");
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
  function fixture(): {
    dir: string;
    config: FileMemoryStoreConfig;
    store: FileMemoryStore;
  } {
    const dir = mkdtempSync(join(tmpdir(), "memory-m1-"));
    const config = {
      root: join(dir, "notes"),
      data: join(dir, "data"),
      state: join(dir, "state"),
      replicaId: "replica-a" as C.ReplicaId,
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
      const heads = await store.listNotes(scope);
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
      b = fixture();
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
  for (const boundary of ["objects", "manifest"] as const)
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
          boundary === "manifest"
            ? { notes: 2, plan: "eligible", count: 2 }
            : { notes: 0, plan: "idle", count: 0 },
        );
        f.store = new FileMemoryStore(f.config);
        expect(await f.store.commit(c)).toMatchObject({
          kind: "locally-committed",
          replay: boundary === "manifest",
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
  it("serializes independent writers and leases one pending window only once", async () => {
    const f = fixture();
    try {
      await f.store.commit(change("capture", [], [window()]));
      f.store.close();
      const run = (
        id: string,
      ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const script = `${childPrelude} let done=false; for(let attempt=0;attempt<2&&!done;attempt++){let store;try{store=new FileMemoryStore(${JSON.stringify(f.config)});await store.commit(${JSON.stringify(change(id, [note(id)]))});console.log(JSON.stringify(await store.plan(${JSON.stringify({ jobId: id, owner: id, scope, now: later, policy })})));done=true;}catch(error){if(!isStoreBusy(error)||attempt===1){console.error(JSON.stringify({message:error.message,errcode:error.errcode}));process.exitCode=1;break;}await new Promise(resolve=>setTimeout(resolve,750));}finally{store?.close();}}`;
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
      expect(results.map((r) => JSON.parse(r.stdout).kind).sort()).toEqual([
        "eligible",
        "idle",
      ]);
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
        original.replace(
          "this.verifyDependencies(dependencies);",
          "/* isolated negative control: verification removed */",
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
  it.runIf(process.platform === "darwin")(
    "retries a real external full-flush failure without acknowledging an unflushed manifest",
    async () => {
      const f = fixture();
      const oldPath = process.env.PATH;
      try {
        f.store.close();
        const helper = join(f.dir, "python3"),
          failed = join(f.dir, "failed"),
          completed = join(f.dir, "completed");
        writeFileSync(
          helper,
          `#!/usr/bin/python3
import os,sys,fcntl
p=fcntl.fcntl(3,50,b'\\0'*1024).split(b'\\0')[0].decode()
if '/commits/' in p and not os.path.basename(p).startswith('.') and not os.path.exists(${JSON.stringify(failed)}):
 open(${JSON.stringify(failed)},'w').write(p)
 fcntl.fcntl(3,2147483646)
fcntl.fcntl(3,51)
if '/commits/' in p and not os.path.basename(p).startswith('.'):
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
        ).toBe(true);
        expect(existsSync(completed)).toBe(false);
        f.store.close();
        f.store = new FileMemoryStore(f.config);
        expect(await f.store.commit(c)).toMatchObject({
          kind: "locally-committed",
          replay: true,
        });
        expect(readFileSync(completed, "utf8")).toContain(
          sha256("flush-retry"),
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
}
