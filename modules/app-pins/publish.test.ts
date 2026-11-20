import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publish } from "./publish.ts";
import type { AppSpec, Deps } from "./pins.ts";

// isolated git: no user config, hooks, signing, or credentials leak in or out.
const env = { ...process.env, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function plist(path: string, version: string) {
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.demo</string><key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string></dict></plist>`);
}
const pin = (version: string) => `${JSON.stringify({ schemaVersion: 1, app: "demo", version, build: version,
  darwin: { arm64: { url: `https://example.test/Demo-${version}.zip`, sha256: createHash("sha256").update(version).digest("hex"), format: "zip" } } }, null, 2)}\n`;

function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "app-pins-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), user = join(root, "user");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, user);
  mkdirSync(join(user, "modules/demo"), { recursive: true });
  writeFileSync(join(user, "modules/demo/app-pin.json"), pin("1.0.0"));
  writeFileSync(join(user, "notes.md"), "committed\n");
  git(user, "add", "."); git(user, "commit", "-m", "initial"); git(user, "push", "origin", "main");
  const spec: AppSpec = { bundle: join(root, "apps/Demo.app"), bundleId: "dev.demo", pin: "modules/demo/app-pin.json",
    compare: "short", feed: { kind: "github", repo: "o/demo", tag: "v{version}", asset: "Demo-{version}.zip" } };
  const deps = (onFetch?: () => void): Deps => ({
    run: (command, args) => execFileSync(command, args, { encoding: "utf8" }),
    text: async url => {
      onFetch?.();
      const version = /tags\/v([^/]+)$/.exec(url)![1];
      return JSON.stringify({ assets: [{ name: `Demo-${version}.zip`, browser_download_url: `https://example.test/Demo-${version}.zip`,
        digest: `sha256:${createHash("sha256").update(version).digest("hex")}` }] });
    },
    download: async () => { throw new Error("publish must not download artifacts"); },
  });
  return { root, remote, user, spec, deps, options: { remote, cacheDir: join(root, "caches"), host: "mbp-test", env } };
}

test("publishes a bump commit to main with host provenance", async t => {
  const f = fixture(t);
  plist(f.spec.bundle, "1.2.0");
  const r = await publish("demo", f.deps(), f.options, f.spec);
  assert.equal(r.status, "published");
  const log = git(f.remote, "log", "-1", "--format=%s%n%n%b", "main");
  assert.equal(log, "bump demo (auto-committed from mbp-test)\n\n1.0.0 -> 1.2.0");
  assert.equal(git(f.remote, "show", "main:modules/demo/app-pin.json"), pin("1.2.0").trim());
  assert.equal(git(f.remote, "diff", "--name-only", "main~1", "main"), "modules/demo/app-pin.json", "only the pin changes");
  assert.equal((await publish("demo", f.deps(), f.options, f.spec)).status, "unchanged", "no empty commits");
});

test("the user's checkout is untouched, whatever state it is in", async t => {
  const f = fixture(t);
  // dirty tracked file, untracked file, staged change, and a conflicting local pin edit.
  writeFileSync(join(f.user, "notes.md"), "uncommitted edit\n");
  writeFileSync(join(f.user, "scratch.txt"), "untracked\n");
  writeFileSync(join(f.user, "modules/demo/app-pin.json"), pin("0.9.0"));
  git(f.user, "add", "modules/demo/app-pin.json");
  git(f.user, "switch", "-c", "elsewhere");
  const before = [git(f.user, "status", "--porcelain=v1"), git(f.user, "rev-parse", "HEAD"), git(f.user, "branch", "--show-current"),
    readFileSync(join(f.user, ".git/index")).toString("base64")];
  plist(f.spec.bundle, "1.2.0");
  assert.equal((await publish("demo", f.deps(), f.options, f.spec)).status, "published");
  const after = [git(f.user, "status", "--porcelain=v1"), git(f.user, "rev-parse", "HEAD"), git(f.user, "branch", "--show-current"),
    readFileSync(join(f.user, ".git/index")).toString("base64")];
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(f.user, "notes.md"), "utf8"), "uncommitted edit\n");
});

test("a concurrent push to main is preserved: the bump retries on top of it", async t => {
  const f = fixture(t);
  plist(f.spec.bundle, "1.2.0");
  let raced = false;
  // another host pushes an unrelated commit while this one resolves the feed.
  const deps = f.deps(() => {
    if (raced) return;
    raced = true;
    const other = join(f.root, "other");
    git(f.root, "clone", f.remote, other);
    writeFileSync(join(other, "notes.md"), "from another host\n");
    git(other, "commit", "-am", "unrelated"); git(other, "push", "origin", "main");
  });
  const r = await publish("demo", deps, f.options, f.spec);
  assert.equal(r.status, "published");
  assert.equal(r.attempts, 2);
  assert.equal(git(f.remote, "log", "--format=%s", "main"), "bump demo (auto-committed from mbp-test)\nunrelated\ninitial");
  assert.equal(git(f.remote, "show", "main:notes.md"), "from another host");
});

test("losing a race to a newer pin from another host is a no-op, not a downgrade", async t => {
  const f = fixture(t);
  plist(f.spec.bundle, "1.2.0");
  let raced = false;
  const deps = f.deps(() => {
    if (raced) return;
    raced = true;
    const other = join(f.root, "other");
    git(f.root, "clone", f.remote, other);
    writeFileSync(join(other, "modules/demo/app-pin.json"), pin("1.3.0"));
    git(other, "commit", "-am", "bump demo (auto-committed from mbp-other)"); git(other, "push", "origin", "main");
  });
  assert.equal((await publish("demo", deps, f.options, f.spec)).status, "unchanged");
  assert.equal(git(f.remote, "log", "-1", "--format=%s", "main"), "bump demo (auto-committed from mbp-other)");
  assert.match(git(f.remote, "show", "main:modules/demo/app-pin.json"), /1\.3\.0/);
});

test("agents for different apps publish concurrently without sharing git state", async t => {
  const f = fixture(t);
  plist(f.spec.bundle, "1.2.0");
  const other: AppSpec = { ...f.spec, pin: "modules/demo2/app-pin.json" };
  const results = await Promise.all([publish("demo", f.deps(), f.options, f.spec), publish("demo2", f.deps(), f.options, other)]);
  assert.deepEqual(results.map(r => r.status), ["published", "published"]);
  assert.deepEqual(git(f.remote, "log", "--format=%s", "main").split("\n").slice(0, 2).sort(),
    ["bump demo (auto-committed from mbp-test)", "bump demo2 (auto-committed from mbp-test)"]);
});

test("a cache left half-built by a crash is rebuilt, not trusted", async t => {
  const f = fixture(t);
  plist(f.spec.bundle, "1.2.0");
  mkdirSync(join(f.options.cacheDir, "demo.git"), { recursive: true }); // crash before HEAD existed
  assert.equal((await publish("demo", f.deps(), f.options, f.spec)).status, "published");
});
