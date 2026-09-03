import { NodeSha256Identity } from "./sha256-identity.ts";
import { emptyLedgerSnapshot, type LedgerSnapshotV1 } from "./state.ts";
import type {
  IngestBatchV1,
  IngestLedgerStore,
  TransactionCandidateV1,
} from "./ingest.ts";

export const syntheticIdentity = new NodeSha256Identity();

export function syntheticCandidate(
  overrides: Partial<TransactionCandidateV1> = {},
): TransactionCandidateV1 {
  const evidenceId = overrides.evidence?.id ?? "evidence-1";
  const candidate: TransactionCandidateV1 = {
    kind: "company-money.transaction-candidate",
    version: 1,
    entityId: "Example Widgets Ltd.",
    accountAlias: "operating",
    provider: "synthetic-provider",
    occurredOn: "2026-01-10",
    bookedOn: "2026-01-10",
    money: {
      kind: "company-money.money",
      version: 1,
      currency: "BRL",
      minorUnits: 1250,
    },
    direction: "incoming",
    status: "completed",
    normalizedCounterparty: "Synthetic Customer LLC",
    normalizedReference: "synthetic invoice",
    providerTransactionId: "provider-transaction-1",
    sourcePosition: "row:1",
    classification: {
      kind: "company-money.classification",
      version: 1,
      value: "revenue",
      confidence: "confirmed",
      basis: "synthetic-rule",
      ruleId: "rule-1",
      evidenceIds: [evidenceId],
    },
    evidence: {
      kind: "company-money.evidence-ref",
      version: 1,
      id: evidenceId,
      provider: "synthetic-provider",
      channel: "synthetic-statement",
      sourceRef: "source-1",
      contentDigest: "content-1",
      grade: "primary",
      parserId: "synthetic-parser",
      parserVersion: 1,
    },
  };
  return {
    ...candidate,
    ...overrides,
    money: overrides.money ?? candidate.money,
    classification: overrides.classification ?? candidate.classification,
    evidence: overrides.evidence ?? candidate.evidence,
  };
}

export function syntheticBatch(
  candidates: readonly TransactionCandidateV1[],
): IngestBatchV1 {
  return {
    kind: "company-money.ingest-batch",
    version: 1,
    candidates: [...candidates],
    quarantine: [],
  };
}

export class MemoryLedgerStore implements IngestLedgerStore {
  revision: string | null = null;
  snapshot: LedgerSnapshotV1 = emptyLedgerSnapshot();
  conflictsRemaining = 0;
  writes = 0;

  async read() {
    return { revision: this.revision, snapshot: structuredClone(this.snapshot) };
  }

  async compareAndSwap(expectedRevision: string | null, next: LedgerSnapshotV1) {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      return "conflict" as const;
    }
    if (expectedRevision !== this.revision) return "conflict" as const;
    this.writes += 1;
    this.snapshot = structuredClone(next);
    this.revision = `revision-${this.writes}`;
    return "committed" as const;
  }
}
