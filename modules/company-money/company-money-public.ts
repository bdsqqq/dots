export * from "./company-money-contract.ts";
export * from "./ledger/ingest.ts";
export * from "./ledger/link-transfers.ts";
export * from "./ledger/report.ts";
export * from "./ledger/state.ts";
export * from "./money.ts";

import { ledgerIngestSchemaCatalog } from "./ledger/ingest.ts";
import { ledgerReportSchemaCatalog } from "./ledger/report.ts";
import { ledgerStateSchemaCatalog } from "./ledger/state.ts";
import { moneySchemaCatalog } from "./money.ts";

export const companyMoneySchemaCatalog = {
  ...moneySchemaCatalog,
  ...ledgerStateSchemaCatalog,
  ...ledgerIngestSchemaCatalog,
  ...ledgerReportSchemaCatalog,
} as const;
