import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compare, install, record, type AppSpec, type Deps } from "./pins.ts";

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
      if (command === "pgrep") throw new Error("not running");
      return execFileSync(command, args, { encoding: "utf8" });
    },
    text: async url => { if (!(url in api)) throw new Error(`no fixture for ${url}`); return JSON.stringify(api[url]); },
    download: async (url, dest) => { writeFileSync(dest, readFileSync(files[url])); },
  };
}
const githubSpec = (root: string): AppSpec => ({
  bundle: join(root, "apps/Demo.app"), bundleId: "dev.demo", pin: "modules/demo/app-pin.json", compare: "short",
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
  assert.deepEqual(await record("demo", repo, d, spec), { app: "demo", status: "recorded", version: "1.2.0", linux: undefined });
  const pin = JSON.parse(readFileSync(join(repo, spec.pin), "utf8"));
  assert.equal(pin.darwin.arm64.sha256, v2.sha256);
  assert.equal(pin.darwin.arm64.format, "zip");
  assert.equal((await record("demo", repo, d, spec)).status, "unchanged");
  bundle(spec.bundle, "dev.demo", "1.1.0");
  assert.equal((await record("demo", repo, d, spec)).status, "unchanged", "an older install never downgrades the pin");
  assert.equal(JSON.parse(readFileSync(join(repo, spec.pin), "utf8")).version, "1.2.0");
});

test("record refuses a bundle with a different identity", async t => {
  const root = fixture(t), spec = githubSpec(root);
  bundle(spec.bundle, "dev.impostor", "9.0.0");
  await assert.rejects(record("demo", join(root, "repo"), deps({}, {}), spec), /not dev\.demo/);
});

test("install fills missing or older apps, and leaves newer ones alone", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  const d = deps({ "https://example.test/Demo-1.2.0.zip": v2.file }, release("1.2.0", v2.sha256));
  await record("demo", repo, d, spec);

  rmSync(spec.bundle, { recursive: true });
  assert.equal((await install("demo", repo, d, spec)).status, "installed");
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /1\.2\.0/);
  assert.equal((await install("demo", repo, d, spec)).status, "current");

  bundle(spec.bundle, "dev.demo", "1.0.0");
  assert.equal((await install("demo", repo, d, spec)).status, "installed", "older install is upgraded to the pin");

  bundle(spec.bundle, "dev.demo", "2.0.0");
  assert.equal((await install("demo", repo, d, spec)).status, "newer", "a self-updated app is never downgraded");
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /2\.0\.0/);
});

test("install rejects a corrupted artifact and keeps the existing app", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0"), tampered = zipArtifact(root, "6.6.6");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record("demo", repo, deps({}, release("1.2.0", v2.sha256)), spec);
  bundle(spec.bundle, "dev.demo", "1.0.0");
  const d = deps({ "https://example.test/Demo-1.2.0.zip": tampered.file }, {});
  await assert.rejects(install("demo", repo, d, spec), /hash mismatch/);
  assert.match(readFileSync(join(spec.bundle, "Contents/Info.plist"), "utf8"), /1\.0\.0/);
});

test("install skips an older app while it is running", async t => {
  const root = fixture(t), spec = githubSpec(root), repo = join(root, "repo");
  const v2 = zipArtifact(root, "1.2.0");
  bundle(spec.bundle, "dev.demo", "1.2.0");
  await record("demo", repo, deps({}, release("1.2.0", v2.sha256)), spec);
  bundle(spec.bundle, "dev.demo", "1.0.0");
  const running: Deps = { ...deps({}, {}), run: (command, args) =>
    command === "pgrep" ? "123\n" : execFileSync(command, args, { encoding: "utf8" }) };
  assert.equal((await install("demo", repo, running, spec)).status, "running");
});

test("sparkle record pins the installed build, not the newest appcast item", async t => {
  const root = fixture(t), repo = join(root, "repo");
  const artifact = zipArtifact(root, "1.0.0");
  const spec: AppSpec = { bundle: join(root, "apps/Demo.app"), bundleId: "dev.demo", pin: "modules/demo/app-pin.json",
    compare: "build", feed: { kind: "sparkle", url: "https://example.test/appcast.xml" } };
  bundle(spec.bundle, "dev.demo", "1.0.0", "41");
  const item = (build: string) => `<item><sparkle:version>${build}</sparkle:version>
    <description>Rex 0.1.0 (\`${"a".repeat(40)}\`)</description>
    <enclosure url="https://example.test/Demo-${build}.zip"/></item>`;
  const d: Deps = { ...deps({ "https://example.test/Demo-41.zip": artifact.file }, {}),
    text: async () => `<rss><channel>${item("42")}${item("41")}</channel></rss>` };
  await record("demo", repo, d, spec);
  const pin = JSON.parse(readFileSync(join(repo, spec.pin), "utf8"));
  assert.equal(pin.build, "41");
  assert.equal(pin.darwin.arm64.url, "https://example.test/Demo-41.zip");
  assert.equal(pin.darwin.arm64.sha256, artifact.sha256);
  assert.equal(pin.rexCommit, "a".repeat(40));
});
