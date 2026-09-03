import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createCompanyMoneyClient } from "./company-money-router.ts";
import type {
  CompanyMoneyAdapter,
  CompanyMoneyCliRuntime,
} from "./company-money-cli.ts";
import {
  MAX_NUBANK_STATEMENT_BYTES,
  NubankStatementEnvelopeV1Schema,
  nubankStatementSchemaCatalog,
  translateNubankStatement,
} from "./evidence/nubank-statement.ts";
import {
  MAX_WISE_ENVELOPE_BYTES,
  translateWiseGmailEnvelope,
  wiseGmailSchemaCatalog,
} from "./evidence/wise-gmail.ts";
import { JsonlLedgerStore } from "./ledger/jsonl-store.ts";
import { NodeSha256Identity } from "./ledger/sha256-identity.ts";
import type { IngestResultV1 } from "./ledger/ingest.ts";
import type { ReportQueryV1, ReportV1 } from "./ledger/report.ts";
import {
  accountAliasForProvider,
  classifyEvidence,
  loadPrivateConfig,
  privateConfigSchemaCatalog,
  transferPolicy,
  type PrivateConfigV1,
} from "./private-config.ts";

export * from "./company-money-cli.ts";
export * from "./company-money-router.ts";
export * from "./evidence/nubank-statement.ts";
export * from "./evidence/wise-gmail.ts";
export * from "./ledger/jsonl-store.ts";
export * from "./ledger/sha256-identity.ts";
export * from "./private-config.ts";

export const COMPANY_MONEY_ROOT =
  "/Users/bdsqqq/commonplace/01_files/money/company-ledger";

export const companyMoneyNodeSchemaCatalog = {
  ...privateConfigSchemaCatalog,
  ...nubankStatementSchemaCatalog,
  ...wiseGmailSchemaCatalog,
} as const;

async function readPrivateInput(path: string, maxBytes: number): Promise<Buffer> {
  const resolved = resolve(path);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new Error("private input is unavailable");
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > maxBytes
  ) {
    throw new Error("private input is unavailable");
  }
  try {
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = await readFile(handle);
      if (bytes.length > maxBytes) throw new Error("private input is unavailable");
      return bytes;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("private input is unavailable");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

async function writeReport(rootPath: string, name: string, report: ReportV1): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) {
    throw new Error("report output name is invalid");
  }
  const root = await lstat(rootPath);
  if (root.isSymbolicLink() || !root.isDirectory() || (root.mode & 0o777) !== 0o700) {
    throw new Error("report output is unavailable");
  }
  const exportsPath = join(rootPath, "exports");
  try {
    await mkdir(exportsPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("report output is unavailable");
    }
  }
  const exportsInfo = await lstat(exportsPath);
  if (
    exportsInfo.isSymbolicLink() ||
    !exportsInfo.isDirectory() ||
    (exportsInfo.mode & 0o777) !== 0o700
  ) {
    throw new Error("report output is unavailable");
  }
  const destination = join(exportsPath, name);
  const temporary = join(exportsPath, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(`${stableJson(report)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    temporaryCreated = false;
    const directory = await open(exportsPath, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new Error("report output is unavailable");
  } finally {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class CompanyMoneyNodeRuntime implements CompanyMoneyCliRuntime {
  readonly identity = new NodeSha256Identity();
  readonly store: JsonlLedgerStore;
  readonly client: ReturnType<typeof createCompanyMoneyClient>;
  readonly rootPath: string;
  readonly config: PrivateConfigV1;

  constructor(rootPath: string, config: PrivateConfigV1) {
    this.rootPath = rootPath;
    this.config = config;
    this.store = new JsonlLedgerStore({ rootPath });
    this.client = createCompanyMoneyClient({
      identity: this.identity,
      store: this.store,
      transferPolicy: transferPolicy(config),
    });
  }

  async ingest(adapter: CompanyMoneyAdapter, inputPath: string): Promise<IngestResultV1> {
    if (adapter === "nubank-statement") {
      const csv = (await readPrivateInput(inputPath, MAX_NUBANK_STATEMENT_BYTES)).toString(
        "utf8",
      );
      const accountAlias = accountAliasForProvider(this.config, "nubank");
      const sourceRef = this.identity.digest("company-money/nubank-source/v1", [csv]);
      const envelope = NubankStatementEnvelopeV1Schema.assert({
        kind: "company-money.nubank-statement-envelope",
        version: 1,
        accountAlias,
        sourceRef,
        csv,
      });
      return this.client.ledger.ingest(
        translateNubankStatement(envelope, {
          entityId: this.config.entityId,
          accountAlias,
          identity: this.identity,
          classify: (facts) => classifyEvidence(this.config, facts),
        }),
      );
    }

    const bytes = await readPrivateInput(inputPath, MAX_WISE_ENVELOPE_BYTES);
    const accountAlias = accountAliasForProvider(this.config, "wise");
    let envelope: unknown;
    try {
      envelope = JSON.parse(bytes.toString("utf8"));
    } catch {
      envelope = {
        malformedEnvelopeDigest: this.identity.digest("company-money/wise-input/v1", [
          bytes.toString("utf8"),
        ]),
      };
    }
    const result = await this.client.ledger.ingest(
      translateWiseGmailEnvelope(envelope, {
        entityId: this.config.entityId,
        accountAlias,
        identity: this.identity,
        classify: (facts, suggested) => classifyEvidence(this.config, facts, suggested),
      }),
    );
    await rm(resolve(inputPath));
    return result;
  }

  async report(query: ReportQueryV1, outputName?: string): Promise<ReportV1> {
    const report = await this.client.ledger.report(query);
    if (outputName) await writeReport(this.rootPath, outputName, report);
    return report;
  }
}

export async function createCompanyMoneyNode(
  rootPath = COMPANY_MONEY_ROOT,
): Promise<CompanyMoneyNodeRuntime> {
  return new CompanyMoneyNodeRuntime(
    rootPath,
    await loadPrivateConfig(join(rootPath, "config.json")),
  );
}
