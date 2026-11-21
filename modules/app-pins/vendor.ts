/**
 * vendor CLIs (claude, codex) installed in their vendor's own native layout, which T3
 * and the vendors' updaters already manage. every host records what its updater
 * accepted, and every host installs the pin, so all hosts run the same build.
 */
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AppPinError, compare, json, sha, type Artifact, type Deps, type InstallResult, type Installed,
  type RecordResult, type Store } from "./core.ts";

export type Layout = "claude" | "codex";
export type VendorApp = {
  name: string; kind: "vendor"; layout: Layout; pin: string;
  /** directories, relative to home, that change when the updater installs a build. */
  watch: string[];
  /** tests point this at a temporary directory; defaults to the user's home. */
  home?: string;
};
export const platforms = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export type Platform = typeof platforms[number];
export type VendorPin = { schemaVersion: 1; app: string; version: string; builds: Record<Platform, Artifact> };

export function platformKey(platform = process.platform, arch = process.arch): Platform {
  const key = `${platform}-${arch}`;
  if (!platforms.some(p => p === key)) throw new AppPinError("unsupported_platform", `no pinned builds for ${key}`);
  return key as Platform;
}
// both vendors name builds like this; anything else must never reach a url or a path.
const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export function parseVendorPin(value: unknown, app: string): VendorPin {
  const p = value as VendorPin;
  const artifact = (a: Artifact | undefined) => !!a && /^https:\/\//.test(a.url) && sha.test(a.sha256);
  if (!p || p.schemaVersion !== 1 || p.app !== app || !versionPattern.test(p.version ?? "") ||
      !platforms.every(k => artifact(p.builds?.[k]))) {
    throw new AppPinError("invalid_pin", `invalid ${app} pin`);
  }
  return p;
}
function readPin(app: VendorApp, store: Store): VendorPin | null {
  const text = store.read(app.pin);
  return text === null ? null : parseVendorPin(JSON.parse(text), app.name);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function fetchVerified(deps: Deps, artifact: Artifact, dest: string) {
  await deps.download(artifact.url, dest);
  if (await hashFile(dest) !== artifact.sha256) throw new AppPinError("artifact_hash_mismatch", "artifact hash mismatch");
}
function readlink(path: string): string | null {
  try { return readlinkSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // EINVAL: a regular file sits where the vendor expects its link.
    if (code === "EINVAL") throw new AppPinError("foreign_install", `${path} is not a vendor link`);
    throw error;
  }
}
/** symlink, then rename over the old one, so the command never disappears mid-swap. */
function swapLink(link: string, target: string) {
  mkdirSync(dirname(link), { recursive: true });
  const temporary = join(dirname(link), `.${basename(link)}.app-pins-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

type Driver = {
  /** the version the vendor's link selects; null when nothing is installed. */
  installed(home: string): string | null;
  resolve(version: string, deps: Deps): Promise<Record<Platform, Artifact>>;
  /** download and unpack beside the live install; returns what select will point at. */
  stage(home: string, version: string, artifact: Artifact, deps: Deps, platform: Platform): Promise<string>;
  /** the only step that changes which build runs. */
  select(home: string, staged: string, platform: Platform): void;
};

// claude.ai/install.sh: one binary per version, selected by ~/.local/bin/claude.
const claudeBase = "https://downloads.claude.ai/claude-code-releases";
const claude: Driver = {
  installed(home) {
    const link = join(home, ".local/bin/claude"), target = readlink(link);
    if (target === null) return null;
    const file = resolve(dirname(link), target), version = basename(file);
    if (dirname(file) !== join(home, ".local/share/claude/versions") || !versionPattern.test(version)) {
      throw new AppPinError("foreign_install", "claude is not a native install");
    }
    return version;
  },
  async resolve(version, deps) {
    const manifest = JSON.parse(await deps.text(`${claudeBase}/${version}/manifest.json`));
    if (manifest.version !== version) throw new AppPinError("feed_missing_build", `no claude ${version} manifest`);
    return Object.fromEntries(platforms.map(p => {
      const checksum = manifest.platforms?.[p]?.checksum;
      if (!sha.test(checksum ?? "")) throw new AppPinError("feed_missing_build", `claude ${version} has no ${p} build`);
      return [p, { url: `${claudeBase}/${version}/${p}/claude`, sha256: checksum }];
    })) as Record<Platform, Artifact>;
  },
  async stage(home, version, artifact, deps) {
    const dir = join(home, ".local/share/claude/versions"), file = join(dir, version);
    if (!existsSync(file) || await hashFile(file) !== artifact.sha256) {
      mkdirSync(dir, { recursive: true });
      const staging = join(dir, `.${version}.app-pins-${process.pid}`);
      try {
        await fetchVerified(deps, artifact, staging);
        chmodSync(staging, 0o755);
        renameSync(staging, file);
      } finally { rmSync(staging, { force: true }); }
    }
    return file;
  },
  select(home, file) { swapLink(join(home, ".local/bin/claude"), file); },
};

// chatgpt.com/codex/install.sh: one package directory per release, selected by
// standalone/current; ~/.local/bin/codex points through `current`.
const codexTargets: Record<Platform, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};
const standalone = (home: string) => join(home, ".codex/packages/standalone");
function codexPackage(release: string): { version: string; target: string } | null {
  try {
    const p = JSON.parse(readFileSync(join(release, "codex-package.json"), "utf8"));
    return typeof p.version === "string" && typeof p.target === "string" && existsSync(join(release, "bin/codex"))
      ? { version: p.version, target: p.target } : null;
  } catch { return null; }
}
const codex: Driver = {
  installed(home) {
    const root = standalone(home), visible = readlink(join(home, ".local/bin/codex"));
    if (visible !== null && resolve(join(home, ".local/bin"), visible) !== join(root, "current/bin/codex")) {
      throw new AppPinError("foreign_install", "codex is not a standalone install");
    }
    const target = readlink(join(root, "current"));
    if (target === null) return null;
    const release = resolve(root, target), found = codexPackage(release);
    if (dirname(release) !== join(root, "releases") || !found || basename(release) !== `${found.version}-${found.target}` ||
        !versionPattern.test(found.version)) {
      throw new AppPinError("foreign_install", "codex current is not a standalone release");
    }
    return found.version;
  },
  async resolve(version, deps) {
    const release = JSON.parse(await deps.text(`https://releases.openai.com/codex/releases/${version}/release.json`));
    if (release.tag_name !== `rust-v${version}`) throw new AppPinError("feed_missing_build", `no codex ${version} release`);
    return Object.fromEntries(platforms.map(p => {
      const name = `codex-package-${codexTargets[p]}.tar.gz`;
      const asset = (release.assets ?? []).find((a: { name: string }) => a.name === name);
      const digest = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? "")?.[1];
      if (!digest || !/^https:\/\//.test(asset.browser_download_url ?? "")) {
        throw new AppPinError("feed_missing_build", `codex ${version} has no ${name}`);
      }
      return [p, { url: asset.browser_download_url, sha256: digest }];
    })) as Record<Platform, Artifact>;
  },
  async stage(home, version, artifact, deps, platform) {
    const root = standalone(home), target = codexTargets[platform];
    const release = join(root, "releases", `${version}-${target}`);
    const matches = (dir: string) => { const p = codexPackage(dir); return p?.version === version && p.target === target; };
    if (!matches(release)) {
      mkdirSync(join(root, "releases"), { recursive: true });
      // `.staging.*` is the vendor installer's own prefix, so it cleans up after a crash too.
      const staging = join(root, "releases", `.staging.app-pins-${process.pid}`);
      const work = mkdtempSync(join(tmpdir(), "app-pin-codex-"));
      try {
        const archive = join(work, "codex.tar.gz");
        await fetchVerified(deps, artifact, archive);
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging);
        deps.run("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"]);
        if (!matches(staging)) throw new AppPinError("artifact_not_pinned_build", "codex archive is not the pinned build");
        // the vendor installer adds this alias and only prunes releases that carry it.
        symlinkSync("bin/codex", join(staging, "codex"));
        rmSync(release, { recursive: true, force: true });
        renameSync(staging, release);
      } finally {
        rmSync(staging, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
    return release;
  },
  select(home, release, platform) {
    const root = standalone(home), current = join(root, "current"), link = readlink(current);
    const previous = link === null ? "" : basename(resolve(root, link));
    swapLink(current, release);
    recordSelection(root, release, previous);
    if (platform.startsWith("linux")) pruneUnused(join(root, "releases"), new Set([basename(release), previous]));
    // a pinned release does not follow the latest channel, as with `install.sh --release`.
    rmSync(join(root, "auto-update-version"), { force: true });
    const bin = join(home, ".local/bin");
    if (readlink(join(bin, "codex")) === null) swapLink(join(bin, "codex"), join(current, "bin/codex"));
    if (platform.startsWith("darwin") && existsSync(join(release, "bin/codex-code-mode-host")) &&
        readlink(join(bin, "codex-code-mode-host")) === null) {
      swapLink(join(bin, "codex-code-mode-host"), join(current, "bin/codex-code-mode-host"));
    }
  },
};
/**
 * the vendor installer prunes old releases only when this file names the current
 * selection and the link's identity, so keep it accurate. if it is wrong, pruning is
 * skipped, never misapplied.
 */
/**
 * a release is ~400MB, and hosts that only follow pins never run the vendor installer,
 * which is what normally prunes. keep the selected and previous releases, and any other
 * that a running process still executes from. darwin is left to the vendor installer.
 */
function pruneUnused(releases: string, keep: Set<string>) {
  const inUse: string[] = [];
  try {
    for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
      try { inUse.push(readlinkSync(`/proc/${pid}/exe`)); }
      catch {
        // like the vendor installer: an uninspectable codex process might hold any release.
        let comm = "";
        try { comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { /* exited */ }
        if (/^(codex|rg$|bwrap$)/.test(comm)) return;
      }
    }
  } catch { return; }
  for (const name of readdirSync(releases)) {
    const dir = join(releases, name);
    if (name.startsWith(".") || keep.has(name) || !codexPackage(dir) || inUse.some(exe => exe.startsWith(`${dir}/`))) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
function recordSelection(root: string, release: string, previous: string) {
  try {
    const s = lstatSync(join(root, "current"), { bigint: true });
    const nanos = (s.ctimeNs % 1_000_000_000n).toString().padStart(9, "0");
    const identity = `${s.dev} ${s.ino} ${s.ctimeNs / 1_000_000_000n}.${nanos}`;
    const temporary = join(root, `.selection-history.app-pins-${process.pid}`);
    writeFileSync(temporary, `${basename(release)}\n${previous}\n${identity}\n`);
    renameSync(temporary, join(root, "selection-history"));
  } catch { /* pruning stays disabled until the vendor's next install */ }
}

const drivers: Record<Layout, Driver> = { claude, codex };
const home = (app: VendorApp) => app.home ?? homedir();

export function installedVendor(app: VendorApp): Installed | null {
  const version = drivers[app.layout].installed(home(app));
  return version === null ? null : { version, build: version };
}

/** whether record could change anything, from the store alone; builds are resolved together, so no follow-ups. */
export function dueVendor(app: VendorApp, store: Store, installed: Installed): { due: boolean; from?: string; to: string } {
  const pin = readPin(app, store);
  if (!pin) return { due: true, to: installed.version };
  const ahead = compare(installed.version, pin.version) > 0;
  return { due: ahead, from: pin.version, to: ahead ? installed.version : pin.version };
}

export async function recordVendor(app: VendorApp, store: Store, deps: Deps): Promise<RecordResult> {
  const installed = installedVendor(app);
  if (!installed) return { status: "absent" };
  const previous = readPin(app, store);
  if (previous && compare(installed.version, previous.version) <= 0) {
    return { status: "unchanged", from: previous.version, to: previous.version, linuxAdvanced: false, changed: false };
  }
  const pin: VendorPin = { schemaVersion: 1, app: app.name, version: installed.version,
    builds: await drivers[app.layout].resolve(installed.version, deps) };
  store.write(app.pin, json(pin));
  return { status: "recorded", from: previous?.version, to: pin.version, linuxAdvanced: false, changed: true };
}

export async function installVendor(app: VendorApp, store: Store, deps: Deps, platform = platformKey()): Promise<InstallResult> {
  const pin = readPin(app, store);
  if (!pin) return { status: "unpinned" };
  const driver = drivers[app.layout];
  const state = (): InstallResult | null => {
    const version = driver.installed(home(app));
    if (version === null || compare(version, pin.version) < 0) return null;
    return { status: compare(version, pin.version) > 0 ? "newer" : "current", version };
  };
  const before = state();
  if (before) return before;
  const staged = await driver.stage(home(app), pin.version, pin.builds[platform], deps, platform);
  // the download takes a while: an update that landed meanwhile wins over the pin.
  const after = state();
  if (after) return after;
  driver.select(home(app), staged, platform);
  return { status: "installed", version: pin.version };
}
