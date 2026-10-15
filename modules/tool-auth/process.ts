import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Native entrypoints may be linked; Node canonicalizes import.meta.url. */
export function isMain(url: string): boolean {
  return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === url;
}

export interface Command {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Authentication diagnostics can contain tokens or private API responses.
 * Capture for validation, but expose only our fixed failure messages. */
export function capture(command: Command, timeout = 15_000): string {
  const result = spawnSync(command.executable, command.args, {
    env: command.env ?? process.env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("authentication check failed or timed out; use the tool's private setup flow");
  return result.stdout;
}

/** Follow runtime SOPS links; never accept a public/store-backed secret. */
export function privateFile(path: string): string {
  if (!path.startsWith("/") || path.startsWith("/nix/store/")) throw new Error("a private absolute runtime credential path is required");
  try {
    if (realpathSync(path).startsWith("/nix/store/")) throw new Error("store-backed credential");
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) throw new Error("unsafe credential");
    const contents = readFileSync(path, "utf8");
    if (!contents.trim()) throw new Error("empty credential");
    return contents;
  } catch {
    throw new Error("credential is missing, empty, or not a private file; provision its owning secret");
  }
}
