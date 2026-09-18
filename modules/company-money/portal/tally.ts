import { type } from "arktype";
import { join } from "node:path";
import { JsonlLedgerStore } from "../ledger/jsonl-store.ts";
import type { LedgerSnapshotV1 } from "../ledger/state.ts";
import { displayAlias, loadPrivateConfig, type PrivateConfigV1 } from "../private-config.ts";
import { ISO_CURRENCY_MINOR_UNITS, IsoCurrencyV1Schema, CalendarDateV1Schema, compareCodeUnits, type IsoCurrency } from "../money.ts";
import { MailReviewV1Schema, readMailReview } from "./mail-review.ts";

const Integer = type("number.safe & number.integer");
export const TallyV2Schema = type({
  "+": "reject",
  kind: "'company-money.tally'",
  version: "2",
  entity: "string",
  revision: "string",
  mail: MailReviewV1Schema,
  currencies: type({
    "+": "reject", currency: IsoCurrencyV1Schema, decimals: "0 | 2",
    incoming: Integer, outgoing: Integer, net: Integer,
  }).array(),
  transactions: type({
    "+": "reject", date: CalendarDateV1Schema, provider: "'nubank' | 'wise'", description: "string", currency: IsoCurrencyV1Schema,
    amount: Integer, status: "'pending' | 'completed' | 'failed' | 'cancelled'", classification: "'revenue' | 'expense' | 'owner-funding' | 'cashback' | 'internal-transfer' | 'unresolved'",
  }).array(),
});

export function createTally(snapshot: LedgerSnapshotV1, revision: string, config: PrivateConfigV1, mail: typeof MailReviewV1Schema.infer = { kind: "company-money.mail-review", version: 1, status: "missing", records: [] }) {
  const transactions = snapshot.transactions
    .filter((t) => t.entityId === config.entityId && config.accounts.some(a => a.provider === t.provider && a.alias === t.accountAlias))
    .sort((a, b) => compareCodeUnits(b.bookedOn, a.bookedOn) || compareCodeUnits(a.id, b.id))
    .map((t) => ({
      date: t.bookedOn,
      provider: t.provider,
      description: t.normalizedCounterparty ? displayAlias(config, t.normalizedCounterparty) : (t.normalizedReference ?? "—"),
      currency: t.money.currency,
      amount: t.money.minorUnits * (t.direction === "incoming" ? 1 : -1),
      status: t.status,
      classification: t.classification.value === "unclassified" || t.classification.confidence === "tentative" ? "unresolved" : t.classification.value,
    }));
  const currencies = [...new Set(transactions.map((t) => t.currency))].sort().map((currency) => {
    let incoming = 0;
    let outgoing = 0;
    for (const t of transactions) {
      if (t.currency !== currency || t.status !== "completed") continue;
      if (t.amount > 0) incoming += t.amount;
      else outgoing -= t.amount;
      if (!Number.isSafeInteger(incoming) || !Number.isSafeInteger(outgoing)) throw new Error("tally unavailable");
    }
    return { currency, decimals: ISO_CURRENCY_MINOR_UNITS[currency as IsoCurrency], incoming, outgoing, net: incoming - outgoing };
  });
  return TallyV2Schema.assert({ kind: "company-money.tally", version: 2, entity: displayAlias(config, config.entityId), revision, currencies, transactions, mail });
}

export async function readTally(root: string) {
  const config = await loadPrivateConfig(join(root, "config.json"));
  const { snapshot, revision } = await new JsonlLedgerStore({ rootPath: root }).read();
  if (revision === null) throw new Error("tally unavailable");
  return createTally(snapshot, revision, config, await readMailReview(root));
}
