import { oc } from "@orpc/contract";
import { type } from "arktype";

import { compareCodeUnits, MoneyV1Schema, CalendarDateV1Schema } from "../money.ts";
import {
  ClassificationV1Schema,
  EvidenceRefV1Schema,
  LedgerUnavailableFailure,
  LedgerUnavailableV1Schema,
  QuarantineEntryV1Schema,
  validateLedgerSnapshot,
  type ClassificationV1,
  type EvidenceGrade,
  type EvidenceRefV1,
  type LedgerSnapshotV1,
  type LedgerUnavailableV1,
  type TransactionStatus,
  type TransactionV1,
} from "./state.ts";
import {
  reconcileTransferLinks,
  type TransferReconciliationPolicy,
} from "./link-transfers.ts";

const NonEmptyStringV1Schema = type("string").narrow(
  (value, context) => value.length > 0 || context.mustBe("a non-empty string"),
);
const NonNegativeSafeIntegerV1Schema = type("number.safe & number.integer").narrow(
  (value, context) => value >= 0 || context.mustBe("a non-negative safe integer"),
);
const CandidateEvidenceGradeV1Schema = type("'primary' | 'secondary'");

export const TransactionCandidateV1Schema = type({
  "+": "reject",
  kind: "'company-money.transaction-candidate'",
  version: "1",
  entityId: NonEmptyStringV1Schema,
  accountAlias: NonEmptyStringV1Schema,
  provider: NonEmptyStringV1Schema,
  occurredOn: CalendarDateV1Schema.or("null"),
  bookedOn: CalendarDateV1Schema,
  money: MoneyV1Schema,
  direction: "'incoming' | 'outgoing'",
  status: "'pending' | 'completed' | 'cancelled' | 'failed'",
  normalizedCounterparty: "string | null",
  normalizedReference: "string | null",
  providerTransactionId: "string | null",
  sourcePosition: "string | null",
  classification: ClassificationV1Schema,
  evidence: EvidenceRefV1Schema,
}).narrow(
  (candidate, context) =>
    candidate.evidence.grade !== "derived" &&
    (candidate.providerTransactionId !== null || candidate.sourcePosition !== null) ||
    context.mustBe("a primary or secondary candidate with stable identity material"),
);

export const IngestBatchV1Schema = type({
  "+": "reject",
  kind: "'company-money.ingest-batch'",
  version: "1",
  candidates: TransactionCandidateV1Schema.array(),
  quarantine: QuarantineEntryV1Schema.array(),
});

export const IngestResultV1Schema = type({
  "+": "reject",
  kind: "'company-money.ingest-result'",
  version: "1",
  committedRevision: "string | null",
  insertedCount: NonNegativeSafeIntegerV1Schema,
  duplicateCount: NonNegativeSafeIntegerV1Schema,
  conflictCount: NonNegativeSafeIntegerV1Schema,
  quarantineCount: NonNegativeSafeIntegerV1Schema,
  linkCount: NonNegativeSafeIntegerV1Schema,
});

export const IngestConflictV1Schema = type({
  "+": "reject",
  kind: "'company-money.ingest-conflict'",
  version: "1",
  id: NonEmptyStringV1Schema,
  reason:
    "'incompatible-evidence' | 'contradictory-terminal-state' | 'evidence-id-collision'",
});

export type TransactionCandidateV1 = typeof TransactionCandidateV1Schema.infer;
export type IngestBatchV1 = typeof IngestBatchV1Schema.infer;
export type IngestResultV1 = typeof IngestResultV1Schema.infer;
export type IngestConflictV1 = typeof IngestConflictV1Schema.infer;

export const ledgerIngestSchemaCatalog = {
  "company-money.transaction-candidate": { 1: TransactionCandidateV1Schema },
  "company-money.ingest-batch": { 1: IngestBatchV1Schema },
  "company-money.ingest-result": { 1: IngestResultV1Schema },
  "company-money.ingest-conflict": { 1: IngestConflictV1Schema },
} as const;

export const ledgerIngestContract = oc
  .input(IngestBatchV1Schema)
  .output(IngestResultV1Schema)
  .errors({
    INGEST_CONFLICT: { data: IngestConflictV1Schema },
    LEDGER_BUSY: {},
    LEDGER_UNAVAILABLE: { data: LedgerUnavailableV1Schema },
  });

export interface StableIdentity {
  digest(namespace: string, parts: readonly string[]): string;
}

export interface IngestLedgerStore {
  read(): Promise<{
    readonly revision: string | null;
    readonly snapshot: LedgerSnapshotV1;
  }>;
  compareAndSwap(
    expectedRevision: string | null,
    next: LedgerSnapshotV1,
  ): Promise<"committed" | "conflict">;
}

export interface IngestDependencies {
  readonly identity: StableIdentity;
  readonly store: IngestLedgerStore;
  readonly transferPolicy: TransferReconciliationPolicy;
  readonly maxCasAttempts?: number;
}

export class IngestConflictFailure extends Error {
  readonly conflict: IngestConflictV1;

  constructor(conflict: IngestConflictV1) {
    super("ingest evidence conflicts with canonical state");
    this.conflict = conflict;
  }
}

export class LedgerBusyFailure extends Error {
  constructor() {
    super("ledger is busy; retry is safe");
  }
}

export const FIELD_PRECEDENCE_V1 = {
  bookedOn: "primary-supersedes-secondary",
  occurredOn: "primary-non-null-supersedes-secondary",
  normalizedCounterparty: "primary-non-null-supersedes-secondary",
  normalizedReference: "primary-non-null-supersedes-secondary",
  status: "terminal-progression-and-primary-terminal-supersedes-secondary",
} as const;

const gradeRank: Readonly<Record<EvidenceGrade, number>> = {
  derived: 0,
  secondary: 1,
  primary: 2,
};

const confidenceRank = { tentative: 0, strong: 1, confirmed: 2 } as const;

function stableComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableComparable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableComparable(entry)]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableComparable(left)) === JSON.stringify(stableComparable(right));
}

function conflict(
  identity: StableIdentity,
  transactionId: string,
  reason: IngestConflictV1["reason"],
): never {
  throw new IngestConflictFailure({
    kind: "company-money.ingest-conflict",
    version: 1,
    id: identity.digest("company-money/ingest-conflict/v1", [transactionId, reason]),
    reason,
  });
}

function mergeObserved<T>(
  existingValue: T | null,
  existingGrade: EvidenceGrade,
  incomingValue: T | null,
  incomingGrade: EvidenceGrade,
  identity: StableIdentity,
  transactionId: string,
): readonly [T | null, EvidenceGrade] {
  if (incomingValue === null) return [existingValue, existingGrade];
  if (existingValue === null) return [incomingValue, incomingGrade];
  if (same(existingValue, incomingValue)) {
    return gradeRank[incomingGrade] > gradeRank[existingGrade]
      ? [incomingValue, incomingGrade]
      : [existingValue, existingGrade];
  }
  if (gradeRank[incomingGrade] > gradeRank[existingGrade]) {
    return [incomingValue, incomingGrade];
  }
  if (gradeRank[incomingGrade] < gradeRank[existingGrade]) {
    return [existingValue, existingGrade];
  }
  return conflict(identity, transactionId, "incompatible-evidence");
}

function terminal(status: TransactionStatus): boolean {
  return status !== "pending";
}

function mergeStatus(
  existing: TransactionStatus,
  existingGrade: EvidenceGrade,
  incoming: TransactionStatus,
  incomingGrade: EvidenceGrade,
  identity: StableIdentity,
  transactionId: string,
): readonly [TransactionStatus, EvidenceGrade] {
  if (existing === incoming) {
    return gradeRank[incomingGrade] > gradeRank[existingGrade]
      ? [incoming, incomingGrade]
      : [existing, existingGrade];
  }
  if (!terminal(existing) && terminal(incoming)) return [incoming, incomingGrade];
  if (terminal(existing) && !terminal(incoming)) return [existing, existingGrade];
  if (gradeRank[incomingGrade] > gradeRank[existingGrade]) return [incoming, incomingGrade];
  if (gradeRank[incomingGrade] < gradeRank[existingGrade]) return [existing, existingGrade];
  return conflict(identity, transactionId, "contradictory-terminal-state");
}

function mergeClassification(
  existing: ClassificationV1,
  incoming: ClassificationV1,
  identity: StableIdentity,
  transactionId: string,
): ClassificationV1 {
  if (existing.value !== incoming.value) {
    if (existing.value === "unclassified") return incoming;
    if (incoming.value === "unclassified") return existing;
    return conflict(identity, transactionId, "incompatible-evidence");
  }
  const preferred =
    confidenceRank[incoming.confidence] > confidenceRank[existing.confidence]
      ? incoming
      : confidenceRank[incoming.confidence] < confidenceRank[existing.confidence]
        ? existing
        : [incoming, existing].sort((left, right) =>
            compareCodeUnits(
              `${left.basis}\0${left.ruleId ?? ""}`,
              `${right.basis}\0${right.ruleId ?? ""}`,
            ),
          )[0];
  return {
    ...preferred,
    evidenceIds: [...new Set([...existing.evidenceIds, ...incoming.evidenceIds])].sort(
      compareCodeUnits,
    ),
  };
}

function candidateIdentity(candidate: TransactionCandidateV1, identity: StableIdentity) {
  if (candidate.providerTransactionId !== null) {
    return {
      id: identity.digest("company-money/transaction/provider-id/v1", [
        candidate.provider,
        candidate.accountAlias,
        candidate.providerTransactionId,
      ]),
      method: "provider-id" as const,
    };
  }
  if (candidate.sourcePosition === null) {
    throw new TypeError("fallback identity requires a stable source position");
  }
  return {
    id: identity.digest("company-money/transaction/fallback/v1", [
      candidate.provider,
      candidate.accountAlias,
      candidate.bookedOn,
      candidate.money.currency,
      String(candidate.money.minorUnits),
      candidate.direction,
      candidate.normalizedCounterparty ?? "",
      candidate.normalizedReference ?? "",
      candidate.sourcePosition,
    ]),
    method: "fallback" as const,
  };
}

function fromCandidate(
  candidate: TransactionCandidateV1,
  identity: StableIdentity,
): TransactionV1 {
  const selected = candidateIdentity(candidate, identity);
  const grade = candidate.evidence.grade as typeof CandidateEvidenceGradeV1Schema.infer;
  return {
    kind: "company-money.transaction",
    version: 1,
    id: selected.id,
    identityMethod: selected.method,
    entityId: candidate.entityId,
    accountAlias: candidate.accountAlias,
    provider: candidate.provider,
    occurredOn: candidate.occurredOn,
    bookedOn: candidate.bookedOn,
    money: candidate.money,
    direction: candidate.direction,
    status: candidate.status,
    normalizedCounterparty: candidate.normalizedCounterparty,
    normalizedReference: candidate.normalizedReference,
    providerTransactionId: candidate.providerTransactionId,
    sourcePosition: candidate.sourcePosition,
    classification: candidate.classification,
    fieldGrades: {
      bookedOn: grade,
      occurredOn: grade,
      normalizedCounterparty: grade,
      normalizedReference: grade,
      status: grade,
    },
    evidenceIds: [candidate.evidence.id],
  };
}

function requireImmutableAgreement(
  existing: TransactionV1,
  incoming: TransactionV1,
  identity: StableIdentity,
): void {
  const compatible =
    existing.identityMethod === incoming.identityMethod &&
    existing.entityId === incoming.entityId &&
    existing.accountAlias === incoming.accountAlias &&
    existing.provider === incoming.provider &&
    existing.money.currency === incoming.money.currency &&
    existing.money.minorUnits === incoming.money.minorUnits &&
    existing.direction === incoming.direction &&
    existing.providerTransactionId === incoming.providerTransactionId &&
    (existing.identityMethod !== "fallback" ||
      existing.sourcePosition === incoming.sourcePosition);
  if (!compatible) conflict(identity, existing.id, "incompatible-evidence");
}

function mergeTransaction(
  existing: TransactionV1,
  incoming: TransactionV1,
  identity: StableIdentity,
): TransactionV1 {
  requireImmutableAgreement(existing, incoming, identity);
  const booked = mergeObserved(
    existing.bookedOn,
    existing.fieldGrades.bookedOn,
    incoming.bookedOn,
    incoming.fieldGrades.bookedOn,
    identity,
    existing.id,
  );
  const occurred = mergeObserved(
    existing.occurredOn,
    existing.fieldGrades.occurredOn,
    incoming.occurredOn,
    incoming.fieldGrades.occurredOn,
    identity,
    existing.id,
  );
  const counterparty = mergeObserved(
    existing.normalizedCounterparty,
    existing.fieldGrades.normalizedCounterparty,
    incoming.normalizedCounterparty,
    incoming.fieldGrades.normalizedCounterparty,
    identity,
    existing.id,
  );
  const reference = mergeObserved(
    existing.normalizedReference,
    existing.fieldGrades.normalizedReference,
    incoming.normalizedReference,
    incoming.fieldGrades.normalizedReference,
    identity,
    existing.id,
  );
  const status = mergeStatus(
    existing.status,
    existing.fieldGrades.status,
    incoming.status,
    incoming.fieldGrades.status,
    identity,
    existing.id,
  );
  return {
    ...existing,
    bookedOn: booked[0] ?? existing.bookedOn,
    occurredOn: occurred[0],
    normalizedCounterparty: counterparty[0],
    normalizedReference: reference[0],
    status: status[0],
    sourcePosition:
      existing.identityMethod === "provider-id"
        ? [existing.sourcePosition, incoming.sourcePosition]
            .filter((value): value is string => value !== null)
            .sort(compareCodeUnits)[0] ?? null
        : existing.sourcePosition,
    classification: mergeClassification(
      existing.classification,
      incoming.classification,
      identity,
      existing.id,
    ),
    fieldGrades: {
      bookedOn: booked[1],
      occurredOn: occurred[1],
      normalizedCounterparty: counterparty[1],
      normalizedReference: reference[1],
      status: status[1],
    },
    evidenceIds: [...new Set([...existing.evidenceIds, ...incoming.evidenceIds])].sort(
      compareCodeUnits,
    ),
  };
}

function orderedSnapshot(snapshot: LedgerSnapshotV1): LedgerSnapshotV1 {
  return {
    ...snapshot,
    transactions: [...snapshot.transactions].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    ),
    evidence: [...snapshot.evidence].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    ),
    transferLinks: [...snapshot.transferLinks].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    ),
    quarantine: [...snapshot.quarantine].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    ),
  };
}

function addEvidence(
  evidence: Map<string, EvidenceRefV1>,
  incoming: EvidenceRefV1,
  identity: StableIdentity,
): boolean {
  const existing = evidence.get(incoming.id);
  if (!existing) {
    evidence.set(incoming.id, incoming);
    return true;
  }
  if (!same(existing, incoming)) conflict(identity, incoming.id, "evidence-id-collision");
  return false;
}

export function applyIngestBatch(
  snapshot: LedgerSnapshotV1,
  batch: IngestBatchV1,
  dependencies: Pick<IngestDependencies, "identity" | "transferPolicy">,
): {
  readonly snapshot: LedgerSnapshotV1;
  readonly insertedCount: number;
  readonly duplicateCount: number;
  readonly quarantineCount: number;
  readonly linkCount: number;
} {
  const transactions = new Map(snapshot.transactions.map((entry) => [entry.id, entry]));
  const evidence = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
  const quarantine = new Map(snapshot.quarantine.map((entry) => [entry.id, entry]));
  let insertedCount = 0;
  let duplicateCount = 0;
  let quarantineCount = 0;

  for (const candidate of batch.candidates) {
    const evidenceWasNew = addEvidence(evidence, candidate.evidence, dependencies.identity);
    const incoming = fromCandidate(candidate, dependencies.identity);
    const existing = transactions.get(incoming.id);
    if (!existing) {
      transactions.set(incoming.id, incoming);
      insertedCount += 1;
    } else {
      const merged = mergeTransaction(existing, incoming, dependencies.identity);
      transactions.set(incoming.id, merged);
      if (!evidenceWasNew && same(existing, merged)) duplicateCount += 1;
    }
  }

  for (const entry of batch.quarantine) {
    const existing = quarantine.get(entry.id);
    if (existing && !same(existing, entry)) {
      conflict(dependencies.identity, entry.id, "evidence-id-collision");
    }
    if (!existing) {
      quarantine.set(entry.id, entry);
      quarantineCount += 1;
    }
  }

  const reconciled = reconcileTransferLinks(
    [...transactions.values()],
    dependencies.transferPolicy,
    dependencies.identity,
  );
  const previousLinks = new Set(snapshot.transferLinks.map((entry) => entry.id));
  const linkCount = reconciled.links.filter((entry) => !previousLinks.has(entry.id)).length;
  return {
    snapshot: orderedSnapshot({
      kind: "company-money.ledger-snapshot",
      version: 1,
      transactions: [...transactions.values()],
      evidence: [...evidence.values()],
      transferLinks: [...reconciled.links],
      quarantine: [...quarantine.values()],
    }),
    insertedCount,
    duplicateCount,
    quarantineCount,
    linkCount,
  };
}

function unavailable(reason: LedgerUnavailableV1["reason"]): LedgerUnavailableFailure {
  return new LedgerUnavailableFailure({
    kind: "company-money.ledger-unavailable",
    version: 1,
    reason,
  });
}

function storageFailureReason(
  error: unknown,
  fallback: LedgerUnavailableV1["reason"],
): LedgerUnavailableV1["reason"] {
  if (typeof error !== "object" || error === null) return fallback;
  const reason = (error as { ledgerUnavailableReason?: unknown }).ledgerUnavailableReason;
  return reason === "unreadable" ||
    reason === "corrupt" ||
    reason === "future-version" ||
    reason === "uncommittable"
    ? reason
    : fallback;
}

export async function ingestLedger(
  batch: IngestBatchV1,
  dependencies: IngestDependencies,
): Promise<IngestResultV1> {
  const maxAttempts = dependencies.maxCasAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let current: Awaited<ReturnType<IngestLedgerStore["read"]>>;
    try {
      current = await dependencies.store.read();
      validateLedgerSnapshot(current.snapshot);
    } catch (error) {
      throw unavailable(storageFailureReason(error, "unreadable"));
    }

    const applied = applyIngestBatch(current.snapshot, batch, dependencies);
    if (same(current.snapshot, applied.snapshot)) {
      return {
        kind: "company-money.ingest-result",
        version: 1,
        committedRevision: current.revision,
        insertedCount: applied.insertedCount,
        duplicateCount: applied.duplicateCount,
        conflictCount: 0,
        quarantineCount: applied.quarantineCount,
        linkCount: applied.linkCount,
      };
    }

    let outcome: "committed" | "conflict";
    try {
      outcome = await dependencies.store.compareAndSwap(current.revision, applied.snapshot);
    } catch (error) {
      throw unavailable(storageFailureReason(error, "uncommittable"));
    }
    if (outcome === "conflict") continue;

    let committedRevision: string | null;
    try {
      committedRevision = (await dependencies.store.read()).revision;
    } catch (error) {
      throw unavailable(storageFailureReason(error, "unreadable"));
    }
    return {
      kind: "company-money.ingest-result",
      version: 1,
      committedRevision,
      insertedCount: applied.insertedCount,
      duplicateCount: applied.duplicateCount,
      conflictCount: 0,
      quarantineCount: applied.quarantineCount,
      linkCount: applied.linkCount,
    };
  }
  throw new LedgerBusyFailure();
}
