import { execFile } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, cp, lchmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createEventLogger, safeErrorCode } from "../service-events/events.ts";
import { DEPLOYMENT_PLACEHOLDER, parseDeployment, type Deployment } from "./deployment.ts";

export const BUNDLE_ID = "dev.bdsqqq.hue-control";
const executable = "Contents/MacOS/HueControl";
const metadataFile = "Contents/Resources/host-deployment.json";
const events = createEventLogger("hue-control");
const exec = promisify(execFile);
export interface HostConfig {
  stateDir: string; destination: string; signer: string; openssl: string; ownerUid: number;
}
interface Identity { fingerprint: string; key: string; certificate: string }
function failure(code: string): never { throw Object.assign(new Error(code), { code }); }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function command(tool: string, args: string[], timeout = 120_000): Promise<string> {
  const result = await exec(tool, args, { timeout, cwd: "/", maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  return result.stdout + result.stderr;
}
export function parseConfig(value: HostConfig): HostConfig {
  if (!value || [value.stateDir, value.destination, value.signer, value.openssl].some(path => typeof path !== "string" || !isAbsolute(path))
    || !value.destination.endsWith("/Hue Control.app") || !Number.isSafeInteger(value.ownerUid) || value.ownerUid < 0) failure("INVALID_HOST_CONFIG");
  return value;
}
async function privatePath(path: string, uid: number, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== uid || !!(stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile())) failure("INSECURE_SIGNING_STATE");
}
async function locked<T>(config: HostConfig, action: () => Promise<T>): Promise<T> {
  parseConfig(config);
  if (process.getuid?.() !== config.ownerUid) failure("WRONG_SIGNING_USER");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await privatePath(config.stateDir, config.ownerUid, true);
  const db = new DatabaseSync(join(config.stateDir, "install-lock.sqlite"));
  try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); return await action(); }
  finally { db.close(); }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function identity(config: HostConfig): Promise<Identity> {
  const folder = join(config.stateDir, "identity"), key = join(folder, "key.pem"), certificate = join(folder, "certificate.pem");
  await privatePath(folder, config.ownerUid, true);
  for (const path of [key, certificate, join(folder, "identity.json")]) await privatePath(path, config.ownerUid, false);
  const cert = new X509Certificate(await readFile(certificate));
  const fingerprint = cert.fingerprint.replaceAll(":", "").toLowerCase();
  const recorded = JSON.parse(await readFile(join(folder, "identity.json"), "utf8"));
  if (recorded.schemaVersion !== 1 || recorded.fingerprint !== fingerprint || !cert.checkPrivateKey(createPrivateKey(await readFile(key)))) failure("SIGNING_IDENTITY_CHANGED");
  return { key, certificate, fingerprint };
}

/** A missing/broken existing identity is an error, never permission to mint another privacy identity. */
export async function provision(config: HostConfig): Promise<Identity> {
  return locked(config, async () => {
    const folder = join(config.stateDir, "identity");
    if (await exists(folder)) return identity(config);
    const staging = join(config.stateDir, `.identity-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      await writeFile(join(staging, "key.pem"), privateKey, { mode: 0o600, flag: "wx" });
      await command(config.openssl, ["req", "-new", "-x509", "-sha256", "-key", join(staging, "key.pem"), "-out", join(staging, "certificate.pem"), "-days", "3650", "-subj", "/CN=Hue Control local signing", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=codeSigning"]);
      await chmod(join(staging, "certificate.pem"), 0o600);
      const cert = new X509Certificate(await readFile(join(staging, "certificate.pem")));
      await atomicJson(join(staging, "identity.json"), { schemaVersion: 1, fingerprint: cert.fingerprint.replaceAll(":", "").toLowerCase() });
      await rename(staging, folder);
      return identity(config);
    } finally { await rm(staging, { recursive: true, force: true }); }
  });
}
export function requirement(fingerprint: string): string {
  if (!/^[a-f0-9]{40}$/.test(fingerprint)) failure("INVALID_SIGNER_FINGERPRINT");
  return `identifier "${BUNDLE_ID}" and certificate leaf = H"${fingerprint}"`;
}
export async function verifyApp(app: string, signer: Identity): Promise<string> {
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", `=${requirement(signer.fingerprint)}`, app]);
  const output = await command("/usr/bin/codesign", ["--display", "-r-", app]);
  const designated = output.split("\n").find(line => line.startsWith("designated => "))?.slice("designated => ".length);
  if (!designated || designated.includes("cdhash") || !designated.toLowerCase().includes(signer.fingerprint)) failure("UNSTABLE_SIGNING_REQUIREMENT");
  return designated;
}
async function verifyOwnedApp(config: HostConfig, app: string, signer: Identity): Promise<void> {
  const stat = await lstat(app);
  if (stat.isSymbolicLink() || stat.uid !== config.ownerUid || !!(stat.mode & 0o022)) failure("UNOWNED_APP_DESTINATION");
  await verifyApp(app, signer);
}
async function writableTree(root: string): Promise<void> {
  // macOS /var is an alias of /private/var; compare canonical paths on both sides.
  const canonicalRoot = await realpath(root);
  const links: string[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      // macos enforces readlink permissions; root's private umask must not hide public dependencies.
      await lchmod(path, 0o777);
      links.push(path); return;
    }
    await chmod(path, stat.isDirectory() ? 0o755 : (stat.mode & 0o111) ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(root);
  for (const path of links) {
    const target = await realpath(path);
    if (!target.startsWith(canonicalRoot + sep)) failure("EXTERNAL_BUNDLE_SYMLINK");
  }
}
async function deployment(app: string): Promise<Deployment> {
  return parseDeployment(JSON.parse(await readFile(join(app, metadataFile), "utf8")));
}
interface Receipt extends Deployment { activatedDeploymentId?: string; activatedPid?: number }
async function receipt(config: HostConfig): Promise<Receipt | undefined> {
  const path = join(config.stateDir, "installation.json");
  if (!await exists(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8"));
  const data = parseDeployment(value);
  if ((value.activatedDeploymentId !== undefined && !/^[a-f0-9]{64}$/.test(value.activatedDeploymentId))
    || (value.activatedPid !== undefined && (!Number.isSafeInteger(value.activatedPid) || value.activatedPid <= 0))) failure("INVALID_INSTALLATION_RECEIPT");
  return { ...data, activatedDeploymentId: value.activatedDeploymentId, activatedPid: value.activatedPid };
}

/** Only staged code is signed. A failed sign/verification never replaces the working app. */
export async function install(config: HostConfig, sourceApp: string): Promise<Deployment> {
  return locked(config, async () => {
    const signer = await identity(config);
    const installed = await receipt(config);
    const source = await realpath(sourceApp);
    if (source === config.destination || !isAbsolute(source)) failure("INVALID_APP_SOURCE");
    const identifier = (await command("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(source, "Contents/Info.plist")])).trim();
    if (identifier !== BUNDLE_ID) failure("UNEXPECTED_APP_IDENTIFIER");
    const desired: Deployment = { schemaVersion: 1, deploymentId: createHash("sha256").update(source).digest("hex") };
    const previous = join(dirname(config.destination), ".Hue Control.previous.app");
    // Recover only an authenticated backup of our own app after an interrupted rename.
    if (!await exists(config.destination) && await exists(previous)) { await verifyOwnedApp(config, previous, signer); await rename(previous, config.destination); }
    if (await exists(config.destination)) {
      await verifyOwnedApp(config, config.destination, signer);
      if ((await deployment(config.destination)).deploymentId === desired.deploymentId) return desired;
    }
    // keep unsigned code behind the root-only state directory until verification and promotion.
    const staging = join(config.stateDir, `.Hue Control.stage-${randomUUID()}.app`);
    const requirements = join(config.stateDir, `requirements-${randomUUID()}`);
    try {
      await cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      await writableTree(staging);
      const mainFile = join(staging, "Contents/Resources/hue-control.mjs");
      const main = await readFile(mainFile, "utf8");
      if (!main.includes(DEPLOYMENT_PLACEHOLDER)) failure("MISSING_DEPLOYMENT_TEMPLATE");
      await writeFile(mainFile, main.replaceAll(DEPLOYMENT_PLACEHOLDER, desired.deploymentId));
      await writeFile(join(staging, metadataFile), JSON.stringify(desired) + "\n", { mode: 0o644 });
      await command("/usr/bin/csreq", ["-r", `=${requirement(signer.fingerprint)}`, "-b", requirements]);
      // No keychain or global certificate trust. The signer-bound requirement,
      // not an ad-hoc code hash or identifier-only rule, authenticates upgrades.
      await command(config.signer, ["--config-file", "/dev/null", "sign", "--pem-file", signer.key, "--pem-file", signer.certificate, "--timestamp-url", "none", "--code-requirements-file", requirements, staging]);
      // signing and metadata writes inherit the private umask; only the key directory stays private.
      await writableTree(staging);
      await verifyApp(staging, signer);
      if (await exists(previous)) { await verifyOwnedApp(config, previous, signer); await rm(previous, { recursive: true }); }
      if (await exists(config.destination)) await rename(config.destination, previous);
      try { await rename(staging, config.destination); }
      catch (error) { if (!await exists(config.destination) && await exists(previous)) await rename(previous, config.destination); throw error; }
      await atomicJson(join(config.stateDir, "installation.json"), { ...desired, activatedDeploymentId: installed?.activatedDeploymentId, activatedPid: installed?.activatedPid });
      return desired;
    } finally { await rm(staging, { recursive: true, force: true }); await rm(requirements, { force: true }); }
  });
}

async function runningDeployment(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual", signal: AbortSignal.timeout(1000), headers: { "user-agent": "service-probe/1" } });
    if (response.status !== 200 || !response.body) return undefined;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) return undefined; chunks.push(value); } }
    finally { await reader.cancel(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value.ok === true && typeof value.deploymentId === "string" && /^[a-f0-9]{64}$/.test(value.deploymentId) ? value.deploymentId : undefined;
  } catch { return undefined; }
}
export function loadedAgentPid(definition: string, destination: string): number | undefined {
  if (!definition.includes(join(destination, executable))) failure("UNEXPECTED_LOADED_AGENT");
  const pid = definition.match(/^\s*pid = (\d+)$/m)?.[1];
  if (pid && (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0)) failure("INVALID_AGENT_EVIDENCE");
  return pid ? Number(pid) : undefined;
}
export function listenerArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) failure("INVALID_AGENT_CONFIG");
  // tailscale legitimately owns the same port on other interfaces; authenticate only the backend socket.
  return ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"];
}
/** A version string is not authentication: the listener must belong to our named launchd agent. */
export function listenerOwned(definition: string, destination: string, listeners: string): boolean {
  const pid = loadedAgentPid(definition, destination);
  const values = [...new Set(listeners.trim().split(/\s+/).filter(Boolean))];
  return pid !== undefined && values.length === 1 && values[0] === String(pid);
}
/** Reload only the named agent when its loaded executable is our stable app. Never signal a listener PID. */
export async function activate(config: HostConfig, uid: number, port: number, plist: string): Promise<string> {
  return locked(config, async () => {
    const desired = await deployment(config.destination);
    await verifyOwnedApp(config, config.destination, await identity(config));
    const installed = await receipt(config);
    const domain = `gui/${uid}`, target = `${domain}/org.nix-community.home.hue-control`;
    try { await command("/bin/launchctl", ["print", domain]); } catch { return "awaiting_aqua_session"; }
    if (!isAbsolute(plist)) failure("INVALID_AGENT_PLIST");
    await command("/bin/launchctl", ["asuser", String(uid), "/usr/bin/sudo", `--user=#${uid}`, "--set-home", "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", config.destination]);
    let loaded: string | undefined;
    try { loaded = await command("/bin/launchctl", ["print", target]); } catch { /* Not registered yet. */ }
    const acknowledgement = async (): Promise<number | undefined> => {
      try {
        const definition = await command("/bin/launchctl", ["print", target]);
        const pid = loadedAgentPid(definition, config.destination);
        const listeners = await command("/usr/sbin/lsof", listenerArguments(port));
        if (listenerOwned(definition, config.destination, listeners) && await runningDeployment(port) === desired.deploymentId) return pid;
      } catch { /* Missing or mismatched evidence is not an applied generation. */ }
      return undefined;
    };
    const record = async (pid: number) => atomicJson(join(config.stateDir, "installation.json"), { ...desired, activatedDeploymentId: desired.deploymentId, activatedPid: pid });
    const acknowledged = await acknowledgement();
    const mustReplaceProcess = installed?.activatedDeploymentId !== desired.deploymentId && installed?.activatedPid === acknowledged && acknowledged !== undefined;
    if (acknowledged !== undefined && !mustReplaceProcess) { await record(acknowledged); return "already_running"; }
    const previousPid = loaded ? loadedAgentPid(loaded, config.destination) : undefined;
    if (loaded) {
      await command("/bin/launchctl", [previousPid ? "kill" : "kickstart", ...(previousPid ? ["SIGTERM", target] : [target])]);
      // KeepAlive restarts the owned agent; no force-kill fallback is safe here.
    } else {
      const label = (await command("/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", plist])).trim();
      const argumentsText = await command("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist]);
      if (label !== "org.nix-community.home.hue-control" || !JSON.parse(argumentsText).join(" ").includes(join(config.destination, executable))) failure("UNEXPECTED_AGENT_PLIST");
      await command("/bin/launchctl", ["bootstrap", domain, plist]);
    }
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const pid = await acknowledgement();
      if (pid !== undefined && pid !== previousPid) { await record(pid); return "reloaded"; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    failure("AGENT_RELOAD_PENDING");
  });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  process.umask(0o077);
  const action = args.shift();
  const option = (name: string, fallback?: string) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; if (!value || value.startsWith("--")) failure("MISSING_OPTION_VALUE"); return value; };
  const config = parseConfig({ stateDir: option("--state-dir", "/var/db/hue-control-signing")!, destination: option("--destination", "/Applications/Hue Control.app")!, signer: option("--signer")!, openssl: option("--openssl")!, ownerUid: 0 });
  const operation = events.begin(`host.${["provision", "install", "activate", "status"].includes(action ?? "") ? action : "invalid"}`, "background");
  try {
    if (action === "provision") await provision(config);
    else if (action === "install") await install(config, option("--source") ?? failure("MISSING_SOURCE"));
    else if (action === "activate") {
      const uid = Number(option("--uid")), port = Number(option("--port"));
      if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isInteger(port) || port < 1 || port > 65535) failure("INVALID_AGENT_CONFIG");
      const result = await activate(config, uid, port, option("--plist") ?? failure("MISSING_PLIST"));
      operation.finish(result === "awaiting_aqua_session" ? "skipped" : "succeeded", { reasonCode: result, readiness: "installation", ready: result !== "awaiting_aqua_session" });
      return;
    } else if (action === "status") {
      const signed = await identity(config);
      console.log(JSON.stringify({ ...(await deployment(config.destination)), fingerprint: signed.fingerprint, requirement: await verifyApp(config.destination, signed) }));
    } else failure("INVALID_HOST_ACTION");
    operation.finish("succeeded", { readiness: "installation", ready: true });
  } catch (error) { operation.finish("failed", { errorCode: safeErrorCode(error), ready: false }); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { events.begin("host.start", "background").finish("failed", { errorCode: safeErrorCode(error), ready: false }); process.exitCode = 1; }
}
