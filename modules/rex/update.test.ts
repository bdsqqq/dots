import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyInstalled, newer, publish, status, update } from "./update.ts";
import { publishedReleaseUrl, upstreamReleaseUrl } from "./release.ts";

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rex-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "usr/local/bin/rex");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "0.0.100-gaaa");
  const calls: string[][] = [];
  const archive = "verified test archive";
  const checksum = createHash("sha256").update(archive).digest("hex");
  let brokenRestart = false, badChecksum = false, offline = false, active = true;
  let concurrentInstall = false;
  const run = (command: string, args: string[]): string => {
    calls.push([command, ...args]);
    if (command === "systemctl") {
      if (args[0] === "restart" && brokenRestart) {
        brokenRestart = false;
        throw new Error("restart failed");
      }
      return "";
    }
    if (command === "curl") {
      if (offline) throw new Error("offline");
      if (!args.includes("--output")) return JSON.stringify({
        schemaVersion: 1, product: "rex", channel: "snapshot", commit: "a".repeat(40), version: "0.0.200-gbbb",
        artifacts: Object.fromEntries([["x64", "amd64"], ["arm64", "arm64"]].map(([arch, name]) => [arch, {
          url: `https://blob.superlogical.com/download/rex/snapshot/${"a".repeat(40)}/rex-linux-${name}.tar.gz`,
          sha256: badChecksum ? "0".repeat(64) : checksum,
        }])),
      });
      writeFileSync(args[args.indexOf("--output") + 1], archive);
      if (concurrentInstall) writeFileSync(binary, "0.0.300-gccc");
      return "";
    }
    if (command === "tar") {
      writeFileSync(join(args[args.indexOf("--directory") + 1], "rex"), "0.0.200-gbbb");
      return "";
    }
    const value = readFileSync(command, "utf8");
    if (value === "broken") throw new Error("not executable");
    return args[0] === "version" ? `Rex ${value}\ncommit: ${"a".repeat(40)}\n` : "usage: rex";
  };
  const options = { root, run, arch: "x64", active: () => active };
  applyInstalled(options);
  calls.length = 0;
  return {
    options, binary, calls,
    contents: () => readFileSync(binary, "utf8"),
    breakRestart: () => { brokenRestart = true; },
    badChecksum: () => { badChecksum = true; },
    offline: () => { offline = true; },
    stop: () => { active = false; },
    concurrent: () => { concurrentInstall = true; },
  };
}

test("published pins validate, persist an install receipt, and restart the login server", t => {
  const f = fixture(t);
  assert.equal(update(f.options), "updated to 0.0.200-gbbb");
  assert.equal(f.contents(), "0.0.200-gbbb");
  assert.ok(f.calls.some(c => c.includes(publishedReleaseUrl)));
  assert.ok(!f.calls.some(c => c.includes(upstreamReleaseUrl)));
  const receipt = JSON.parse(readFileSync(join(f.options.root, "var/lib/rex-update/applied.json"), "utf8"));
  assert.equal(receipt.source, publishedReleaseUrl);
  assert.equal(receipt.release.version, "0.0.200-gbbb");
  assert.equal(receipt.binarySha256, createHash("sha256").update(f.contents()).digest("hex"));
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "restart").length, 1);
  f.calls.length = 0;
  assert.match(update(f.options), /already current/);
  assert.ok(!f.calls.some(c => c[0] === "systemctl"));
});

test("an already-current bootstrap receives verified evidence without reinstalling", t => {
  const f = fixture(t);
  assert.equal(status(f.options.root).state, "unverified");
  writeFileSync(f.binary, "0.0.200-gbbb");
  applyInstalled({ ...f.options, active: () => false });
  f.calls.length = 0;
  assert.match(update(f.options), /already current/);
  assert.equal(status(f.options.root).matchesInstalledBinary, true);
  assert.ok(!f.calls.some(c => c[0] === "systemctl"));
});

test("a failed receipt write is repaired on the next same-version poll", t => {
  const f = fixture(t), rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (to.endsWith("/applied.json")) throw new Error("receipt storage unavailable");
    rename(from, to);
  });
  assert.throws(() => update(f.options), /receipt storage unavailable/);
  assert.equal(f.contents(), "0.0.200-gbbb");
  assert.equal(status(f.options.root).state, "unverified");
  fault.mock.restore();
  f.calls.length = 0;
  assert.match(update(f.options), /already current/);
  assert.equal(status(f.options.root).matchesInstalledBinary, true);
  assert.ok(!f.calls.some(c => c[0] === "systemctl"));
});

test("a matching version string cannot bless custom native bytes", t => {
  const f = fixture(t);
  writeFileSync(f.binary, "0.0.200-gbbb|local patch");
  assert.match(update(f.options), /native bytes differ/);
  assert.equal(f.contents(), "0.0.200-gbbb|local patch");
  assert.equal(status(f.options.root).state, "unverified");
});

test("native replacements apply offline without changing settings or stopping account servers", t => {
  const f = fixture(t);
  const settings = join(f.options.root, "accounts.jsonc");
  writeFileSync(settings, "native settings");
  writeFileSync(f.binary, "0.0.300-gccc");
  f.offline();
  applyInstalled(f.options);
  assert.equal(f.contents(), "0.0.300-gccc");
  assert.equal(readFileSync(settings, "utf8"), "native settings");
  assert.deepEqual(f.calls.filter(c => c[0] === "systemctl"), [
    ["systemctl", "restart", "rex-login-server.service"],
    ["systemctl", "is-active", "--quiet", "rex-login-server.service"],
  ]);
  // timer fetch failure must not roll the already-applied native install back.
  assert.throws(() => update(f.options), /offline/);
  assert.equal(f.contents(), "0.0.300-gccc");
});

test("a newer native release is never reset to snapshot", t => {
  const f = fixture(t);
  writeFileSync(f.binary, "0.1.0");
  assert.match(update(f.options), /newer native install/);
  assert.equal(f.contents(), "0.1.0");
  assert.ok(!f.calls.some(c => c[0] === "tar"));
});

test("checksum and download failures leave the installed binary untouched", t => {
  const f = fixture(t);
  f.badChecksum();
  assert.throws(() => update(f.options), /checksum mismatch/);
  assert.equal(f.contents(), "0.0.100-gaaa");
  assert.ok(!f.calls.some(c => c[0] === "systemctl" || c[0] === "tar"));
});

test("a concurrent native install wins over a timer download", t => {
  const f = fixture(t);
  f.concurrent();
  assert.match(update(f.options), /left untouched/);
  assert.equal(f.contents(), "0.0.300-gccc");
});

test("a native rename immediately before publish is preserved", t => {
  const f = fixture(t);
  const expected = createHash("sha256").update(f.contents()).digest("hex");
  const candidate = join(f.options.root, "candidate");
  writeFileSync(candidate, "0.0.200-gbbb");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (from === f.binary) writeFileSync(f.binary, "0.0.300-native");
    rename(from, to);
  });
  assert.equal(publish(candidate, f.binary, expected), false);
  assert.equal(f.contents(), "0.0.300-native");
});

test("a native install immediately after claim is not replaced", t => {
  const f = fixture(t);
  const expected = createHash("sha256").update(f.contents()).digest("hex");
  const candidate = join(f.options.root, "candidate");
  writeFileSync(candidate, "0.0.200-gbbb");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    rename(from, to);
    if (from === f.binary) writeFileSync(f.binary, "0.0.300-native");
  });
  assert.equal(publish(candidate, f.binary, expected), false);
  assert.equal(f.contents(), "0.0.300-native");
});

test("failed publication and restoration retain the held executable for recovery", t => {
  const f = fixture(t);
  const expected = createHash("sha256").update(f.contents()).digest("hex");
  const candidate = join(f.options.root, "candidate");
  writeFileSync(candidate, "0.0.200-gbbb");
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
  assert.throws(() => publish(candidate, f.binary, expected), /disk full/);
  assert.equal(existsSync(f.binary), false);
  const recovery = readdirSync(dirname(f.binary)).find(name => name.startsWith(".rex-update-"));
  assert.ok(recovery);
  assert.equal(readFileSync(join(dirname(f.binary), recovery, "previous"), "utf8"), "0.0.100-gaaa");
});

test("broken native binary restores last-good without restarting into broken code", t => {
  const f = fixture(t);
  writeFileSync(f.binary, "broken");
  assert.throws(() => applyInstalled(f.options), /not executable/);
  assert.equal(f.contents(), "0.0.100-gaaa");
});

test("failed service apply restores and restarts the previous executable", t => {
  const f = fixture(t);
  f.breakRestart();
  assert.throws(() => update(f.options), /restart failed/);
  assert.equal(f.contents(), "0.0.100-gaaa");
  assert.equal(f.calls.filter(c => c[0] === "systemctl" && c[1] === "restart").length, 2);
});

test("stopped services stay stopped during installation", t => {
  const f = fixture(t);
  f.stop();
  update(f.options);
  assert.equal(f.contents(), "0.0.200-gbbb");
  assert.ok(!f.calls.some(c => c[0] === "systemctl"));
});

test("version ordering accepts snapshots without downgrading stable releases", () => {
  assert.ok(newer("0.0.200-gbbb", "Rex 0.0.100-gaaa"));
  assert.ok(!newer("0.0.200-gbbb", "Rex 0.1.0"));
  assert.ok(!newer("0.0.200-gbbb", "Rex 0.0.200-gbbb"));
  assert.throws(() => newer("not a version", "0.0.100"), /recognizable/);
});
