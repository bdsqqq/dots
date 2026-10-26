import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
interface Role {
  hostname: string;
  nativeT3: boolean;
  gogAuth: boolean;
  mounts: string[];
  units: string[];
  buildDir: string;
  bootstrap: string;
  sshKeys: string[];
  checkoutSync: string[];
  runtimeApply: string[];
  drv: string;
}

function assertIndependent(role: Role): void {
  assert.equal(role.hostname, "htz-lab");
  assert.equal(role.nativeT3, true);
  assert.equal(role.gogAuth, false);
  assert.ok(!role.mounts.some((p) => p.startsWith("/mnt/xfs-vdo")));
  assert.ok(!role.units.some((p) => p.includes("working-storage")));
  assert.ok(!role.buildDir.includes("xfs-vdo"));
  assert.ok(role.bootstrap.endsWith("/tailscale/secrets/machines/htz-lab.yaml"));
  assert.deepEqual(role.sshKeys, ["/etc/ssh/ssh_host_ed25519_key"]);
  assert.ok(role.checkoutSync.some((cmd) => cmd.endsWith("fetch origin main")));
  assert.ok(role.checkoutSync.some((cmd) => cmd.endsWith("-c merge.autoStash=false merge --ff-only origin/main")));
  assert.ok(role.runtimeApply.some((cmd) => cmd.endsWith("restart home-manager-bdsqqq.service")));
  assert.ok(role.drv.endsWith(".drv"));
}

const fixture: Role = {
  hostname: "htz-lab", nativeT3: true, gogAuth: false,
  mounts: ["/"], units: [], buildDir: "",
  bootstrap: "/source/tailscale/secrets/machines/htz-lab.yaml",
  sshKeys: ["/etc/ssh/ssh_host_ed25519_key"],
  checkoutSync: ["git fetch origin main", "git -c merge.autoStash=false merge --ff-only origin/main"],
  runtimeApply: ["systemctl restart home-manager-bdsqqq.service"], drv: "/nix/store/fixture.drv",
};

test("role verifier rejects inherited storage and enrollment", () => {
  assertIndependent(fixture);
  for (const change of [
    { mounts: ["/", "/mnt/xfs-vdo"] },
    { units: ["working-storage-prepare"] },
    { buildDir: "/mnt/xfs-vdo/nix-build" },
    { bootstrap: "/source/tailscale/secrets/machines/htz-xfs-lab.yaml" },
    { gogAuth: true },
    { checkoutSync: [] },
    { runtimeApply: [] },
  ]) assert.throws(() => assertIndependent({ ...fixture, ...change }));
});

test("machine bootstrap has a separate recipient, not a new name for the old identity", () => {
  const { machines } = JSON.parse(readFileSync(`${root}/tailscale/machines.json`, "utf8"));
  const fresh = machines["htz-lab"];
  assert.equal(fresh.bootstrapGeneration, 1);
  assert.equal(fresh.tag, "tag:service-host");
  assert.equal(fresh.ageRecipients.length, 1);
  assert.ok(!machines["htz-xfs-lab"].ageRecipients.includes(fresh.ageRecipients[0]));
});

test("native source catch-up fast-forwards but preserves dirty and divergent work", () => {
  const temp = mkdtempSync(join(tmpdir(), "htz-lab-git-"));
  const origin = join(temp, "origin.git"), publisher = join(temp, "publisher"), checkout = join(temp, "checkout");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const publish = (file: string, value: string) => {
    writeFileSync(join(publisher, file), value);
    git(publisher, "add", file);
    git(publisher, "commit", "-m", "fixture");
    git(publisher, "push", "origin", "main");
  };
  const merge = () => git(checkout, "-c", "merge.autoStash=false", "merge", "--ff-only", "origin/main");
  try {
    git(temp, "init", "--bare", "--initial-branch=main", origin);
    git(temp, "clone", origin, publisher);
    publish("notes", "original");
    git(temp, "clone", origin, checkout);
    writeFileSync(join(checkout, "notes"), "unpublished edit");
    writeFileSync(join(checkout, "draft"), "untracked draft");
    publish("manifest", "published update");
    git(checkout, "fetch", "origin", "main");
    merge();
    assert.equal(readFileSync(join(checkout, "manifest"), "utf8"), "published update");
    assert.equal(readFileSync(join(checkout, "notes"), "utf8"), "unpublished edit");
    publish("notes", "conflicting published update");
    git(checkout, "fetch", "origin", "main");
    assert.throws(merge);
    assert.equal(readFileSync(join(checkout, "notes"), "utf8"), "unpublished edit");
    git(checkout, "add", "notes");
    git(checkout, "commit", "-m", "unpublished local commit");
    const localHead = git(checkout, "rev-parse", "HEAD");
    assert.throws(merge);
    assert.equal(git(checkout, "rev-parse", "HEAD"), localHead);
    assert.equal(readFileSync(join(checkout, "draft"), "utf8"), "untracked draft");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("evaluated native Linux role is independent and forces its system derivation", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, () => {
  const role: Role = JSON.parse(execFileSync("nix", [
    "eval", "--json", "--no-write-lock-file",
    `path:${root}#nixosConfigurations.htz-lab.config`, "--apply", `c: {
      hostname = c.networking.hostName;
      nativeT3 = c.my.t3Code.nativeService.enable;
      gogAuth = c.my.gog.enable;
      mounts = builtins.attrNames c.fileSystems;
      units = builtins.attrNames c.systemd.services;
      buildDir = c.nix.settings."build-dir" or "";
      bootstrap = toString c.sops.secrets.tailscale_auth_key.sopsFile;
      sshKeys = c.sops.age.sshKeyPaths;
      checkoutSync = c.systemd.services.nixos-upgrade.serviceConfig.ExecStartPre;
      runtimeApply = c.systemd.services.nixos-upgrade.serviceConfig.ExecStartPost;
      drv = c.system.build.toplevel.drvPath;
    }`,
  ], { cwd: root, encoding: "utf8", timeout: 180_000 }));
  assertIndependent(role);
});
