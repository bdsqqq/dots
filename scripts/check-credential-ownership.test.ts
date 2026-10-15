import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("ownership checker discovers nested backup credentials and detects missing/duplicate owners", () => {
  const root = mkdtempSync(join(tmpdir(), "credential-ownership-"));
  const put = (name: string, contents: string) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  const check = () => spawnSync(process.env.CREDENTIAL_PYTHON ?? "python", [
    fileURLToPath(new URL("./check-credential-ownership.py", import.meta.url)), "--root", root,
  ], { encoding: "utf8", timeout: 10_000 });
  try {
    put("flake.nix", "{}");
    for (const [domain, name] of [["media-cookies", "cookies.txt"], ["o11y", ".axiom.toml"]]) {
      put(`modules/${domain}/credential.nix`, `sopsFile = ./${name};`);
    }
    // These are ownership fixtures, not decryptable or deployable SOPS files.
    put("modules/backup/ssd-01/secrets.yaml", "restic_ssd_01_password: fixture\nsops: {}\n");
    put("modules/backup/ssd-01/credential.nix", "sopsFile = ./secrets.yaml; # restic_ssd_01_password");
    put("cloudflare/secrets.yaml", "cloudflare_family_emails: fixture\nsops: {}\n");
    put("cloudflare/tofu-with-secrets", "cloudflare_family_emails");
    const valid = check();
    assert.equal(valid.status, 0, valid.stderr || String(valid.error));

    put("modules/backup/ssd-01/credential.nix", "default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null; inherit (cfg) sopsFile; # restic_ssd_01_password");
    assert.equal(check().status, 0, "optional adjacent owners remain valid after real encrypted credentials are added");
    put("modules/backup/ssd-01/credential.nix", "sopsFile = /elsewhere/secrets.yaml; # restic_ssd_01_password");
    const wrongSource = check();
    assert.equal(wrongSource.status, 1);
    assert.match(wrongSource.stderr, /does not own its adjacent secrets.yaml/);
    rmSync(join(root, "modules/backup/ssd-01/credential.nix"));
    const missing = check();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /modules\/backup\/ssd-01\/secrets.yaml has no adjacent credential.nix/);

    put("modules/backup/ssd-01/credential.nix", "sopsFile = ./secrets.yaml; # restic_ssd_01_password");
    put("modules/duplicate/secrets.yaml", "restic_ssd_01_password: fixture\nsops: {}\n");
    put("modules/duplicate/credential.nix", "sopsFile = ./secrets.yaml; # restic_ssd_01_password");
    const duplicate = check();
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /restic_ssd_01_password has multiple owners/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
