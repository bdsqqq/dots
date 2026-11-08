import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { scanJournal } from './verify.ts';

export async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || (s.mode & 0o077)) throw new Error('private directory required');
}
export async function privateOpen(path: string, flags = constants.O_RDONLY) {
  const fd = await open(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const s = await fd.stat();
    if (!s.isFile() || (s.mode & 0o077) || s.nlink !== 1) throw new Error('private regular file required');
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
/** Launcher config may live in the Nix store; key material must use privateText. */
export async function loadConfiguration<T>(path: string): Promise<T> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await fd.stat()).isFile()) throw new Error('regular configuration required'); return JSON.parse(await fd.readFile('utf8')) as T; }
  finally { await fd.close(); }
}
export async function privateText(path: string) {
  const fd = await privateOpen(path);
  try { return await fd.readFile('utf8'); } finally { await fd.close(); }
}
export async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function durableJson(path: string, value: unknown, beforeSync?: () => void | Promise<void>) {
  // Existing targets must never redirect an atomic receipt update through a symlink.
  try { const fd = await privateOpen(path); await fd.close(); } catch (e) { if (!missing(e)) throw e; }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await privateOpen(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await beforeSync?.(); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, path); await syncDirectory(dirname(path));
}
export function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Canonical roots share a kernel-owned lock, released on process death. */
export async function rootLock(root: string, role: 'collector' | 'replicate') {
  const canonical = await realpath(root);
  const port = 20000 + createHash('sha256').update(`${role}\0${canonical}`).digest().readUInt32BE(0) % 40000;
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((ok, fail) => { lock.once('error', fail); lock.listen(port, '127.0.0.1', ok); });
  return () => new Promise<void>((ok, fail) => lock.close(error => error ? fail(error) : ok()));
}
export async function prefixHash(fd: FileHandle, end: number) {
  const hash = createHash('sha256'); const chunk = Buffer.alloc(256 * 1024);
  let at = 0;
  while (at < end) {
    const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, end - at), at);
    if (!bytesRead) throw new Error('source shortened');
    hash.update(chunk.subarray(0, bytesRead)); at += bytesRead;
  }
  return hash.digest('hex');
}
export async function readRange(fd: FileHandle, offset: number, length: number) {
  const bytes = Buffer.alloc(length); let at = 0;
  while (at < length) {
    const { bytesRead } = await fd.read(bytes, at, length - at, offset + at);
    if (!bytesRead) throw new Error('source shortened');
    at += bytesRead;
  }
  return bytes;
}

/** Private source identity wraps the same bounded v1 parser used by indexing. */
export async function* scanReplicationJournal(path: string, id: string, sealed: boolean) {
  const fd = await privateOpen(path);
  try {
    for await (const line of scanJournal(path, sealed)) {
      if (line.record.requestId !== id) throw new Error('journal identity conflict');
      yield { end: line.end, prefixSha256: line.prefixSha256, sequence: line.record.sequence + 1, lane: line.record.lane, finished: line.record.kind === 'finish' };
    }
  } finally { await fd.close(); }
}
