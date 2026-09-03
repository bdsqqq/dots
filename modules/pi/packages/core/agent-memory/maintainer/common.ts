import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { MemoryConfig } from "../catalog.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return object(value) && Object.values(value).every(isJsonValue);
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
): void {
  if (Object.keys(value).sort().join("\0") !== keys.slice().sort().join("\0"))
    throw new Error("invalid fields");
}

export function timestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`invalid ${name}`);
  return value;
}

export function boundedString(
  value: unknown,
  name: string,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  )
    throw new Error(`invalid ${name}`);
  return value;
}

export function safeRelativePath(value: unknown): string {
  const path = boundedString(value, "relative path", 500);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid relative path");
  return path;
}

export function contained(root: string, target: string): string {
  const parent = resolve(root);
  const child = resolve(target);
  const rel = relative(parent, child);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`path escapes ${parent}`);
  return child;
}

export function v3Data(
  cfg: Pick<MemoryConfig, "data">,
  ...parts: string[]
): string {
  return contained(cfg.data, join(cfg.data, "v3", ...parts));
}

export function v3State(
  cfg: Pick<MemoryConfig, "state">,
  ...parts: string[]
): string {
  return contained(cfg.state, join(cfg.state, "v3", ...parts));
}

export function ensureDurableDirectory(path: string): void {
  if (existsSync(path)) {
    chmodSync(path, 0o700);
    return;
  }
  const parent = dirname(path);
  if (parent !== path) ensureDurableDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(parent);
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function durableWrite(path: string, value: string | Buffer): void {
  ensureDurableDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function durableCreate(path: string, value: string | Buffer): boolean {
  ensureDurableDirectory(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function durableRemove(path: string): void {
  try {
    rmSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

type LockOwner = {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: string;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireDirectoryLock(
  path: string,
  options: { staleMs?: number; now?: () => Date } = {},
): { release: () => void } {
  ensureDurableDirectory(dirname(path));
  const now = options.now ?? (() => new Date());
  const staleMs = options.staleMs ?? 30_000;
  const token = randomUUID();
  const ownerPath = join(path, "owner.json");
  const acquire = (): void => {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockOwner | undefined;
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
      } catch {}
      const stale =
        (!owner || !processExists(owner.pid)) &&
        now().getTime() - statSync(path).mtimeMs >= staleMs;
      if (!stale) throw new Error("lock-contended");
      const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
      renameSync(path, stalePath);
      fsyncDirectory(dirname(path));
      rmSync(stalePath, { recursive: true, force: true });
      acquire();
      return;
    }
    durableWrite(
      ownerPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        token,
        acquiredAt: now().toISOString(),
      })}\n`,
    );
  };
  acquire();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      let owner: LockOwner | undefined;
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
      } catch {}
      if (owner?.token === token) {
        rmSync(path, { recursive: true, force: true });
        fsyncDirectory(dirname(path));
      }
    },
  };
}

export function withDirectoryLock<T>(
  path: string,
  operation: () => T,
  options: { staleMs?: number; now?: () => Date } = {},
): T {
  const lock = acquireDirectoryLock(path, options);
  try {
    return operation();
  } finally {
    lock.release();
  }
}

export async function withAsyncDirectoryLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { staleMs?: number; now?: () => Date } = {},
): Promise<T> {
  const lock = acquireDirectoryLock(path, options);
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  describe("v3 durable file primitives", () => {
    it("publishes complete records and rejects escaping paths", () => {
      const root = mkdtempSync(join(tmpdir(), "pi-memory-common-"));
      const path = join(root, "nested/record.json");
      durableWrite(path, '{"complete":true}\n');
      expect(readFileSync(path, "utf8")).toBe('{"complete":true}\n');
      expect(() => contained(root, join(root, "../escape"))).toThrow(
        "path escapes",
      );
    });

    it("serializes lock owners and releases after the operation", () => {
      const root = mkdtempSync(join(tmpdir(), "pi-memory-lock-"));
      const path = join(root, "lock");
      withDirectoryLock(path, () => {
        expect(() => withDirectoryLock(path, () => undefined)).toThrow(
          "lock-contended",
        );
      });
      expect(existsSync(path)).toBe(false);
    });
  });
}
