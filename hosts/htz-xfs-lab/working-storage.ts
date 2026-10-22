import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const GIB = 1024 ** 3;
export interface Storage {
  volume: string;
  home: string;
  label: string;
  device: string;
  directories: string[];
}
export type Command = (executable: string, args: string[], timeoutMs?: number) => string;

export function parseStorage(value: unknown): Storage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid storage configuration");
  const cfg = value as Record<string, unknown>;
  const string = (key: string): string => {
    const item = cfg[key];
    if (typeof item !== "string" || !item) throw new Error(`invalid storage ${key}`);
    return item;
  };
  const volume = string("volume"), home = string("home");
  for (const path of [volume, home]) {
    if (!path.startsWith("/") || path === "/" || resolve(path) !== path) throw new Error("invalid storage path");
  }
  if (!Array.isArray(cfg.directories) || cfg.directories.length === 0
    || cfg.directories.some(path => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".."))
    || new Set(cfg.directories).size !== cfg.directories.length) {
    throw new Error("invalid storage directories");
  }
  return { volume, home, label: string("label"), device: string("device"), directories: cfg.directories };
}

export const nativeCommand: Command = (executable, args, timeoutMs = 15_000) => {
  try {
    return execFileSync(executable, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`${executable} failed or timed out`);
  }
};

export function assertReady(cfg: Storage, volumeOnly = false, command = nativeCommand): void {
  command("mountpoint", ["-q", cfg.volume]);
  const uuid = command("findmnt", ["-n", "-o", "UUID", "--mountpoint", cfg.volume]);
  if (!uuid || command("findmnt", ["-n", "-o", "LABEL", "--mountpoint", cfg.volume]) !== cfg.label) {
    throw new Error("working volume identity mismatch");
  }
  if (!volumeOnly) {
    for (const relative of cfg.directories) {
      const path = join(cfg.home, relative);
      command("mountpoint", ["-q", path]);
      if (command("findmnt", ["-n", "-o", "UUID", "--mountpoint", path]) !== uuid) {
        throw new Error(`working-storage bind identity mismatch: ${relative}`);
      }
    }
  }
}

/** systemd can create missing bind sources; admission must run BEFORE mounting. */
export function assertSources(cfg: Storage, command = nativeCommand): void {
  assertReady(cfg, true, command);
  if (!lstatSync(join(cfg.volume, "host-data/.migration-complete")).isFile()) throw new Error("storage migration is incomplete");
  for (const relative of cfg.directories) {
    if (!lstatSync(join(cfg.volume, "host-data/bdsqqq", relative)).isDirectory()) {
      throw new Error(`missing or unsafe working-storage source: ${relative}`);
    }
  }
}

/** VDO's physical counters include overhead; the 100 GiB filesystem does not. */
export function capacityReport(output: string, rootFree: number) {
  const fields = new Map(output.split("\n").filter(line => line.includes(":")).map(line => {
    const separator = line.indexOf(":");
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const total = Number(fields.get("1K-blocks")) * 1024;
  const free = Number(fields.get("1K-blocks available")) * 1024;
  const mode = fields.get("operating mode");
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(free) || free < 0 || free > total || !mode) {
    throw new Error("missing or invalid VDO capacity");
  }
  const usedPercent = 100 * (total - free) / total;
  const warnings: string[] = [];
  if (usedPercent >= 80) warnings.push("VDO physical usage >= 80%; logical free space is not physical headroom");
  if (mode !== "normal") warnings.push("VDO operating mode is not normal");
  if (rootFree < 4 * GIB) warnings.push("root available space < 4 GiB");
  return {
    vdo_physical_total_bytes: total,
    vdo_physical_free_bytes: free,
    vdo_physical_used_percent: Math.round(usedPercent * 100) / 100,
    vdo_operating_mode: mode,
    root_available_bytes: rootFree,
    warnings,
    healthy: warnings.length === 0,
  };
}

function rootAvailable(): number {
  const root = statfsSync("/");
  return root.bavail * root.bsize;
}

/** Between-build pressure GC only touches the dead store set, never profiles. */
export function collectRoot(free: number, command = nativeCommand): void {
  if (free < 4 * GIB) command("nix-store", ["--gc", "--max-freed", String(8 * GIB - free)], 600_000);
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      config: { type: "string" }, "volume-only": { type: "boolean" },
    } });
    if (!values.config || positionals.length !== 1) throw new Error("usage: working-storage --config <path> ready|sources|prepare|health|gc [--volume-only]");
    const cfg = parseStorage(JSON.parse(readFileSync(values.config, "utf8")));
    switch (positionals[0]) {
      case "ready": assertReady(cfg, values["volume-only"]); break;
      case "sources": assertSources(cfg); break;
      case "prepare": {
        assertReady(cfg);
        const build = join(cfg.volume, "nix-build");
        const scratch = join(cfg.home, ".cache/tmp");
        mkdirSync(build, { recursive: true, mode: 0o755 });
        chmodSync(build, 0o755);
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const owner = statSync(cfg.home);
        chownSync(scratch, owner.uid, owner.gid);
        chmodSync(scratch, 0o700);
        break;
      }
      case "gc": collectRoot(rootAvailable()); break;
      case "health": {
        assertReady(cfg, true);
        const result = capacityReport(nativeCommand("vdostats", ["--verbose", cfg.device]), rootAvailable());
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result.healthy ? 0 : 1;
      }
      default: throw new Error("unknown working-storage action");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ healthy: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
