import assert from "node:assert/strict";
import test from "node:test";

import { companyMoneySchemaCatalog } from "../company-money-public.ts";
import { IngestBatchV1Schema, IngestResultV1Schema } from "./ingest.ts";
import { CurrencySummaryV1Schema } from "./report.ts";
import { emptyLedgerSnapshot, LedgerSnapshotV1Schema } from "./state.ts";
import { syntheticBatch, syntheticCandidate } from "./test-fixtures.ts";

test("canonical and ingest schemas reject unknown fields without replacing values", () => {
  const snapshot = emptyLedgerSnapshot();
  const batch = syntheticBatch([syntheticCandidate()]);
  assert.equal(LedgerSnapshotV1Schema.assert(snapshot), snapshot);
  assert.equal(IngestBatchV1Schema.assert(batch), batch);
  assert.throws(() => LedgerSnapshotV1Schema.assert({ ...snapshot, extra: true }), /extra/);
  assert.throws(
    () =>
      IngestBatchV1Schema.assert({
        ...batch,
        candidates: [{ ...batch.candidates[0], extra: true }],
      }),
    /extra/,
  );
});

test("result counts and totals reject negative values", () => {
  assert.throws(
    () =>
      IngestResultV1Schema.assert({
        kind: "company-money.ingest-result",
        version: 1,
        committedRevision: null,
        insertedCount: -1,
        duplicateCount: 0,
        conflictCount: 0,
        quarantineCount: 0,
        linkCount: 0,
      }),
    /non-negative/,
  );
  assert.throws(
    () =>
      CurrencySummaryV1Schema.assert({
        kind: "company-money.currency-summary",
        version: 1,
        currency: "BRL",
        receiptsMinorUnits: -1,
        revenueMinorUnits: 0,
        outgoingMinorUnits: 0,
        expenseMinorUnits: 0,
        ownerFundingMinorUnits: 0,
        cashbackMinorUnits: 0,
        internalTransferMinorUnits: 0,
        failedCount: 0,
        cancelledCount: 0,
        unresolvedCount: 0,
        unlinkedInternalTransferCount: 0,
      }),
    /non-negative/,
  );
});

test("the public catalog contains every named v1 model exactly once", () => {
  assert.deepEqual(Object.keys(companyMoneySchemaCatalog), [
    "company-money.money",
    "company-money.evidence-ref",
    "company-money.classification",
    "company-money.transaction",
    "company-money.quarantine-entry",
    "company-money.transfer-link",
    "company-money.ledger-snapshot",
    "company-money.ledger-unavailable",
    "company-money.transaction-candidate",
    "company-money.ingest-batch",
    "company-money.ingest-result",
    "company-money.ingest-conflict",
    "company-money.report-query",
    "company-money.currency-summary",
    "company-money.report",
  ]);
  for (const versions of Object.values(companyMoneySchemaCatalog)) {
    assert.deepEqual(Object.keys(versions), ["1"]);
  }
});
