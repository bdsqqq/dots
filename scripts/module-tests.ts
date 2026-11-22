/**
 * runs the repo's module tests, which no flake check or workflow ran before,
 * so they broke unnoticed. modules/pi is excluded: it has its own suite.
 *
 * a directory with a package.json and pnpm lockfile is a package: it gets a
 * frozen install, then `node --test` on every selected test file under it,
 * not its `test` script, whose glob can miss a new file. other test files run
 * with `node --test`, or `bun test` under BUN_DIRS. a test is selected unless EXCLUDED names it with a
 * reason, so a new test runs in CI by default.
 *
 *   node --experimental-strip-types scripts/module-tests.ts [--list]
 */

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const TEST_FILE = /(\.test|(^|\/)test_[^/]*)\.[cm]?[jt]s$/u;

/** these import `bun:` modules, so bun runs them instead of node. */
const BUN_DIRS = ["modules/html-stuff/"];

/** path prefix → why this harness can't run it. */
export const EXCLUDED: Record<string, string> = {
  "modules/pi/": "has its own vitest suite and CI job",
  "modules/tailnet-registry/": "bun tests; built by checks.tailnet-registry",
  "modules/node-pnpm/runtime.test.ts":
    "fixture pkgs lacks stdenv.hostPlatform; fails on main since 632bf51d",
  "scripts/check-credential-ownership.test.ts":
    "built by checks.credential-ownership, which provides python",
};

/** path prefix → the one platform it can run on, and why. */
export const PLATFORM_ONLY: Record<string, { platform: NodeJS.Platform; reason: string }> = {
  "modules/app-pins/cli.test.ts": { platform: "darwin", reason: "installs app bundles with ditto and plutil" },
  "modules/app-pins/pins.test.ts": { platform: "darwin", reason: "builds app bundles with ditto" },
  "modules/app-pins/publish.test.ts": { platform: "darwin", reason: "reads bundle versions with plutil" },
  "modules/t3-code/sync-credentials.test.ts": { platform: "darwin", reason: "locks with /usr/bin/lockf" },
  "modules/household-intake/smb-audit.test.mjs": { platform: "darwin", reason: "reads plists with /usr/bin/plutil" },
};

const excluded = (file: string, platform: NodeJS.Platform): boolean =>
  Object.keys(EXCLUDED).some((prefix) => file.startsWith(prefix)) ||
  Object.entries(PLATFORM_ONLY).some(
    ([prefix, only]) => file.startsWith(prefix) && only.platform !== platform,
  );

export type Suite =
  | { kind: "package"; dir: string; files: string[] }
  | { kind: "file"; file: string; runner: "node" | "bun" };

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
  platform: NodeJS.Platform = process.platform,
): Suite[] {
  const packages = new Map<string, string[]>();
  const loose: string[] = [];
  for (const file of files) {
    if (!TEST_FILE.test(file) || excluded(file, platform)) continue;
    const dir = owningPackage(file, isPackage);
    if (dir) packages.set(dir, [...(packages.get(dir) ?? []), file]);
    else loose.push(file);
  }
  return [
    ...[...packages.keys()].sort().map(
      (dir) => ({ kind: "package", dir, files: packages.get(dir)!.sort() }) as const,
    ),
    ...loose.sort().map(
      (file) =>
        ({
          kind: "file",
          file,
          runner: BUN_DIRS.some((dir) => file.startsWith(dir)) ? "bun" : "node",
        }) as const,
    ),
  ];
}

const isPackage = (dir: string): boolean =>
  existsSync(join(dir, "package.json")) &&
  existsSync(join(dir, "pnpm-lock.yaml"));


function trackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split("\0").filter(Boolean);
}

const label = (suite: Suite) =>
  suite.kind === "package"
    ? `${suite.dir}/ (${suite.files.length} files)`
    : suite.runner === "bun"
      ? `${suite.file} (bun)`
      : suite.file;

function run(suite: Suite): SpawnSyncReturns<string> {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (suite.kind === "file")
    return suite.runner === "bun"
      ? spawnSync("bun", ["test", suite.file], options)
      : spawnSync(process.execPath, ["--experimental-strip-types", "--test", suite.file], options);
  const install = spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts"],
    { ...options, cwd: suite.dir },
  );
  if (install.status !== 0) return install;
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
