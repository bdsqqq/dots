/**
 * the one command line for app-pins. it parses argv, runs one operation per app, emits
 * one context-rich event per operation, and maps outcomes to an exit status. the
 * operations themselves live in pins.ts (record, install) and publish.ts (publish).
 *
 *   cli.ts record  --repo DIR [APP...]
 *   cli.ts install --repo DIR [APP...]
 *   cli.ts publish --remote URL --host NAME [--cache-dir DIR] [--notify] [APP...]
 *
 * no APP means every app in apps.json. unknown apps and flags fail before any work.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventLogger, safeErrorCode, type EventContext } from "../service-events/events.ts";
import { AppPinError, install, loadApps, nativeDeps, record, worktree, type App, type Deps } from "./pins.ts";
import { publish } from "./publish.ts";

export type Command =
  | { op: "record"; repo: string; apps: App[] }
  | { op: "install"; repo: string; apps: App[] }
  | { op: "publish"; remote: string; host: string; cacheDir: string; notify: boolean; apps: App[] };

export class UsageError extends Error {}
const usage = "usage: cli.ts record|install --repo DIR [APP...] | publish --remote URL --host NAME [--cache-dir DIR] [--notify] [APP...]";

export function parse(argv: string[], catalog = loadApps()): Command {
  const [op, ...rest] = argv;
  const flags = new Map<string, string | true>(), names: string[] = [];
  const valued = new Set(["--repo", "--remote", "--host", "--cache-dir"]), switches = new Set(["--notify"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (valued.has(arg)) {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a value\n${usage}`);
      flags.set(arg, value);
    } else if (switches.has(arg)) flags.set(arg, true);
    else if (arg.startsWith("-")) throw new UsageError(`unknown flag ${arg}\n${usage}`);
    else names.push(arg);
  }
  const unknown = names.filter(n => !catalog[n]);
  if (unknown.length) throw new UsageError(`unknown app ${unknown.join(", ")}; known: ${Object.keys(catalog).join(", ")}`);
  const apps = (names.length ? names : Object.keys(catalog)).map(n => catalog[n]);
  const value = (flag: string) => {
    const v = flags.get(flag);
    if (typeof v !== "string") throw new UsageError(`${op} needs ${flag}\n${usage}`);
    return v;
  };
  const only = (allowed: string[]) => {
    const extra = [...flags.keys()].filter(f => !allowed.includes(f));
    if (extra.length) throw new UsageError(`${op} does not take ${extra.join(", ")}\n${usage}`);
  };
  if (op === "record") { only(["--repo"]); return { op, repo: value("--repo"), apps }; }
  if (op === "install") { only(["--repo"]); return { op, repo: value("--repo"), apps }; }
  if (op === "publish") {
    only(["--remote", "--host", "--cache-dir", "--notify"]);
    const cacheDir = flags.get("--cache-dir");
    return { op, remote: value("--remote"), host: value("--host"), notify: flags.get("--notify") === true, apps,
      cacheDir: typeof cacheDir === "string" ? cacheDir : join(homedir(), ".local/state/app-pins") };
  }
  throw new UsageError(usage);
}

type Outcome = { context: EventContext; notify?: string };
async function runOne(command: Command, app: App, deps: Deps): Promise<Outcome> {
  if (command.op === "record") {
    const r = await record(app, worktree(command.repo), deps);
    return { context: r.status === "absent" ? { reasonCode: "absent", changed: false }
      : { reasonCode: r.status, changed: r.changed, fromVersion: r.from, toVersion: r.to } };
  }
  if (command.op === "install") {
    const r = await install(app, worktree(command.repo), deps);
    return { context: { reasonCode: r.status, changed: r.status === "installed", toVersion: r.version } };
  }
  return publishOne(command, app, deps);
}
async function publishOne(command: Extract<Command, { op: "publish" }>, app: App, deps: Deps): Promise<Outcome> {
  const r = await publish(app, deps, command);
  const versions = r.record && r.record.status !== "absent" ? { fromVersion: r.record.from, toVersion: r.record.to } : {};
  return {
    context: { reasonCode: r.status, changed: r.status === "published", networkSkipped: r.networkSkipped,
      attempt: r.attempts, ...r.timings, ...versions, ...(r.status === "published" ? { revision: r.commit } : {}) },
    notify: r.status === "published" && command.notify ? `pushed ${app.name} ${r.record.to} to main` : undefined,
  };
}

/** returns the exit status; one event per app, success or not. */
export async function main(argv: string[], deps: Deps = nativeDeps, log = createEventLogger("app-pins"),
    catalog: Record<string, App> = loadApps()): Promise<number> {
  let command: Command;
  try { command = parse(argv, catalog); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  let status = 0;
  for (const app of command.apps) {
    const event = log.begin(`app.${command.op}`, "background", { action: app.name });
    try {
      const { context, notify } = await runOne(command, app, deps);
      event.finish("succeeded", { action: app.name, ...context });
      if (notify) {
        try { deps.run("osascript", ["-e", `display notification "${notify}" with title "app-pins"`]); } catch { /* cosmetic */ }
      }
    } catch (error) {
      status = 1;
      // expected failures keep their domain code; everything else stays a generic code,
      // never exception text in the event. the message goes to stderr for the log file.
      event.finish("failed", { action: app.name, errorCode: safeErrorCode(error),
        ...(error instanceof AppPinError ? { reasonCode: error.code } : {}) });
      console.error(`app-pins ${command.op} ${app.name}: ${(error as Error).message ?? error}`);
    }
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
