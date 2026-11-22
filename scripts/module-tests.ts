/**
 * runs the repo's module tests, which no flake check or workflow ran before,
 * so they broke unnoticed. modules/pi is excluded: it has its own suite.
 *
 * a directory with a package.json and pnpm lockfile is a package: it gets a
 * frozen install, then its `test` script, or `node --test` on its test files
 * when it has none. every other tracked test file runs with `node --test`. a test is selected unless EXCLUDED names it with a
 * reason, so a new test runs in CI by default.
 *
 *   node --experimental-strip-types scripts/module-tests.ts [--list]
 */

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TEST_FILE = /\.test\.(ts|mts|mjs|js)$/u;

/** path prefix → why this harness can't run it. */
export const EXCLUDED: Record<string, string> = {
  "modules/pi/": "has its own vitest suite and CI job",
  "modules/html-stuff/": "bun tests; run with `bun test`",
  "modules/tailnet-registry/": "bun tests; built by checks.tailnet-registry",
  "modules/node-pnpm/runtime.test.ts":
    "fixture pkgs lacks stdenv.hostPlatform; fails on main since 632bf51d",
  "scripts/check-credential-ownership.test.ts":
    "built by checks.credential-ownership, which provides python",
  "modules/household-intake/smb-audit.test.mjs":
    "built by checks.household-intake-smb-audit on darwin",
};

const excluded = (file: string): boolean =>
  Object.keys(EXCLUDED).some((prefix) => file.startsWith(prefix));

export type Suite =
  | { kind: "package"; dir: string; files: string[] }
  | { kind: "file"; file: string };

/** the nearest ancestor with a package.json and a pnpm lockfile. */
function owningPackage(
  file: string,
  isPackage: (dir: string) => boolean,
): string | undefined {
  for (let dir = dirname(file); dir !== "."; dir = dirname(dir))
    if (isPackage(dir)) return dir;
  return undefined;
}

export function selectSuites(
  files: readonly string[],
  isPackage: (dir: string) => boolean,
): Suite[] {
  const packages = new Map<string, string[]>();
  const loose: string[] = [];
  for (const file of files) {
    if (!TEST_FILE.test(file) || excluded(file)) continue;
    const dir = owningPackage(file, isPackage);
    if (dir) packages.set(dir, [...(packages.get(dir) ?? []), file]);
    else loose.push(file);
  }
  return [
    ...[...packages.keys()].sort().map(
      (dir) => ({ kind: "package", dir, files: packages.get(dir)!.sort() }) as const,
    ),
    ...loose.sort().map((file) => ({ kind: "file", file }) as const),
  ];
}

const isPackage = (dir: string): boolean =>
  existsSync(join(dir, "package.json")) &&
  existsSync(join(dir, "pnpm-lock.yaml"));

const hasTestScript = (dir: string): boolean =>
  typeof (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: { test?: unknown };
    }
  ).scripts?.test === "string";

function trackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\0").filter(Boolean);
}

const label = (suite: Suite) =>
  suite.kind === "package"
    ? `${suite.dir}/ (${hasTestScript(suite.dir) ? "pnpm test" : `${suite.files.length} files`})`
    : suite.file;

function run(suite: Suite): SpawnSyncReturns<string> {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (suite.kind === "file")
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", suite.file],
      options,
    );
  const install = spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts"],
    { ...options, cwd: suite.dir },
  );
  if (install.status !== 0) return install;
  if (hasTestScript(suite.dir))
    return spawnSync("pnpm", ["run", "test"], { ...options, cwd: suite.dir });
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", ...suite.files],
    options,
  );
}

function main(): number {
  const suites = selectSuites(trackedFiles(), isPackage);
  if (process.argv.includes("--list")) {
    console.log(suites.map(label).join("\n"));
    return 0;
  }
  if (suites.length === 0) {
    console.error("no module tests selected");
    return 1;
  }
  const failed: string[] = [];
  for (const suite of suites) {
    const started = Date.now();
    const result = run(suite);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === 0) {
      console.log(`ok   ${label(suite)} (${seconds}s)`);
      continue;
    }
    failed.push(label(suite));
    console.log(`FAIL ${label(suite)} (${seconds}s)`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ?? ""}`;
    console.log(output.split("\n").slice(-40).join("\n"));
  }
  console.log(`${suites.length - failed.length}/${suites.length} suites passed`);
  if (failed.length) console.log(`failed:\n  ${failed.join("\n  ")}`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exit(main());
