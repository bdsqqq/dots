/**
 * record → commit → push, without touching the user's checkout.
 *
 * the working tree may be dirty, on another branch, or mid-rebase; none of that
 * matters here. a private bare clone fetches origin/main, pins are read from and
 * written to an in-memory overlay of that tree, and the commit is built with a
 * throwaway index. a rejected push (main moved) refetches and recomputes from the
 * new main; since pins only move up, a lost race usually turns into a no-op.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventLogger, safeErrorCode } from "../service-events/events.ts";
import { loadApps, nativeDeps, record, type AppSpec, type Deps, type RecordResult, type Store } from "./pins.ts";

export type PublishOptions = {
  remote: string;        // e.g. git@github.com:bdsqqq/dots.git
  branch?: string;       // default main
  cache?: string;        // private bare clone
  host?: string;         // provenance in the commit message
  attempts?: number;
  env?: NodeJS.ProcessEnv;
};
export type PublishResult = { app: string; status: "published" | "unchanged" | "absent"; commit?: string; attempts: number; result?: RecordResult };

function git(cache: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync("git", ["--git-dir", cache, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", env, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    // a launchd agent must never hang on a stuck network or credential prompt.
    timeout: 300_000,
  }).trim();
}

/** an overlay of one commit's tree: reads fall through to git, writes stay in memory. */
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

function ensureCache(cache: string, remote: string, branch: string, env: NodeJS.ProcessEnv) {
  if (!existsSync(join(cache, "HEAD"))) {
    mkdirSync(cache, { recursive: true });
    // blobless: pins are a few KB; history and other files are fetched lazily, if ever.
    execFileSync("git", ["clone", "--bare", "--filter=blob:none", "--single-branch", "--branch", branch, remote, cache],
      { env, stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 });
  }
  git(cache, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], env);
  return git(cache, ["rev-parse", `refs/remotes/origin/${branch}`], env);
}

export function message(name: string, host: string, result: RecordResult) {
  const subject = `bump ${name} (auto-committed from ${host})`;
  const lines = [];
  if (result.status === "recorded") lines.push(`${result.previous ?? "unpinned"} -> ${result.version}`);
  if (result.linux) lines.push("linux pin advanced to match.");
  return lines.length ? `${subject}\n\n${lines.join("\n")}\n` : `${subject}\n`;
}

/** every app's agent fires at load; they share one private clone, so serialize on it. */
async function locked<T>(cache: string, run: () => Promise<T>): Promise<T> {
  const lock = `${cache}.lock`, deadline = Date.now() + 20 * 60_000;
  mkdirSync(join(cache, ".."), { recursive: true });
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // a crashed holder can't release; any run is bounded well under 30 minutes.
      try { if (Date.now() - statSync(lock).mtimeMs > 30 * 60_000) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  try { return await run(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export async function publish(name: string, deps: Deps, options: PublishOptions, spec: AppSpec = loadApps()[name]): Promise<PublishResult> {
  const cache = options.cache ?? join(homedir(), ".local/state/app-pins/dots.git");
  return locked(cache, () => publishLocked(name, deps, options, spec, cache));
}

async function publishLocked(name: string, deps: Deps, options: PublishOptions, spec: AppSpec, cache: string): Promise<PublishResult> {
  const branch = options.branch ?? "main", env = { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=20" };
  const host = options.host ?? hostname().replace(/\.local$/, "");
  const attempts = options.attempts ?? 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const base = ensureCache(cache, options.remote, branch, env);
    const store = overlay(cache, base, env);
    const result = await record(name, store, deps, spec);
    if (result.status === "absent") return { app: name, status: "absent", attempts: attempt };
    if (store.changes.size === 0) return { app: name, status: "unchanged", attempts: attempt, result };

    const work = mkdtempSync(join(tmpdir(), "app-pins-index-"));
    try {
      const indexEnv = { ...env, GIT_INDEX_FILE: join(work, "index") };
      git(cache, ["read-tree", base], indexEnv);
      for (const [path, text] of store.changes) {
        const blob = git(cache, ["hash-object", "-w", "--stdin"], env, text);
        git(cache, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], indexEnv);
      }
      const tree = git(cache, ["write-tree"], indexEnv);
      // commit-tree takes the user's identity from config but ignores commit.gpgsign: pass it on.
      let sign: string[] = [];
      try { if (git(cache, ["config", "--bool", "commit.gpgsign"], env) === "true") sign = ["-S"]; } catch { /* unset */ }
      const commit = git(cache, ["commit-tree", ...sign, tree, "-p", base, "-F", "-"], env, message(name, host, result));
      try {
        // a plain push: a moved main is rejected, never overwritten.
        git(cache, ["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`], env);
        git(cache, ["update-ref", `refs/remotes/origin/${branch}`, commit, base], env);
        return { app: name, status: "published", commit, attempts: attempt, result };
      } catch (error) {
        if (attempt === attempts) throw error;
        // fall through: refetch the new main and recompute against it.
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  throw new Error("unreachable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const remote = flag("--remote"), host = flag("--host"), notify = args.includes("--notify");
  const names = args.filter(a => a !== "--notify");
  if (!remote || !names.length) throw new Error("usage: publish.ts --remote URL [--host NAME] [--notify] APP...");
  let failed = false;
  for (const name of names) {
    const event = createEventLogger("app-pins").begin("app.publish", "background", { action: name });
    try {
      const r = await publish(name, nativeDeps, { remote, host });
      event.finish("succeeded", { action: name, reasonCode: r.status, revision: r.commit, attempt: r.attempts, changed: r.status === "published" });
      if (notify && r.status === "published") {
        try { nativeDeps.run("osascript", ["-e", `display notification "pushed ${name} ${r.result?.version} to main" with title "app-pins"`]); } catch { /* cosmetic */ }
      }
    } catch (error) {
      failed = true;
      event.finish("failed", { action: name, errorCode: safeErrorCode(error) });
      console.error(`app-pins publish ${name}: ${(error as Error).message ?? error}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
