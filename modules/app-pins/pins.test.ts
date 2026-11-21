import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compare, install, record, worktree, type BundleApp as App, type Deps } from "./pins.ts";

const plist = (id: string, version: string, build: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
</dict></plist>`;
function bundle(path: string, id: string, version: string, build = version) {
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents/Info.plist"), plist(id, version, build));
}
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "app-pins-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "repo/modules/demo"), { recursive: true });
  return root;
}
// a zip artifact containing Demo.app at the given version, served from memory.
function zipArtifact(root: string, version: string) {
  const stage = join(root, `stage-${version}`);
  bundle(join(stage, "Demo.app"), "dev.demo", version);
  const file = join(root, `Demo-${version}.zip`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", join(stage, "Demo.app"), file]);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}
function deps(files: Record<string, string>, api: Record<string, unknown>, calls: string[] = []): Deps {
  return {
    run: (command, args) => {
      calls.push(command);
      if (command === "pgrep") throw Object.assign(new Error("not running"), { status: 1 });
      return execFileSync(command, args, { encoding: "utf8" });
    },
    text: async url => { if (!(url in api)) throw new Error(`no fixture for ${url}`); return JSON.stringify(api[url]); },
    download: async (url, dest) => { writeFileSync(dest, readFileSync(files[url])); },
  };
}
const githubSpec = (root: string): App => ({
  name: "demo", bundle: join(root, "apps/Demo.app"), bundleId: "dev.demo", pin: "modules/demo/app-pin.json", compare: "short",
  feed: { kind: "github", repo: "o/demo", tag: "v{version}", asset: "Demo-{version}.zip" },
});
const release = (version: string, sha256: string) => ({
  [`https://api.github.com/repos/o/demo/releases/tags/v${version}`]: { assets: [
    { name: `Demo-${version}.zip`, browser_download_url: `https://example.test/Demo-${version}.zip`, digest: `sha256:${sha256}` },
  ] },
});

test("versions compare by numeric runs, including nightly suffixes", () => {
  assert.equal(compare("0.1.11-nightly.20261118.4877", "0.1.11-nightly.20261120.4979"), -1);
  assert.equal(compare("0.22.1.1", "0.21.3.1"), 1);
  assert.equal(compare("2067", "2067"), 0);
});

test("record pins the exact installed build, then ignores equal and older installs", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  const d = deps({}, release("1.2.0", v2.sha256));
  assert.deepEqual(await record(spec, worktree(repo), d), { status: "recorded", from: undefined, to: "1.2.0", linuxAdvanced: false, changed: true });
  const pin = JSON.parse(readFileSync(join(repo, spec.pin), "utf8"));
  assert.equal(pin.darwin.arm64.sha256, v2.sha256);
  assert.equal(pin.darwin.arm64.format, "zip");
  assert.equal((await record(spec, worktree(repo), d)).status, "unchanged");
  bundle(spec.bundle, "dev.demo", "1.1.0");
  assert.equal((await record(spec, worktree(repo), d)).status, "unchanged", "an older install never downgrades the pin");
  assert.equal(JSON.parse(readFileSync(join(repo, spec.pin), "utf8")).version, "1.2.0");
});

test("record refuses a bundle with a different identity", async t => {
  const root = fixture(t), spec = githubSpec(root);
  bundle(spec.bundle, "dev.impostor", "9.0.0");
  await assert.rejects(record(spec, worktree(join(root, "repo")), deps({}, {})), /not dev\.demo/);
});

test("install fills missing or older apps, and leaves newer ones alone", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  const d = deps({ "https://example.test/Demo-1.2.0.zip": v2.file }, release("1.2.0", v2.sha256));
  await record(spec, worktree(repo), d);

  rmSync(spec.bundle, { recursive: true });
  assert.equal((await install(spec, worktree(repo), d)).status, "installed");
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /1\.2\.0/);
  assert.equal((await install(spec, worktree(repo), d)).status, "current");

  bundle(spec.bundle, "dev.demo", "1.0.0");
  assert.equal((await install(spec, worktree(repo), d)).status, "installed", "older install is upgraded to the pin");

  bundle(spec.bundle, "dev.demo", "2.0.0");
  assert.equal((await install(spec, worktree(repo), d)).status, "newer", "a self-updated app is never downgraded");
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /2\.0\.0/);
});

test("install rejects a corrupted artifact and keeps the existing app", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0"), tampered = zipArtifact(root, "6.6.6");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record(spec, worktree(repo), deps({}, release("1.2.0", v2.sha256)));
  bundle(spec.bundle, "dev.demo", "1.0.0");
  const d = deps({ "https://example.test/Demo-1.2.0.zip": tampered.file }, {});
  await assert.rejects(install(spec, worktree(repo), d), /hash mismatch/);
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /1\.0\.0/);
});

test("install skips an older app while it is running", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record(spec, worktree(repo), deps({}, release("1.2.0", v2.sha256)));
  bundle(spec.bundle, "dev.demo", "1.0.0");
  const running: Deps = { ...deps({}, {}), run: (command, args) =>
    command === "pgrep" ? "123\n" : execFileSync(command, args, { encoding: "utf8" }) };
  assert.equal((await install(spec, worktree(repo), running)).status, "running");
});

test("sparkle record pins the installed build, not the newest appcast item", async t => {
  const root = fixture(t), repo = join(root, "repo");
  const artifact = zipArtifact(root, "1.0.0");
  const spec: App = { name: "demo", bundle: join(root, "apps/Demo.app"), bundleId: "dev.demo", pin: "modules/demo/app-pin.json",
    compare: "build", feed: { kind: "sparkle", url: "https://example.test/appcast.xml" } };
  bundle(spec.bundle, "dev.demo", "1.0.0", "41");
  const item = (build: string) => `<item><sparkle:version>${build}</sparkle:version>
    <description>Rex 0.1.0 (\`${"a".repeat(40)}\`)</description>
    <enclosure url="https://example.test/Demo-${build}.zip"/></item>`;
  const d: Deps = { ...deps({ "https://example.test/Demo-41.zip": artifact.file }, {}),
    text: async () => `<rss><channel>${item("42")}${item("41")}</channel></rss>` };
  await record(spec, worktree(repo), d);
  const pin = JSON.parse(readFileSync(join(repo, spec.pin), "utf8"));
  assert.equal(pin.build, "41");
  assert.equal(pin.darwin.arm64.url, "https://example.test/Demo-41.zip");
  assert.equal(pin.darwin.arm64.sha256, artifact.sha256);
  assert.equal(pin.rexCommit, "a".repeat(40));
});

test("a newer app installed while the pin downloads is not overwritten", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record(spec, worktree(repo), deps({}, release("1.2.0", v2.sha256)));
  bundle(spec.bundle, "dev.demo", "1.0.0");
  const d = deps({ "https://example.test/Demo-1.2.0.zip": v2.file }, {});
  const racing: Deps = { ...d, download: async (url, dest) => { await d.download(url, dest); bundle(spec.bundle, "dev.demo", "3.0.0"); } };
  assert.equal((await install(spec, worktree(repo), racing)).status, "newer");
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /3\.0\.0/);
});

test("the running check matches bundle paths with regex metacharacters", async t => {
  const root = fixture(t), spec = { ...githubSpec(root), bundle: join(root, "apps/Demo (Nightly).app") };
  const repo = join(root, "repo"), v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record(spec, worktree(repo), deps({}, release("1.2.0", v2.sha256)));
  bundle(spec.bundle, "dev.demo", "1.0.0");
  // a real process whose argv starts with the bundle executable path.
  const exe = join(spec.bundle, "Contents/MacOS/Demo");
  mkdirSync(join(spec.bundle, "Contents/MacOS"), { recursive: true });
  writeFileSync(exe, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const child = (await import("node:child_process")).spawn(exe, [], { stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise(r => setTimeout(r, 300));
  const real: Deps = { ...deps({}, {}), run: (command, args) => execFileSync(command, args, { encoding: "utf8" }) };
  assert.equal((await install(spec, worktree(repo), real)).status, "running");
});

test("a linux pin that failed to resolve is retried without a new mac update", async t => {
  const root = fixture(t), repo = join(root, "repo"), v2 = zipArtifact(root, "1.2.0");
  const spec: App = { ...githubSpec(root), feed: { kind: "github", repo: "o/demo", tag: "v{version}", asset: "Demo-{version}.zip",
    linux: { repo: "o/demo-linux", assets: { x64: "demo-{version}-x64", arm64: "demo-{version}-arm64" } } } };
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record(spec, worktree(repo), deps({}, release("1.2.0", v2.sha256)));
  assert.equal(JSON.parse(readFileSync(join(repo, spec.pin), "utf8")).linux, undefined, "linux not published yet");
  const linux = { "https://api.github.com/repos/o/demo-linux/releases/tags/v1.2.0": { assets: ["x64", "arm64"].map(a => (
    { name: `demo-1.2.0-${a}`, browser_download_url: `https://example.test/demo-1.2.0-${a}`, digest: `sha256:${"b".repeat(64)}` })) } };
  const later = await record(spec, worktree(repo), deps({}, { ...release("1.2.0", v2.sha256), ...linux }));
  assert.ok(later.status === "unchanged" && later.linuxAdvanced && later.changed);
  assert.equal(JSON.parse(readFileSync(join(repo, spec.pin), "utf8")).linux.version, "1.2.0");
});
