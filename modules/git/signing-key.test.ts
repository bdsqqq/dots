import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(execFileSync("nix", [
  "eval", "--impure", "--json", "--no-write-lock-file", "--expr", `
    let
      flake = builtins.getFlake ${JSON.stringify(`git+file://${root}`)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = import ${JSON.stringify(`${root}/modules/git/default.nix`)};
      configured = (module {
        inputs.hunk.homeManagerModules.default = {};
      }).home-manager.users.bdsqqq {
        inherit pkgs;
        lib = pkgs.lib // { hm.dag.entryAfter = _: script: script; };
        config.home.homeDirectory = "/fixture";
        osConfig.networking.hostName = "fixture-host";
      };
      script = configured.home.activation.ensureGitSigningKey;
    in {
      inherit script;
      # eval names store paths without building them; these are what the
      # snippet and the test run, so a fresh runner can build them first.
      drvs = builtins.attrNames (builtins.getContext "\${script}\${pkgs.bash}\${pkgs.openssh}");
      sshKeygen = "\${pkgs.openssh}/bin/ssh-keygen";
      bash = "\${pkgs.bash}/bin/bash";
    }
  `,
], { encoding: "utf8" }));
execFileSync("nix", ["build", "--no-link", ...fixture.drvs.map((drv: string) => `${drv}^*`)], { stdio: "pipe" });

function setup(t: { after: (cleanup: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "git-signing-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, key: join(home, ".ssh/id_ed25519") };
}

function activate(home: string, dryRun = false) {
  const env = { ...process.env, HOME: home, DRY_RUN_CMD: dryRun ? "echo" : "" };
  delete env.DRY_RUN;
  if (dryRun) env.DRY_RUN = "1";
  // home-manager activation runs nix's bash; the host's may be 3.2, without `[[ -v ]]`.
  execFileSync(fixture.bash, ["-eu", "-c", `
    run() { if [[ -v DRY_RUN ]]; then :; else "$@"; fi; }
    ${fixture.script}
  `], { env, stdio: "pipe" });
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("a fresh host can sign and verify in git's SSH namespace", (t) => {
  const { home, key } = setup(t);
  activate(home);
  assert.equal(statSync(dirname(key)).mode & 0o777, 0o700);
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const message = join(home, "message");
  writeFileSync(message, "signing probe\n");
  execFileSync(fixture.sshKeygen, ["-Y", "sign", "-f", key, "-n", "git", message], { stdio: "pipe" });
  const signers = join(home, "allowed-signers");
  writeFileSync(signers, `fixture namespaces="git" ${readFileSync(`${key}.pub`, "utf8")}`);
  const result = spawnSync(fixture.sshKeygen, ["-Y", "verify", "-f", signers,
    "-I", "fixture", "-n", "git", "-s", `${message}.sig`], { input: readFileSync(message) });
  assert.equal(result.status, 0, result.stderr.toString());
});

test("repeated activation preserves both existing key files", (t) => {
  const { home, key } = setup(t);
  activate(home);
  const before = [digest(key), digest(`${key}.pub`)];
  activate(home);
  assert.deepEqual([digest(key), digest(`${key}.pub`)], before);
});

test("hosts generate different identities", (t) => {
  const first = setup(t);
  const second = setup(t);
  activate(first.home);
  activate(second.home);
  assert.notEqual(digest(`${first.key}.pub`), digest(`${second.key}.pub`));
});

test("a missing public key is recovered without replacing the private key", (t) => {
  const { home, key } = setup(t);
  activate(home);
  const privateDigest = digest(key);
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2);
  rmSync(`${key}.pub`);
  activate(home);
  assert.equal(digest(key), privateDigest);
  assert.deepEqual(readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2), publicKey);
});

test("dry runs neither create keys nor recover a missing public key", (t) => {
  const { home, key } = setup(t);
  activate(home, true);
  assert.equal(existsSync(dirname(key)), false);
  activate(home);
  rmSync(`${key}.pub`);
  const privateDigest = digest(key);
  activate(home, true);
  assert.equal(existsSync(`${key}.pub`), false);
  assert.equal(digest(key), privateDigest);
});
