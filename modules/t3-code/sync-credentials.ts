#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export interface SyncConfig {
  home: string;
  secrets: Record<string, string>;
}

const reserved = new Set(["PATH", "T3CODE_HOME", "T3_BOOT_SERVICE_UNIT", "T3_SERVICE_LAUNCHER_CONTEXT"]);
const validName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reserved.has(name.toUpperCase());

function quote(value: string): string {
  for (const delimiter of ["'", '"', "`"]) {
    if (value.includes(delimiter)) continue;
    const encoded = `${delimiter}${value}${delimiter}`;
    if (parseEnv(`KEY=${encoded}\n`).KEY === value) return encoded;
  }
  throw new Error("credential cannot be represented losslessly in native dotenv format");
}

// A quoted dotenv value may span lines that look like other assignments.
function entries(contents: string): { name?: string; text: string }[] {
  const lines = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: { name?: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^]*)$/.exec(text);
    if (match) {
      const value = match[2]!;
      const delimiter = value[0];
      if (delimiter === "'" || delimiter === '"' || delimiter === "`") {
        let remainder = value.slice(1);
        while (!remainder.includes(delimiter)) {
          if (++i >= lines.length) throw new Error("unterminated quoted service environment value");
          remainder += lines[i]!;
          text += lines[i]!;
        }
      }
    }
    result.push({ ...(match ? { name: match[1]! } : {}), text });
  }
  return result;
}

export function mergeEnvironment(contents: string, previous: string[], values: Record<string, string>): string {
  const owned = new Set([...previous, ...Object.keys(values)]);
  if (![...owned].every(validName)) throw new Error("invalid or reserved managed environment name");
  const kept = entries(contents).filter((entry) => !entry.name || !owned.has(entry.name)).map((entry) => entry.text).join("");
  const managed = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${quote(value)}\n`).join("");
  const next = kept + (kept && !kept.endsWith("\n") && managed ? "\n" : "") + managed;
  const expected = Object.fromEntries(Object.entries(parseEnv(contents)).filter(([name]) => !owned.has(name)));
  if (JSON.stringify(Object.entries(parseEnv(next)).sort()) !== JSON.stringify(Object.entries({ ...expected, ...values }).sort())) {
    throw new Error("environment merge would change unrelated settings");
  }
  return next;
}

async function optionalRead(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function atomicWrite(path: string, contents: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function secretEnvironment(secrets: Record<string, string>) {
  const values: Record<string, string> = Object.create(null);
  const owners = new Map<string, string>();
  const fileOnly: string[] = [];
  for (const [secret, path] of Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))) {
    if (!secret || typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid deployed secret");
    let canonical = secret.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
    if (/^[0-9]/.test(canonical)) canonical = `_${canonical}`;
    if (!validName(canonical)) canonical = `SOPS_${canonical}`;
    const aliases = [...new Set([canonical, ...(validName(secret) ? [secret] : [])])];
    for (const name of aliases.flatMap((alias) => [alias, `${alias}_FILE`])) {
      if (owners.has(name)) throw new Error("deployed secret names collide in the environment");
      owners.set(name, secret);
    }
    const bytes = await readFile(path);
    let value: string | undefined;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "");
      // Cookie jars stay on disk even if a small jar could fit in dotenv.
      if (bytes.length <= 4096 && !decoded.includes("\0") && !/(^|_)COOKIES?(_|$)/.test(canonical)) {
        quote(decoded);
        value = decoded;
      }
    } catch { /* Native dotenv cannot represent arbitrary file contents; the file stays available. */ }
    for (const alias of aliases) {
      values[`${alias}_FILE`] = path;
      if (value !== undefined) values[alias] = value;
    }
    if (value === undefined) fileOnly.push(secret);
  }
  return { values, fileOnly, managedNames: [...owners.keys()].sort() };
}

export async function syncCredentials(config: SyncConfig): Promise<{ changed: boolean; restartPending: boolean; fileOnly: string[] }> {
  if (!config.home || !config.secrets || typeof config.secrets !== "object" || Array.isArray(config.secrets)) throw new Error("invalid sync configuration");
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  const lock = await open(join(config.home, ".credential-sync.flock"), "a", 0o600);
  try {
    // BSD flock belongs to the inherited open file description: closing this
    // descriptor (including on process death) releases it. Never unlink the file.
    const acquired = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
    });
    if (acquired.error) throw acquired.error;
    if (acquired.status !== 0) throw new Error("credential sync lock unavailable");
    const target = join(config.home, "service.env");
    const state = join(config.home, ".managed-service-env.json");
    const pending = join(config.home, "service-env-restart-required");
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("service.env must be a regular, unshared file");
    const previousText = await optionalRead(state);
    const previous: unknown = previousText ? JSON.parse(previousText) : [];
    if (!Array.isArray(previous) || !previous.every((name) => typeof name === "string" && validName(name))) throw new Error("invalid managed credential state");
    const { values, fileOnly, managedNames: names } = await secretEnvironment(config.secrets);
    const original = await optionalRead(target);
    const next = mergeEnvironment(original, [...previous, ...names], values);
    const changed = JSON.stringify(Object.entries(parseEnv(original)).sort()) !== JSON.stringify(Object.entries(parseEnv(next)).sort());
    // Record ownership first so interrupted removal can be retried without losing retired names.
    const retainedState = JSON.stringify([...new Set([...previous, ...names])].sort()) + "\n";
    if (retainedState !== previousText) await atomicWrite(state, retainedState);
    if (next !== original) {
      if (changed) await atomicWrite(pending, "credentials changed; restart the native T3 service, then remove this notice\n");
      if (await optionalRead(target) !== original) throw new Error("service.env changed during sync; retry");
      await atomicWrite(target, next);
    } else if (stat) {
      await chmod(target, 0o600);
    }
    const nextState = JSON.stringify(names) + "\n";
    if (nextState !== retainedState) await atomicWrite(state, nextState);
    return { changed, restartPending: Boolean(await optionalRead(pending)), fileOnly };
  } finally { await lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const configPath = process.argv[2] ?? join(homedir(), ".config/t3-code/credentials.json");
    const result = await syncCredentials(JSON.parse(await readFile(configPath, "utf8")));
    console.log(result.restartPending ? "t3 credentials synced; native service restart pending" : "t3 credentials up to date");
    if (result.fileOnly.length) console.log(`available as files only (cookies, binary, large, or not dotenv-compatible): ${result.fileOnly.join(", ")}`);
  } catch {
    // Filesystem and parser errors can contain credential text; never forward them to launchd logs.
    console.error("t3 credential sync failed; check configuration, secret availability, and concurrent syncs");
    process.exitCode = 1;
  }
}
