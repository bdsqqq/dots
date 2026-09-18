import { type } from "arktype";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { CalendarDateV1Schema, IsoCurrencyV1Schema, compareCodeUnits } from "../money.ts";

const Integer = type("number.safe & number.integer");
const Text = type("string <= 512");
const Instant = type("string").narrow((value, ctx) =>
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(value) &&
  CalendarDateV1Schema.allows(value.slice(0, 10)) || ctx.mustBe("a UTC timestamp"));
const Provider = type("'nubank' | 'wise'");
const Hints = type("'received' | 'sent' | 'cancelled' | 'failed' | 'cashback' | 'pending' | 'statement' | 'card'").array();
const Disposition = type("'unresolved' | 'statement-ingested' | 'notification-ingested' | 'statement-quarantined' | 'unresolved-account-ownership' | 'card-statement-excluded' | 'unresolved-provider-template' | 'supplementary-notification-not-counted' | 'no-supported-transaction-extracted'");
const Amount = type({
  "+": "reject", currency: IsoCurrencyV1Schema, lexeme: Text,
  signedMinorUnits: Integer.or("null"),
});
export const MailObservationV1Schema = type({
  "+": "reject", kind: "'company-money.mail-observation'", version: "1",
  provider: Provider, sourceRef: Text, contentDigest: Text,
  workLabelVerified: "true", receivedAt: Instant, companyNameMentioned: "boolean",
  subjectHints: Hints, amountCandidates: Amount.array(), dateCandidates: CalendarDateV1Schema.array(),
  attachments: type({ "+": "reject", format: Text, bytes: "number.integer >= 0", "digest?": Text }).array(),
  disposition: Disposition, countsTowardTotals: "false",
});
export const MailObservationSetV1Schema = type({
  "+": "reject", kind: "'company-money.mail-observation-set'", version: "1",
  scope: "'gmail-exact-work-label'", records: MailObservationV1Schema.array().atMostLength(1000),
});
export const MailReviewV1Schema = type({
  "+": "reject", kind: "'company-money.mail-review'", version: "1",
  status: "'available' | 'missing' | 'unavailable'",
  records: type({
    "+": "reject", provider: Provider, receivedAt: Instant, hints: Hints,
    disposition: Disposition, amounts: Amount.array(),
  }).array(),
});
export const mailReviewSchemaCatalog = {
  "company-money.mail-observation": { 1: MailObservationV1Schema },
  "company-money.mail-observation-set": { 1: MailObservationSetV1Schema },
  "company-money.mail-review": { 1: MailReviewV1Schema },
} as const;

export function createMailReview(input: unknown) {
  const set = MailObservationSetV1Schema.assert(input);
  return MailReviewV1Schema.assert({
    kind: "company-money.mail-review", version: 1, status: "available",
    records: [...set.records]
      .sort((a, b) => compareCodeUnits(b.receivedAt, a.receivedAt) || compareCodeUnits(a.sourceRef, b.sourceRef) || compareCodeUnits(a.contentDigest, b.contentDigest))
      .map(record => ({
        provider: record.provider, receivedAt: record.receivedAt,
        hints: record.subjectHints, disposition: record.disposition,
        amounts: record.companyNameMentioned && !["unresolved-account-ownership", "statement-ingested", "notification-ingested"].includes(record.disposition) && !record.subjectHints.includes("card") ? record.amountCandidates : [],
      })),
  });
}

export async function readMailReview(root: string): Promise<typeof MailReviewV1Schema.infer> {
  const unavailable = (status: "missing" | "unavailable") => MailReviewV1Schema.assert({
    kind: "company-money.mail-review", version: 1, status, records: [],
  });
  try {
    for (const path of [root, join(root, "state")]) {
      const info = await lstat(path);
      if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) return unavailable("unavailable");
    }
    const file = await open(join(root, "state", "work-mail-observations.v1.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      const limit = 4 * 1024 * 1024;
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > limit) return unavailable("unavailable");
      const bytes = Buffer.alloc(limit + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, null);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count > limit) return unavailable("unavailable");
      return createMailReview(JSON.parse(bytes.subarray(0, count).toString("utf8")));
    } finally { await file.close(); }
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
  }
}
