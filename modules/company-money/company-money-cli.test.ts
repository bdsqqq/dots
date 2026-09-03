import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runCompanyMoneyCli,
  type CompanyMoneyCliIO,
  type CompanyMoneyCliRuntime,
} from "./company-money-cli.ts";
import { CompanyMoneyNodeRuntime } from "./company-money-node.ts";
import type { IngestResultV1 } from "./ledger/ingest.ts";
import type { ReportV1 } from "./ledger/report.ts";
import type { PrivateConfigV1 } from "./private-config.ts";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CompanyMoneyCliIO = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { io, stdout, stderr };
}

const result: IngestResultV1 = {
  kind: "company-money.ingest-result",
  version: 1,
  committedRevision: "private-revision",
  insertedCount: 1,
  duplicateCount: 2,
  conflictCount: 0,
  quarantineCount: 3,
  linkCount: 4,
};

const report: ReportV1 = {
  kind: "company-money.report",
  version: 1,
  query: {
    kind: "company-money.report-query",
    version: 1,
    from: "2026-01-01",
    through: "2026-01-31",
  },
  sourceRevision: "private-revision",
  currencies: [],
  diagnostics: {
    transactionCount: 0,
    quarantineCount: 0,
    unresolvedCount: 0,
    unlinkedInternalTransferCount: 0,
  },
};

test("help is non-mutating and command parsing is exact", async () => {
  let invoked = false;
  const runtime: CompanyMoneyCliRuntime = {
    ingest: async () => {
      invoked = true;
      return result;
    },
    report: async () => {
      invoked = true;
      return report;
    },
  };
  const output = capture();
  assert.equal(
    await runCompanyMoneyCli({ argv: ["--help"], runtime, io: output.io }),
    0,
  );
  assert.equal(invoked, false);
  assert.match(output.stdout[0], /nubank-statement\|wise-gmail/);

  const invalid = capture();
  assert.equal(
    await runCompanyMoneyCli({
      argv: ["ingest", "--adapter", "wise-gmail", "--input", "x", "extra"],
      runtime,
      io: invalid.io,
    }),
    2,
  );
  assert.equal(invoked, false);
});

test("default ingest output contains sanitized counts only", async () => {
  const output = capture();
  const runtime: CompanyMoneyCliRuntime = {
    ingest: async () => result,
    report: async () => report,
  };
  assert.equal(
    await runCompanyMoneyCli({
      argv: ["ingest", "--adapter", "wise-gmail", "--input", "SYNTHETIC-PRIVATE-PATH"],
      runtime,
      io: output.io,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    conflictCount: 0,
    duplicateCount: 2,
    insertedCount: 1,
    linkCount: 4,
    quarantineCount: 3,
  });
  assert.doesNotMatch(output.stdout[0], /private-revision|SYNTHETIC-PRIVATE-PATH/);
});

test("reports require an explicit valid interval and json opt-in", async () => {
  const runtime: CompanyMoneyCliRuntime = {
    ingest: async () => result,
    report: async () => report,
  };
  const missing = capture();
  assert.equal(
    await runCompanyMoneyCli({
      argv: ["report", "--from", "2026-01-01", "--through", "2026-01-31"],
      runtime,
      io: missing.io,
    }),
    2,
  );
  const reversed = capture();
  assert.equal(
    await runCompanyMoneyCli({
      argv: [
        "report",
        "--from",
        "2026-02-01",
        "--through",
        "2026-01-01",
        "--json",
      ],
      runtime,
      io: reversed.io,
    }),
    1,
  );
});

function privateConfig(): PrivateConfigV1 {
  return {
    kind: "company-money.private-config",
    version: 1,
    entityId: "Example Widgets Ltd.",
    accounts: [
      { alias: "operating", provider: "nubank" },
      { alias: "reserve", provider: "wise" },
    ],
    entityAliases: [],
    ownerFundingRules: [],
    internalTransferRules: [],
    classificationRules: [],
  };
}

test("node runtime removes each bounded Wise envelope only after a durable result", async () => {
  const parent = await mkdtemp(join(tmpdir(), "company-money-cli-"));
  const root = join(parent, "ledger");
  await mkdir(root, { mode: 0o700 });
  try {
    const runtime = new CompanyMoneyNodeRuntime(root, privateConfig());
    const value = {
      kind: "company-money.wise-gmail-envelope",
      version: 1,
      accountAlias: "reserve",
      messages: [
        {
          sourceRef: "synthetic-message",
          receivedAt: "2026-01-10T12:00:00Z",
          subject: "Wise: received",
          body: [
            "transaction-id: synthetic-wise-1",
            "date: 2026-01-10",
            "amount: 1.00",
            "currency: BRL",
          ].join("\n"),
        },
      ],
    };
    for (const [index, expected] of [1, 0].entries()) {
      const input = join(root, `envelope-${index}.json`);
      await writeFile(input, JSON.stringify(value), { mode: 0o600 });
      assert.equal((await runtime.ingest("wise-gmail", input)).insertedCount, expected);
      await assert.rejects(() => lstat(input), { code: "ENOENT" });
    }

    const retained = join(root, "retained.json");
    await writeFile(retained, JSON.stringify(value), { mode: 0o644 });
    await assert.rejects(() => runtime.ingest("wise-gmail", retained));
    assert.ok(await lstat(retained));

    const query = {
      kind: "company-money.report-query" as const,
      version: 1 as const,
      from: "2026-01-01",
      through: "2026-01-31",
    };
    const exported = await runtime.report(query, "january.json");
    const exportPath = join(root, "exports", "january.json");
    assert.deepEqual(JSON.parse(await readFile(exportPath, "utf8")), exported);
    assert.equal((await lstat(exportPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(root, "exports")), ["january.json"]);
    await assert.rejects(() => runtime.report(query, "../escape.json"), /invalid/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("node runtime ingests the observed Nubank shape without deleting primary evidence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "company-money-nubank-cli-"));
  const root = join(parent, "ledger");
  const input = join(parent, "statement.csv");
  await mkdir(root, { mode: 0o700 });
  await writeFile(
    input,
    "Data, Valor, Identificador, Descrição\n10/01/2026,12.34,synthetic-1,Synthetic receipt\n",
    { mode: 0o600 },
  );
  try {
    const runtime = new CompanyMoneyNodeRuntime(root, privateConfig());
    assert.deepEqual(
      await runtime.ingest("nubank-statement", input),
      {
        kind: "company-money.ingest-result",
        version: 1,
        committedRevision: (await runtime.store.read()).revision,
        insertedCount: 1,
        duplicateCount: 0,
        conflictCount: 0,
        quarantineCount: 0,
        linkCount: 0,
      },
    );
    assert.equal((await runtime.ingest("nubank-statement", input)).duplicateCount, 1);
    assert.ok(await lstat(input));

    const reported = await runtime.report({
      kind: "company-money.report-query",
      version: 1,
      from: "2026-01-01",
      through: "2026-01-31",
    });
    assert.equal(reported.currencies[0].currency, "BRL");
    assert.equal(reported.currencies[0].receiptsMinorUnits, 0);
    assert.equal(reported.diagnostics.transactionCount, 1);
    assert.equal(reported.diagnostics.unresolvedCount, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
