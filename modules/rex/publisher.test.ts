import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyInstalled, update } from "./update.ts";
import { parseRelease } from "./release.ts";

// Exercise the actual workflow's final shell gate, not a second implementation.
const workflow = readFileSync(new URL("../../.depot/workflows/rex-update.yml", import.meta.url), "utf8");
const body = workflow.split("      - name: publish tested release record\n")[1]?.split("        run: |\n")[1];
assert.ok(body, "publisher shell step must remain discoverable");
const script = body.trimEnd().split("\n").map(line => line.slice(10)).join("\n");

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rex-publisher-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = join(root, "remote.git"), seed = join(root, "seed"), work = join(root, "publisher");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  const configure = (path: string) => {
    git(path, "config", "user.name", "fixture"); git(path, "config", "user.email", "fixture@example.test");
    git(path, "config", "commit.gpgSign", "false"); git(path, "config", "core.hooksPath", "/dev/null");
  };
  configure(seed);
  mkdirSync(join(seed, "modules/rex"), { recursive: true });
  writeFileSync(join(seed, "modules/rex/release.json"), "old pin\n");
  writeFileSync(join(seed, "unrelated.txt"), "keep me\n");
  git(seed, "add", "modules/rex/release.json", "unrelated.txt");
  git(seed, "commit", "-m", "fixture: initial main");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");
  git(root, "clone", remote, work);
  configure(work);
  const base = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "--detach", base);
  writeFileSync(join(work, "modules/rex/release.json"), "tested candidate\n");
  return { root, remote, seed, work, base, git,
    publish: () => spawnSync("bash", ["-c", script], { cwd: work, env: { ...env, TESTED_BASE: base }, encoding: "utf8" }) };
}

test("only Depot CI owns the schedule and manual runs default to read-only validation", () => {
  assert.equal(existsSync(new URL("../../.github/workflows/rex-update.yml", import.meta.url)), false);
  assert.match(workflow, /publish:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: false/);
  const checkGuard = (source: string) => {
    const guard = source.match(/^  publish:\n[\s\S]*?\n    if: ([^\n]+)/m)?.[1];
    assert.ok(guard);
    assert.match(guard, /github\.ref == 'refs\/heads\/main'/);
    assert.match(guard, /github\.event_name == 'schedule' \|\| inputs\.publish == true/);
  };
  checkGuard(workflow);
  assert.throws(() => checkGuard(workflow.replace("github.ref == 'refs/heads/main' && ", "")));
  assert.match(workflow, /ref: \$\{\{[^\n]+\|\| github\.sha \}\}/);
});

test("publisher pushes only the tested release record directly to main", t => {
  const f = fixture(t), result = f.publish();
  assert.equal(result.status, 0, result.stderr);
  const head = f.git(f.remote, "rev-parse", "refs/heads/main");
  assert.notEqual(head, f.base);
  assert.equal(f.git(f.remote, "diff-tree", "--no-commit-id", "--name-only", "-r", head), "modules/rex/release.json");
  assert.equal(f.git(f.remote, "show", "main:modules/rex/release.json"), "tested candidate");
  assert.equal(f.git(f.remote, "show", "main:unrelated.txt"), "keep me");
});

test("moving main rejects the stale candidate without force/rebase or losing the other commit", t => {
  const f = fixture(t);
  writeFileSync(join(f.seed, "unrelated.txt"), "new unpublished-to-publisher work\n");
  f.git(f.seed, "add", "unrelated.txt"); f.git(f.seed, "commit", "-m", "fixture: main moved");
  f.git(f.seed, "push", "origin", "main");
  const moved = f.git(f.remote, "rev-parse", "refs/heads/main"), result = f.publish();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main moved/);
  assert.equal(f.git(f.remote, "rev-parse", "refs/heads/main"), moved);
  assert.equal(f.git(f.remote, "show", "main:modules/rex/release.json"), "old pin");
  assert.equal(f.git(f.work, "rev-parse", "HEAD"), f.base);
});

test("a committed pin reaches isolated consumers, including offline catch-up", t => {
  const f = fixture(t), archive = "approved fixture archive", commit = "b".repeat(40);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const release = parseRelease({ schemaVersion: 1, product: "rex", channel: "snapshot", version: "0.0.200-gbbbbbb", commit,
    artifacts: Object.fromEntries([["x64", "amd64"], ["arm64", "arm64"]].map(([arch, name]) => [arch, {
      url: `https://blob.superlogical.com/download/rex/snapshot/${commit}/rex-linux-${name}.tar.gz`, sha256,
    }])) });
  writeFileSync(join(f.work, "modules/rex/release.json"), JSON.stringify(release));
  assert.equal(f.publish().status, 0);
  const publishedCommit = f.git(f.remote, "rev-parse", "main");
  let offline = true;
  const hosts = ["online-a", "offline", "online-b"].map(name => {
    const root = join(f.root, name), binary = join(root, "usr/local/bin/rex");
    mkdirSync(join(root, "usr/local/bin"), { recursive: true });
    writeFileSync(binary, "0.0.100-gaaaaaa");
    const run = (command: string, args: string[]) => {
      if (command === "systemctl") return "";
      if (command === "curl") {
        if (name === "offline" && offline) throw new Error("host offline");
        if (!args.includes("--output")) return f.git(f.remote, "show", "main:modules/rex/release.json");
        writeFileSync(args[args.indexOf("--output") + 1], archive);
        return "";
      }
      if (command === "tar") {
        writeFileSync(join(args[args.indexOf("--directory") + 1], "rex"), release.version);
        return "";
      }
      const installed = readFileSync(command, "utf8");
      return args[0] === "version" ? `rex ${installed}\ncommit: ${installed === release.version ? commit : "a".repeat(40)}\n` : "usage";
    };
    const options = { root, arch: "x64", run, active: () => true };
    applyInstalled({ ...options, active: () => false });
    return { name, root, binary, options };
  });
  for (const host of hosts) {
    if (host.name === "offline") {
      assert.throws(() => update(host.options), /offline/);
      assert.equal(readFileSync(host.binary, "utf8"), "0.0.100-gaaaaaa");
    } else assert.match(update(host.options), /updated to/);
  }
  offline = false;
  assert.match(update(hosts[1].options), /updated to/);
  for (const host of hosts) {
    const receipt = JSON.parse(readFileSync(join(host.root, "var/lib/rex-update/applied.json"), "utf8"));
    assert.deepEqual(receipt.release, release);
    assert.equal(receipt.binarySha256, createHash("sha256").update(readFileSync(host.binary)).digest("hex"));
  }
  assert.equal(f.git(f.remote, "rev-parse", "main"), publishedCommit, "consumers never write back to git");
});

test("unexpected staged paths block publication", t => {
  const f = fixture(t);
  writeFileSync(join(f.work, "unrelated.txt"), "do not publish this\n");
  f.git(f.work, "add", "unrelated.txt");
  assert.notEqual(f.publish().status, 0);
  assert.equal(f.git(f.remote, "rev-parse", "refs/heads/main"), f.base);
  assert.equal(readFileSync(join(f.work, "unrelated.txt"), "utf8"), "do not publish this\n");
});
