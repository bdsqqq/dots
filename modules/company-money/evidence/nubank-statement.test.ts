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

const header = "Data, Valor, Identificador, Descrição";

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

test("parses the observed Nubank PJ shape into completed native-BRL movements", () => {
  const batch = translateNubankStatement(
    envelope(
      `\uFEFF${header}\n02/01/2026,12.34,txn-in,Synthetic receipt\n` +
        `03/01/2026,-10.50,txn-out,"Synthetic expense, with detail"\n`,
    ),
    options,
  );
  assert.deepEqual(
    batch.candidates.map((candidate) => ({
      bookedOn: candidate.bookedOn,
      currency: candidate.money.currency,
      direction: candidate.direction,
      minorUnits: candidate.money.minorUnits,
      normalizedCounterparty: candidate.normalizedCounterparty,
      normalizedReference: candidate.normalizedReference,
      providerTransactionId: candidate.providerTransactionId,
      status: candidate.status,
    })),
    [
      {
        bookedOn: "2026-01-02",
        currency: "BRL",
        direction: "incoming",
        minorUnits: 1234,
        normalizedCounterparty: null,
        normalizedReference: "Synthetic receipt",
        providerTransactionId: "txn-in",
        status: "completed",
      },
      {
        bookedOn: "2026-01-03",
        currency: "BRL",
        direction: "outgoing",
        minorUnits: 1050,
        normalizedCounterparty: null,
        normalizedReference: "Synthetic expense, with detail",
        providerTransactionId: "txn-out",
        status: "completed",
      },
    ],
  );
  assert.ok(batch.candidates.every((candidate) => candidate.evidence.grade === "primary"));
});

test("fallback source positions are stable under row reordering", () => {
  const rows = [
    "03/01/2026,-2.00,,Synthetic second",
    "02/01/2026,1.00,,Synthetic first",
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

test("malformed provider rows quarantine metadata only", () => {
  const secret = "SYNTHETIC-RAW-MARKER";
  const batch = translateNubankStatement(
    envelope(
      `${header}\n30/02/2026,1.00,txn-date,${secret}\n` +
        `02/01/2026,1,txn-amount,${secret}\n`,
    ),
    options,
  );
  assert.deepEqual(batch.quarantine.map((entry) => entry.reason), [
    "malformed-record",
    "malformed-record",
  ]);
  assert.doesNotMatch(JSON.stringify(batch.quarantine), new RegExp(secret));
});

test("accepts the provider's empty no-header statement without inventing activity", () => {
  assert.deepEqual(translateNubankStatement(envelope("\uFEFF\n"), options), {
    kind: "company-money.ingest-batch",
    version: 1,
    candidates: [],
    quarantine: [],
  });
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
      `${header}\n02/01/2026,12.34,txn-1,Synthetic invoice 1\n`,
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
      `${header}\n02/01/2026,1.00,same-id,Synthetic one\n` +
        `02/01/2026,2.00,same-id,Synthetic two\n`,
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
