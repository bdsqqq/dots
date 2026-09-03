import { type } from "arktype";

import { CalendarDateV1Schema, MoneyV1Schema } from "../money.ts";

const NonEmptyStringV1Schema = type("string").narrow(
  (value, context) => value.length > 0 || context.mustBe("a non-empty string"),
);
const EvidenceGradeV1Schema = type("'primary' | 'secondary' | 'derived'");
const TransactionDirectionV1Schema = type("'incoming' | 'outgoing'");
const TransactionStatusV1Schema = type("'pending' | 'completed' | 'cancelled' | 'failed'");
const ClassificationValueV1Schema = type(
  "'revenue' | 'expense' | 'owner-funding' | 'cashback' | 'internal-transfer' | 'unclassified'",
);
const ClassificationConfidenceV1Schema = type("'confirmed' | 'strong' | 'tentative'");

export const EvidenceRefV1Schema = type({
  "+": "reject",
  kind: "'company-money.evidence-ref'",
  version: "1",
  id: NonEmptyStringV1Schema,
  provider: NonEmptyStringV1Schema,
  channel: NonEmptyStringV1Schema,
  sourceRef: NonEmptyStringV1Schema,
  contentDigest: NonEmptyStringV1Schema,
  grade: EvidenceGradeV1Schema,
  parserId: NonEmptyStringV1Schema,
  parserVersion: "1",
});

export const ClassificationV1Schema = type({
  "+": "reject",
  kind: "'company-money.classification'",
  version: "1",
  value: ClassificationValueV1Schema,
  confidence: ClassificationConfidenceV1Schema,
  basis: NonEmptyStringV1Schema,
  ruleId: "string | null",
  evidenceIds: NonEmptyStringV1Schema.array(),
});

const FieldGradesV1Schema = type({
  "+": "reject",
  bookedOn: EvidenceGradeV1Schema,
  occurredOn: EvidenceGradeV1Schema,
  normalizedCounterparty: EvidenceGradeV1Schema,
  normalizedReference: EvidenceGradeV1Schema,
  status: EvidenceGradeV1Schema,
});

const TransactionFactsV1Schema = {
  entityId: NonEmptyStringV1Schema,
  accountAlias: NonEmptyStringV1Schema,
  provider: NonEmptyStringV1Schema,
  occurredOn: CalendarDateV1Schema.or("null"),
  bookedOn: CalendarDateV1Schema,
  money: MoneyV1Schema,
  direction: TransactionDirectionV1Schema,
  status: TransactionStatusV1Schema,
  normalizedCounterparty: "string | null",
  normalizedReference: "string | null",
  providerTransactionId: "string | null",
  sourcePosition: "string | null",
  classification: ClassificationV1Schema,
} as const;

export const TransactionV1Schema = type({
  "+": "reject",
  kind: "'company-money.transaction'",
  version: "1",
  id: NonEmptyStringV1Schema,
  identityMethod: "'provider-id' | 'fallback'",
  ...TransactionFactsV1Schema,
  fieldGrades: FieldGradesV1Schema,
  evidenceIds: NonEmptyStringV1Schema.array(),
});

export const QuarantineEntryV1Schema = type({
  "+": "reject",
  kind: "'company-money.quarantine-entry'",
  version: "1",
  id: NonEmptyStringV1Schema,
  provider: NonEmptyStringV1Schema,
  channel: NonEmptyStringV1Schema,
  sourceRef: NonEmptyStringV1Schema,
  evidenceId: NonEmptyStringV1Schema,
  contentDigest: NonEmptyStringV1Schema,
  parserId: NonEmptyStringV1Schema,
  parserVersion: "1",
  reason:
    "'unsupported-template' | 'malformed-envelope' | 'malformed-record' | 'unsupported-currency' | 'unstable-identity' | 'size-limit'",
  resolution: "'pending' | 'ignored' | 'resolved'",
});

export const TransferLinkV1Schema = type({
  "+": "reject",
  kind: "'company-money.transfer-link'",
  version: "1",
  id: NonEmptyStringV1Schema,
  outgoingTransactionId: NonEmptyStringV1Schema,
  incomingTransactionId: NonEmptyStringV1Schema,
  reconciliationRuleVersion: "1",
});

export const LedgerSnapshotV1Schema = type({
  "+": "reject",
  kind: "'company-money.ledger-snapshot'",
  version: "1",
  transactions: TransactionV1Schema.array(),
  evidence: EvidenceRefV1Schema.array(),
  transferLinks: TransferLinkV1Schema.array(),
  quarantine: QuarantineEntryV1Schema.array(),
});

export const LedgerUnavailableV1Schema = type({
  "+": "reject",
  kind: "'company-money.ledger-unavailable'",
  version: "1",
  reason: "'unreadable' | 'corrupt' | 'future-version' | 'uncommittable'",
});

export type EvidenceGrade = typeof EvidenceGradeV1Schema.infer;
export type TransactionDirection = typeof TransactionDirectionV1Schema.infer;
export type TransactionStatus = typeof TransactionStatusV1Schema.infer;
export type ClassificationValue = typeof ClassificationValueV1Schema.infer;
export type ClassificationConfidence = typeof ClassificationConfidenceV1Schema.infer;
export type EvidenceRefV1 = typeof EvidenceRefV1Schema.infer;
export type ClassificationV1 = typeof ClassificationV1Schema.infer;
export type TransactionV1 = typeof TransactionV1Schema.infer;
export type QuarantineEntryV1 = typeof QuarantineEntryV1Schema.infer;
export type TransferLinkV1 = typeof TransferLinkV1Schema.infer;
export type LedgerSnapshotV1 = typeof LedgerSnapshotV1Schema.infer;
export type LedgerUnavailableV1 = typeof LedgerUnavailableV1Schema.infer;

export class LedgerUnavailableFailure extends Error {
  readonly unavailable: LedgerUnavailableV1;

  constructor(unavailable: LedgerUnavailableV1) {
    super("ledger is unavailable");
    this.unavailable = unavailable;
  }
}

export const ledgerStateSchemaCatalog = {
  "company-money.evidence-ref": { 1: EvidenceRefV1Schema },
  "company-money.classification": { 1: ClassificationV1Schema },
  "company-money.transaction": { 1: TransactionV1Schema },
  "company-money.quarantine-entry": { 1: QuarantineEntryV1Schema },
  "company-money.transfer-link": { 1: TransferLinkV1Schema },
  "company-money.ledger-snapshot": { 1: LedgerSnapshotV1Schema },
  "company-money.ledger-unavailable": { 1: LedgerUnavailableV1Schema },
} as const;

export function emptyLedgerSnapshot(): LedgerSnapshotV1 {
  return {
    kind: "company-money.ledger-snapshot",
    version: 1,
    transactions: [],
    evidence: [],
    transferLinks: [],
    quarantine: [],
  };
}

export function validateLedgerSnapshot(value: unknown): asserts value is LedgerSnapshotV1 {
  const validated = LedgerSnapshotV1Schema.assert(value);
  if (validated !== value) {
    throw new TypeError("ledger validation must preserve object identity");
  }
}
