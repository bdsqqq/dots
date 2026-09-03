import assert from "node:assert/strict";
import test from "node:test";

import { createCompanyMoneyClient } from "../company-money-router.ts";
import type { ClassificationV1 } from "../ledger/state.ts";
import {
  MemoryLedgerStore,
  syntheticIdentity,
} from "../ledger/test-fixtures.ts";
import {
  MAX_WISE_MESSAGE_BYTES,
  translateWiseGmailEnvelope,
} from "./wise-gmail.ts";

function classification(
  evidenceId: string,
  suggested: "cashback" | null,
): ClassificationV1 {
  return {
    kind: "company-money.classification",
    version: 1,
    value: suggested ?? "unclassified",
    confidence: suggested ? "strong" : "tentative",
    basis: suggested ? "provider-template" : "unresolved",
    ruleId: null,
    evidenceIds: [evidenceId],
  };
}

const options = {
  entityId: "Example Widgets Ltd.",
  accountAlias: "reserve",
  identity: syntheticIdentity,
  classify: (facts: { evidenceId: string }, suggested: "cashback" | null) =>
    classification(facts.evidenceId, suggested),
};

function message(sourceRef: string, subject: string, overrides: Partial<{ body: string }> = {}) {
  return {
    sourceRef,
    receivedAt: "2026-01-10T12:00:00Z",
    subject,
    body:
      overrides.body ??
      [
        `transaction-id: ${sourceRef}`,
        "date: 2026-01-10",
        "amount: 12.34",
        "currency: BRL",
        "counterparty: Synthetic Counterparty LLC",
        "reference: Synthetic reference",
      ].join("\n"),
  };
}

function envelope(messages: ReturnType<typeof message>[]) {
  return {
    kind: "company-money.wise-gmail-envelope",
    version: 1,
    accountAlias: "reserve",
    messages,
  };
}

test("supports received, Pix, sent, cashback, cancelled, and failed families", () => {
  const batch = translateWiseGmailEnvelope(
    envelope([
      message("received", "Wise: received"),
      message("pix", "Wise: Pix received"),
      message("sent", "Wise: sent"),
      message("cashback", "Wise: cashback"),
      message("cancelled", "Wise: cancelled"),
      message("failed", "Wise: failed"),
    ]),
    options,
  );
  assert.equal(batch.candidates.length, 6);
  assert.deepEqual(
    batch.candidates.map((candidate) => [candidate.direction, candidate.status]),
    [
      ["incoming", "completed"],
      ["incoming", "completed"],
      ["outgoing", "completed"],
      ["incoming", "completed"],
      ["outgoing", "cancelled"],
      ["outgoing", "failed"],
    ],
  );
  assert.equal(batch.candidates[3].classification.value, "cashback");
  assert.ok(batch.candidates.every((candidate) => candidate.evidence.grade === "secondary"));
});

test("unknown and malformed messages quarantine hashes without bodies", () => {
  const marker = "SYNTHETIC-BODY-MARKER";
  const batch = translateWiseGmailEnvelope(
    envelope([
      message("unknown", "Wise: something new", { body: marker }),
      message("malformed", "Wise: received", { body: `counterparty: ${marker}` }),
    ]),
    options,
  );
  assert.deepEqual(
    batch.quarantine.map((entry) => entry.reason),
    ["unsupported-template", "malformed-record"],
  );
  assert.doesNotMatch(JSON.stringify(batch.quarantine), new RegExp(marker));
});

test("envelope and message bounds become durable quarantine outcomes", () => {
  const oversized = translateWiseGmailEnvelope(
    envelope([
      message("large", "Wise: received", {
        body: "x".repeat(MAX_WISE_MESSAGE_BYTES + 1),
      }),
    ]),
    options,
  );
  assert.equal(oversized.quarantine[0].reason, "size-limit");
  const malformed = translateWiseGmailEnvelope(
    { ...envelope([]), unexpected: true },
    options,
  );
  assert.equal(malformed.quarantine[0].reason, "malformed-envelope");
  const invalidInstant = translateWiseGmailEnvelope(
    envelope([
      {
        ...message("invalid-date", "Wise: received"),
        receivedAt: "2025-02-31T12:00:00Z",
      },
    ]),
    options,
  );
  assert.equal(invalidInstant.quarantine[0].reason, "malformed-envelope");
});

test("secondary envelopes replay idempotently through the local client", async () => {
  const batch = translateWiseGmailEnvelope(
    envelope([message("received", "Wise: received")]),
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
  assert.equal(store.snapshot.transactions.length, 1);
});
