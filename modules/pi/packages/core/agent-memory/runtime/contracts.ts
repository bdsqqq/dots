/**
 * markdown owns knowledge; the journal owns recovery and durable acknowledgments.
 * these are validated core values, not wire validators or permission grants.
 * adapters retain native session/entry ids and validate external input once.
 */
declare const identity: unique symbol;
type Identity<Kind extends string> = string & { readonly [identity]: Kind };
type NonEmpty<T> = readonly [T, ...T[]];

export type SourceId = Identity<"source">;
export type SessionId = Identity<"native-session">;
/** producer identity: native ids stay verbatim; file producers use their own ids. */
export type EntryId = Identity<"producer-entry">;
export type WindowId = Identity<"window">;
export type NoteId = Identity<"note">;
/** hash of canonical revision content/ancestry, excluding its own id. */
export type RevisionId = Identity<"revision">;
export type JobId = Identity<"job">;
export type LeaseId = Identity<"local-lease">;
export type CommitId = Identity<"local-commit">;
export type IntentId = Identity<"recall-intent">;
export type DeliveryId = Identity<"delivery">;
export type ReplicaId = Identity<"replica">;
export type SuppressionId = Identity<"suppression">;
export type SourceHash = Identity<"source-sha256">;
/** utc iso-8601; adapters validate timestamps before entering core. */
export type Timestamp = string;

export type MemoryScope =
  | { readonly kind: "personal"; readonly ownerId: string }
  | { readonly kind: "project"; readonly repositoryId: string };

export interface SourceRef {
  readonly sourceId: SourceId;
  readonly producer: string;
  readonly origin:
    | {
        readonly kind: "session";
        readonly sessionId: SessionId;
        /** producer-observed context, not authority supplied by a model. */
        readonly project?: {
          readonly repositoryId: string;
          readonly revision?: string;
        };
      }
    | { readonly kind: "file"; readonly path: string };
}

/** offsets are half-open utf-8 bytes in a producer's identified text part. */
export interface SourceSpan {
  readonly entryId: EntryId;
  readonly partId: string;
  readonly start: number;
  readonly end: number;
}

export interface SourceExcerpt {
  readonly span: SourceSpan;
  readonly parentEntryId: EntryId | null;
  /** copied from the producer, never inferred by a consolidation model. */
  readonly producerRole: string;
  readonly occurredAt: Timestamp;
  readonly text: string;
}

export interface SourceWindow {
  /** derived from source identity, ordered spans and sourceHash, not a job id. */
  readonly windowId: WindowId;
  readonly source: SourceRef;
  readonly scope: MemoryScope;
  /** binds exact excerpts/roles/spans; proves identity, not factual truth. */
  readonly sourceHash: SourceHash;
  readonly excerpts: NonEmpty<SourceExcerpt>;
  readonly capturedAt: Timestamp;
  readonly importance: "ordinary" | "correction";
}

export interface EvidenceRef {
  readonly windowId: WindowId;
  readonly source: SourceRef;
  readonly sourceHash: SourceHash;
  readonly spans: NonEmpty<SourceSpan>;
}

export interface NoteRef {
  readonly noteId: NoteId;
  readonly revisionId: RevisionId;
}

export interface NoteClaim {
  readonly kind: "producer-statement" | "observation" | "model-inference";
  /** half-open utf-8 bytes in the complete markdown file. */
  readonly markdownSpan: { readonly start: number; readonly end: number };
  readonly evidence: NonEmpty<EvidenceRef>;
  /** summaries retain their lineage instead of becoming independent evidence. */
  readonly derivedFrom: readonly NoteRef[];
}

export type RevisionAncestry =
  | { readonly kind: "known"; readonly parents: readonly RevisionId[] }
  | {
      readonly kind: "unknown-base";
      /** heads observed at import are not asserted to be the edit's parents. */
      readonly observedHeads: readonly RevisionId[];
    };

export type NoteExposure =
  | { readonly kind: "active" }
  | { readonly kind: "demoted"; readonly reason: string }
  | { readonly kind: "superseded"; readonly by: NonEmpty<NoteId> }
  | { readonly kind: "deleted"; readonly reason: string };

export interface NoteRevision extends NoteRef {
  readonly ancestry: RevisionAncestry;
  readonly scope: MemoryScope;
  /** descriptive relative markdown path with permanent note-id suffix. */
  readonly path: string;
  /** complete editable file; metadata must round-trip through markdown. */
  readonly markdown: string;
  readonly links: readonly NoteId[];
  readonly claims: readonly NoteClaim[];
  readonly exposure: NoteExposure;
  readonly authoredAt: Timestamp;
}

export type SuppressionTarget =
  | { readonly kind: "note"; readonly noteId: NoteId }
  | { readonly kind: "evidence"; readonly evidence: EvidenceRef };

/** retained and replicated: suppression governs admission as well as delivery. */
export interface Suppression {
  readonly suppressionId: SuppressionId;
  readonly scope: MemoryScope;
  readonly target: SuppressionTarget;
  readonly reason: string;
  readonly createdAt: Timestamp;
}

export type SourceInput =
  | { readonly kind: "provided"; readonly windows: readonly SourceWindow[] }
  | {
      readonly kind: "read";
      readonly request: SourceReadRequest;
    };

export interface SourceReadRequest {
  readonly source: SourceRef;
  readonly scope: MemoryScope;
  /** native selected entry, not a fabricated memory branch or turn id. */
  readonly throughEntryId: EntryId;
  readonly after: SourceSpan | null;
  readonly maxWindowBytes: number;
  readonly maxWindows: number;
}

export interface SourcePage {
  readonly windows: readonly SourceWindow[];
  /** only advance after every returned window is durably captured. */
  readonly next: SourceSpan | null;
  readonly complete: boolean;
}

export interface SourceProducer {
  read(request: SourceReadRequest, signal: AbortSignal): Promise<SourcePage>;
}

export interface CaptureInput {
  readonly source: SourceInput;
  /** caller checks source authorization; knowledge never grants access. */
  readonly scope: MemoryScope;
  readonly commitId: CommitId;
  readonly now: Timestamp;
}

export type CaptureOutcome =
  | {
      readonly kind: "locally-committed";
      readonly commitId: CommitId;
      readonly windows: readonly WindowId[];
      readonly continuation: SourceSpan | null;
    }
  | {
      readonly kind: "unchanged";
      readonly windows: readonly WindowId[];
      readonly continuation: SourceSpan | null;
    }
  | { readonly kind: "ineligible"; readonly reason: string }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAt: Timestamp;
    };

export type WindowDecision =
  | { readonly kind: "changed"; readonly notes: NonEmpty<NoteRef> }
  | { readonly kind: "no-change"; readonly reason: string }
  | { readonly kind: "ineligible"; readonly reason: string }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAt: Timestamp;
    };

export interface WindowOutcome {
  readonly windowId: WindowId;
  readonly sourceHash: SourceHash;
  readonly decision: WindowDecision;
  readonly recordedAt: Timestamp;
}

/** terminal coverage travels with evidence; retry timing stays host-local. */
export type TerminalWindowOutcome = Omit<WindowOutcome, "decision"> & {
  readonly decision: Exclude<WindowDecision, { kind: "retry" }>;
};

export interface PendingWindow {
  readonly window: SourceWindow;
  readonly pendingSince: Timestamp;
  readonly attempts: number;
  readonly notBefore: Timestamp;
}

export interface BacklogPolicy {
  readonly minWindows: number;
  readonly maxPendingAgeMs: number;
  readonly maxBatchWindows: number;
  readonly maxBatchBytes: number;
  readonly leaseMs: number;
}

/** host-local fencing token; replication never transfers worker ownership. */
export interface LocalLease {
  readonly leaseId: LeaseId;
  readonly jobId: JobId;
  readonly owner: string;
  readonly expiresAt: Timestamp;
}

export interface LeasedBatch {
  readonly lease: LocalLease;
  readonly windows: NonEmpty<PendingWindow>;
}

export type BacklogPlan =
  | {
      readonly kind: "idle";
      readonly reason: "empty" | "below-threshold" | "backoff" | "leased";
      readonly nextCheckAt: Timestamp | null;
    }
  | {
      readonly kind: "eligible";
      readonly reason: "threshold" | "correction" | "age" | "recovery";
      readonly batch: LeasedBatch;
    };

export interface PlanInput {
  readonly jobId: JobId;
  readonly owner: string;
  readonly scope: MemoryScope;
  readonly now: Timestamp;
  readonly policy: BacklogPolicy;
}

export interface NoteEdit {
  readonly revision: NoteRevision;
  /** compare all heads atomically; a stale edit cannot overwrite alternatives. */
  readonly expectedHeads: readonly RevisionId[];
}

export interface LocalChangeSet {
  /** stable across retries; replay returns the original receipt. */
  readonly commitId: CommitId;
  readonly now: Timestamp;
  /** new windows become pending in the same transaction, including early spans. */
  readonly windows: readonly SourceWindow[];
  readonly edits: readonly NoteEdit[];
  readonly suppressions: readonly Suppression[];
  readonly outcomes: readonly WindowOutcome[];
  readonly lease: LocalLease | null;
}

export type CommitResult =
  | {
      readonly kind: "locally-committed";
      readonly commitId: CommitId;
      readonly replay: boolean;
    }
  | { readonly kind: "conflict"; readonly current: readonly NoteRevision[] }
  | { readonly kind: "lease-lost" }
  | { readonly kind: "identity-conflict"; readonly commitId: CommitId }
  | {
      readonly kind: "suppressed";
      readonly suppressions: NonEmpty<Suppression>;
    };

export interface ConsolidationInput {
  readonly batch: LeasedBatch;
  /** supplied snapshot includes competing heads, not just an arbitrary winner. */
  readonly notes: readonly NoteRevision[];
  readonly suppressions: readonly Suppression[];
}

export interface ConsolidationResult {
  readonly edits: readonly NoteEdit[];
  /**
   * one decision per leased window; core supplies sourceHash and recordedAt.
   * a model cannot mint a durable acceptance receipt.
   */
  readonly outcomes: NonEmpty<Pick<WindowOutcome, "windowId" | "decision">>;
}

export interface ConsolidationModel {
  reconcile(
    input: ConsolidationInput,
    signal: AbortSignal,
  ): Promise<ConsolidationResult>;
}

export interface RecallTarget {
  readonly consumerId: string;
  readonly sessionId: SessionId;
  readonly scope: MemoryScope;
}

export interface RecallIntent {
  readonly intentId: IntentId;
  readonly target: RecallTarget;
  /** native entry anchors obsolescence without inventing SDK turn semantics. */
  readonly entryId: EntryId;
  readonly query: string;
  readonly expiresAt: Timestamp;
  readonly maxChars: number;
  readonly maxNotes: number;
}

export interface RecallContext {
  readonly text: string;
  readonly notes: NonEmpty<NoteRef>;
  readonly evidence: readonly EvidenceRef[];
}

export interface RecallDelivery {
  /** stable across retries of the same intent, revision set and context. */
  readonly deliveryId: DeliveryId;
  readonly intent: RecallIntent;
  readonly context: RecallContext;
}

export type RecallOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "queued"; readonly deliveryId: DeliveryId }
  | {
      readonly kind: "discarded";
      readonly reason: "expired" | "obsolete" | "wrong-scope" | "suppressed";
    };

export type DeliveryEligibility =
  | { readonly kind: "eligible" }
  | {
      readonly kind: "discard";
      readonly reason:
        | "expired"
        | "obsolete"
        | "wrong-scope"
        | "suppressed"
        | "duplicate";
    };

export type DispatchOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "queued"; readonly deliveryId: DeliveryId }
  | {
      readonly kind: "discarded";
      readonly deliveryId: DeliveryId;
      readonly reason: Extract<
        DeliveryEligibility,
        { kind: "discard" }
      >["reason"];
    };

export interface SearchIndex {
  /** rebuildable cache; handlers recheck revision heads and suppression. */
  search(
    intent: RecallIntent,
    signal: AbortSignal,
  ): Promise<readonly NoteRef[]>;
  project(notes: readonly NoteRevision[], signal: AbortSignal): Promise<void>;
  readiness(): Promise<ProjectionReadiness>;
}

export type ProjectionReadiness =
  | { readonly kind: "ready"; readonly throughCommit: CommitId }
  | { readonly kind: "pending"; readonly afterCommit: CommitId | null }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface NativeInbox {
  /**
   * queues context for a later native inference; never starts or waits for one.
   * consumer checks its live native intent, deduplicates deliveryId and invokes
   * eligibility immediately before enqueueing; retries may repeat this call.
   */
  enqueue(
    delivery: RecallDelivery,
    eligibility: () => Promise<DeliveryEligibility>,
  ): Promise<
    | { readonly kind: "queued" }
    | Extract<DeliveryEligibility, { kind: "discard" }>
  >;
}

export interface MemoryStore {
  /**
   * journal + markdown recovery is durable here; no git/remote/index wait.
   * validates evidence/suppression, lease and heads atomically with all outcomes.
   * identical ids/payloads replay; a reused id with different content conflicts.
   */
  commit(change: LocalChangeSet): Promise<CommitResult>;
  /** cheap atomic selection/lease; idle plans must not call a model. */
  plan(input: PlanInput): Promise<BacklogPlan>;
  /** includes competing heads; callers must not choose an arbitrary winner. */
  listNotes(scope: MemoryScope): Promise<readonly NoteRevision[]>;
  readNotes(
    scope: MemoryScope,
    ids: readonly NoteId[],
  ): Promise<readonly NoteRevision[]>;
  readSuppressions(scope: MemoryScope): Promise<readonly Suppression[]>;
  /** current heads/suppression are checked again for cache hits and dispatch. */
  checkDelivery(
    delivery: RecallDelivery,
    now: Timestamp,
  ): Promise<DeliveryEligibility>;
  queueDelivery(delivery: RecallDelivery): Promise<"queued" | "duplicate">;
  nextDelivery(target: RecallTarget): Promise<RecallDelivery | null>;
  recordDispatch(
    deliveryId: DeliveryId,
    outcome: DispatchOutcome,
  ): Promise<void>;
}

/** immutable replication data excludes leases, inbox targets and search indexes. */
export interface ReplicaChange {
  readonly commitId: CommitId;
  readonly replicaId: ReplicaId;
  readonly parents: readonly CommitId[];
  readonly revisions: readonly NoteRevision[];
  readonly windows: readonly SourceWindow[];
  readonly suppressions: readonly Suppression[];
  readonly outcomes: readonly TerminalWindowOutcome[];
}

export interface ReplicaTransport {
  /** cursor and acknowledgments belong to this configured peer, not every peer. */
  exchange(
    input: {
      readonly outgoing: readonly ReplicaChange[];
      readonly cursor: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly incoming: readonly ReplicaChange[];
    readonly acknowledged: readonly CommitId[];
    readonly cursor: string;
  }>;
}

export interface ReplicaStore {
  pending(limit: number): Promise<readonly ReplicaChange[]>;
  readCursor(): Promise<string | null>;
  /** idempotent durable integration retains unknown ancestry and competing heads. */
  integrate(changes: readonly ReplicaChange[]): Promise<void>;
  /**
   * peer-scoped acknowledgment advances outbox only, never local acceptance.
   * save the receive cursor only after incoming changes are durably integrated.
   */
  acknowledge(commits: readonly CommitId[], cursor: string): Promise<void>;
}

/** separate signatures make supplied windows usable without a producer dependency. */
export interface CaptureHandler {
  (
    input: CaptureInput & {
      readonly source: Extract<SourceInput, { kind: "provided" }>;
    },
    deps: { readonly store: MemoryStore },
  ): Promise<CaptureOutcome>;
  (
    input: CaptureInput & {
      readonly source: Extract<SourceInput, { kind: "read" }>;
    },
    deps: {
      readonly store: MemoryStore;
      readonly producer: SourceProducer;
      readonly signal: AbortSignal;
    },
  ): Promise<CaptureOutcome>;
}

export type PlanHandler = (
  input: PlanInput,
  deps: { readonly store: MemoryStore },
) => Promise<BacklogPlan>;
export type ReconcileHandler = (
  input: ConsolidationInput & {
    readonly commitId: CommitId;
    readonly now: Timestamp;
  },
  deps: {
    readonly store: MemoryStore;
    readonly model: ConsolidationModel;
    readonly signal: AbortSignal;
  },
) => Promise<CommitResult>;
/** adapters schedule this off the primary inference path; empty hits stay silent. */
export type RecallHandler = (
  input: RecallIntent,
  deps: {
    readonly store: MemoryStore;
    readonly index: SearchIndex;
    readonly now: () => Timestamp;
    readonly signal: AbortSignal;
  },
) => Promise<RecallOutcome>;
export type DispatchHandler = (
  input: { readonly target: RecallTarget; readonly now: () => Timestamp },
  deps: { readonly store: MemoryStore; readonly inbox: NativeInbox },
) => Promise<DispatchOutcome>;
