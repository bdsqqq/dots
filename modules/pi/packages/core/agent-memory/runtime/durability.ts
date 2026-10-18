import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
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
/** logical content hashes cannot certify a restored or replaced physical file. */
export function physicalIdentity(path: string): string {
  const link = lstatSync(path, { bigint: true });
  const identity = (s: typeof link): string =>
    [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  return (
    identity(link) +
    (link.isSymbolicLink()
      ? `>${identity(statSync(path, { bigint: true }))}`
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
/** safe during concurrent preparation: establish barriers without removing stages. */
export function confirmDurability(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
    flushDirectory(dirname(path));
    flushFile(fd);
  } finally {
    closeSync(fd);
  }
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
/** unreferenced objects grant no acceptance; cleanup waits for serialized admission. */
export function prepareDurableCreate(
  path: string,
  bytes: string | Buffer,
): string | null {
  createImmutable(path, bytes);
  const identity = physicalIdentity(path);
  confirmDurability(path);
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
  const { it, expect } = import.meta.vitest;
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
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
