import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, statfs, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Lane = 'client' | 'codex-upstream';
export type Outcome = 'complete' | 'aborted' | 'error' | 'recovered-incomplete';
export type Reason = 'peer-aborted' | 'upstream-failure' | 'storage-failure' | 'size-limit' | 'shutdown' | 'process-interrupted' | 'protocol-failure';
export type JournalEvent =
  | { kind: 'start'; transport: 'http' | 'websocket'; method: string; pathname: string; headers: Record<string, string>; upstream: string }
  | { kind: 'data'; direction: 'request' | 'response'; data: string; binary?: boolean }
  | { kind: 'response'; status: number; headers: Record<string, string> }
  | { kind: 'control'; direction: 'request' | 'response'; control: 'ping' | 'pong' | 'close'; data: string; code?: number }
  | { kind: 'finish'; outcome: Outcome; reason?: Reason };
export type JournalRecord = JournalEvent & {
  schemaVersion: 1; requestId: string; sequence: number; timestamp: string; lane: Lane;
};

const terminalBudget = 1024;
const maxLine = 24 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasons = new Set<Reason>(['peer-aborted', 'upstream-failure', 'storage-failure', 'size-limit', 'shutdown', 'process-interrupted', 'protocol-failure']);

/** Deliberately carries no native error/cause, which can contain credentials or paths. */
export class JournalError extends Error {
  readonly code: 'storage-failure' | 'storage-limit' | 'size-limit' | 'corrupt-journal' | 'writer-locked';
  constructor(code: JournalError['code']) { super(code); this.code = code; }
}

/** Only named metadata is retained; even an innocuous-looking arbitrary header can be a credential. */
export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const allowed = new Set(['content-type', 'content-encoding', 'accept', 'openai-beta', 'anthropic-version']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (allowed.has(name) && typeof value === 'string' && value.length <= 1024) result[name] = value;
    // Correlation IDs must be opaque UUIDs, not arbitrary bearer material.
    if (['x-request-id', 'x-correlation-id', 'x-inference-archive-request-id', 'x-inference-archive-parent'].includes(name)
      && typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) result[name] = value;
  }
  return result;
}

function validEvent(r: Record<string, unknown>): boolean {
  const headers = (h: unknown) => typeof h === 'object' && h !== null && !Array.isArray(h)
    && Object.entries(h).every(([k, v]) => typeof v === 'string' && sanitizeHeaders({ [k]: v })[k] === v);
  const base64 = (v: unknown) => typeof v === 'string' && Buffer.from(v, 'base64').toString('base64') === v;
  switch (r.kind) {
    case 'start': return ['http', 'websocket'].includes(String(r.transport)) && typeof r.method === 'string'
      && typeof r.pathname === 'string' && r.pathname.startsWith('/') && !r.pathname.includes('?') && !r.pathname.includes('#')
      && headers(r.headers) && typeof r.upstream === 'string' && /^https?:\/\//.test(r.upstream);
    case 'data': return ['request', 'response'].includes(String(r.direction)) && base64(r.data) && (r.binary === undefined || typeof r.binary === 'boolean');
    case 'response': return Number.isInteger(r.status) && Number(r.status) >= 100 && Number(r.status) <= 599 && headers(r.headers);
    case 'control': return ['request', 'response'].includes(String(r.direction)) && ['ping', 'pong', 'close'].includes(String(r.control)) && base64(r.data)
      && (r.code === undefined || Number.isInteger(r.code));
    case 'finish': return ['complete', 'aborted', 'error', 'recovered-incomplete'].includes(String(r.outcome)) && (r.reason === undefined || reasons.has(r.reason as Reason));
    default: return false;
  }
}

/** Streaming integrity check shared by startup recovery and offline consumers. No repair/truncation. */
export async function inspectJournal(path: string, requestId?: string): Promise<{ count: number; finished: boolean; lane: Lane; bytes: number }> {
  let pending = Buffer.alloc(0), count = 0, finished = false, lane: Lane | undefined, bytes = 0, id = requestId;
  try {
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > maxLine || finished) throw new JournalError('corrupt-journal');
        const raw = pending.subarray(0, end);
        if (!raw.equals(Buffer.from(raw.toString('utf8')))) throw new JournalError('corrupt-journal');
        const r = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        id ??= String(r.requestId);
        lane ??= r.lane as Lane;
        if (!idPattern.test(id) || r.schemaVersion !== 1 || r.requestId !== id || r.sequence !== count || r.lane !== lane
          || !['client', 'codex-upstream'].includes(lane) || typeof r.timestamp !== 'string'
          || !Number.isFinite(Date.parse(r.timestamp)) || (count === 0 ? r.kind !== 'start' : r.kind === 'start') || !validEvent(r)) throw new JournalError('corrupt-journal');
        finished = r.kind === 'finish';
        count++;
        pending = pending.subarray(end + 1);
      }
      if (pending.length > maxLine) throw new JournalError('corrupt-journal');
    }
    if (pending.length || count === 0 || !lane) throw new JournalError('corrupt-journal');
    return { count, finished, lane, bytes };
  } catch (e) {
    if (e instanceof JournalError) throw e;
    throw new JournalError('corrupt-journal');
  }
}

export interface JournalOptions {
  root: string;
  /** Free space that capture must never intentionally spend. Defaults to 5 GiB. */
  reserveBytes?: number;
  /** Includes open and finalized journals; nothing is automatically deleted. Defaults to 8 GiB. */
  spoolLimitBytes?: number;
  /** Fault injection at the native durability boundary; never receives content. */
  beforeIO?: (operation: 'write' | 'sync' | 'rename') => void | Promise<void>;
}

/** One writer per root. Separate processes/lanes must use separate roots (or share this instance). */
export class JournalStore {
  private bytes = 0;
  private reserved = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<Journal>();
  private broken = false;
  private closed = false;
  private options: JournalOptions;
  private directory: string;
  private dir: FileHandle;
  private lock: FileHandle;
  private constructor(options: JournalOptions, directory: string, dir: FileHandle, lock: FileHandle) {
    this.options = options; this.directory = directory; this.dir = dir; this.lock = lock;
  }

  static async open(options: JournalOptions): Promise<JournalStore> {
    for (const n of [options.reserveBytes ?? 5 * 1024 ** 3, options.spoolLimitBytes ?? 8 * 1024 ** 3]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new JournalError('size-limit');
    }
    if (typeof options.root !== 'string' || !options.root) throw new JournalError('storage-failure');
    let store: JournalStore | undefined, lock: FileHandle | undefined;
    const directory = join(options.root, 'journal');
    try {
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      if (!(await lstat(options.root)).isDirectory()) throw new JournalError('storage-failure');
      await chmod(options.root, 0o700);
      await mkdir(directory, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      if (!(await lstat(directory)).isDirectory()) throw new JournalError('storage-failure');
      await chmod(directory, 0o700);
      const lockPath = join(options.root, '.capture.lock');
      const recoveryPath = join(options.root, '.capture-recovery');
      // Serialize stale-lock reclamation. Ambiguous/partial ownership stays fail-closed.
      try { await lstat(recoveryPath); throw new JournalError('writer-locked'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch {
        let recovery: FileHandle | undefined;
        try {
          recovery = await open(recoveryPath, 'wx', 0o600);
          const pid = Number(await readFile(lockPath, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new JournalError('writer-locked');
          try { process.kill(pid, 0); throw new JournalError('writer-locked'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new JournalError('writer-locked'); }
          await unlink(lockPath);
          lock = await open(lockPath, 'wx', 0o600);
        } finally {
          if (recovery) { await recovery.close(); await unlink(recoveryPath); }
        }
      }
      await lock.writeFile(String(process.pid));
      await lock.sync();
      for (const path of [options.root, dirname(options.root)]) {
        const parent = await open(path, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      const dir = await open(directory, 'r');
      store = new JournalStore(options, directory, dir, lock);
      for (const name of await readdir(directory)) {
        const match = /^(.+)\.(open|jsonl)$/.exec(name);
        if (!match || !idPattern.test(match[1])) throw new JournalError('corrupt-journal');
        const path = join(directory, name);
        if (!(await lstat(path)).isFile()) throw new JournalError('corrupt-journal');
        await chmod(path, 0o600);
        const info = await inspectJournal(path, match[1]);
        store.bytes += info.bytes;
        if (match[2] === 'jsonl' && !info.finished) throw new JournalError('corrupt-journal');
      }
      // Validate the entire spool before modifying any record.
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.open')) continue;
        const id = name.slice(0, -5), path = join(directory, name);
        const info = await inspectJournal(path, id);
        const handle = await open(path, 'a', 0o600);
        const journal = new Journal(store, id, info.lane, handle, info.count);
        store.active.add(journal);
        store.reserved += terminalBudget;
        if (!info.finished) await journal.finish('recovered-incomplete', 'process-interrupted');
        else await store.finalize(journal);
      }
      await dir.sync();
      return store;
    } catch (e) {
      if (store) for (const j of store.active) await j.handle.close().catch(() => {});
      await store?.dir.close().catch(() => {});
      if (lock) { await lock.close().catch(() => {}); await unlink(join(options.root, '.capture.lock')).catch(() => {}); }
      if (e instanceof JournalError) throw e;
      throw new JournalError('storage-failure');
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  private async budget(add: number, terminal = false): Promise<void> {
    const fs = await statfs(this.directory, { bigint: true });
    const reserve = this.options.reserveBytes ?? 5 * 1024 ** 3;
    const cap = this.options.spoolLimitBytes ?? 8 * 1024 ** 3;
    const held = terminal ? Math.max(0, this.reserved - terminalBudget) : this.reserved;
    if (this.bytes + add + held > cap || fs.bavail * fs.bsize < BigInt(reserve) + BigInt(add) + BigInt(held)) throw new JournalError('storage-limit');
  }

  async begin(lane: Lane, start: Extract<JournalEvent, { kind: 'start' }>): Promise<Journal> {
    return this.serial(async () => {
      if (this.closed || this.broken) throw new JournalError('storage-failure');
      const id = randomUUID();
      let handle: FileHandle | undefined;
      try {
        this.reserved += terminalBudget;
        await this.budget(4096);
        handle = await open(join(this.directory, `${id}.open`), 'wx', 0o600);
        const journal = new Journal(this, id, lane, handle);
        const headers = { ...start.headers };
        if (lane === 'client') {
          // The edge owns this identity. Caller-supplied archive lineage must not impersonate another exchange.
          headers['x-inference-archive-request-id'] = id;
          delete headers['x-inference-archive-parent'];
        }
        await this.appendNow(journal, { ...start, headers });
        await this.dir.sync(); // File fsync alone does not make its new directory entry durable.
        this.active.add(journal);
        return journal;
      } catch (e) {
        this.reserved -= terminalBudget;
        await handle?.close().catch(() => {});
        this.broken = true;
        throw e instanceof JournalError ? e : new JournalError('storage-failure');
      }
    });
  }

  private async appendNow(journal: Journal, event: JournalEvent): Promise<void> {
    const record: JournalRecord = { ...event, schemaVersion: 1, requestId: journal.requestId, sequence: journal.sequence, timestamp: new Date().toISOString(), lane: journal.lane };
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (line.length > maxLine) throw new JournalError('size-limit');
    await this.budget(line.length, event.kind === 'finish');
    await this.options.beforeIO?.('write');
    let offset = 0;
    while (offset < line.length) {
      const { bytesWritten } = await journal.handle.write(line, offset, line.length - offset);
      if (!bytesWritten) throw new JournalError('storage-failure');
      offset += bytesWritten;
      this.bytes += bytesWritten;
    }
    await this.options.beforeIO?.('sync');
    await journal.handle.sync();
    journal.sequence++;
  }

  append(journal: Journal, event: JournalEvent): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.broken || journal.finished) throw new JournalError('storage-failure');
      try {
        await this.appendNow(journal, event);
        if (event.kind === 'finish') await this.finalize(journal);
      } catch (e) {
        // A failed write/fsync has unknown durability. Do not append an apparently healthy terminal.
        if (!(e instanceof JournalError && ['size-limit', 'storage-limit'].includes(e.code))) this.broken = true;
        throw e instanceof JournalError ? e : new JournalError('storage-failure');
      }
    });
  }

  private async finalize(journal: Journal): Promise<void> {
    await journal.handle.close();
    await this.options.beforeIO?.('rename');
    const from = join(this.directory, `${journal.requestId}.open`), to = join(this.directory, `${journal.requestId}.jsonl`);
    try { await lstat(to); throw new JournalError('corrupt-journal'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await rename(from, to);
    await this.dir.sync();
    journal.finished = true;
    this.active.delete(journal);
    this.reserved -= terminalBudget;
  }

  /** Readiness checks the actual writer and filesystem budget, without creating a payload record. */
  async checkHealth(): Promise<void> {
    await this.serial(async () => {
      if (this.closed || this.broken) throw new JournalError('storage-failure');
      try { await this.budget(4096); }
      catch (e) { throw e instanceof JournalError ? e : new JournalError('storage-failure'); }
    });
  }

  async close(): Promise<void> {
    await this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      for (const j of this.active) await j.handle.close().catch(() => {});
      await this.dir.close();
      await this.lock.close();
      await unlink(join(this.options.root, '.capture.lock'));
    }).catch(() => { throw new JournalError('storage-failure'); });
  }
}

export class Journal {
  sequence: number;
  finished = false;
  private store: JournalStore;
  readonly requestId: string;
  readonly lane: Lane;
  readonly handle: FileHandle;
  constructor(store: JournalStore, requestId: string, lane: Lane, handle: FileHandle, sequence = 0) {
    this.store = store; this.requestId = requestId; this.lane = lane; this.handle = handle; this.sequence = sequence;
  }
  data(direction: 'request' | 'response', data: Buffer, binary?: boolean): Promise<void> {
    return this.store.append(this, { kind: 'data', direction, data: data.toString('base64'), ...(binary === undefined ? {} : { binary }) });
  }
  response(status: number, headers: Record<string, string>): Promise<void> { return this.store.append(this, { kind: 'response', status, headers }); }
  control(direction: 'request' | 'response', control: 'ping' | 'pong' | 'close', data: Buffer, code?: number): Promise<void> {
    return this.store.append(this, { kind: 'control', direction, control, data: data.toString('base64'), ...(code === undefined ? {} : { code }) });
  }
  finish(outcome: Outcome, reason?: Reason): Promise<void> { return this.store.append(this, { kind: 'finish', outcome, ...(reason ? { reason } : {}) }); }
}
