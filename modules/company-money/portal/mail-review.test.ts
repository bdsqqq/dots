import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailReview, MailObservationSetV1Schema, readMailReview } from "./mail-review.ts";

const observation = {
  kind: "company-money.mail-observation", version: 1, provider: "wise",
  sourceRef: "synthetic-message-id", contentDigest: "synthetic-content-digest",
  workLabelVerified: true, receivedAt: "2026-01-10T12:00:00.123000Z", companyNameMentioned: true,
  subjectHints: ["received"], amountCandidates: [{ currency: "EUR", lexeme: "12.50", signedMinorUnits: 1250 }],
  dateCandidates: ["2026-01-09"], attachments: [],
  disposition: "unresolved-provider-template", countsTowardTotals: false,
};
const set = { kind: "company-money.mail-observation-set", version: 1, scope: "gmail-exact-work-label", records: [observation] };

test("saved mail schemas are exact, work-only, non-counting and versioned", () => {
  assert.ok(MailObservationSetV1Schema.allows(set));
  for (const override of [{ body: "synthetic secret" }, { countsTowardTotals: true }, { workLabelVerified: false }, { version: 2 }, { receivedAt: "2026-02-30T12:00:00Z" }]) {
    assert.throws(() => createMailReview({ ...set, records: [{ ...observation, ...override }] }));
  }
  assert.throws(() => createMailReview({ ...set, scope: "all-mail" }));
  assert.throws(() => createMailReview({ ...set, records: Array(1001).fill(observation) }));
});

test("projection keeps unresolved evidence separate and hides ambiguous amounts and source identifiers", () => {
  const input = { ...set, records: [
    observation,
    { ...observation, sourceRef: "ambiguous", disposition: "unresolved-account-ownership" },
    { ...observation, sourceRef: "unmatched", companyNameMentioned: false },
    { ...observation, sourceRef: "card", subjectHints: ["card"], disposition: "card-statement-excluded" },
    { ...observation, sourceRef: "failed", subjectHints: ["failed"] },
    { ...observation, sourceRef: "ingested", disposition: "notification-ingested" },
  ] };
  const result = createMailReview(input);
  assert.equal(result.records.length, 6);
  assert.equal(result.records.filter(r => r.amounts.length > 0).length, 2);
  assert.equal(result.records.find(r => r.disposition === "unresolved-account-ownership")?.amounts.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-message-id|synthetic-content-digest|sourceRef|dateCandidates/);
  assert.deepEqual(createMailReview({ ...input, records: [...input.records].reverse() }), result);
});

test("private mail reloads without writes and distinguishes missing from invalid, unsafe and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthetic-mail-review-"));
  const state = join(root, "state");
  const file = join(state, "work-mail-observations.v1.json");
  try {
    assert.equal((await readMailReview(root)).status, "missing");
    assert.deepEqual(await readdir(root), []);
    await mkdir(state, { mode: 0o700 });
    await writeFile(file, JSON.stringify(set), { mode: 0o600 });
    const bytes = await readFile(file);
    assert.deepEqual(await readMailReview(root), createMailReview(set));
    assert.deepEqual(await readFile(file), bytes);
    await writeFile(file, JSON.stringify({ ...set, records: [] }));
    assert.deepEqual((await readMailReview(root)).records, []);
    await chmod(file, 0o644);
    assert.equal((await readMailReview(root)).status, "unavailable");
    await chmod(file, 0o600);
    await writeFile(file, "corrupt");
    assert.equal((await readMailReview(root)).status, "unavailable");
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.equal((await readMailReview(root)).status, "unavailable");
    await rm(file);
    await writeFile(join(root, "elsewhere"), JSON.stringify(set), { mode: 0o600 });
    await symlink(join(root, "elsewhere"), file);
    assert.equal((await readMailReview(root)).status, "unavailable");
    await rm(file);
    await chmod(state, 0o755);
    assert.equal((await readMailReview(root)).status, "unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
