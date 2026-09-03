import type { IngestResultV1 } from "./ledger/ingest.ts";
import { ReportQueryV1Schema, type ReportV1 } from "./ledger/report.ts";

export type CompanyMoneyAdapter = "nubank-statement" | "wise-gmail";

export interface CompanyMoneyCliRuntime {
  ingest(adapter: CompanyMoneyAdapter, inputPath: string): Promise<IngestResultV1>;
  report(query: typeof ReportQueryV1Schema.infer, outputName?: string): Promise<ReportV1>;
}

export interface CompanyMoneyCliIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface RunCompanyMoneyCliOptions {
  readonly argv: readonly string[];
  readonly runtime?: CompanyMoneyCliRuntime;
  readonly io: CompanyMoneyCliIO;
  readonly programName?: string;
}

function usage(programName: string): string {
  return [
    `Usage: ${programName} <command>`,
    "",
    "Commands:",
    `  ingest --adapter <nubank-statement|wise-gmail> --input <path>`,
    `  report --from <date> --through <date> --json [--output <name.json>]`,
    "",
    "source collection is external, bounded, read-only, and manually invoked.",
    "",
  ].join("\n");
}

function optionValue(argv: readonly string[], name: string): string | null {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length !== 1) return null;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function hasOnlyOptions(argv: readonly string[], options: readonly string[]): boolean {
  const values = new Set(options);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!values.has(value)) return false;
    if (value !== "--json") index += 1;
  }
  return true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export async function runCompanyMoneyCli(
  options: RunCompanyMoneyCliOptions,
): Promise<number> {
  const programName = options.programName ?? "company-money";
  if (
    options.argv.length === 0 ||
    (options.argv.length === 1 && options.argv[0] === "--help")
  ) {
    options.io.stdout(usage(programName));
    return 0;
  }
  if (!options.runtime) {
    options.io.stderr("local company-money runtime is unavailable\n");
    return 1;
  }

  const [command, ...argv] = options.argv;
  try {
    if (command === "ingest") {
      if (!hasOnlyOptions(argv, ["--adapter", "--input"])) {
        options.io.stderr("invalid ingest arguments\n");
        return 2;
      }
      const adapter = optionValue(argv, "--adapter");
      const inputPath = optionValue(argv, "--input");
      if (
        (adapter !== "nubank-statement" && adapter !== "wise-gmail") ||
        inputPath === null
      ) {
        options.io.stderr("ingest requires one supported adapter and one input\n");
        return 2;
      }
      const result = await options.runtime.ingest(adapter, inputPath);
      options.io.stdout(
        `${stableJson({
          conflictCount: result.conflictCount,
          duplicateCount: result.duplicateCount,
          insertedCount: result.insertedCount,
          linkCount: result.linkCount,
          quarantineCount: result.quarantineCount,
        })}\n`,
      );
      return 0;
    }
    if (command === "report") {
      if (!hasOnlyOptions(argv, ["--from", "--through", "--json", "--output"])) {
        options.io.stderr("invalid report arguments\n");
        return 2;
      }
      const from = optionValue(argv, "--from");
      const through = optionValue(argv, "--through");
      const outputName = optionValue(argv, "--output");
      if (
        from === null ||
        through === null ||
        !argv.includes("--json") ||
        (argv.includes("--output") &&
          (outputName === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(outputName)))
      ) {
        options.io.stderr("report requires --from, --through, and --json\n");
        return 2;
      }
      const query = ReportQueryV1Schema.assert({
        kind: "company-money.report-query",
        version: 1,
        from,
        through,
      });
      options.io.stdout(
        `${stableJson(await options.runtime.report(query, outputName ?? undefined))}\n`,
      );
      return 0;
    }
    options.io.stderr(`unknown command\n\n${usage(programName)}`);
    return 2;
  } catch {
    options.io.stderr("company-money operation failed\n");
    return 1;
  }
}
