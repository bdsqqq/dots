/**
 * record and install. both go through a `Store` so publish.ts can run them against an
 * overlay of origin/main instead of the user's checkout.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromUpstream, newer, parseRelease } from "../rex/release.ts";

export type Artifact = { url: string; sha256: string };
export type Pin = {
  schemaVersion: 1;
  app: string;
  version: string;
  build: string;
  darwin: { arm64: Artifact & { format: "dmg" | "zip" } };
  linux?: { version: string; x64: Artifact; arm64: Artifact };
  /** rex only: the CLI build bundled in this app, named by its appcast notes. */
  rexCommit?: string;
  /** rex only: that CLI build's version, once looked up; lets later runs settle offline. */
  rexCliVersion?: string;
};
type Feed =
  | { kind: "sparkle"; url: string }
  | { kind: "github"; repo: string; tag: string; asset: string;
      linux?: { repo: string; assets: { x64: string; arm64: string } } };
export type App = {
  name: string; bundle: string; bundleId: string; pin: string;
  /** "build" for Sparkle apps, whose builds advance under an unchanged marketing version. */
  compare: "build" | "short";
  feed: Feed;
  linuxRelease?: string;
};
export type Installed = { version: string; build: string; bundleId: string };
export type Deps = {
  text: (url: string) => Promise<string>;
  download: (url: string, dest: string) => Promise<void>;
  run: (command: string, args: string[]) => string;
};
export type Store = { read(path: string): string | null; write(path: string, text: string): void };

/** expected failures carry a stable code; callers map it, never the message, into events. */
export type AppPinErrorCode =
  | "bundle_identity_mismatch" | "invalid_pin" | "feed_missing_build" | "artifact_hash_mismatch"
  | "artifact_not_pinned_build" | "rex_commit_mismatch";
export class AppPinError extends Error {
  readonly code: AppPinErrorCode;
  constructor(code: AppPinErrorCode, message: string) { super(message); this.code = code; }
}

const sha = /^[a-f0-9]{64}$/;
const here = dirname(fileURLToPath(import.meta.url));
export function loadApps(): Record<string, App> {
  const specs: Record<string, Omit<App, "name">> = JSON.parse(readFileSync(join(here, "apps.json"), "utf8"));
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, { name, ...spec }]));
}

export const worktree = (repo: string): Store => ({
  read: path => existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null,
  write: (path, text) => {
    const target = join(repo, path), temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, text);
    renameSync(temporary, target);
  },
});
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** numeric runs only: "0.1.11-nightly.20261118.4877" -> [0,1,11,20261118,4877]. */
export function compare(a: string, b: string): number {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return Math.sign(d);
  }
  return 0;
}
const key = (app: App, v: { version: string; build: string }) => app.compare === "build" ? v.build : v.version;
/** what a person reads: Sparkle builds share a marketing version, so show both. */
const label = (app: App, v: { version: string; build: string }) => app.compare === "build" ? `${v.version} (${v.build})` : v.version;

export function readInstalled(bundle: string, run: Deps["run"]): Installed | null {
  const plist = join(bundle, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  const read = (k: string) => run("plutil", ["-extract", k, "raw", "-o", "-", plist]).trim();
  return { version: read("CFBundleShortVersionString"), build: read("CFBundleVersion"), bundleId: read("CFBundleIdentifier") };
}
export function installedApp(app: App, deps: Deps): Installed | null {
  const installed = readInstalled(app.bundle, deps.run);
  if (installed && installed.bundleId !== app.bundleId) {
    throw new AppPinError("bundle_identity_mismatch", `${app.bundle} is ${installed.bundleId}, not ${app.bundleId}`);
  }
  return installed;
}

export function parsePin(value: unknown, app: string): Pin {
  const p = value as Pin;
  const artifact = (a: Artifact | undefined) => !!a && /^https:\/\//.test(a.url) && sha.test(a.sha256);
  if (!p || p.schemaVersion !== 1 || p.app !== app || typeof p.version !== "string" || typeof p.build !== "string" ||
      !artifact(p.darwin?.arm64) || !["dmg", "zip"].includes(p.darwin.arm64.format) ||
      (p.linux && !(typeof p.linux.version === "string" && artifact(p.linux.x64) && artifact(p.linux.arm64)))) {
    throw new AppPinError("invalid_pin", `invalid ${app} pin`);
  }
  return p;
}
function readPin(app: App, store: Store): Pin | null {
  const text = store.read(app.pin);
  return text === null ? null : parsePin(JSON.parse(text), app.name);
}

const expand = (template: string, version: string) => template.replaceAll("{version}", version);
async function githubAsset(deps: Deps, repo: string, tag: string, name: string): Promise<Artifact> {
  const release = JSON.parse(await deps.text(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`));
  const asset = (release.assets ?? []).find((a: { name: string }) => a.name === name);
  if (!asset) throw new AppPinError("feed_missing_build", `release ${repo}@${tag} has no ${name}`);
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? "")?.[1];
  return { url: asset.browser_download_url, sha256: digest ?? await hashUrl(deps, asset.browser_download_url) };
}
async function hashUrl(deps: Deps, url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "app-pin-hash-"));
  try {
    await deps.download(url, join(dir, "artifact"));
    return createHash("sha256").update(readFileSync(join(dir, "artifact"))).digest("hex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** the feed entry for exactly the installed build; a moving channel head is never used. */
async function resolve(app: App, installed: Installed, deps: Deps, previous: Pin | null): Promise<Pin> {
  const base = { schemaVersion: 1 as const, app: app.name, version: installed.version, build: installed.build };
  if (app.feed.kind === "sparkle") {
    const xml = await deps.text(app.feed.url);
    const item = xml.split("<item>").slice(1).find(i => i.includes(`<sparkle:version>${installed.build}</sparkle:version>`));
    const url = item?.match(/<enclosure[^>]*\surl="([^"]+)"/)?.[1];
    if (!item || !url) throw new AppPinError("feed_missing_build", `${app.name} appcast has no build ${installed.build}`);
    const pin: Pin = { ...base, darwin: { arm64: { url, sha256: await hashUrl(deps, url), format: url.endsWith(".zip") ? "zip" : "dmg" } } };
    const commit = item.match(/\(`([a-f0-9]{40})`\)/)?.[1];
    if (commit) pin.rexCommit = commit;
    return pin;
  }
  const f = app.feed;
  const assetName = expand(f.asset, installed.version);
  const darwin = await githubAsset(deps, f.repo, expand(f.tag, installed.version), assetName);
  const pin: Pin = { ...base, darwin: { arm64: { ...darwin, format: assetName.endsWith(".zip") ? "zip" : "dmg" } } };
  if (previous?.linux) pin.linux = previous.linux;
  return pin;
}

/** linux builds publish separately; retried until they match the mac pin. */
const githubLinuxSettled = (app: App, pin: Pin) =>
  app.feed.kind !== "github" || !app.feed.linux || pin.linux?.version === pin.version;
async function advanceGithubLinux(app: App, pin: Pin, deps: Deps): Promise<boolean> {
  const f = app.feed;
  if (f.kind !== "github" || !f.linux || githubLinuxSettled(app, pin)) return false;
  const tag = expand(f.tag, pin.version);
  try {
    pin.linux = {
      version: pin.version,
      x64: await githubAsset(deps, f.linux.repo, tag, expand(f.linux.assets.x64, pin.version)),
      arm64: await githubAsset(deps, f.linux.repo, tag, expand(f.linux.assets.arm64, pin.version)),
    };
    return true;
  } catch { return false; /* not published yet; keep the last known-good linux pin */ }
}

/** settled once the linux CLI pin is at, or past, the CLI bundled in the pinned app. */
function rexLinuxSettled(app: App, pin: Pin, store: Store): boolean {
  if (!app.linuxRelease || !pin.rexCommit) return true;
  const current = parseRelease(JSON.parse(store.read(app.linuxRelease) ?? "null"));
  return current.commit === pin.rexCommit || (!!pin.rexCliVersion && !newer(pin.rexCliVersion, current.version));
}
/** the linux CLI follows the build bundled in the accepted mac app, never the channel head. */
async function advanceRexLinux(app: App, pin: Pin, store: Store, deps: Deps): Promise<boolean> {
  if (!app.linuxRelease || !pin.rexCommit || rexLinuxSettled(app, pin, store)) return false;
  const current = parseRelease(JSON.parse(store.read(app.linuxRelease) ?? "null"));
  const candidate = fromUpstream(JSON.parse(await deps.text(
    `https://blob.superlogical.com/api/releases/rex/snapshot?commit=${pin.rexCommit}`)));
  if (candidate.commit !== pin.rexCommit) throw new AppPinError("rex_commit_mismatch", "rex release api returned a different commit");
  pin.rexCliVersion = candidate.version;
  if (!newer(candidate.version, current.version)) return false;
  store.write(app.linuxRelease, json(candidate));
  return true;
}

/**
 * whether `record` could change anything, decided from the store alone, with the
 * versions it compared. a lagging store can only err towards true for the mac pin
 * (pins only move up); linux follow-ups are not monotonic, so callers must bound how
 * stale a store they trust (see publish.ts).
 */
export function due(app: App, store: Store, installed: Installed): { due: boolean; from?: string; to: string } {
  const pin = readPin(app, store);
  const to = label(app, installed);
  if (!pin) return { due: true, to };
  const from = label(app, pin);
  if (compare(key(app, installed), key(app, pin)) > 0) return { due: true, from, to };
  return { due: !githubLinuxSettled(app, pin) || !rexLinuxSettled(app, pin, store), from, to: from };
}

export type RecordResult =
  | { status: "absent" }
  | { status: "recorded" | "unchanged"; from?: string; to: string; linuxAdvanced: boolean; changed: boolean };
export async function record(app: App, store: Store, deps: Deps): Promise<RecordResult> {
  const installed = installedApp(app, deps);
  if (!installed) return { status: "absent" };
  const previous = readPin(app, store);
  const advance = !previous || compare(key(app, installed), key(app, previous)) > 0;
  const pin = advance ? await resolve(app, installed, deps, previous) : structuredClone(previous!);
  const linuxAdvanced = await advanceGithubLinux(app, pin, deps) || await advanceRexLinux(app, pin, store, deps);
  const changed = JSON.stringify(pin) !== JSON.stringify(previous);
  if (changed) store.write(app.pin, json(pin));
  return { status: advance ? "recorded" : "unchanged", from: previous ? label(app, previous) : undefined,
    to: label(app, pin), linuxAdvanced, changed };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function running(app: App, deps: Deps): boolean {
  try { deps.run("pgrep", ["-f", `${escapeRegex(app.bundle)}/Contents/MacOS/`]); return true; }
  catch (error) {
    // pgrep exits 1 for "no match"; anything else must not be read as "not running".
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export type InstallResult = { status: "installed" | "current" | "newer" | "running" | "unpinned"; version?: string };
export async function install(app: App, store: Store, deps: Deps): Promise<InstallResult> {
  const pin = readPin(app, store);
  if (!pin) return { status: "unpinned" };
  const installed = installedApp(app, deps);
  if (installed) {
    const order = compare(key(app, installed), key(app, pin));
    if (order > 0) return { status: "newer", version: label(app, installed) };
    if (order === 0) return { status: "current", version: label(app, installed) };
    if (running(app, deps)) return { status: "running", version: label(app, installed) };
  }
  const work = mkdtempSync(join(tmpdir(), `app-pin-${app.name}-`));
  const artifact = pin.darwin.arm64, file = join(work, `artifact.${artifact.format}`);
  try {
    await deps.download(artifact.url, file);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== artifact.sha256) {
      throw new AppPinError("artifact_hash_mismatch", `${app.name} artifact hash mismatch`);
    }
    const source = join(work, "source");
    if (artifact.format === "zip") deps.run("ditto", ["-x", "-k", file, source]);
    else deps.run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", source, file]);
    try {
      const apps = readdirSync(source).filter(n => n.endsWith(".app"));
      const staged = apps.length === 1 ? readInstalled(join(source, apps[0]), deps.run) : null;
      if (staged?.bundleId !== app.bundleId || key(app, staged) !== key(app, pin)) {
        throw new AppPinError("artifact_not_pinned_build", `${app.name} artifact is not the pinned build`);
      }
      // stage on the target filesystem so the final swap is a rename.
      const target = app.bundle, next = `${dirname(target)}/.${app.name}-pin-${process.pid}.app`, old = `${next}.old`;
      deps.run("ditto", [join(source, apps[0]), next]);
      try {
        // the download takes a while: recheck right before publishing, so an update or
        // launch that happened meanwhile wins over the pin.
        const now = installedApp(app, deps);
        if (now && compare(key(app, now), key(app, pin)) >= 0) {
          return { status: compare(key(app, now), key(app, pin)) > 0 ? "newer" : "current", version: label(app, now) };
        }
        if (now && running(app, deps)) return { status: "running", version: label(app, now) };
        if (now) renameSync(target, old);
        try { renameSync(next, target); } catch (error) { if (existsSync(old)) renameSync(old, target); throw error; }
        rmSync(old, { recursive: true, force: true });
      } finally { rmSync(next, { recursive: true, force: true }); }
    } finally {
      if (artifact.format === "dmg") try { deps.run("hdiutil", ["detach", source, "-force"]); } catch { /* best effort */ }
    }
    return { status: "installed", version: label(app, pin) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const curl = ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
  "--connect-timeout", "15", "--max-time", "600"];
export const nativeDeps: Deps = {
  run: (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  text: async url => execFileSync("curl", [...curl, "--header", "Accept: application/vnd.github+json", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  download: async (url, dest) => { execFileSync("curl", [...curl, "--output", dest, url]); },
};

// activations before cli.ts existed run `pins.ts record|install REPO [APP...]`; forward them.
// no top-level await: cli.ts imports this module, which must finish loading first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [op, repo, ...rest] = process.argv.slice(2);
  void import("./cli.ts").then(async ({ main }) => {
    process.exitCode = await main([op, "--repo", repo, ...rest.filter(a => a !== "--notify")]);
  });
}
