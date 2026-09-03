import assert from "node:assert/strict";
import test from "node:test";

import { ORPCError } from "@orpc/server";

import { createCompanyMoneyClient } from "./company-money-router.ts";
import {
  MemoryLedgerStore,
  syntheticBatch,
  syntheticCandidate,
  syntheticIdentity,
} from "./ledger/test-fixtures.ts";

const transferPolicy = { isEligibleAccountPair: () => false };

test("the complete local contract validates and invokes ingest and report", async () => {
  const store = new MemoryLedgerStore();
  const client = createCompanyMoneyClient({ identity: syntheticIdentity, store, transferPolicy });
  assert.equal((await client.ledger.ingest(syntheticBatch([syntheticCandidate()]))).insertedCount, 1);
  const report = await client.ledger.report({
    kind: "company-money.report-query",
    version: 1,
    from: "2026-01-01",
    through: "2026-01-31",
  });
  assert.equal(report.currencies[0].revenueMinorUnits, 1250);

  const call = client.ledger.report as unknown as (input: unknown) => Promise<unknown>;
  await assert.rejects(() =>
    call({
      kind: "company-money.report-query",
      version: 1,
      from: "2026-02-01",
      through: "2026-01-01",
      unexpected: true,
    }),
  );
});

test("router maps sanitized conflict and busy outcomes to declared oRPC errors", async () => {
  const store = new MemoryLedgerStore();
  const client = createCompanyMoneyClient({
    identity: syntheticIdentity,
    store,
    transferPolicy,
    maxCasAttempts: 1,
  });
  await client.ledger.ingest(syntheticBatch([syntheticCandidate()]));
  await assert.rejects(
    () =>
      client.ledger.ingest(
        syntheticBatch([syntheticCandidate({ bookedOn: "2026-01-11" })]),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ORPCError);
      assert.equal(error.code, "INGEST_CONFLICT");
      assert.equal(error.data.reason, "incompatible-evidence");
      return true;
    },
  );

  const busyStore = new MemoryLedgerStore();
  busyStore.conflictsRemaining = 1;
  const busyClient = createCompanyMoneyClient({
    identity: syntheticIdentity,
    store: busyStore,
    transferPolicy,
    maxCasAttempts: 1,
  });
  await assert.rejects(
    () => busyClient.ledger.ingest(syntheticBatch([syntheticCandidate()])),
    (error: unknown) => error instanceof ORPCError && error.code === "LEDGER_BUSY",
  );
});
