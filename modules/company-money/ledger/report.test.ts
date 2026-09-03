import assert from "node:assert/strict";
import test from "node:test";

import { applyIngestBatch } from "./ingest.ts";
import { createReport } from "./report.ts";
import { emptyLedgerSnapshot } from "./state.ts";
import {
  syntheticBatch,
  syntheticCandidate,
  syntheticIdentity,
} from "./test-fixtures.ts";

const noTransfers = { isEligibleAccountPair: () => false };

function classified(
  id: string,
  value: ReturnType<typeof syntheticCandidate>["classification"]["value"],
  direction: "incoming" | "outgoing",
  minorUnits: number,
  overrides: Parameters<typeof syntheticCandidate>[0] = {},
) {
  const base = syntheticCandidate();
  return syntheticCandidate({
    ...overrides,
    providerTransactionId: id,
    direction,
    money: {
      ...base.money,
      minorUnits,
      ...(overrides.money ?? {}),
    },
    evidence: {
      ...base.evidence,
      id: `evidence-${id}`,
      contentDigest: `content-${id}`,
    },
    classification: {
      ...base.classification,
      value,
      confidence: overrides.classification?.confidence ?? "confirmed",
      evidenceIds: [`evidence-${id}`],
    },
  });
}

test("reports completed native-currency totals without treating every receipt as revenue", () => {
  const applied = applyIngestBatch(
    emptyLedgerSnapshot(),
    syntheticBatch([
      classified("revenue", "revenue", "incoming", 1000),
      classified("owner", "owner-funding", "incoming", 2000),
      classified("cashback", "cashback", "incoming", 300),
      classified("expense", "expense", "outgoing", 400),
      classified("unresolved", "unclassified", "incoming", 500),
      classified("tentative", "revenue", "incoming", 600, {
        classification: {
          ...syntheticCandidate().classification,
          value: "revenue",
          confidence: "tentative",
        },
      }),
      classified("cancelled", "expense", "outgoing", 700, { status: "cancelled" }),
      classified("failed", "expense", "outgoing", 800, { status: "failed" }),
      classified("usd", "revenue", "incoming", 900, {
        money: {
          ...syntheticCandidate().money,
          currency: "USD",
          minorUnits: 900,
        },
      }),
    ]),
    { identity: syntheticIdentity, transferPolicy: noTransfers },
  );
  const report = createReport(
    {
      kind: "company-money.report-query",
      version: 1,
      from: "2026-01-10",
      through: "2026-01-10",
    },
    "revision-1",
    applied.snapshot,
  );
  assert.deepEqual(
    report.currencies.map((entry) => entry.currency),
    ["BRL", "USD"],
  );
  const brl = report.currencies[0];
  assert.equal(brl.receiptsMinorUnits, 1000);
  assert.equal(brl.revenueMinorUnits, 1000);
  assert.equal(brl.ownerFundingMinorUnits, 2000);
  assert.equal(brl.cashbackMinorUnits, 300);
  assert.equal(brl.outgoingMinorUnits, 400);
  assert.equal(brl.expenseMinorUnits, 400);
  assert.equal(brl.unresolvedCount, 2);
  assert.equal(brl.cancelledCount, 1);
  assert.equal(brl.failedCount, 1);
  assert.equal(report.currencies[1].revenueMinorUnits, 900);
});

test("report membership uses inclusive bookedOn rather than occurredOn", () => {
  const applied = applyIngestBatch(
    emptyLedgerSnapshot(),
    syntheticBatch([
      classified("inside-start", "revenue", "incoming", 100, {
        bookedOn: "2026-02-01",
        occurredOn: "2025-12-01",
      }),
      classified("inside-end", "revenue", "incoming", 200, {
        bookedOn: "2026-02-28",
        occurredOn: "2026-03-01",
      }),
      classified("outside", "revenue", "incoming", 400, {
        bookedOn: "2026-03-01",
        occurredOn: "2026-02-15",
      }),
    ]),
    { identity: syntheticIdentity, transferPolicy: noTransfers },
  );
  const report = createReport(
    {
      kind: "company-money.report-query",
      version: 1,
      from: "2026-02-01",
      through: "2026-02-28",
    },
    null,
    applied.snapshot,
  );
  assert.equal(report.currencies[0].revenueMinorUnits, 300);
  assert.equal(report.diagnostics.transactionCount, 2);
});
