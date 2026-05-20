#!/usr/bin/env node
import { spawnSync } from "node:child_process";

export interface ZmxRow {
  name: string;
  clients: string;
  pid: string;
  created: string;
  startDir: string;
  details: Record<string, string>;
}

const KEY_ALIASES = {
  session_name: "name",
  started_in: "start_dir",
} as const;

const KNOWN_KEYS = new Set([
  "name",
  "session_name",
  "pid",
  "clients",
  "created",
  "start_dir",
  "started_in",
]);

const PREFIX_BEFORE_KNOWN_KEY = /.*?\b(name|session_name)=/;

type KnownKey = keyof typeof KEY_ALIASES | "name" | "pid" | "clients" | "created" | "start_dir";

function normalizeKey(key: string): string {
  return KEY_ALIASES[key as keyof typeof KEY_ALIASES] ?? key;
}

function stripPrefixBeforeKnownKey(field: string): string {
  return field.replace(PREFIX_BEFORE_KNOWN_KEY, "$1=");
}

export function parseZmxList(output: string): ZmxRow[] {
  return output
    .split("\n")
    .map((line) => parseZmxListLine(line))
    .filter((row): row is ZmxRow => row !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseZmxListLine(line: string): ZmxRow | undefined {
  const details: Record<string, string> = {};

  for (const rawField of line.split("\t")) {
    const field = stripPrefixBeforeKnownKey(rawField.trim());
    const separator = field.indexOf("=");
    if (separator === -1) continue;

    const rawKey = field.slice(0, separator);
    if (!KNOWN_KEYS.has(rawKey)) continue;

    const key = normalizeKey(rawKey) as KnownKey;
    details[key] = field.slice(separator + 1);
  }

  if (!details.name) return undefined;

  return {
    name: details.name,
    clients: details.clients ?? "?",
    pid: details.pid ?? "?",
    created: details.created ?? "",
    startDir: details.start_dir ?? "",
    details,
  };
}

export function formatZmxRows(rows: readonly ZmxRow[]): string {
  return rows
    .map((row) =>
      [
        row.name,
        `clients:${row.clients}`,
        `pid:${row.pid}`,
        `created:${row.created}`,
        row.startDir,
      ].join("\t"),
    )
    .join("\n");
}

export function zmxRowsFromListOutput(output: string): string {
  const rows = formatZmxRows(parseZmxList(output));
  return rows ? `${rows}\n` : "";
}

if (import.meta.main) {
  const result = spawnSync("zmx", ["list"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.stdout.write(zmxRowsFromListOutput(result.stdout));
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("zmxRowsFromListOutput", () => {
    it("parses name output", () => {
      expect(
        zmxRowsFromListOutput(
          "name=nix\tpid=123\tclients=0\tcreated=177\tstart_dir=/repo\n",
        ),
      ).toBe("nix\tclients:0\tpid:123\tcreated:177\t/repo\n");
    });

    it("parses session_name output", () => {
      expect(
        zmxRowsFromListOutput(
          "session_name=nix.build\tpid=456\tclients=0\tcreated=178\tstarted_in=/tmp\n",
        ),
      ).toBe("nix.build\tclients:0\tpid:456\tcreated:178\t/tmp\n");
    });

    it("strips leading spaces before known keys", () => {
      expect(
        zmxRowsFromListOutput(
          "  name=mbp-m2\tpid=1\tclients=0\tcreated=179\tstart_dir=/home\n",
        ),
      ).toBe("mbp-m2\tclients:0\tpid:1\tcreated:179\t/home\n");
    });

    it("strips leading glyphs before known keys", () => {
      expect(
        zmxRowsFromListOutput(
          "→ name=nix\tpid=2\tclients=0\tcreated=180\tstart_dir=/repo\n",
        ),
      ).toBe("nix\tclients:0\tpid:2\tcreated:180\t/repo\n");
    });

    it("preserves nested names and client counts", () => {
      expect(
        zmxRowsFromListOutput(
          "→ name=nix.list\tpid=34359\tclients=1\tcreated=1777303536\tstart_dir=/Users/bdsqqq/commonplace/01_files/nix\n",
        ),
      ).toBe(
        "nix.list\tclients:1\tpid:34359\tcreated:1777303536\t/Users/bdsqqq/commonplace/01_files/nix\n",
      );
    });
  });
}
