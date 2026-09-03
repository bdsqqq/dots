#!/usr/bin/env node

import { runCompanyMoneyCli, type CompanyMoneyCliIO } from "./company-money-cli.ts";
import { createCompanyMoneyNode } from "./company-money-node.ts";

const io: CompanyMoneyCliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const argv = process.argv.slice(2);
const help = argv.length === 0 || (argv.length === 1 && argv[0] === "--help");
process.exitCode = await runCompanyMoneyCli({
  argv,
  runtime: help ? undefined : await createCompanyMoneyNode().catch(() => undefined),
  io,
});
