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

test("normalizes padded legacy subjects before choosing the parser", () => {
  const batch = translateWiseGmailEnvelope(
    envelope([message("padded", "  Wise: received  ")]),
    options,
  );
  assert.equal(batch.candidates.length, 1);
  assert.equal(batch.candidates[0].status, "completed");
});

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

function nativeMessage(id: string, subject: string, body: string) {
  return message(id, subject, { body: `This message is for the business account of ${options.entityId}\n${body}` });
}
const nativeReceived = nativeMessage("native-received", "Money received from Synthetic Client LLC.", "You received 1,000.25 USD from Synthetic Client LLC.\nFrom:\nSynthetic Client LLC\nAmount received:\n1,000.25 USD\nReference:\nSynthetic invoice\nTransfer number:\n#1001");
const nativeSent = nativeMessage("native-sent", "Transfer sent (#1002)", "1,000 BRL is now in Synthetic Recipient's account.\nTransfer details\nAmount:\n1,000.00 BRL\nWise fee:\n0 BRL\nTransfer number:\n#1002");
const nativePix = nativeMessage("native-pix", "Pix of 100 BRL received", "You received a Pix of 100 BRL from Synthetic Person.\nFrom:\nSynthetic Person\nAmount received:\n100 BRL\nReference:\nSynthetic funding\nTransfer number:\n#1003");
const nativeReturned = nativeMessage("native-returned", "There’s a problem with your transfer (#1004)", "Your transfer of 20.00 BRL to Synthetic Recipient was sent back to us.");
const nativeCancelled = nativeMessage("native-cancelled", "Transfer cancelled (#1004)", "We've cancelled your transfer of 20.00 BRL.");
const nativeCashback = nativeMessage("native-cashback", "Your business received cashback for December", "You've received 1.25 BRL cashback for December. For example, if you hold 10,000 BRL you’ll receive 20 BRL cashback.");

test("native Wise notifications parse authoritative fields, not every amount mentioned in an email", () => {
  const result = translateWiseGmailEnvelope(envelope([nativeReceived, nativeSent, nativePix, nativeReturned, nativeCancelled, nativeCashback]), options);
  assert.equal(result.quarantine.length, 0);
  assert.deepEqual(result.candidates.map(c => [c.money.currency, c.money.minorUnits, c.direction, c.status]), [
    ["USD", 100025, "incoming", "completed"], ["BRL", 100000, "outgoing", "completed"],
    ["BRL", 10000, "incoming", "completed"], ["BRL", 2000, "outgoing", "pending"],
    ["BRL", 2000, "outgoing", "cancelled"], ["BRL", 125, "incoming", "completed"],
  ]);
  assert.ok(result.candidates.every(c => c.occurredOn === null && c.bookedOn === "2026-01-10"));
  assert.ok(result.candidates.every(c => c.evidence.parserId.endsWith("/native-notification")));
  assert.equal(result.candidates.at(-1)?.providerTransactionId, "cashback-period:2025-12");
  assert.equal(result.candidates.at(-1)?.classification.value, "cashback");
});

test("native returned/cancelled notifications reconcile to one excluded transfer and replay in either order", async () => {
  for (const messages of [[nativeReturned, nativeCancelled], [nativeCancelled, nativeReturned]]) {
    const store = new MemoryLedgerStore();
    const client = createCompanyMoneyClient({ identity: syntheticIdentity, store, transferPolicy: { isEligibleAccountPair: () => false } });
    for (const m of messages) await client.ledger.ingest(translateWiseGmailEnvelope(envelope([m]), options));
    assert.equal(store.snapshot.transactions.length, 1);
    assert.equal(store.snapshot.transactions[0].status, "cancelled");
    assert.equal(store.snapshot.transactions[0].evidenceIds.length, 2);
    const replay = await client.ledger.ingest(translateWiseGmailEnvelope(envelope(messages), options));
    assert.equal(replay.insertedCount, 0);
    assert.equal(replay.duplicateCount, 2);
  }
});

test("native unknown, foreign-account, conflicting, unconfirmed and fee-bearing evidence is quarantined", () => {
  const invalid = [
    { ...nativeSent, subject: "Transfer sent (#9999)" },
    { ...nativeSent, body: nativeSent.body.replace(options.entityId, "Another Company Ltd.") },
    { ...nativeSent, body: nativeSent.body.replace("is now in", "will arrive in") },
    { ...nativeSent, body: nativeSent.body.replace("Wise fee:\n0 BRL", "Wise fee:\n5 BRL") },
    { ...nativeReceived, body: nativeReceived.body.replace("Amount received:\n1,000.25", "Amount received:\n10.25") },
    { ...nativeReceived, body: `${nativeReceived.body}\nAmount received:\n1,000.25 USD` },
    { ...nativeReceived, subject: "Your account is ready to use" },
  ];
  const result = translateWiseGmailEnvelope(envelope(invalid), options);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.quarantine.length, invalid.length);
  assert.doesNotMatch(JSON.stringify(result.quarantine), /Synthetic Recipient|Synthetic Client|Another Company/);
});
