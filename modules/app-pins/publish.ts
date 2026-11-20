/**
 * pins are read and written through an in-memory overlay of main and committed with a
 * throwaway index, so the user's checkout is never touched, whatever state it's in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { due, installedApp, record, type App, type Deps, type RecordResult, type Store } from "./pins.ts";

export type PublishOptions = {
  remote: string;
  /** provenance in the commit subject, e.g. "mbp-m2". */
  host: string;
  cacheDir: string;
  branch?: string;
  attempts?: number;
  /** how old a local fetch may be and still decide "nothing to do" offline. */
  maxStaleMs?: number;
  env?: NodeJS.ProcessEnv;
};
export type PublishTimings = { fetchMs: number; feedMs: number; pushMs: number };
export type PublishResult =
  | { status: "absent"; networkSkipped: boolean; attempts: number; timings: PublishTimings }
  | { status: "unchanged"; networkSkipped: true; attempts: 0; timings: PublishTimings; from?: string; to: string }
  | { status: "unchanged"; networkSkipped: false; attempts: number; timings: PublishTimings; record: RecordResult & { status: "recorded" | "unchanged" } }
  | { status: "published"; networkSkipped: false; attempts: number; timings: PublishTimings; record: RecordResult & { status: "recorded" | "unchanged" }; commit: string };

const elapsed = (since: number) => Math.round(performance.now() - since);

function git(cache: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync("git", ["--git-dir", cache, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    // a launchd agent must never hang on a stuck network or credential prompt.
    timeout: 300_000,
  }).trim();
}

function overlay(cache: string, commit: string, env: NodeJS.ProcessEnv): Store & { changes: Map<string, string> } {
  const changes = new Map<string, string>();
  return {
    changes,
    read(path) {
      if (changes.has(path)) return changes.get(path)!;
      // trees are local in a blobless clone, so absence is decided without the network.
      // a blob that can't be fetched must fail loudly, never read as "no pin yet".
      if (!git(cache, ["ls-tree", "--name-only", commit, "--", path], env)) return null;
      return execFileSync("git", ["--git-dir", cache, "cat-file", "blob", `${commit}:${path}`],
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    },
    write(path, text) { changes.set(path, text); },
  };
}

function clone(cache: string, remote: string, branch: string, env: NodeJS.ProcessEnv) {
  // clone beside it and rename into place, so a crash mid-clone never leaves a
  // half-built cache that later runs would trust.
  mkdirSync(join(cache, ".."), { recursive: true });
  rmSync(cache, { recursive: true, force: true });
  const partial = `${cache}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  try {
    execFileSync("git", ["clone", "--bare", "--filter=blob:none", "--single-branch", "--branch", branch, remote, partial],
      { env, stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 });
    renameSync(partial, cache);
  } finally { rmSync(partial, { recursive: true, force: true }); }
}
const tracking = (branch: string) => `refs/remotes/origin/${branch}`;
/** a stamp touched after every successful fetch; its age bounds how stale an offline decision can be. */
const fetchedStamp = (cache: string) => join(cache, "app-pins-fetched");
function freshMain(cache: string, branch: string, env: NodeJS.ProcessEnv, maxStaleMs: number): string | null {
  try {
    if (Date.now() - statSync(fetchedStamp(cache)).mtimeMs > maxStaleMs) return null;
    return git(cache, ["rev-parse", "--verify", "--quiet", tracking(branch)], env);
  } catch { return null; }
}
function markFetched(cache: string) {
  const stamp = fetchedStamp(cache), now = new Date();
  try { utimesSync(stamp, now, now); } catch { writeFileSync(stamp, ""); }
}

export function message(app: App, host: string, result: RecordResult & { status: "recorded" | "unchanged" }) {
  const subject = `bump ${app.name} (auto-committed from ${host})`;
  const lines = [];
  if (result.status === "recorded") lines.push(`${result.from ?? "unpinned"} -> ${result.to}`);
  if (result.linuxAdvanced) lines.push("linux pin advanced to match.");
  // a change with neither is pin metadata (e.g. the bundled rex CLI version); say so.
  if (!lines.length) lines.push(`${result.to}: pin metadata updated, version unchanged.`);
  return `${subject}\n\n${lines.join("\n")}\n`;
}

function commit(cache: string, base: string, changes: Map<string, string>, text: string, env: NodeJS.ProcessEnv): string {
  const work = mkdtempSync(join(tmpdir(), "app-pins-index-"));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(work, "index") };
    git(cache, ["read-tree", base], indexEnv);
    for (const [path, content] of changes) {
      const blob = git(cache, ["hash-object", "-w", "--stdin"], env, content);
      git(cache, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], indexEnv);
    }
    const tree = git(cache, ["write-tree"], indexEnv);
    // commit-tree takes the user's identity from config but ignores commit.gpgsign: pass it on.
    let sign: string[] = [];
    try { if (git(cache, ["config", "--bool", "commit.gpgsign"], env) === "true") sign = ["-S"]; } catch { /* unset */ }
    return git(cache, ["commit-tree", ...sign, tree, "-p", base, "-F", "-"], env, text);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export async function publish(app: App, deps: Deps, options: PublishOptions): Promise<PublishResult> {
  const cache = join(options.cacheDir, `${app.name}.git`), branch = options.branch ?? "main";
  const env = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=20" };
  const timings: PublishTimings = { fetchMs: 0, feedMs: 0, pushMs: 0 };

  // identity is checked before any shortcut, so a foreign bundle always fails.
  const installed = installedApp(app, deps);
  if (!installed) return { status: "absent", networkSkipped: true, attempts: 0, timings };
  // the mac pin only moves up, so a lagging clone can only ask for an extra fetch.
  // linux follow-ups can be settled by another mac, so trust a clone only briefly.
  const known = freshMain(cache, branch, env, options.maxStaleMs ?? 6 * 60 * 60_000);
  if (known) {
    const check = due(app, overlay(cache, known, env), installed);
    if (!check.due) return { status: "unchanged", networkSkipped: true, attempts: 0, timings, from: check.from, to: check.to };
  }

  const attempts = options.attempts ?? 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let started = performance.now();
    if (!existsSync(join(cache, "HEAD"))) clone(cache, options.remote, branch, env);
    git(cache, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${tracking(branch)}`], env);
    markFetched(cache);
    const base = git(cache, ["rev-parse", tracking(branch)], env);
    timings.fetchMs += elapsed(started);

    started = performance.now();
    const store = overlay(cache, base, env);
    const result = await record(app, store, deps);
    timings.feedMs += elapsed(started);
    if (result.status === "absent") return { status: "absent", networkSkipped: false, attempts: attempt, timings };
    if (store.changes.size === 0) return { status: "unchanged", networkSkipped: false, attempts: attempt, timings, record: result };

    started = performance.now();
    const created = commit(cache, base, store.changes, message(app, options.host, result), env);
    try {
      // a plain push: a moved main is rejected, never overwritten.
      git(cache, ["push", "--quiet", "origin", `${created}:refs/heads/${branch}`], env);
      git(cache, ["update-ref", tracking(branch), created, base], env);
      timings.pushMs += elapsed(started);
      return { status: "published", networkSkipped: false, attempts: attempt, timings, record: result, commit: created };
    } catch (error) {
      timings.pushMs += elapsed(started);
      if (attempt === attempts) throw error;
    }
  }
  throw new Error("unreachable");
}

// agents activated before cli.ts existed still launch this file with the old argv
// (`--remote URL --host NAME [--notify] APP`). forward them until every mac has switched.
// no top-level await: cli.ts imports this module, which must finish loading first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void import("./cli.ts").then(async ({ main }) => { process.exitCode = await main(["publish", ...process.argv.slice(2)]); });
}
