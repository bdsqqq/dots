import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Desktop = { entries: Record<string, { exec: string }>; mime: Record<string, unknown> };
type RuntimeFixture = {
  nixpkgsRevision: string;
  stockNode: string;
  defaultNode: string;
  latestNode: string;
  stockGhostty: string;
  configuredGhostty: string;
  pnpm: string;
  homePackages: string[];
  launcher: string;
  launcherScript: string;
  pathSegments: { order: number; value: string }[];
  installScript: string;
  graphicalLinux: Desktop;
  headlessLinux: Desktop;
  graphicalDarwin: Desktop;
  headlessDarwin: Desktop;
};

const fixture = fileURLToPath(new URL("./runtime-fixture.nix", import.meta.url));
const nodeModule = fileURLToPath(new URL("./default.nix", import.meta.url));
const shellModule = fileURLToPath(new URL("../shell/default.nix", import.meta.url));

function evaluate(overrides: Record<string, string> = {}): RuntimeFixture {
  const argumentsNix = Object.entries({ nodeModulePath: nodeModule, shellModulePath: shellModule, ...overrides })
    .map(([key, value]) => `${key} = ${JSON.stringify(value)};`).join(" ");
  const result = spawnSync("nix", [
    "eval", "--offline", "--impure", "--json", "--expr",
    `(import ${JSON.stringify(fixture)}) { ${argumentsNix} }`,
  ], { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout) as RuntimeFixture;
}

function assertCacheCompatible(value: RuntimeFixture): void {
  assert.equal(value.defaultNode, value.stockNode, "upstream Node must not be globally replaced");
  assert.equal(value.configuredGhostty, value.stockGhostty, "Ghostty must retain its upstream cache identity");
}

function assertHeadless(value: Desktop): void {
  assert.deepEqual(value.entries, {}, "headless hosts must not depend on graphical launchers");
  assert.deepEqual(value.mime, {}, "headless hosts must not install desktop MIME defaults");
}

const current = evaluate();

test("the configured package collection retains upstream Node and Ghostty identities", () => {
  assertCacheCompatible(current);
});

test("our CLI still installs current Node and pnpm 12 explicitly", () => {
  assert.ok(current.homePackages.includes(current.latestNode));
  assert.ok(current.homePackages.includes(current.pnpm));
  assert.notEqual(current.latestNode, current.stockNode, "fixture must exercise distinct Node releases");
});

test("shells and scripts get an executable adapter delegating to the selected upstream pnpm", () => {
  assert.ok(current.homePackages.includes(current.launcher));
  assert.ok(current.launcherScript.includes(`exec "${current.latestNode}/bin/node"`));
  assert.ok(current.launcherScript.includes('"/fixture/commonplace/01_files/nix/modules/node-pnpm/pnpm.mts"'));
  assert.ok(current.launcherScript.includes(`"${current.pnpm}/bin/pnpm" "$@"`));
  const adapterPath = current.pathSegments.find((segment) => segment.value === `${current.launcher}/bin`);
  const toolsPath = current.pathSegments.find((segment) => segment.value.endsWith("node_modules/.bin"));
  assert.ok(adapterPath && toolsPath && adapterPath.order < toolsPath.order);
});

test("dependency installation uses the selected runtime and package manager", () => {
  assert.ok(current.installScript.includes(`${current.latestNode}/bin`));
  assert.ok(current.installScript.includes(`"${current.pnpm}/bin/pnpm" install`));
  assert.ok(!current.installScript.includes(`${current.stockNode}/bin`));
});

test("graphical Linux keeps the Ghostty-backed Yazi launcher and MIME integration", () => {
  assert.equal(current.graphicalLinux.entries.yazi?.exec,
    "/fixture/ghostty/bin/ghostty --title=yazi -e /fixture/yazi/bin/yazi %U");
  assert.equal(current.graphicalLinux.mime.enable, true);
});

test("headless Linux has no graphical launcher or desktop MIME integration", () => {
  assertHeadless(current.headlessLinux);
});

test("Darwin does not acquire Linux desktop integration in either head mode", () => {
  assertHeadless(current.graphicalDarwin);
  assertHeadless(current.headlessDarwin);
});

test("the cache verifier rejects an isolated reintroduction of the old Node override", () => {
  const directory = mkdtempSync(join(tmpdir(), "node-cache-regression-"));
  try {
    const path = join(directory, "default.nix");
    writeFileSync(path, `{ config, ... }: (import ${JSON.stringify(nodeModule)} { inherit config; }) // {
      nixpkgs.overlays = [ (final: prev: { nodejs = prev.nodejs_latest; }) ];
    }`);
    const broken = evaluate({ nodeModulePath: path });
    assert.notEqual(broken.configuredGhostty, broken.stockGhostty);
    assert.throws(() => assertCacheCompatible(broken), /upstream Node must not be globally replaced/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the desktop verifier rejects an isolated loss of headless gating", () => {
  const directory = mkdtempSync(join(tmpdir(), "desktop-gating-regression-"));
  try {
    const path = join(directory, "default.nix");
    writeFileSync(path, `{ ... }@args: import ${JSON.stringify(shellModule)} (args // { headMode = "graphical"; })`);
    const broken = evaluate({ shellModulePath: path });
    assert.throws(() => assertHeadless(broken.headlessLinux), /headless hosts must not depend/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
