import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export class IntegrityError extends Error {}
class DurabilityIdentityError extends IntegrityError {}
function statIdentity(s: import("node:fs").BigIntStats): string {
  return [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(
    ":",
  );
}
/** logical content hashes cannot certify a restored or replaced physical file. */
export function physicalIdentity(path: string): string {
  const link = lstatSync(path, { bigint: true });
  return (
    statIdentity(link) +
    (link.isSymbolicLink()
      ? `>${statIdentity(statSync(path, { bigint: true }))}`
      : "")
  );
}
/** darwin's fsync alone does not force a drive-cache barrier. fail closed. */
export function flushFile(fd: number): void {
  fsyncSync(fd);
  if (process.platform === "darwin") {
    const r = spawnSync("python3", ["-c", "import fcntl; fcntl.fcntl(3, 51)"], {
      stdio: ["ignore", "ignore", "pipe", fd],
      timeout: 10_000,
    });
    if (r.status !== 0)
      throw new Error(
        `F_FULLFSYNC failed: ${r.error?.message ?? r.stderr?.toString()}`,
      );
  }
}
export function flushDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableDirectory(path: string): void {
  if (existsSync(path)) return;
  const parent = dirname(path);
  if (parent !== path) durableDirectory(parent);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if (!existsSync(path)) throw e;
  }
  flushDirectory(parent);
}
/** a pathname replacement cannot inherit the barrier of an unlinked descriptor. */
export function confirmDurability(path: string): string {
  const fd = openSync(path, "r");
  try {
    const identity = physicalIdentity(path);
    const opened = statIdentity(fstatSync(fd, { bigint: true }));
    if (statIdentity(statSync(path, { bigint: true })) !== opened)
      throw new DurabilityIdentityError(`durability identity changed: ${path}`);
    fsyncSync(fd);
    flushDirectory(dirname(path));
    flushFile(fd);
    if (
      statIdentity(fstatSync(fd, { bigint: true })) !== opened ||
      statIdentity(statSync(path, { bigint: true })) !== opened ||
      physicalIdentity(path) !== identity
    )
      throw new DurabilityIdentityError(`durability identity changed: ${path}`);
    return identity;
  } catch (error) {
    // publication may already be visible; this must never request callback replay.
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new DurabilityIdentityError(
        `durability identity changed: ${path}`,
        {
          cause: error,
        },
      );
    throw error;
  } finally {
    closeSync(fd);
  }
}
/** Same descriptor/path barriers as confirmDurability, amortizing Darwin's helper startup. */
export function confirmDurabilities(
  paths: readonly string[],
): Map<string, string> {
  const unique = [...new Set(paths)];
  if (process.platform !== "darwin")
    return new Map(unique.map((path) => [path, confirmDurability(path)]));
  if (!unique.length) return new Map();
  const script = `import os,sys,json,fcntl,signal
signal.signal(signal.SIGALRM, signal.SIG_DFL)
def identity(s):
 return ':'.join(str(x) for x in (s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns))
def physical(p):
 s=os.lstat(p)
 return identity(s)+('>'+identity(os.stat(p)) if os.path.islink(p) else '')
result=[]
try:
 for p in json.load(sys.stdin):
  signal.alarm(10)
  fd=os.open(p,os.O_RDONLY)
  try:
   before=physical(p); opened=identity(os.fstat(fd))
   if identity(os.stat(p))!=opened: raise RuntimeError('identity')
   os.fsync(fd)
   directory=os.open(os.path.dirname(p) or '.',os.O_RDONLY)
   try: os.fsync(directory)
   finally: os.close(directory)
   os.fsync(fd); fcntl.fcntl(fd,51)
   if identity(os.fstat(fd))!=opened or identity(os.stat(p))!=opened or physical(p)!=before: raise RuntimeError('identity')
   result.append([p,before])
  finally: os.close(fd)
  signal.alarm(0)
 print(json.dumps({'values':result}))
except (FileNotFoundError,RuntimeError):
 print(json.dumps({'identityChanged':True}));sys.exit(2)
`;
  const input = JSON.stringify(unique);
  const result = spawnSync("python3", ["-c", script], {
    input,
    encoding: "utf8",
    maxBuffer: Math.max(1024 * 1024, Buffer.byteLength(input) * 4),
  });
  let output:
    | { identityChanged?: boolean; values?: [string, string][] }
    | undefined;
  try {
    output = JSON.parse(result.stdout || "null");
  } catch {
    /* fail closed below */
  }
  if (output?.identityChanged)
    throw new DurabilityIdentityError(
      "durability identity changed during batch",
    );
  if (result.status !== 0 || output?.values?.length !== unique.length)
    throw new IntegrityError("durability batch confirmation failed");
  const confirmed = new Map<string, string>();
  for (const [i, value] of output.values.entries()) {
    if (
      value[0] !== unique[i] ||
      typeof value[1] !== "string" ||
      physicalIdentity(value[0]) !== value[1]
    )
      throw new DurabilityIdentityError(
        "durability identity changed after batch",
      );
    confirmed.set(value[0], value[1]);
  }
  return confirmed;
}

/** only published hardlinks can be removed while another preparer owns a stage. */
export function cleanupDurableStages(path: string): void {
  const prefix = `.pi-memory-stage-${basename(path)}-`;
  const bytes = readFileSync(path);
  for (const file of readdirSync(dirname(path))) {
    if (!file.startsWith(prefix)) continue;
    const stage = join(dirname(path), file);
    try {
      const staged = lstatSync(stage);
      if (staged.nlink > 1 && readFileSync(stage).equals(bytes))
        unlinkSync(stage);
    } catch (error) {
      // Another preparer may have removed this published hardlink already.
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  flushDirectory(dirname(path));
}
/** retries must establish the barrier even if a failed attempt left a final path. */
export function confirmDurable(path: string): void {
  confirmDurability(path);
  cleanupDurableStages(path);
}
/** exclusive publication keeps an existing immutable value intact on collision. */
function createImmutable(
  path: string,
  bytes: string | Buffer,
  beforeLink?: () => void,
): void {
  durableDirectory(dirname(path));
  const prefix = `.pi-memory-stage-${basename(path)}-`;
  if (existsSync(path)) {
    if (!readFileSync(path).equals(Buffer.from(bytes)))
      throw new IntegrityError(`immutable collision: ${path}`);
    beforeLink?.();
  } else {
    const temporary = join(dirname(path), `${prefix}${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforeLink?.();
    try {
      linkSync(temporary, path);
    } catch (e) {
      if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes)))
        throw e;
    }
  }
}
/** unreferenced objects grant no acceptance; concurrent cleanup removes published hardlinks only. */
export function prepareDurableCreate(
  path: string,
  bytes: string | Buffer,
): string | null {
  createImmutable(path, bytes);
  const identity = physicalIdentity(path);
  try {
    confirmDurability(path);
  } catch (error) {
    // A competing preparer's published-stage cleanup can change inode metadata.
    // This object grants no acceptance yet; reprepare instead of dropping capture.
    if (error instanceof DurabilityIdentityError) return null;
    throw error;
  }
  return physicalIdentity(path) === identity ? identity : null;
}
export function durableCreate(
  path: string,
  bytes: string | Buffer,
  beforeLink?: () => void,
): void {
  createImmutable(path, bytes, beforeLink);
  confirmDurable(path);
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  it("batches descriptor-bound barriers without one helper process per retained file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-batch-barrier-"));
    const { symlinkSync } = await import("node:fs");
    const child = (await import("node:child_process")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const spy = vi.spyOn(child, "spawnSync");
    syncBuiltinESMExports();
    try {
      const a = join(dir, "first-🌿"),
        b = join(dir, "second"),
        link = join(dir, "linked");
      writeFileSync(a, "first");
      writeFileSync(b, "second");
      symlinkSync(a, link);
      const result = confirmDurabilities([a, b, link, a]);
      expect(result.size).toBe(3);
      for (const path of [a, b, link])
        expect(result.get(path)).toBe(physicalIdentity(path));
      expect(spy.mock.calls.length).toBe(process.platform === "darwin" ? 1 : 0);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "batch confirmation rejects a replacement inode after the descriptor barrier",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "memory-batch-replace-"));
      const path = join(dir, "payload"),
        replacement = join(dir, "replacement");
      const originalPath = process.env.PATH;
      const python = spawnSync("which", ["python3"], {
        encoding: "utf8",
      }).stdout.trim();
      try {
        mkdirSync(join(dir, "bin"));
        writeFileSync(path, "same bytes");
        writeFileSync(replacement, "same bytes");
        writeFileSync(
          join(dir, "bin", "python3"),
          `#!${python}
import sys,os,fcntl
original=fcntl.fcntl
def swap(fd,operation):
 result=original(fd,operation)
 if operation==51: os.replace(${JSON.stringify(replacement)},${JSON.stringify(path)})
 return result
fcntl.fcntl=swap
exec(sys.argv[2])
`,
          { mode: 0o700 },
        );
        process.env.PATH = join(dir, "bin") + ":" + originalPath;
        expect(() => confirmDurabilities([path])).toThrow(
          "durability identity changed",
        );
        expect(readFileSync(path, "utf8")).toBe("same bytes");
      } finally {
        process.env.PATH = originalPath;
        rmSync(dir, { recursive: true });
      }
    },
  );

  it("prepares physical durability without removing staging files; explicit serialized cleanup removes only matching bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-barrier-"));
    try {
      const path = join(dir, "immutable"),
        matching = join(dir, ".pi-memory-stage-immutable-matching"),
        different = join(dir, ".pi-memory-stage-immutable-different"),
        unpublished = join(dir, ".pi-memory-stage-immutable-unpublished");
      writeFileSync(path, "accepted bytes");
      linkSync(path, matching);
      writeFileSync(different, "different bytes");
      writeFileSync(unpublished, "accepted bytes");
      confirmDurability(path);
      expect(readFileSync(matching, "utf8")).toBe("accepted bytes");
      expect(readFileSync(different, "utf8")).toBe("different bytes");
      cleanupDurableStages(path);
      expect(existsSync(matching)).toBe(false);
      expect(readFileSync(unpublished, "utf8")).toBe("accepted bytes");
      expect(readFileSync(path, "utf8")).toBe("accepted bytes");
      expect(readFileSync(different, "utf8")).toBe("different bytes");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("prepares an immutable object without cleaning its stage or replacing conflicting bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-object-prepare-"));
    try {
      const path = join(dir, "object");
      expect(prepareDurableCreate(path, "prepared bytes")).toBe(
        physicalIdentity(path),
      );
      const stages = readdirSync(dir).filter((name) =>
        name.startsWith(".pi-memory-stage-object-"),
      );
      expect(stages).toHaveLength(1);
      expect(readFileSync(join(dir, stages[0]!), "utf8")).toBe(
        "prepared bytes",
      );
      expect(() => prepareDurableCreate(path, "different bytes")).toThrow(
        "immutable collision",
      );
      expect(readFileSync(path, "utf8")).toBe("prepared bytes");
      cleanupDurableStages(path);
      expect(readdirSync(dir)).toEqual(["object"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}
