import { createRouterClient, implement } from "@orpc/server";

import { companyMoneyContract } from "./company-money-contract.ts";
import {
  ingestLedger,
  IngestConflictFailure,
  LedgerBusyFailure,
  type IngestDependencies,
} from "./ledger/ingest.ts";
import { reportLedger } from "./ledger/report.ts";
import { LedgerUnavailableFailure } from "./ledger/state.ts";

export function createCompanyMoneyRouter(dependencies: IngestDependencies) {
  const os = implement(companyMoneyContract);
  return os.router({
    ledger: {
      ingest: os.ledger.ingest.handler(async ({ input, errors }) => {
        try {
          return await ingestLedger(input, dependencies);
        } catch (error) {
          if (error instanceof IngestConflictFailure) {
            throw errors.INGEST_CONFLICT({ data: error.conflict });
          }
          if (error instanceof LedgerBusyFailure) throw errors.LEDGER_BUSY();
          if (error instanceof LedgerUnavailableFailure) {
            throw errors.LEDGER_UNAVAILABLE({ data: error.unavailable });
          }
          throw error;
        }
      }),
      report: os.ledger.report.handler(async ({ input, errors }) => {
        try {
          return await reportLedger(input, dependencies.store);
        } catch (error) {
          if (error instanceof LedgerUnavailableFailure) {
            throw errors.LEDGER_UNAVAILABLE({ data: error.unavailable });
          }
          throw error;
        }
      }),
    },
  });
}

export function createCompanyMoneyClient(dependencies: IngestDependencies) {
  return createRouterClient(createCompanyMoneyRouter(dependencies));
}
