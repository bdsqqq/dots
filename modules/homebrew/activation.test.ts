import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDir, "../..");
const lock = JSON.parse(readFileSync(join(root, "flake.lock"), "utf8"));
const source = Object.fromEntries(["type", "owner", "repo", "rev", "narHash"].map(key => [key, lock.nodes.nixpkgs.locked[key]]));
const nixSource = Object.entries(source).map(([key, value]) => `${key} = ${JSON.stringify(value)};`).join(" ");
const decisions = '{"formulae":["example/tap/existing"]}\n';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "homebrew-activation-"));
  const home = join(directory, "user home");
  const configHome = join(home, "custom config");
  const trust = join(configHome, "homebrew/trust.json");
  const legacyTrust = join(home, ".homebrew/trust.json");
  const logs = join(home, "Library/Logs");
  const prefix = join(directory, "brew");
  for (const path of [dirname(trust), dirname(legacyTrust), logs, join(prefix, "bin")]) mkdirSync(path, { recursive: true });
  const brew = join(prefix, "bin/brew");
  // No installation or trust changes: the fake bundle checks preparation ordering.
  writeFileSync(brew, `#!/bin/bash\n[ -x ${JSON.stringify(logs)} ] || exit 12\n[ -d ${JSON.stringify(join(logs, "Homebrew"))} ] || exit 13\nexit "\${FIXTURE_BREW_STATUS:-0}"\n`, { mode: 0o755 });
  const expression = `let
    source = builtins.fetchTree { ${nixSource} };
    lib = import (source.outPath + "/lib");
    module = import ${moduleDir}/best-effort.nix {
      inherit lib;
      config = {
        system.primaryUser = "fixture";
        users.users.fixture.home = ${JSON.stringify(home)};
        home-manager.users.fixture.xdg.configHome = ${JSON.stringify(configHome)};
        homebrew.prefix = ${JSON.stringify(prefix)};
        homebrew.onActivation.brewBundleCmd = _: lib.escapeShellArg ${JSON.stringify(brew)};
      };
    };
  in {
    script = module.system.activationScripts.homebrew.text.content;
    seed = builtins.toFile "homebrew-trust.json" ${JSON.stringify(decisions)};
  }`;
  // Use our own uid so the isolated activation needs no sudo or real user changes.
  const result = spawnSync("nix", ["eval", "--impure", "--json", "--expr", expression], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const rendered = JSON.parse(result.stdout) as { script: string; seed: string };
  const script = rendered.script.replaceAll("chown fixture", `chown ${process.getuid!()}`);
  return {
    directory, home, trust, legacyTrust, logs, seed: rendered.seed,
    run(status = 0) {
      return spawnSync("/bin/bash", ["-eu", "-c", script], {
        encoding: "utf8", env: { ...process.env, FIXTURE_BREW_STATUS: String(status) }, timeout: 10000,
      });
    },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const state of ["dangling", "readable", "regular", "custom-link", "missing"] as const) {
  test(`activation repairs legacy state idempotently: ${state}`, () => {
    const f = fixture();
    try {
      if (state === "dangling") {
        symlinkSync("/nix/store/does-not-exist-homebrew-trust.json", f.trust);
        symlinkSync("/nix/store/does-not-exist-homebrew-trust.json", f.legacyTrust);
        // Prove the postcondition rejects the known bad fixture before repair.
        assert.throws(() => assert.equal(lstatSync(f.trust).isSymbolicLink(), false));
      } else if (state === "readable") {
        symlinkSync(f.seed, f.trust);
        symlinkSync(f.seed, f.legacyTrust);
      } else if (state === "regular") {
        writeFileSync(f.trust, decisions, { mode: 0o600 });
      } else if (state === "custom-link") {
        const custom = join(f.home, "editable-trust.json");
        writeFileSync(custom, decisions);
        symlinkSync(custom, f.trust);
      }
      chmodSync(f.logs, 0o444);
      const first = f.run();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(statSync(f.logs).mode & 0o700, 0o700);
      if (state === "dangling" || state === "missing") {
        assert.equal(existsSync(f.trust), false);
        assert.throws(() => lstatSync(f.trust), { code: "ENOENT" });
        assert.throws(() => lstatSync(f.legacyTrust), { code: "ENOENT" });
        // A later activation must preserve newly recorded native trust decisions.
        writeFileSync(f.trust, decisions, { mode: 0o600 });
      }
      assert.equal(readFileSync(f.trust, "utf8"), decisions);
      assert.equal(lstatSync(f.trust).isSymbolicLink(), state === "custom-link");
      if (state === "readable") {
        assert.equal(readFileSync(f.legacyTrust, "utf8"), decisions);
        assert.equal(statSync(f.trust).mode & 0o777, 0o600);
      }
      if (state === "custom-link") assert.equal(readlinkSync(f.trust), join(f.home, "editable-trust.json"));
      const before = statSync(f.trust);
      const second = f.run();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(f.trust, "utf8"), decisions);
      assert.equal(statSync(f.trust).ino, before.ino);
      assert.equal(statSync(f.trust).mtimeMs, before.mtimeMs);
      const failedBundle = f.run(1);
      assert.equal(failedBundle.status, 0, failedBundle.stderr);
      assert.match(failedBundle.stderr, /Homebrew bundle failed; continuing system activation/);
    } finally { f.cleanup(); }
  });
}
