import assert from "node:assert/strict";
import test from "node:test";

import { createCompanyMoneyClient } from "../company-money-router.ts";
import type { ClassificationV1 } from "../ledger/state.ts";
import {
  MemoryLedgerStore,
  syntheticIdentity,
} from "../ledger/test-fixtures.ts";
import {
  MAX_NUBANK_STATEMENT_BYTES,
  translateNubankStatement,
} from "./nubank-statement.ts";

const header =
  "date,amount,currency,direction,status,transaction_id,counterparty,reference";

function classification(evidenceId: string): ClassificationV1 {
  return {
    kind: "company-money.classification",
    version: 1,
    value: "revenue",
    confidence: "confirmed",
    basis: "synthetic-rule",
    ruleId: "synthetic-revenue",
    evidenceIds: [evidenceId],
  };
}

const options = {
  entityId: "Example Widgets Ltd.",
  accountAlias: "operating",
  identity: syntheticIdentity,
  classify: (facts: { evidenceId: string }) => classification(facts.evidenceId),
};

function envelope(csv: string) {
  return {
    kind: "company-money.nubank-statement-envelope",
    version: 1,
    accountAlias: "operating",
    sourceRef: "statement-2026-01",
    csv,
  };
}

test("parses BOM, comma/semicolon delimiters, native amounts, statuses, and provider ids", () => {
  const comma = translateNubankStatement(
    envelope(
      `\uFEFF${header}\n2026-01-02,12.34,BRL,incoming,completed,txn-1,Synthetic Customer LLC,Invoice 1\n`,
    ),
    options,
  );
  assert.equal(comma.candidates.length, 1);
  assert.equal(comma.candidates[0].money.minorUnits, 1234);
  assert.equal(comma.candidates[0].evidence.grade, "primary");
  assert.equal(comma.candidates[0].providerTransactionId, "txn-1");

  const semicolonHeader = header.replaceAll(",", ";");
  const semicolon = translateNubankStatement(
    envelope(
      `${semicolonHeader}\n2026-01-03;10,50;EUR;outgoing;cancelled;;Synthetic Vendor;Refund\n`,
    ),
    options,
  );
  assert.equal(semicolon.candidates[0].money.minorUnits, 1050);
  assert.equal(semicolon.candidates[0].status, "cancelled");
  assert.equal(semicolon.candidates[0].providerTransactionId, null);
});

test("fallback source positions are stable under row reordering", () => {
  const rows = [
    "2026-01-03,2.00,BRL,incoming,completed,,Synthetic B,Second",
    "2026-01-02,1.00,BRL,incoming,completed,,Synthetic A,First",
  ];
  const first = translateNubankStatement(envelope(`${header}\n${rows.join("\n")}\n`), options);
  const second = translateNubankStatement(
    envelope(`${header}\n${[...rows].reverse().join("\n")}\n`),
    options,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.candidates.map((candidate) => candidate.sourcePosition),
    ["row:1", "row:2"],
  );
});

test("malformed rows and unsupported currencies quarantine metadata only", () => {
  const secret = "SYNTHETIC-RAW-MARKER";
  const batch = translateNubankStatement(
    envelope(
      `${header}\n2026-02-30,1.00,BRL,incoming,completed,txn-bad,${secret},bad date\n` +
        `2026-01-02,1.00,ZZZ,incoming,completed,txn-currency,${secret},bad currency\n`,
    ),
    options,
  );
  assert.deepEqual(
    batch.quarantine.map((entry) => entry.reason).sort(),
    ["malformed-record", "unsupported-currency"],
  );
  assert.doesNotMatch(JSON.stringify(batch.quarantine), new RegExp(secret));
});

test("oversized and structurally malformed envelopes quarantine instead of throwing", () => {
  const oversized = translateNubankStatement(
    envelope("x".repeat(MAX_NUBANK_STATEMENT_BYTES + 1)),
    options,
  );
  assert.equal(oversized.quarantine[0].reason, "size-limit");
  const malformed = translateNubankStatement({ unexpected: true }, options);
  assert.equal(malformed.quarantine[0].reason, "malformed-envelope");
});

test("translator to local client to report is incremental and idempotent", async () => {
  const batch = translateNubankStatement(
    envelope(
      `${header}\n2026-01-02,12.34,BRL,incoming,completed,txn-1,Synthetic Customer LLC,Invoice 1\n`,
    ),
    options,
  );
  const store = new MemoryLedgerStore();
  const client = createCompanyMoneyClient({
    identity: syntheticIdentity,
    store,
    transferPolicy: { isEligibleAccountPair: () => false },
  });
  assert.equal((await client.ledger.ingest(batch)).insertedCount, 1);
  assert.equal((await client.ledger.ingest(batch)).duplicateCount, 1);
  const report = await client.ledger.report({
    kind: "company-money.report-query",
    version: 1,
    from: "2026-01-01",
    through: "2026-01-31",
  });
  assert.equal(report.currencies[0].revenueMinorUnits, 1234);
});

test("duplicate provider ids with contradictory primary facts fail the batch", async () => {
  const batch = translateNubankStatement(
    envelope(
      `${header}\n2026-01-02,1.00,BRL,incoming,completed,same-id,Synthetic A,One\n` +
        `2026-01-02,2.00,BRL,incoming,completed,same-id,Synthetic A,Two\n`,
    ),
    options,
  );
  const store = new MemoryLedgerStore();
  const client = createCompanyMoneyClient({
    identity: syntheticIdentity,
    store,
    transferPolicy: { isEligibleAccountPair: () => false },
  });
  await assert.rejects(() => client.ledger.ingest(batch));
  assert.equal(store.writes, 0);
});
