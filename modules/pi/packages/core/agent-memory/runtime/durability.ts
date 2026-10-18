import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export class IntegrityError extends Error {}
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
/** retries must establish the barrier even if a failed attempt left a final path. */
export function confirmDurable(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
    flushDirectory(dirname(path));
    flushFile(fd);
    const prefix = `.pi-memory-stage-${basename(path)}-`;
    const bytes = readFileSync(path);
    for (const file of readdirSync(dirname(path))) {
      if (!file.startsWith(prefix)) continue;
      const stage = join(dirname(path), file);
      if (readFileSync(stage).equals(bytes)) unlinkSync(stage);
    }
    flushDirectory(dirname(path));
  } finally {
    closeSync(fd);
  }
}
/** exclusive publication keeps an existing immutable value intact on collision. */
export function durableCreate(path: string, bytes: string | Buffer): void {
  durableDirectory(dirname(path));
  const prefix = `.pi-memory-stage-${basename(path)}-`;
  if (existsSync(path)) {
    if (!readFileSync(path).equals(Buffer.from(bytes)))
      throw new IntegrityError(`immutable collision: ${path}`);
  } else {
    const temporary = join(dirname(path), `${prefix}${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (e) {
      if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(bytes)))
        throw e;
    }
  }
  confirmDurable(path);
}
