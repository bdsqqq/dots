import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDir, "../..");

test("remindctl excludes homebrew on Linux and scopes Darwin trust to its formula", () => {
  const lock: unknown = JSON.parse(readFileSync(resolve(root, "flake.lock"), "utf8"));
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  assert.ok(record(lock) && record(lock.nodes));
  const nixpkgs = lock.nodes.nixpkgs;
  assert.ok(record(nixpkgs) && record(nixpkgs.locked));
  const tree = ["type", "owner", "repo", "rev", "narHash"].map((key) => {
    assert.ok(record(nixpkgs.locked));
    const value = nixpkgs.locked[key];
    assert.equal(typeof value, "string");
    return `${key} = ${JSON.stringify(value)};`;
  }).join(" ");
  for (const [system, expected] of [
    ["aarch64-linux", []],
    ["aarch64-darwin", ["homebrew"]],
  ] satisfies [string, string[]][]) {
    const expression = `let
      source = builtins.fetchTree { ${tree} };
      module = import ${moduleDir}/default.nix {
        lib = import (source.outPath + "/lib");
        config.my.paths.commonplace = "/tmp/fixture-vault";
        hostSystem = ${JSON.stringify(system)};
      };
    in {
      keys = builtins.attrNames module;
      homebrew = module.homebrew or null;
    }`;
    const result = spawnSync("nix", ["eval", "--impure", "--json", "--expr", expression], {
      encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const actual: unknown = JSON.parse(result.stdout);
    assert.ok(record(actual));
    assert.deepEqual(actual.keys, expected);
    assert.deepEqual(actual.homebrew, system.endsWith("-darwin") ? {
      taps: ["steipete/tap"],
      brews: [{ name: "steipete/tap/remindctl", trusted: true }],
    } : null);
  }
});
