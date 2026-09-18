import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTally, readTally, TallyV2Schema } from "./tally.ts";
import { createMailReview } from "./mail-review.ts";
import { PrivateConfigV1Schema } from "../private-config.ts";
import { applyIngestBatch } from "../ledger/ingest.ts";
import { emptyLedgerSnapshot } from "../ledger/state.ts";
import { JsonlLedgerStore } from "../ledger/jsonl-store.ts";
import { syntheticCandidate, syntheticBatch, syntheticIdentity } from "../ledger/test-fixtures.ts";

const config = PrivateConfigV1Schema.assert({
  kind: "company-money.private-config", version: 1, entityId: "Example Widgets Ltd.",
  accounts: [{ alias: "operating", provider: "nubank" }],
  entityAliases: [{ entityId: "Example Widgets Ltd.", alias: "Example" }],
  ownerFundingRules: [], internalTransferRules: [], classificationRules: [],
});
function snapshot() {
  const base = syntheticCandidate();
  return applyIngestBatch(emptyLedgerSnapshot(), syntheticBatch([
    {}, { direction: "outgoing" as const }, { status: "failed" as const },
    { status: "cancelled" as const }, { status: "pending" as const },
    { entityId: "Other Ltd." }, { provider: "wise" }, { accountAlias: "other" },
    { money: { ...base.money, currency: "USD" } },
  ].map((overrides, index) => syntheticCandidate({
    provider: "nubank", ...overrides, providerTransactionId: `synthetic-${index}`,
    classification: { ...base.classification, value: "unclassified", evidenceIds: [`e-${index}`] },
    evidence: { ...base.evidence, id: `e-${index}`, contentDigest: `c-${index}` },
  }))), { identity: syntheticIdentity, transferPolicy: { isEligibleAccountPair: () => false } }).snapshot;
}

test("tally scopes entity/account/provider, counts unresolved flows, separates currencies and retains excluded statuses", () => {
  const ledger = snapshot();
  const tally = createTally(ledger, "revision", config);
  assert.equal(tally.entity, "Example");
  assert.equal(tally.transactions.length, 6);
  assert.deepEqual(tally.currencies, [
    { currency: "BRL", decimals: 2, incoming: 1250, outgoing: 1250, net: 0 },
    { currency: "USD", decimals: 2, incoming: 1250, outgoing: 0, net: 1250 },
  ]);
  assert.ok(tally.transactions.every(t => t.classification === "unresolved"));
  assert.deepEqual(createTally({ ...ledger, transactions: [...ledger.transactions].reverse() }, "revision", config), tally);
  assert.throws(() => TallyV2Schema.assert({ ...tally, rawEvidence: "forbidden" }));
  const large = structuredClone(ledger);
  const selected = large.transactions.find(t => t.entityId === config.entityId && t.provider === "nubank" && t.accountAlias === "operating")!;
  large.transactions = [selected, { ...selected, id: "other" }];
  large.transactions.forEach(t => { t.money.minorUnits = Number.MAX_SAFE_INTEGER; t.status = "completed"; });
  assert.throws(() => createTally(large, "revision", config), /unavailable/);
});

test("disk tally is read-only and missing/corrupt state fails rather than showing zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthetic-money-"));
  try {
    await assert.rejects(readTally(root));
    assert.deepEqual(await readdir(root), []);
    await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(readTally(root));
    const store = new JsonlLedgerStore({ rootPath: root });
    await store.compareAndSwap(null, snapshot());
    const before = await readFile(join(root, "ledger.jsonl"));
    const missingMail = await readTally(root);
    assert.equal(missingMail.transactions.length, 6);
    assert.equal(missingMail.mail.status, "missing");
    const observationSet = { kind: "company-money.mail-observation-set", version: 1, scope: "gmail-exact-work-label", records: [] };
    await writeFile(join(root, "state", "work-mail-observations.v1.json"), JSON.stringify(observationSet), { mode: 0o600 });
    const withMail = await readTally(root);
    assert.deepEqual(withMail.mail, createMailReview(observationSet));
    assert.deepEqual(withMail.currencies, missingMail.currencies);
    await writeFile(join(root, "state", "work-mail-observations.v1.json"), "corrupt");
    const badMail = await readTally(root);
    assert.equal(badMail.mail.status, "unavailable");
    assert.deepEqual(badMail.currencies, missingMail.currencies);
    assert.deepEqual(await readFile(join(root, "ledger.jsonl")), before);
    await writeFile(join(root, "ledger.jsonl"), "corrupt");
    await assert.rejects(readTally(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured Wise transfers feed native-currency totals while failed, cancelled and pending transfers remain excluded", () => {
  const ledger = snapshot();
  const wise = ledger.transactions.find(t => t.provider === "wise")!;
  wise.accountAlias = "reserve";
  wise.money.currency = "USD";
  ledger.transactions.push(...(["failed", "cancelled", "pending"] as const).map(status => ({ ...wise, id: `wise-${status}`, status })));
  const accounts = [...config.accounts, { alias: "reserve", provider: "wise" as const }];
  const tally = createTally(ledger, "revision", { ...config, accounts });
  assert.equal(tally.transactions.filter(t => t.provider === "wise").length, 4);
  assert.deepEqual(tally.currencies, [
    { currency: "BRL", decimals: 2, incoming: 1250, outgoing: 1250, net: 0 },
    { currency: "USD", decimals: 2, incoming: 2500, outgoing: 0, net: 2500 },
  ]);
  const wiseOnly = createTally(ledger, "revision", { ...config, accounts: [{ alias: "reserve", provider: "wise" }] });
  assert.equal(wiseOnly.transactions.length, 4);
  assert.deepEqual(wiseOnly.currencies, [{ currency: "USD", decimals: 2, incoming: 1250, outgoing: 0, net: 1250 }]);
});
