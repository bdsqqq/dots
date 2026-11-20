/**
 * self-updating mac apps keep their own updaters. this module only:
 * - record: after an app updated itself, write its exact version and artifact
 *   (url + sha256) into a tracked pin file in the working tree. never downgrades.
 * - install: on activation, install the pinned build when the app is missing or
 *   older. never touches a newer or running app.
 * the working tree, not the nix store, is the source of truth; git carries pins
 * between hosts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEventLogger, safeErrorCode } from "../service-events/events.ts";
import { fromUpstream, newer, parseRelease } from "../rex/release.ts";

export type Artifact = { url: string; sha256: string };
export type Pin = {
  schemaVersion: 1;
  app: string;
  version: string;
  build: string;
  darwin: { arm64: Artifact & { format: "dmg" | "zip" } };
  linux?: { version: string; x64: Artifact; arm64: Artifact };
  rexCommit?: string;
};
type Feed =
  | { kind: "sparkle"; url: string }
  | { kind: "github"; repo: string; tag: string; asset: string;
      linux?: { repo: string; assets: { x64: string; arm64: string } } };
export type AppSpec = {
  bundle: string; bundleId: string; pin: string; compare: "build" | "short"; feed: Feed; linuxRelease?: string;
};
export type Installed = { version: string; build: string; bundleId: string };
export type Deps = {
  text: (url: string) => Promise<string>;
  download: (url: string, dest: string) => Promise<void>;
  run: (command: string, args: string[]) => string;
};

const sha = /^[a-f0-9]{64}$/;
const here = dirname(fileURLToPath(import.meta.url));
export const loadApps = (): Record<string, AppSpec> =>
  JSON.parse(readFileSync(join(here, "apps.json"), "utf8"));

/** numeric runs only: "0.1.11-nightly.20261118.4877" -> [0,1,11,20261118,4877]. */
export function compare(a: string, b: string): number {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return Math.sign(d);
  }
  return 0;
}
const key = (spec: AppSpec, v: { version: string; build: string }) => spec.compare === "build" ? v.build : v.version;

export function readInstalled(bundle: string, run: Deps["run"]): Installed | null {
  const plist = join(bundle, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  const read = (k: string) => run("plutil", ["-extract", k, "raw", "-o", "-", plist]).trim();
  return { version: read("CFBundleShortVersionString"), build: read("CFBundleVersion"), bundleId: read("CFBundleIdentifier") };
}

export function parsePin(value: unknown, app: string): Pin {
  const p = value as Pin;
  const artifact = (a: Artifact | undefined) => !!a && /^https:\/\//.test(a.url) && sha.test(a.sha256);
  if (!p || p.schemaVersion !== 1 || p.app !== app || typeof p.version !== "string" || typeof p.build !== "string" ||
      !artifact(p.darwin?.arm64) || !["dmg", "zip"].includes(p.darwin.arm64.format) ||
      (p.linux && !(typeof p.linux.version === "string" && artifact(p.linux.x64) && artifact(p.linux.arm64)))) {
    throw new Error(`invalid ${app} pin`);
  }
  return p;
}
const readPin = (path: string, app: string) => existsSync(path) ? parsePin(JSON.parse(readFileSync(path, "utf8")), app) : null;
function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

const expand = (template: string, version: string) => template.replaceAll("{version}", version);
async function githubAsset(deps: Deps, repo: string, tag: string, name: string): Promise<Artifact> {
  const release = JSON.parse(await deps.text(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`));
  const asset = (release.assets ?? []).find((a: { name: string }) => a.name === name);
  if (!asset) throw new Error(`release ${repo}@${tag} has no ${name}`);
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
export async function resolve(name: string, spec: AppSpec, installed: Installed, deps: Deps, previous: Pin | null): Promise<Pin> {
  const base = { schemaVersion: 1 as const, app: name, version: installed.version, build: installed.build };
  if (spec.feed.kind === "sparkle") {
    const xml = await deps.text(spec.feed.url);
    const item = xml.split("<item>").slice(1).find(i => i.includes(`<sparkle:version>${installed.build}</sparkle:version>`));
    const url = item?.match(/<enclosure[^>]*\surl="([^"]+)"/)?.[1];
    if (!item || !url) throw new Error(`${name} appcast has no build ${installed.build}`);
    const pin: Pin = { ...base, darwin: { arm64: { url, sha256: await hashUrl(deps, url), format: url.endsWith(".zip") ? "zip" : "dmg" } } };
    const commit = item.match(/\(`([a-f0-9]{40})`\)/)?.[1];
    if (commit) pin.rexCommit = commit;
    return pin;
  }
  const f = spec.feed;
  const assetName = expand(f.asset, installed.version);
  const darwin = await githubAsset(deps, f.repo, expand(f.tag, installed.version), assetName);
  const pin: Pin = { ...base, darwin: { arm64: { ...darwin, format: assetName.endsWith(".zip") ? "zip" : "dmg" } } };
  if (previous?.linux) pin.linux = previous.linux;
  return pin;
}

/** linux builds publish separately; retried on every run until they match the mac pin. */
async function advanceGithubLinux(spec: AppSpec, pin: Pin, deps: Deps): Promise<boolean> {
  const f = spec.feed;
  if (f.kind !== "github" || !f.linux || pin.linux?.version === pin.version) return false;
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

/** the linux CLI follows the build bundled in the accepted mac app, never the channel head. */
async function advanceRexLinux(path: string, commit: string, deps: Deps): Promise<boolean> {
  const current = parseRelease(JSON.parse(readFileSync(path, "utf8")));
  if (current.commit === commit) return false;
  const candidate = fromUpstream(JSON.parse(await deps.text(
    `https://blob.superlogical.com/api/releases/rex/snapshot?commit=${commit}`)));
  if (candidate.commit !== commit) throw new Error("rex release api returned a different commit");
  if (!newer(candidate.version, current.version)) return false;
  writeJson(path, candidate);
  return true;
}

export type RecordResult = { app: string; status: "recorded" | "unchanged" | "absent"; version?: string; linux?: boolean };
export async function record(name: string, repo: string, deps: Deps, spec = loadApps()[name]): Promise<RecordResult> {
  const installed = readInstalled(spec.bundle, deps.run);
  if (!installed) return { app: name, status: "absent" };
  if (installed.bundleId !== spec.bundleId) throw new Error(`${spec.bundle} is ${installed.bundleId}, not ${spec.bundleId}`);
  const pinPath = join(repo, spec.pin), previous = readPin(pinPath, name);
  const advance = !previous || compare(key(spec, installed), key(spec, previous)) > 0;
  const pin = advance ? await resolve(name, spec, installed, deps, previous) : previous!;
  // linux pins reconcile independently, so a transient feed/api failure is retried next run.
  const helium = await advanceGithubLinux(spec, pin, deps);
  if (advance || helium) writeJson(pinPath, pin);
  const rex = pin.rexCommit && spec.linuxRelease ? await advanceRexLinux(join(repo, spec.linuxRelease), pin.rexCommit, deps) : false;
  if (!advance) return { app: name, status: "unchanged", version: installed.version, linux: helium || rex };
  return { app: name, status: "recorded", version: pin.version, linux: helium || rex };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function running(spec: AppSpec, deps: Deps): boolean {
  try { deps.run("pgrep", ["-f", `${escapeRegex(spec.bundle)}/Contents/MacOS/`]); return true; }
  catch (error) {
    // pgrep exits 1 for "no match"; anything else must not be read as "not running".
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export type InstallResult = { app: string; status: "installed" | "current" | "newer" | "running" | "unpinned"; version?: string };
export async function install(name: string, repo: string, deps: Deps, spec = loadApps()[name]): Promise<InstallResult> {
  const pin = readPin(join(repo, spec.pin), name);
  if (!pin) return { app: name, status: "unpinned" };
  const installed = readInstalled(spec.bundle, deps.run);
  if (installed) {
    const order = compare(key(spec, installed), key(spec, pin));
    if (order > 0) return { app: name, status: "newer", version: installed.version };
    if (order === 0) return { app: name, status: "current", version: installed.version };
    if (running(spec, deps)) return { app: name, status: "running", version: installed.version };
  }
  const work = mkdtempSync(join(tmpdir(), `app-pin-${name}-`));
  const artifact = pin.darwin.arm64, file = join(work, `artifact.${artifact.format}`);
  try {
    await deps.download(artifact.url, file);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== artifact.sha256) throw new Error(`${name} artifact hash mismatch`);
    const source = join(work, "source");
    if (artifact.format === "zip") deps.run("ditto", ["-x", "-k", file, source]);
    else deps.run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", source, file]);
    try {
      const apps = readdirSync(source).filter(n => n.endsWith(".app"));
      if (apps.length !== 1) throw new Error(`${name} artifact must contain exactly one app`);
      const staged = readInstalled(join(source, apps[0]), deps.run);
      if (staged?.bundleId !== spec.bundleId || key(spec, staged) !== key(spec, pin)) throw new Error(`${name} artifact is not the pinned build`);
      // stage on the target filesystem so the final swap is a rename.
      const target = spec.bundle, next = `${dirname(target)}/.${name}-pin-${process.pid}.app`, old = `${next}.old`;
      deps.run("ditto", [join(source, apps[0]), next]);
      try {
        // the download takes a while: recheck right before publishing, so an update or
        // launch that happened meanwhile wins over the pin.
        const now = readInstalled(target, deps.run);
        if (now && now.bundleId !== spec.bundleId) throw new Error(`${target} is ${now.bundleId}, not ${spec.bundleId}`);
        if (now && compare(key(spec, now), key(spec, pin)) >= 0) {
          return { app: name, status: compare(key(spec, now), key(spec, pin)) > 0 ? "newer" : "current", version: now.version };
        }
        if (now && running(spec, deps)) return { app: name, status: "running", version: now.version };
        if (now) renameSync(target, old);
        try { renameSync(next, target); } catch (error) { if (existsSync(old)) renameSync(old, target); throw error; }
        rmSync(old, { recursive: true, force: true });
      } finally { rmSync(next, { recursive: true, force: true }); }
    } finally {
      if (artifact.format === "dmg") try { deps.run("hdiutil", ["detach", source, "-force"]); } catch { /* best effort */ }
    }
    return { app: name, status: "installed", version: pin.version };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, repo, ...names] = process.argv.slice(2);
  if (!["record", "install"].includes(command) || !repo) throw new Error("usage: pins.ts record|install REPO [APP...] [--notify]");
  const notify = names.includes("--notify"), apps = loadApps();
  let failed = false;
  for (const name of names.filter(n => n !== "--notify").length ? names.filter(n => n !== "--notify") : Object.keys(apps)) {
    if (!apps[name]) throw new Error(`unknown app ${name}`);
    // the event schema is fixed; the app rides in `action`, the result in `reasonCode`/`revision`.
    const event = createEventLogger("app-pins").begin(`app.${command}`, "background", { action: name });
    try {
      const result = command === "record" ? await record(name, repo, nativeDeps) : await install(name, repo, nativeDeps);
      event.finish("succeeded", { action: name, reasonCode: result.status, revision: result.version,
        changed: result.status === "recorded" || result.status === "installed" });
      if (notify && result.status === "recorded") {
        try { nativeDeps.run("osascript", ["-e", `display notification "pinned ${name} ${result.version} in the nix repo (uncommitted)" with title "app-pins"`]); } catch { /* cosmetic */ }
      }
    } catch (error) {
      failed = true;
      event.finish("failed", { action: name, errorCode: safeErrorCode(error) });
      console.error(`app-pins ${command} ${name}: ${(error as Error).message ?? error}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
