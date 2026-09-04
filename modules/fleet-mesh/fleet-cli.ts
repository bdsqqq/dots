import { traverseContractProcedures } from "@orpc/server";

import {
  fleetContract,
  type FleetClient,
  type FleetOperationMetadata,
} from "./fleet-public.ts";

interface ProjectedOperation {
  path: readonly string[];
  metadata: Required<Pick<FleetOperationMetadata, "id" | "version" | "summary" | "cli">>;
}

export interface FleetCliIO {
  stdin?(): Promise<string>;
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface RunFleetCliOptions {
  argv: readonly string[];
  client?: FleetClient;
  io: FleetCliIO;
  programName?: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationMetadata(
  path: readonly string[],
  value: unknown,
): ProjectedOperation["metadata"] {
  if (typeof value !== "object" || value === null) {
    throw new Error(`operation ${path.join(".")} has no metadata`);
  }
  const metadata = value as FleetOperationMetadata;
  if (
    metadata.id !== path.join(".") ||
    metadata.version !== 1 ||
    typeof metadata.summary !== "string" ||
    !metadata.cli ||
    (metadata.cli.input !== "none" &&
      metadata.cli.input !== "scalar" &&
      metadata.cli.input !== "json") ||
    (metadata.cli.input === "scalar" && typeof metadata.cli.argument !== "string")
  ) {
    throw new Error(`operation ${path.join(".")} has incomplete CLI metadata`);
  }
  return metadata as ProjectedOperation["metadata"];
}

/**
 * oRPC's exported traversal helper and documented `~orpc.meta` definition are
 * the only reflection surface used here. The CLI must stop rather than grow a
 * second operation registry if that public surface becomes insufficient.
 */
export function projectFleetOperations(): readonly ProjectedOperation[] {
  const operations: ProjectedOperation[] = [];
  traverseContractProcedures(
    { router: fleetContract, path: [] },
    ({ contract, path }) => {
      operations.push({
        path: [...path],
        metadata: operationMetadata(path, contract["~orpc"].meta),
      });
    },
  );
  return operations.sort((left, right) =>
    compareCodeUnits(left.metadata.id, right.metadata.id),
  );
}

function clientProcedure(
  client: FleetClient,
  path: readonly string[],
): (input?: unknown) => Promise<unknown> {
  let current: unknown = client;
  for (const segment of path) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      throw new Error(`local client is missing operation ${path.join(".")}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "function") {
    throw new Error(`local client operation ${path.join(".")} is not callable`);
  }
  return current as (input?: unknown) => Promise<unknown>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function commandUsage(programName: string, operation: ProjectedOperation): string {
  const argument =
    operation.metadata.cli.input === "scalar"
      ? ` <${operation.metadata.cli.argument}>`
      : "";
  const input =
    operation.metadata.cli.input === "json"
      ? ["", "Input:", "  exact JSON on stdin"]
      : [];
  return [
    `Usage: ${programName} ${operation.path.join(" ")}${argument} [--json]`,
    "",
    operation.metadata.summary,
    ...input,
    "",
    "Options:",
    "  --json  emit one stable JSON document",
    "  --help  show command help",
    "",
  ].join("\n");
}

function rootUsage(programName: string, operations: readonly ProjectedOperation[]): string {
  const commands = operations.map((operation) => {
    const argument =
      operation.metadata.cli.input === "scalar"
        ? ` <${operation.metadata.cli.argument}>`
        : operation.metadata.cli.input === "json"
          ? " <json-stdin>"
        : "";
    return `  ${operation.path.join(" ")}${argument}  ${operation.metadata.summary}`;
  });
  return [
    `Usage: ${programName} <command> [--json]`,
    "",
    "Commands:",
    ...commands,
    "",
    "Options:",
    "  --json  emit one stable JSON document",
    "  --help  show help",
    "",
  ].join("\n");
}

function findOperation(
  argv: readonly string[],
  operations: readonly ProjectedOperation[],
): ProjectedOperation | undefined {
  return operations.find((operation) =>
    operation.path.every((segment, index) => argv[index] === segment),
  );
}

export async function runFleetCli(options: RunFleetCliOptions): Promise<number> {
  const programName = options.programName ?? "fleet";
  const operations = projectFleetOperations();
  if (options.argv.length === 0 || (options.argv.length === 1 && options.argv[0] === "--help")) {
    options.io.stdout(rootUsage(programName, operations));
    return 0;
  }

  const operation = findOperation(options.argv, operations);
  if (!operation) {
    options.io.stderr(`unknown command\n\n${rootUsage(programName, operations)}`);
    return 2;
  }

  const rest = options.argv.slice(operation.path.length);
  const delimiter = rest.indexOf("--");
  const optionArguments = delimiter === -1 ? rest : rest.slice(0, delimiter);
  const escapedPositionals = delimiter === -1 ? [] : rest.slice(delimiter + 1);
  if (optionArguments.includes("--help")) {
    if (optionArguments.some((value) => value !== "--help") || escapedPositionals.length > 0) {
      options.io.stderr(`--help cannot be combined with command arguments\n`);
      return 2;
    }
    options.io.stdout(commandUsage(programName, operation));
    return 0;
  }

  const jsonFlags = optionArguments.filter((value) => value === "--json").length;
  if (jsonFlags > 1) {
    options.io.stderr(`--json may be specified only once\n`);
    return 2;
  }
  const unescapedPositionals = optionArguments.filter((value) => value !== "--json");
  const unknownOption = unescapedPositionals.find((value) => value.startsWith("-"));
  if (unknownOption) {
    options.io.stderr(`unknown option: ${unknownOption}\n`);
    return 2;
  }
  const positional = [...unescapedPositionals, ...escapedPositionals];

  if (operation.metadata.cli.input === "none" && positional.length !== 0) {
    options.io.stderr(`${operation.metadata.id} accepts no input\n`);
    return 2;
  }
  if (operation.metadata.cli.input === "scalar" && positional.length !== 1) {
    options.io.stderr(
      `${operation.metadata.id} requires exactly one <${operation.metadata.cli.argument}>\n`,
    );
    return 2;
  }
  if (operation.metadata.cli.input === "json" && positional.length !== 0) {
    options.io.stderr(`${operation.metadata.id} reads JSON from stdin\n`);
    return 2;
  }

  try {
    if (!options.client) throw new Error("local client is required to invoke a command");
    const procedure = clientProcedure(options.client, operation.path);
    let result: unknown;
    if (operation.metadata.cli.input === "none") {
      result = await procedure();
    } else if (operation.metadata.cli.input === "scalar") {
      result = await procedure(positional[0]);
    } else {
      if (!options.io.stdin) throw new Error("JSON stdin is unavailable");
      const source = await options.io.stdin();
      let input: unknown;
      try {
        input = JSON.parse(source);
      } catch {
        throw new Error("stdin must contain valid JSON");
      }
      result = await procedure(input);
    }
    const stable = stableValue(result);
    options.io.stdout(
      jsonFlags === 1 ? `${JSON.stringify(stable)}\n` : `${JSON.stringify(stable, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    options.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
