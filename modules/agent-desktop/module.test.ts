import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDir, "../..");
const lock = JSON.parse(readFileSync(join(root, "flake.lock"), "utf8"));
const tree = ["type", "owner", "repo", "rev", "narHash"].map(
  (key) => `${key} = ${JSON.stringify(lock.nodes.nixpkgs.locked[key])};`,
).join(" ");

/** Evaluate the real module's scripts without running a host activation. */
function moduleScripts(system: string, commonplace: string) {
  const expression = `let
    source = builtins.fetchTree { ${tree} };
    baseLib = import (source.outPath + "/lib");
    lib = baseLib // { hm.dag.entryAfter = after: text: { inherit after text; }; };
    module = import ${moduleDir}/default.nix {
      inherit lib;
      config.my.paths.commonplace = ${JSON.stringify(commonplace)};
      hostSystem = ${JSON.stringify(system)};
    };
    home = module.home-manager.users.bdsqqq {
      inherit lib;
      pkgs = {
        nodejs_latest = "/fixture/node";
        pnpm_12 = "/fixture/pnpm";
        writeShellScriptBin = name: text: { inherit name text; };
      };
    };
  in if module == {} then {} else home`;
  const result = spawnSync("nix", ["eval", "--impure", "--json", "--expr", expression], {
    encoding: "utf8", timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Linux receives no desktop wiring; both Mac architectures select matching binaries", () => {
  assert.deepEqual(moduleScripts("x86_64-linux", "/fixture"), {});
  assert.deepEqual(moduleScripts("aarch64-linux", "/fixture"), {});
  for (const [system, architecture] of [["aarch64-darwin", "arm64"], ["x86_64-darwin", "x64"]]) {
    const home = moduleScripts(system, "/fixture");
    assert.equal(home.home.packages.length, 1);
    assert.equal(home.home.packages[0].name, "agent-desktop");
    assert.match(home.home.packages[0].text, new RegExp(`agent-desktop-darwin-${architecture}`));
    assert.match(home.home.packages[0].text, new RegExp(`agent-desktop-macos-helper-darwin-${architecture}`));
    const activation = home.home.activation.installAgentDesktop;
    assert.deepEqual(activation.after, ["linkGeneration"]);
    assert.match(activation.text, /--frozen-lockfile --ignore-scripts/);
    assert.doesNotMatch(activation.text, /permissions|--guide|--request|launch|codesign|tccutil/);
  }
});

test("evaluated launcher preserves arguments, helper identity and native failure without UI fallback", () => {
  const fixture = mkdtempSync(join(tmpdir(), "agent-desktop module "));
  try {
    const bin = join(fixture, "01_files/nix/modules/agent-desktop/node_modules/agent-desktop/bin");
    mkdirSync(bin, { recursive: true });
    const native = join(bin, "agent-desktop-darwin-arm64");
    // This is a fake native executable: no accessibility APIs or UI interaction.
    writeFileSync(native, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),helper:process.env.AGENT_DESKTOP_MACOS_HELPER_PATH}));process.exit(process.argv[2] === 'fail' ? 42 : 0);\n`, { mode: 0o755 });
    const script = moduleScripts("aarch64-darwin", fixture).home.packages[0].text;
    const launcher = join(fixture, "launcher.sh");
    writeFileSync(launcher, script);
    assert.equal(spawnSync("bash", ["-n", launcher]).status, 0);
    for (const args of [["snapshot", "--app", "An App", "literal;$HOME", ""], ["fail"]]) {
      const result = spawnSync("bash", [launcher, ...args], { encoding: "utf8" });
      assert.equal(result.status, args[0] === "fail" ? 42 : 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        args,
        helper: join(bin, "agent-desktop-macos-helper-darwin-arm64"),
      });
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("shared discovery resolves the colocated skill and hosts explicitly import the module", () => {
  assert.equal(realpathSync(join(root, "modules/agents/skills/agent-desktop/SKILL.md")), join(moduleDir, "SKILL.md"));
  for (const host of ["mbp-m2", "mbp-m5", "mmn-m4"]) {
    assert.match(readFileSync(join(root, "hosts", host, "default.nix"), "utf8"), /\.\.\/\.\.\/modules\/agent-desktop\s/);
  }
});
