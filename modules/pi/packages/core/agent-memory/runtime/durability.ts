import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export class IntegrityError extends Error {}
/** darwin's fsync alone does not force a drive-cache barrier. fail closed. */
export function flushFile(fd: number): void {
  fsyncSync(fd);
  if (process.platform === "darwin") {
    const r = spawnSync("python3", ["-c", "import fcntl; fcntl.fcntl(3, 51)"], { stdio: ["ignore", "ignore", "pipe", fd], timeout: 10_000 });
    if (r.status !== 0) throw new Error(`F_FULLFSYNC failed: ${r.error?.message ?? r.stderr?.toString()}`);
  }
}
export function flushDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function durableDirectory(path: string): void {
  if (existsSync(path)) return;
  const parent = dirname(path); if (parent !== path) durableDirectory(parent);
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if (!existsSync(path)) throw e; }
  flushDirectory(parent);
}
/** exclusive publication keeps an existing immutable value intact on collision. */
export function durableCreate(path: string, bytes: string | Buffer): void {
  durableDirectory(dirname(path));
  if (existsSync(path)) { if (!readFileSync(path).equals(Buffer.from(bytes))) throw new IntegrityError(`immutable collision: ${path}`); return; }
  const temporary = join(dirname(path), `.stage-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); flushFile(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } catch (e) { if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes))) throw e; }
  // staged files are retained: kill recovery never relies on an unlinked inode.
  flushDirectory(dirname(path));
  const finalFd = openSync(path, "r"); try { flushFile(finalFd); } finally { closeSync(finalFd); }
}
