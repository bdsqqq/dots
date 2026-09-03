import { oc } from "@orpc/contract";
import { type } from "arktype";

import {
  CalendarDateV1Schema,
  IsoCurrencyV1Schema,
  compareCodeUnits,
} from "../money.ts";
import {
  LedgerUnavailableFailure,
  LedgerUnavailableV1Schema,
  type LedgerSnapshotV1,
} from "./state.ts";

const NonNegativeSafeIntegerV1Schema = type("number.safe & number.integer").narrow(
  (value, context) => value >= 0 || context.mustBe("a non-negative safe integer"),
);

export const ReportQueryV1Schema = type({
  "+": "reject",
  kind: "'company-money.report-query'",
  version: "1",
  from: CalendarDateV1Schema,
  through: CalendarDateV1Schema,
}).narrow(
  (query, context) =>
    query.from <= query.through || context.mustBe("an inclusive non-reversed date interval"),
);

export const CurrencySummaryV1Schema = type({
  "+": "reject",
  kind: "'company-money.currency-summary'",
  version: "1",
  currency: IsoCurrencyV1Schema,
  receiptsMinorUnits: NonNegativeSafeIntegerV1Schema,
  revenueMinorUnits: NonNegativeSafeIntegerV1Schema,
  outgoingMinorUnits: NonNegativeSafeIntegerV1Schema,
  expenseMinorUnits: NonNegativeSafeIntegerV1Schema,
  ownerFundingMinorUnits: NonNegativeSafeIntegerV1Schema,
  cashbackMinorUnits: NonNegativeSafeIntegerV1Schema,
  internalTransferMinorUnits: NonNegativeSafeIntegerV1Schema,
  failedCount: NonNegativeSafeIntegerV1Schema,
  cancelledCount: NonNegativeSafeIntegerV1Schema,
  unresolvedCount: NonNegativeSafeIntegerV1Schema,
  unlinkedInternalTransferCount: NonNegativeSafeIntegerV1Schema,
});

const ReportDiagnosticsV1Schema = type({
  "+": "reject",
  transactionCount: NonNegativeSafeIntegerV1Schema,
  quarantineCount: NonNegativeSafeIntegerV1Schema,
  unresolvedCount: NonNegativeSafeIntegerV1Schema,
  unlinkedInternalTransferCount: NonNegativeSafeIntegerV1Schema,
});

export const ReportV1Schema = type({
  "+": "reject",
  kind: "'company-money.report'",
  version: "1",
  query: ReportQueryV1Schema,
  sourceRevision: "string | null",
  currencies: CurrencySummaryV1Schema.array(),
  diagnostics: ReportDiagnosticsV1Schema,
});

export type ReportQueryV1 = typeof ReportQueryV1Schema.infer;
export type CurrencySummaryV1 = typeof CurrencySummaryV1Schema.infer;
export type ReportV1 = typeof ReportV1Schema.infer;

export const ledgerReportSchemaCatalog = {
  "company-money.report-query": { 1: ReportQueryV1Schema },
  "company-money.currency-summary": { 1: CurrencySummaryV1Schema },
  "company-money.report": { 1: ReportV1Schema },
} as const;

export const ledgerReportContract = oc
  .input(ReportQueryV1Schema)
  .output(ReportV1Schema)
  .errors({
    LEDGER_UNAVAILABLE: { data: LedgerUnavailableV1Schema },
  });

export interface ReportLedgerReader {
  read(): Promise<{
    readonly revision: string | null;
    readonly snapshot: LedgerSnapshotV1;
  }>;
}

function initialSummary(currency: string): CurrencySummaryV1 {
  return {
    kind: "company-money.currency-summary",
    version: 1,
    currency,
    receiptsMinorUnits: 0,
    revenueMinorUnits: 0,
    outgoingMinorUnits: 0,
    expenseMinorUnits: 0,
    ownerFundingMinorUnits: 0,
    cashbackMinorUnits: 0,
    internalTransferMinorUnits: 0,
    failedCount: 0,
    cancelledCount: 0,
    unresolvedCount: 0,
    unlinkedInternalTransferCount: 0,
  };
}

export function createReport(
  query: ReportQueryV1,
  revision: string | null,
  snapshot: LedgerSnapshotV1,
): ReportV1 {
  const summaries = new Map<string, CurrencySummaryV1>();
  const linked = new Set(
    snapshot.transferLinks.flatMap((entry) => [
      entry.outgoingTransactionId,
      entry.incomingTransactionId,
    ]),
  );
  const inRange = snapshot.transactions.filter(
    (transaction) =>
      transaction.bookedOn >= query.from && transaction.bookedOn <= query.through,
  );
  for (const transaction of inRange) {
    const currency = transaction.money.currency;
    const summary = summaries.get(currency) ?? initialSummary(currency);
    summaries.set(currency, summary);
    if (transaction.status === "failed") {
      summary.failedCount += 1;
      continue;
    }
    if (transaction.status === "cancelled") {
      summary.cancelledCount += 1;
      continue;
    }
    if (transaction.status !== "completed") continue;

    const classification = transaction.classification;
    const unresolved =
      classification.value === "unclassified" || classification.confidence === "tentative";
    if (unresolved) {
      summary.unresolvedCount += 1;
    }
    if (
      transaction.direction === "incoming" &&
      !unresolved &&
      !["owner-funding", "cashback", "internal-transfer"].includes(classification.value)
    ) {
      summary.receiptsMinorUnits += transaction.money.minorUnits;
    }
    if (
      transaction.direction === "incoming" &&
      classification.value === "revenue" &&
      classification.confidence !== "tentative"
    ) {
      summary.revenueMinorUnits += transaction.money.minorUnits;
    }
    if (
      transaction.direction === "outgoing" &&
      classification.value !== "internal-transfer" &&
      !linked.has(transaction.id)
    ) {
      summary.outgoingMinorUnits += transaction.money.minorUnits;
    }
    if (transaction.direction === "outgoing" && classification.value === "expense") {
      summary.expenseMinorUnits += transaction.money.minorUnits;
    }
    if (transaction.direction === "incoming" && classification.value === "owner-funding") {
      summary.ownerFundingMinorUnits += transaction.money.minorUnits;
    }
    if (transaction.direction === "incoming" && classification.value === "cashback") {
      summary.cashbackMinorUnits += transaction.money.minorUnits;
    }
    if (classification.value === "internal-transfer") {
      summary.internalTransferMinorUnits += transaction.money.minorUnits;
      if (!linked.has(transaction.id)) summary.unlinkedInternalTransferCount += 1;
    }
  }

  const currencies = [...summaries.values()].sort((left, right) =>
    compareCodeUnits(left.currency, right.currency),
  );
  return {
    kind: "company-money.report",
    version: 1,
    query,
    sourceRevision: revision,
    currencies,
    diagnostics: {
      transactionCount: inRange.length,
      quarantineCount: snapshot.quarantine.length,
      unresolvedCount: currencies.reduce((sum, entry) => sum + entry.unresolvedCount, 0),
      unlinkedInternalTransferCount: currencies.reduce(
        (sum, entry) => sum + entry.unlinkedInternalTransferCount,
        0,
      ),
    },
  };
}

export async function reportLedger(
  query: ReportQueryV1,
  reader: ReportLedgerReader,
): Promise<ReportV1> {
  try {
    const current = await reader.read();
    return createReport(query, current.revision, current.snapshot);
  } catch (error) {
    const candidate =
      typeof error === "object" && error !== null
        ? (error as { ledgerUnavailableReason?: unknown }).ledgerUnavailableReason
        : undefined;
    const reason =
      candidate === "unreadable" ||
      candidate === "corrupt" ||
      candidate === "future-version" ||
      candidate === "uncommittable"
        ? candidate
        : "unreadable";
    throw new LedgerUnavailableFailure({
      kind: "company-money.ledger-unavailable",
      version: 1,
      reason,
    });
  }
}
