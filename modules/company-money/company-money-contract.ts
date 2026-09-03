import { oc, type ContractRouterClient } from "@orpc/contract";

import { ledgerIngestContract } from "./ledger/ingest.ts";
import { ledgerReportContract } from "./ledger/report.ts";

export const companyMoneyContract = oc.router({
  ledger: {
    ingest: ledgerIngestContract,
    report: ledgerReportContract,
  },
});

export type CompanyMoneyClient = ContractRouterClient<typeof companyMoneyContract>;
