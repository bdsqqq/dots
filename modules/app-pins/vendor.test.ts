import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { worktree, type Deps } from "./pins.ts";
import { installVendor, platforms, recordVendor, installedVendor, type VendorApp } from "./vendor.ts";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "app-pins-vendor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), repo = join(root, "repo"), files = join(root, "files");
  for (const dir of [home, join(repo, "modules"), files]) mkdirSync(dir, { recursive: true });
  return { root, home, repo, files };
}
function deps(api: Record<string, unknown>, files: Record<string, string>): Deps {
  return {
    run: (command, args) => execFileSync(command, args, { encoding: "utf8" }),
    text: async url => { if (!(url in api)) throw new Error(`no fixture for ${url}`); return JSON.stringify(api[url]); },
    download: async (url, dest) => {
      if (!(url in files)) throw new Error(`no artifact for ${url}`);
      writeFileSync(dest, readFileSync(files[url]));
    },
  };
}

// claude: one executable per version under versions/, selected by ~/.local/bin/claude.
const claudeApp = (home: string): VendorApp =>
  ({ name: "claude", kind: "vendor", layout: "claude", pin: "modules/claude/app-pin.json", watch: [], home });
const claudeBase = "https://downloads.claude.ai/claude-code-releases";
function claudeRelease(files: string, version: string) {
  const binaries = Object.fromEntries(platforms.map(p => {
    const file = join(files, `claude-${version}-${p}`);
    writeFileSync(file, `#!/bin/sh\necho ${version} ${p}\n`);
    return [p, file];
  }));
  return {
    api: { [`${claudeBase}/${version}/manifest.json`]: { version,
      platforms: Object.fromEntries(platforms.map(p => [p, { checksum: digest(binaries[p]), size: 1 }])) } },
    files: Object.fromEntries(platforms.map(p => [`${claudeBase}/${version}/${p}/claude`, binaries[p]])),
  };
}
function claudeInstall(home: string, version: string) {
  const file = join(home, ".local/share/claude/versions", version);
  mkdirSync(join(home, ".local/share/claude/versions"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(file, "native\n", { mode: 0o755 });
  rmSync(join(home, ".local/bin/claude"), { force: true });
  symlinkSync(file, join(home, ".local/bin/claude"));
}

test("claude: record pins every platform's build of the installed version", async t => {
  const f = fixture(t), app = claudeApp(f.home), v = claudeRelease(f.files, "2.1.329");
  assert.deepEqual(await recordVendor(app, worktree(f.repo), deps({}, {})), { status: "absent" });
  claudeInstall(f.home, "2.1.329");
  const r = await recordVendor(app, worktree(f.repo), deps(v.api, {}));
  assert.deepEqual(r, { status: "recorded", from: undefined, to: "2.1.329", linuxAdvanced: false, changed: true });
  const pin = JSON.parse(readFileSync(join(f.repo, app.pin), "utf8"));
  assert.deepEqual(Object.keys(pin.builds), [...platforms]);
  assert.equal(pin.builds["linux-x64"].url, `${claudeBase}/2.1.329/linux-x64/claude`);
  assert.equal(pin.builds["linux-x64"].sha256, digest(v.files[`${claudeBase}/2.1.329/linux-x64/claude`]));
  claudeInstall(f.home, "2.1.300");
  assert.equal((await recordVendor(app, worktree(f.repo), deps({}, {}))).status, "unchanged", "an older install never lowers the pin");
});

test("claude: install selects the pinned build, and leaves equal or newer installs alone", async t => {
  const f = fixture(t), app = claudeApp(f.home), v = claudeRelease(f.files, "2.1.329");
  claudeInstall(f.home, "2.1.329");
  await recordVendor(app, worktree(f.repo), deps(v.api, {}));
  rmSync(join(f.home, ".local"), { recursive: true });
  assert.deepEqual(await installVendor(app, worktree(f.repo), deps({}, v.files), "linux-x64"), { status: "installed", version: "2.1.329" });
  const link = join(f.home, ".local/bin/claude");
  assert.equal(readlinkSync(link), join(f.home, ".local/share/claude/versions/2.1.329"));
  assert.match(execFileSync(link, { encoding: "utf8" }), /2\.1\.329 linux-x64/, "the platform's own build, executable");
  assert.equal((await installVendor(app, worktree(f.repo), deps({}, {}), "linux-x64")).status, "current");
  claudeInstall(f.home, "2.2.0");
  assert.equal((await installVendor(app, worktree(f.repo), deps({}, {}), "linux-x64")).status, "newer");
  assert.equal(readlinkSync(link), join(f.home, ".local/share/claude/versions/2.2.0"), "a self-updated cli is never downgraded");
});

test("claude: a tampered download is rejected and the old build stays selected", async t => {
  const f = fixture(t), app = claudeApp(f.home), v = claudeRelease(f.files, "2.1.329");
  claudeInstall(f.home, "2.1.329");
  await recordVendor(app, worktree(f.repo), deps(v.api, {}));
  claudeInstall(f.home, "2.1.300");
  rmSync(join(f.home, ".local/share/claude/versions/2.1.329"));
  const evil = join(f.files, "evil");
  writeFileSync(evil, "#!/bin/sh\necho pwned\n");
  const tampered = Object.fromEntries(Object.keys(v.files).map(url => [url, evil]));
  await assert.rejects(installVendor(app, worktree(f.repo), deps({}, tampered), "linux-x64"), /hash mismatch/);
  assert.equal(readlinkSync(join(f.home, ".local/bin/claude")), join(f.home, ".local/share/claude/versions/2.1.300"));
  assert.ok(!existsSync(join(f.home, ".local/share/claude/versions/2.1.329")));
});

test("a cli that is not the vendor's native install is refused, not overwritten", async t => {
  const f = fixture(t), app = claudeApp(f.home);
  mkdirSync(join(f.home, ".local/bin"), { recursive: true });
  symlinkSync("/opt/elsewhere/claude", join(f.home, ".local/bin/claude"));
  assert.throws(() => installedVendor(app), /not a native install/);
  rmSync(join(f.home, ".local/bin/claude"));
  writeFileSync(join(f.home, ".local/bin/claude"), "#!/bin/sh\n");
  assert.throws(() => installedVendor(app), /not a vendor link/);
});

// codex: one package directory per release, selected by standalone/current.
const codexApp = (home: string): VendorApp =>
  ({ name: "codex", kind: "vendor", layout: "codex", pin: "modules/codex/app-pin.json", watch: [], home });
const targets = { "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl" };
const codexBase = "https://releases.openai.com/codex/releases";
function codexPackage(dir: string, version: string, target: string) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/codex"), `#!/bin/sh\necho codex-cli ${version}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version, target, entrypoint: "bin/codex" }));
}
function codexRelease(files: string, version: string, overrideTarget?: string) {
  const archives = Object.fromEntries(Object.entries(targets).map(([p, target]) => {
    const stage = join(files, `stage-${version}-${p}`), archive = join(files, `codex-${version}-${p}.tar.gz`);
    codexPackage(stage, version, overrideTarget ?? target);
    execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
    return [p, archive];
  }));
  const url = (p: string) => `${codexBase}/${version}/codex-package-${targets[p as keyof typeof targets]}.tar.gz`;
  return {
    api: { [`${codexBase}/${version}/release.json`]: { tag_name: `rust-v${version}`, assets: Object.keys(targets).map(p => (
      { name: `codex-package-${targets[p as keyof typeof targets]}.tar.gz`, browser_download_url: url(p), digest: `sha256:${digest(archives[p])}` })) } },
    files: Object.fromEntries(Object.keys(targets).map(p => [url(p), archives[p]])),
  };
}
function codexInstall(home: string, version: string, target = targets["darwin-arm64"]) {
  const root = join(home, ".codex/packages/standalone"), release = join(root, "releases", `${version}-${target}`);
  codexPackage(release, version, target);
  rmSync(join(root, "current"), { force: true });
  symlinkSync(release, join(root, "current"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  rmSync(join(home, ".local/bin/codex"), { force: true });
  symlinkSync(join(root, "current/bin/codex"), join(home, ".local/bin/codex"));
}

test("codex: record pins every platform's package for the selected release", async t => {
  const f = fixture(t), app = codexApp(f.home), v = codexRelease(f.files, "0.169.1");
  codexInstall(f.home, "0.169.1");
  assert.equal((await recordVendor(app, worktree(f.repo), deps(v.api, {}))).status, "recorded");
  const pin = JSON.parse(readFileSync(join(f.repo, app.pin), "utf8"));
  assert.equal(pin.version, "0.169.1");
  assert.equal(pin.builds["linux-arm64"].url, `${codexBase}/0.169.1/codex-package-aarch64-unknown-linux-musl.tar.gz`);
});

test("codex: install unpacks into the vendor layout and moves only the selection", async t => {
  const f = fixture(t), app = codexApp(f.home), v = codexRelease(f.files, "0.169.1");
  codexInstall(f.home, "0.169.1");
  await recordVendor(app, worktree(f.repo), deps(v.api, {}));
  codexInstall(f.home, "0.167.0", targets["linux-x64"]);
  const root = join(f.home, ".codex/packages/standalone");
  writeFileSync(join(root, "auto-update-version"), "0.167.0-x86_64-unknown-linux-musl");
  assert.deepEqual(await installVendor(app, worktree(f.repo), deps({}, v.files), "linux-x64"), { status: "installed", version: "0.169.1" });
  const release = join(root, "releases/0.169.1-x86_64-unknown-linux-musl");
  assert.equal(readlinkSync(join(root, "current")), release);
  assert.equal(readlinkSync(join(release, "codex")), "bin/codex", "the alias the vendor installer expects");
  assert.match(execFileSync(join(f.home, ".local/bin/codex"), { encoding: "utf8" }), /codex-cli 0\.169\.1/);
  assert.equal(readFileSync(join(root, "selection-history"), "utf8").split("\n").slice(0, 2).join(" "),
    "0.169.1-x86_64-unknown-linux-musl 0.167.0-x86_64-unknown-linux-musl");
  assert.ok(!existsSync(join(root, "auto-update-version")), "a pinned release is not on the latest channel");
  assert.equal((await installVendor(app, worktree(f.repo), deps({}, {}), "linux-x64")).status, "current");
});

test("codex: an archive for the wrong target is rejected before anything is selected", async t => {
  const f = fixture(t), app = codexApp(f.home);
  codexInstall(f.home, "0.169.1");
  await recordVendor(app, worktree(f.repo), deps(codexRelease(f.files, "0.169.1").api, {}));
  const wrong = codexRelease(join(f.files), "0.169.1", "aarch64-apple-darwin");
  codexInstall(f.home, "0.167.0", targets["linux-x64"]);
  // the digests match the wrong archives, so only the package check can catch them.
  const pinned = JSON.parse(readFileSync(join(f.repo, app.pin), "utf8"));
  for (const p of platforms) pinned.builds[p].sha256 = digest(wrong.files[pinned.builds[p].url]);
  writeFileSync(join(f.repo, app.pin), JSON.stringify(pinned));
  await assert.rejects(installVendor(app, worktree(f.repo), deps({}, wrong.files), "linux-x64"), /not the pinned build/);
  const root = join(f.home, ".codex/packages/standalone");
  assert.equal(readlinkSync(join(root, "current")), join(root, "releases/0.167.0-x86_64-unknown-linux-musl"));
});

test("codex: an update that lands while the pin downloads wins", async t => {
  const f = fixture(t), app = codexApp(f.home), v = codexRelease(f.files, "0.169.1");
  codexInstall(f.home, "0.169.1");
  await recordVendor(app, worktree(f.repo), deps(v.api, {}));
  codexInstall(f.home, "0.167.0", targets["linux-x64"]);
  const d = deps({}, v.files);
  const racing: Deps = { ...d, download: async (url, dest) => { await d.download(url, dest); codexInstall(f.home, "0.171.0", targets["linux-x64"]); } };
  assert.deepEqual(await installVendor(app, worktree(f.repo), racing, "linux-x64"), { status: "newer", version: "0.171.0" });
  const root = join(f.home, ".codex/packages/standalone");
  assert.equal(readlinkSync(join(root, "current")), join(root, "releases/0.171.0-x86_64-unknown-linux-musl"));
});
