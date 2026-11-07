import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createEventLogger, safeErrorCode } from "../service-events/events.ts";
import { parseUpgradeState, readUpgradeHealth, type ComponentState, type UpgradePhase, type UpgradeState } from "./upgrade-status.ts";

export type UpgradeConfig = {
  host: string; flake: string; stateDir: string; operation: "build" | "switch";
  nixCommand: string[]; rebuildCommand: string[]; revisionCommand: string[];
  dependencyCheckCommand?: string[];
  dependencyRepairCommand?: string[];
  buildTimeoutMs: number; activationWarnAfterMs: number; retryBaseMs: number; retryMaxMs: number;
};
const sha = /^[a-f0-9]{40}$/;
const phasesActive = new Set(["resolving", "building", "activating", "repairing", "verifying"]);
function currentBootId(): string | null {
  try {
    const value = process.platform === "darwin"
      ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()
      : readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return /^[a-f0-9-]{36}$/i.test(value) ? value.toLowerCase() : null;
  } catch { return null; }
}
const iso = () => new Date().toISOString();
const events = createEventLogger("host-upgrade");
const statePath = (config: UpgradeConfig) => join(config.stateDir, "status.json");

export function parseConfig(value: unknown): UpgradeConfig {
  const c = value as UpgradeConfig;
  const command = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" && x.length > 0 && !x.includes("\0"));
  if (!c || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(c.host) || !/^github:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(c.flake)
    || typeof c.stateDir !== "string" || !c.stateDir.startsWith("/") || !["build", "switch"].includes(c.operation)
    || !command(c.nixCommand) || !command(c.rebuildCommand) || !command(c.revisionCommand)
    || (c.dependencyCheckCommand !== undefined && !command(c.dependencyCheckCommand))
    || (c.dependencyRepairCommand !== undefined && (!command(c.dependencyRepairCommand) || !c.dependencyCheckCommand))
    || ![c.buildTimeoutMs, c.activationWarnAfterMs, c.retryBaseMs, c.retryMaxMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2 ** 31 - 1)
    || c.retryBaseMs > c.retryMaxMs) throw new Error("invalid upgrade configuration");
  return c;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o644 });
  await rename(temporary, path);
}

export type CommandResult = { code: number; timedOut: boolean; stdout: string };
/** Only the process group created here is cancelled. Never kill the shared Nix daemon. */
export function execute(command: string[], options: { timeoutMs?: number; killGraceMs?: number; capture?: boolean } = {}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", options.capture ? "pipe" : "inherit", "inherit"],
      env: { ...process.env, NONINTERACTIVE: "1" } });
    let stdout = "", timedOut = false, closed = false, killed = false, code = 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (closed && (!timedOut || killed)) resolveResult({ code, timedOut, stdout }); };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const oversized = stdout.length + chunk.length > 4 * 1024 * 1024;
      stdout += chunk.toString().slice(0, Math.max(0, 4 * 1024 * 1024 - stdout.length));
      if (oversized && !timedOut) { timedOut = true; signalGroup("SIGTERM"); killer = setTimeout(() => { signalGroup("SIGKILL"); killed = true; finish(); }, options.killGraceMs ?? 10_000); }
    });
    child.once("error", error => { if (timer) clearTimeout(timer); if (killer) clearTimeout(killer); reject(error); });
    child.once("close", status => { closed = true; code = status ?? 1; if (timer) clearTimeout(timer); finish(); });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => {
      if (closed || timedOut) return;
      timedOut = true;
      signalGroup("SIGTERM");
      // Keep this deadline even if the leader exits: descendants may ignore TERM.
      killer = setTimeout(() => { signalGroup("SIGKILL"); killed = true; finish(); }, options.killGraceMs ?? 10_000);
    }, options.timeoutMs);
  });
}

async function readState(config: UpgradeConfig): Promise<UpgradeState | null> {
  try { return parseUpgradeState(JSON.parse(await readFile(statePath(config), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function revision(config: UpgradeConfig): Promise<string | null> {
  const result = await execute(config.revisionCommand, { timeoutMs: 15_000, capture: true });
  const value = result.stdout.trim();
  return !result.timedOut && result.code === 0 && sha.test(value) ? value : null;
}
function initial(config: UpgradeConfig): UpgradeState {
  const now = iso();
  return { schemaVersion: 1, host: config.host, operationId: randomUUID(), phase: "scheduled", desiredRevision: null, appliedRevision: null,
    startedAt: now, phaseStartedAt: now, updatedAt: now, lastSuccessAt: null, nextAttemptAt: null,
    consecutiveFailures: 0, reasonCode: "awaiting_first_attempt", buildTimeoutMs: config.buildTimeoutMs,
    activationWarnAfterMs: config.activationWarnAfterMs, components: {}, bootId: currentBootId(), dependencyRepairAttempts: 0 };
}
export async function initialize(config: UpgradeConfig): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o755 });
  if (await readState(config)) return;
  const state = initial(config);
  state.appliedRevision = await revision(config);
  // Initialization is pending work, never a fabricated successful activation.
  const temporary = join(config.stateDir, `initialize-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o644 });
  try { await link(temporary, statePath(config)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await unlink(temporary); }
}
export async function recordComponent(config: UpgradeConfig, name: string, status: ComponentState["status"], reasonCode: string): Promise<void> {
  if (name !== "homebrew" || !["running", "succeeded", "failed", "missing"].includes(status) || !/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) throw new Error("invalid component result");
  const event = createEventLogger("host-upgrade", { host: config.host }).begin("upgrade.component", "background", { action: name });
  try {
    await mkdir(config.stateDir, { recursive: true, mode: 0o755 });
    const component = { status, reasonCode, checkedAt: iso() };
    await atomicJson(join(config.stateDir, `${name}.json`), component);
    event.finish(status === "succeeded" ? "succeeded" : "degraded", { ready: status === "succeeded", readiness: status, reasonCode });
  } catch (error) { event.finish("failed", { errorCode: safeErrorCode(error) }); throw error; }
}

export type UpgradeResult = { status: "succeeded" | "partial" | "failed" | "blocked" | "skipped"; reasonCode: string };
export async function reconcile(config: UpgradeConfig, options: { acknowledgeInterrupted?: boolean; configFile?: string; bootId?: string | null } = {}): Promise<UpgradeResult> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o755 });
  const lock = new DatabaseSync(join(config.stateDir, "run-lock.sqlite"));
  try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
  catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) return { status: "skipped", reasonCode: "attempt_running" };
    throw error;
  }
  const event = createEventLogger("host-upgrade", { host: config.host }).begin("upgrade.attempt", "background");
  let state: UpgradeState | undefined;
  const finish = (status: UpgradeResult["status"], reasonCode: string): UpgradeResult => {
    event.finish(status === "partial" || status === "blocked" ? "degraded" : status, { ready: status === "succeeded", reasonCode,
      action: state?.phase, attempt: state?.consecutiveFailures, revision: state?.desiredRevision ?? undefined, appliedRevision: state?.appliedRevision ?? undefined, retryInMs: state?.nextAttemptAt ? Math.max(0, Date.parse(state.nextAttemptAt) - Date.now()) : 0 });
    return { status, reasonCode };
  };
  try {
    const previous = await readState(config);
    const bootId = options.bootId === undefined ? currentBootId() : options.bootId;
    const rebooted = !!bootId && !!previous?.bootId && bootId !== previous.bootId;
    // A proven reboot eliminates pre-activation children; it cannot prove that
    // interrupted native installation writes completed successfully.
    const interrupted = previous && (previous.phase === "activating" || previous.phase === "repairing" || previous.phase === "blocked"
      || (phasesActive.has(previous.phase) && !rebooted));
    if (previous && interrupted && !options.acknowledgeInterrupted) {
      state = { ...previous, phase: "blocked", updatedAt: iso(), reasonCode: previous.phase === "blocked" ? previous.reasonCode : "previous_attempt_interrupted" };
      await atomicJson(statePath(config), state);
      return finish("blocked", state.reasonCode);
    }
    if (previous?.nextAttemptAt && Date.parse(previous.nextAttemptAt) > Date.now()) {
      state = previous;
      return finish("skipped", "retry_backoff");
    }
    state = { ...initial(config), bootId, operationId: event.operationId, appliedRevision: previous?.appliedRevision ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null, consecutiveFailures: previous?.consecutiveFailures ?? 0 };
    const phase = async (value: UpgradePhase, reasonCode: string = value) => {
      state!.phase = value; state!.reasonCode = reasonCode; state!.phaseStartedAt = iso(); state!.updatedAt = state!.phaseStartedAt;
      await atomicJson(statePath(config), state);
    };
    const fail = async (reasonCode: string): Promise<UpgradeResult> => {
      state!.consecutiveFailures++;
      const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(state!.consecutiveFailures - 1, 20));
      state!.nextAttemptAt = new Date(Date.now() + delay).toISOString();
      await phase("failed", reasonCode);
      return finish("failed", reasonCode);
    };
    await phase("resolving");
    const metadata = await execute([...config.nixCommand, "flake", "metadata", "--refresh", "--json", config.flake], { timeoutMs: 30_000, capture: true });
    if (metadata.code !== 0 || metadata.timedOut) return await fail("resolve_failed");
    const data = JSON.parse(metadata.stdout);
    const target = data.revision ?? data.locked?.rev;
    if (typeof target !== "string" || !sha.test(target)) return await fail("invalid_revision");
    state.desiredRevision = target;
    state.dependencyRepairAttempts = previous?.desiredRevision === target ? previous.dependencyRepairAttempts ?? 0 : 0;
    state.appliedRevision = await revision(config);
    const pinned = `${config.flake}/${target}`;
    let activated = false;
    const reapply = options.acknowledgeInterrupted && previous && (phasesActive.has(previous.phase) || previous.phase === "blocked");
    if (state.appliedRevision !== target || reapply) {
      await phase("building");
      const build = await execute([...config.nixCommand, "build", "--no-write-lock-file", "--out-link", join(config.stateDir, "candidate"), `${pinned}#darwinConfigurations.${config.host}.system`], { timeoutMs: config.buildTimeoutMs });
      if (build.code !== 0 || build.timedOut) return await fail(build.timedOut ? "build_timeout" : "build_failed");
      if (config.operation === "build") {
        // A deliberately build-only host must never claim its target was applied.
        await phase("partial", "build_only");
        return finish("partial", "build_only");
      }
      activated = true;
      await phase("activating");
      // Unlike builds, activation mutates native system/user state. An external
      // observer reports an overdue phase; a timer must not kill it mid-write.
      const activation = await execute([...config.rebuildCommand, "switch", "--flake", `${pinned}#${config.host}`, "--no-write-lock-file"]);
      if (activation.code !== 0) {
        state.appliedRevision = await revision(config);
        await phase("blocked", "activation_failed");
        return finish("blocked", "activation_failed");
      }
    }
    await phase("verifying");
    state.appliedRevision = await revision(config);
    if (state.appliedRevision !== target) return await fail("revision_not_applied");
    let verification = config;
    if (options.configFile) {
      verification = parseConfig(JSON.parse(await readFile(options.configFile, "utf8")));
      if (verification.host !== config.host || verification.stateDir !== config.stateDir) throw new Error("upgrade identity changed during activation");
    }
    if (verification.dependencyCheckCommand) {
      const installerResult = async (): Promise<ComponentState> => {
        try {
          const value = JSON.parse(await readFile(join(config.stateDir, "homebrew.json"), "utf8"));
          const component = parseUpgradeState({ ...state, components: { homebrew: value } }).components.homebrew;
          return { status: component.status, checkedAt: component.checkedAt, reasonCode: component.reasonCode };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return { status: "missing", checkedAt: iso(), reasonCode: "installation_unverified" };
        }
      };
      let installed = await installerResult();
      let check = await execute(verification.dependencyCheckCommand, { timeoutMs: 60_000 });
      if ((check.code !== 0 || check.timedOut || installed.status !== "succeeded") && !activated
        && verification.dependencyRepairCommand && state.dependencyRepairAttempts < 3) {
        state.dependencyRepairAttempts++;
        await phase("repairing", "dependency_repairing");
        await recordComponent(config, "homebrew", "running", "dependency_repairing");
        // Retry the declared native installer, not developer-tool setup or trust
        // grants. Report overdue native writes rather than killing them halfway.
        const repair = await execute(verification.dependencyRepairCommand);
        await recordComponent(config, "homebrew", repair.code === 0 ? "succeeded" : "failed", repair.code === 0 ? "dependencies_installed" : "dependency_install_failed");
        installed = await installerResult();
        await phase("verifying");
        check = await execute(verification.dependencyCheckCommand, { timeoutMs: 60_000 });
      }
      state.components.homebrew = installed;
      // Presence checks cannot erase a failed installer (e.g. an upgrade fails
      // while an older version remains installed and passes bundle check).
      state.components.dependencies = { status: check.code === 0 && !check.timedOut ? "succeeded" : "failed",
        checkedAt: iso(), reasonCode: check.code === 0 && !check.timedOut ? "dependencies_present" : "dependencies_unverified" };
    }
    state.nextAttemptAt = null;
    if (Object.values(state.components).some(component => component.status !== "succeeded")) {
      state.consecutiveFailures++;
      state.nextAttemptAt = new Date(Date.now() + Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(state.consecutiveFailures - 1, 20))).toISOString();
      const reason = state.dependencyRepairAttempts >= 3 ? "dependency_repair_exhausted" : "partial_dependencies";
      await phase("partial", reason);
      return finish("partial", reason);
    }
    state.lastSuccessAt = iso(); state.consecutiveFailures = 0;
    await phase("succeeded", "healthy");
    return finish("succeeded", "healthy");
  } catch (error) {
    if (state) {
      state.phase = ["activating", "repairing"].includes(state.phase) ? "blocked" : "failed";
      state.reasonCode = "attempt_error"; state.updatedAt = iso(); state.consecutiveFailures++;
      state.nextAttemptAt = new Date(Date.now() + Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(state.consecutiveFailures - 1, 20))).toISOString();
      await atomicJson(statePath(config), state);
    }
    event.finish("failed", { ready: false, errorCode: safeErrorCode(error), reasonCode: "attempt_error" });
    return { status: state?.phase === "blocked" ? "blocked" : "failed", reasonCode: "attempt_error" };
  } finally { lock.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift() ?? "run";
  const option = (name: string, fallback?: string) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  const configFile = option("--config", "/etc/host-upgrade.json")!;
  const config = parseConfig(JSON.parse(await readFile(configFile, "utf8")));
  if (command === "init") return initialize(config);
  if (command === "component") return recordComponent(config, option("--name")!, option("--status")! as ComponentState["status"], option("--reason")!);
  if (command === "status") { console.log(JSON.stringify(await readUpgradeHealth(statePath(config)))); return; }
  if (command !== "run") throw new Error("unknown upgrade operation");
  const result = await reconcile(config, { acknowledgeInterrupted: args.includes("--acknowledge-interrupted"), configFile });
  if (!["succeeded", "skipped"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { events.begin("upgrade.start", "background").finish("failed", { errorCode: safeErrorCode(error), ready: false }); process.exitCode = 1; }
}
