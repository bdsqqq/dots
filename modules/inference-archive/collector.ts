import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanJournal, validateRecord, MAX_RECORD_BYTES } from './verify.ts';
import { UUID, NODE_ID, TOKEN, MAX_BATCH, EMPTY_SHA, sha256, validProof } from './replication-protocol.ts';
import type { Proof } from './replication-protocol.ts';
import { durableJson, loadConfiguration, missing, prefixHash, privateDirectory, privateOpen, privateText, readRange, rootLock, scanReplicationJournal, syncDirectory } from './replication-store.ts';
const SHA = /^[a-f0-9]{64}$/;
type Transaction = { offset: number; prefix: string; sha256: string; sealed: boolean; length: number; bodySha256: string };
/** Nonsecret launcher configuration; keysFile itself must be a private runtime file. */
export type CollectorConfiguration = { root: string; host: '127.0.0.1'; port: number; keysFile: string; reserveBytes?: number; maxBytes?: number };
export type CollectorOptions = {
  root: string; keys: Record<string, string>; port?: number; reserveBytes?: number; spoolLimitBytes?: number;
  /** Test-only durability fault boundary; never receives keys or journal content. */
  beforeIO?: (operation: 'data-write' | 'data-sync' | 'directory-sync' | 'metadata-sync') => void | Promise<void>;
};
class Failure extends Error {
  status: number;
  constructor(status: number) { super('archive request failed'); this.status = status; }
}
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if (missing(e)) return false; throw e; } }
async function diskUsage(path: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(path)) {
    const file = join(path, name), s = await lstat(file);
    if (s.isDirectory()) { if (s.mode & 0o077) throw new Error('unsafe directory'); bytes += await diskUsage(file); }
    else if (s.isFile() && s.nlink === 1 && !(s.mode & 0o077)) bytes += s.size;
    else throw new Error('unsafe spool entry');
  }
  return bytes;
}
function checkProof(p: Proof, id: string, node: string) {
  if (!validProof(p, id, node)) throw new Failure(409);
}

/** Validate a proposed batch BEFORE it reaches the authoritative journal. Existing
 * records are checked with scanJournal; this continuation uses the same v1 contract.
 */
function validateBatch(body: Buffer, id: string, prior: { sequence: number; lane?: string; finished: boolean }) {
  const state = { ...prior, requestId: id };
  if (body.length && body[body.length - 1] !== 10) throw new Failure(400);
  let at = 0;
  while (at < body.length) {
    const end = body.indexOf(10, at);
    if (end - at + 1 > MAX_RECORD_BYTES) throw new Failure(400);
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(at, end)));
    try { validateRecord(r, state); } catch { throw new Failure(400); }
    at = end + 1;
  }
  return state;
}

/** Runtime key file format: {"gateway-node":"43+ base64url characters"}.
 * Keys are never placed in argv, persisted as origins, or included in HTTP errors.
 */
export async function loadKeys(path: string): Promise<Record<string, string>> {
  try { const keys: unknown = JSON.parse(await privateText(path)); return validateKeys(keys); }
  catch { throw new Error('invalid private key configuration'); }
}
function validateKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid key configuration');
  const keys = value as Record<string, string>;
  if (!Object.keys(keys).length || !Object.entries(keys).every(([node, key]) => NODE_ID.test(node) && typeof key === 'string' && TOKEN.test(key)) || new Set(Object.values(keys)).size !== Object.keys(keys).length) throw new Error('invalid key configuration');
  return { ...keys };
}

/** Explicit disaster-recovery operation, never automatic adoption of unknown
 * bytes. Raw + origins are the backup contract; acknowledgements are derived.
 * Partial records stay untouched and require preserved producer replay.
 */
export async function adoptRestoredCollector(directory: string) {
  const root = resolve(directory);
  await privateDirectory(root);
  const unlock = await rootLock(root, 'collector');
  let adopted = 0;
  try {
    const journal = join(root, 'journal'), origins = join(root, 'origins'), states = join(root, 'replication-state');
    await privateDirectory(journal); await privateDirectory(origins); await privateDirectory(states, true);
    const pending = join(root, 'replication-pending');
    if (await exists(pending) && (await readdir(pending)).some(name => name.endsWith('.txn'))) throw new Error('pending transaction requires normal recovery');
    for (const name of (await readdir(journal)).sort()) {
      const match = /^(.+)\.(jsonl|open)$/.exec(name);
      if (!match || !UUID.test(match[1])) continue;
      const id = match[1], raw = join(journal, name), sealed = match[2] === 'jsonl';
      if (await exists(join(journal, id + (sealed ? '.open' : '.jsonl')))) throw new Error('ambiguous restored journal');
      const originFile = await privateOpen(join(origins, id + '.json'));
      let origin: { schemaVersion: number; requestId: string; nodeId: string };
      try {
        origin = JSON.parse(await originFile.readFile('utf8'));
        if (origin.schemaVersion !== 1 || origin.requestId !== id || typeof origin.nodeId !== 'string' || !NODE_ID.test(origin.nodeId)) throw new Error('invalid restored origin');
        // A restored directory sync does not persist its files' contents.
        await originFile.sync();
      } finally { await originFile.close(); }
      let offset = 0, hash = EMPTY_SHA;
      for await (const line of scanReplicationJournal(raw, id, sealed)) { offset = line.end; hash = line.prefixSha256; }
      const fd = await privateOpen(raw, constants.O_RDWR);
      try {
        if ((await fd.stat()).size !== offset || await prefixHash(fd, offset) !== hash) throw new Error('partial or changed restored journal; preserve bytes before producer replay');
        await fd.sync();
      } finally { await fd.close(); }
      const proof: Proof = { schemaVersion: 1, nodeId: origin.nodeId, requestId: id, offset, sha256: hash, sealed };
      const state = join(states, id + '.json');
      if (await exists(state)) {
        const previous = JSON.parse(await privateText(state)); checkProof(previous, id, origin.nodeId);
        if (previous.offset !== offset || previous.sha256 !== hash || previous.sealed !== sealed) throw new Error('conflicting restored state');
      } else { await durableJson(state, proof); adopted++; }
    }
    await syncDirectory(journal); await syncDirectory(origins); await syncDirectory(states);
    return { adopted };
  } finally { await unlock(); }
}

export async function startCollector(options: CollectorOptions) {
  const root = resolve(options.root), keys = validateKeys(options.keys);
  const reserve = options.reserveBytes ?? 8 * 1024 ** 3, cap = options.spoolLimitBytes ?? 24 * 1024 ** 3;
  for (const n of [reserve, cap]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid capacity');
  const port = options.port ?? 18925;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  await privateDirectory(root, true);
  const unlock = await rootLock(root, 'collector');
  const journal = join(root, 'journal'), origins = join(root, 'origins'), states = join(root, 'replication-state'), pending = join(root, 'replication-pending');
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
  const hook = options.beforeIO;
  const budget = async (add: number) => {
    const fs = await statfs(root, { bigint: true });
    if (await diskUsage(root) + add > cap || fs.bavail * fs.bsize < BigInt(reserve) + BigInt(add)) throw new Failure(507);
  };
  const paths = (id: string) => ({ origin: join(origins, id + '.json'), state: join(states, id + '.json'), txn: join(pending, id + '.txn'), active: join(journal, id + '.open'), sealed: join(journal, id + '.jsonl') });
  const saveState = (path: string, proof: Proof) => durableJson(path, proof, () => hook?.('metadata-sync'));
  const inspect = async (path: string, p: Proof) => {
    const fd = await privateOpen(path);
    try { if ((await fd.stat()).size !== p.offset || await prefixHash(fd, p.offset) !== p.sha256) throw new Failure(409); }
    finally { await fd.close(); }
    let sequence = 0, lane: string | undefined, finished = false;
    for await (const line of scanReplicationJournal(path, p.requestId, p.sealed)) {
      sequence = line.sequence; lane = line.lane; finished = line.finished;
    }
    return { sequence, lane, finished };
  };
  const get = async (id: string, node: string, create: boolean): Promise<Proof> => {
    for (const dir of [root, journal, origins, states, pending]) await privateDirectory(dir);
    const p = paths(id);
    const empty: Proof = { schemaVersion: 1, nodeId: node, requestId: id, offset: 0, sha256: EMPTY_SHA, sealed: false };
    if (!await exists(p.origin)) {
      if (await exists(p.state) || await exists(p.active) || await exists(p.sealed) || await exists(p.txn)) throw new Failure(409);
      if (!create) return empty;
      await budget(8192);
      await durableJson(p.origin, { schemaVersion: 1, nodeId: node, requestId: id }, () => hook?.('metadata-sync'));
    }
    const origin = JSON.parse(await privateText(p.origin));
    if (origin.schemaVersion !== 1 || origin.requestId !== id || origin.nodeId !== node) throw new Failure(409);
    let proof: Proof;
    if (!await exists(p.state)) {
      if (await exists(p.sealed) || await exists(p.txn)) throw new Failure(409);
      if (!await exists(p.active)) {
        const fd = await privateOpen(p.active, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try { await fd.sync(); } finally { await fd.close(); }
        await syncDirectory(journal);
      }
      const fd = await privateOpen(p.active);
      try { if ((await fd.stat()).size) throw new Failure(409); } finally { await fd.close(); }
      await saveState(p.state, empty); proof = empty;
    } else { proof = JSON.parse(await privateText(p.state)); checkProof(proof, id, node); }
    if (await exists(p.txn)) proof = await recover(id, proof);
    if (await exists(p.active) === await exists(p.sealed)) throw new Failure(409);
    await inspect(proof.sealed ? p.sealed : p.active, proof);
    // Even a previous fsync failure must be retried before a status can prove durability.
    const fd = await privateOpen(proof.sealed ? p.sealed : p.active);
    try { await hook?.('data-sync'); await fd.sync(); } finally { await fd.close(); }
    await hook?.('directory-sync'); await syncDirectory(journal); await syncDirectory(origins); await syncDirectory(states);
    return proof;
  };
  const recover = async (id: string, proof: Proof): Promise<Proof> => {
    const p = paths(id), envelope = await privateOpen(p.txn);
    let txn: Transaction, body: Buffer;
    try {
      const size = (await envelope.stat()).size;
      if (size > MAX_BATCH + 2048) throw new Failure(409);
      const bytes = await envelope.readFile(), lf = bytes.indexOf(10);
      if (lf < 0 || lf > 2048) throw new Failure(409);
      txn = JSON.parse(bytes.subarray(0, lf).toString('utf8')); body = bytes.subarray(lf + 1);
    } finally { await envelope.close(); }
    if (!Number.isSafeInteger(txn.offset) || txn.offset < 0 || !SHA.test(txn.prefix) || !SHA.test(txn.sha256) || typeof txn.sealed !== 'boolean' || txn.length !== body.length || sha256(body) !== txn.bodySha256) throw new Failure(409);
    const end = txn.offset + body.length;
    if (proof.offset !== txn.offset && proof.offset !== end) throw new Failure(409);
    if (proof.offset === txn.offset && proof.sha256 !== txn.prefix) throw new Failure(409);
    if (proof.offset === end && body.length && (proof.sha256 !== txn.sha256 || proof.sealed !== txn.sealed)) throw new Failure(409);
    const isSealed = await exists(p.sealed);
    if (isSealed && (!txn.sealed || await exists(p.active))) throw new Failure(409);
    const raw = isSealed ? p.sealed : p.active;
    const fd = await privateOpen(raw, constants.O_RDWR);
    try {
      const size = (await fd.stat()).size;
      if (size < txn.offset || size > end || await prefixHash(fd, txn.offset) !== txn.prefix) throw new Failure(409);
      if (!(await readRange(fd, txn.offset, size - txn.offset)).equals(body.subarray(0, size - txn.offset))) throw new Failure(409);
      let at = size - txn.offset;
      // A restart cannot spend yesterday's free-space reservation: other writers
      // may have consumed the filesystem while the collector was offline.
      if (at < body.length) await budget(body.length - at + 8192);
      while (at < body.length) {
        await hook?.('data-write');
        const { bytesWritten } = await fd.write(body, at, Math.min(64 * 1024, body.length - at), txn.offset + at);
        if (!bytesWritten) throw new Failure(507);
        at += bytesWritten;
      }
      if (await prefixHash(fd, end) !== txn.sha256) throw new Failure(409);
      await hook?.('data-sync'); await fd.sync();
    } finally { await fd.close(); }
    const next: Proof = { ...proof, offset: end, sha256: txn.sha256, sealed: txn.sealed };
    await inspect(raw, next);
    if (txn.sealed && !isSealed) { await rename(p.active, p.sealed); }
    await hook?.('directory-sync'); await syncDirectory(journal);
    await saveState(p.state, next);
    await unlink(p.txn); await syncDirectory(pending);
    return next;
  };
  const append = async (id: string, node: string, txn: Transaction, body: Buffer) => {
    const proof = await get(id, node, true), p = paths(id);
    if (txn.offset > proof.offset) throw new Failure(409);
    const fd = await privateOpen(proof.sealed ? p.sealed : p.active);
    try {
      if (await prefixHash(fd, txn.offset) !== txn.prefix) throw new Failure(409);
      if (txn.offset + body.length <= proof.offset) {
        if (!(await readRange(fd, txn.offset, body.length)).equals(body) || await prefixHash(fd, txn.offset + body.length) !== txn.sha256) throw new Failure(409);
        if (!txn.sealed || proof.sealed) return proof;
        if (txn.offset + body.length !== proof.offset) throw new Failure(409);
        // An empty (or replayed final) batch may finalize an already-uploaded finish.
        txn = { ...txn, offset: proof.offset, prefix: proof.sha256, length: 0, bodySha256: EMPTY_SHA }; body = Buffer.alloc(0);
      }
    } finally { await fd.close(); }
    if (txn.offset !== proof.offset || proof.sealed) throw new Failure(409);
    const lifecycle = await inspect(p.active, proof);
    const next = validateBatch(body, id, lifecycle);
    if (txn.sealed && !next.finished) throw new Failure(400);
    if (!body.length && !txn.sealed) return proof;
    const hashFd = await privateOpen(p.active);
    try {
      const hash = createHash('sha256'); const chunk = Buffer.alloc(256 * 1024); let at = 0;
      while (at < proof.offset) { const n = Math.min(chunk.length, proof.offset - at); const b = await readRange(hashFd, at, n); hash.update(b); at += n; }
      if (hash.update(body).digest('hex') !== txn.sha256) throw new Failure(409);
    } finally { await hashFd.close(); }
    // Account for both staging and the eventual raw append, plus small metadata writes.
    await budget(body.length * 2 + 16384);
    const temp = p.txn + '.' + randomUUID() + '.tmp';
    const staging = await privateOpen(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await staging.writeFile(Buffer.concat([Buffer.from(JSON.stringify(txn) + '\n'), body])); await staging.sync(); } finally { await staging.close(); }
    await rename(temp, p.txn); await syncDirectory(pending);
    return recover(id, proof);
  };
  const reply = (res: ServerResponse, status: number, value?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const authenticate = (req: IncomingMessage) => {
    const node = req.headers['x-archive-node'], auth = req.headers.authorization;
    if (typeof node !== 'string' || !NODE_ID.test(node) || typeof auth !== 'string' || !auth.startsWith('Bearer ')) throw new Failure(401);
    const candidate = sha256(Buffer.from(auth.slice(7))), expected = sha256(Buffer.from(keys[node] ?? 'invalid-key'));
    if (!Object.hasOwn(keys, node) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) throw new Failure(401);
    return node;
  };
  const server = httpServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { schemaVersion: 1, service: 'inference-archive-collector', healthy: true });
      if (req.method === 'GET' && req.url === '/ready') {
        await serial(() => budget(16384)); return reply(res, 200, { schemaVersion: 1, ready: true });
      }
      const node = authenticate(req);
      const match = /^\/v1\/journals\/([^/]+)$/.exec(req.url ?? '');
      if (!match || !UUID.test(match[1])) throw new Failure(400);
      const id = match[1];
      if (req.method === 'GET') return reply(res, 200, await serial(() => get(id, node, false)));
      if (req.method !== 'POST') throw new Failure(405);
      const offset = Number(req.headers['x-archive-offset']), prefix = req.headers['x-archive-prefix-sha256'], hash = req.headers['x-archive-sha256'], seal = req.headers['x-archive-sealed'];
      if (!Number.isSafeInteger(offset) || offset < 0 || typeof prefix !== 'string' || !SHA.test(prefix) || typeof hash !== 'string' || !SHA.test(hash) || !['true', 'false'].includes(String(seal))) throw new Failure(400);
      if (Number(req.headers['content-length']) > MAX_BATCH) throw new Failure(413);
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BATCH) throw new Failure(413); parts.push(Buffer.from(chunk)); }
      const body = Buffer.concat(parts);
      const txn: Transaction = { offset, prefix, sha256: hash, sealed: seal === 'true', length: body.length, bodySha256: sha256(body) };
      return reply(res, 200, await serial(() => append(id, node, txn, body)));
    })().catch(error => {
      req.resume();
      if (!res.headersSent) reply(res, error instanceof Failure ? error.status : 503);
      else res.destroy();
    });
  });
  server.requestTimeout = 60_000; server.headersTimeout = 15_000;
  try {
    for (const dir of [journal, origins, states, pending]) await privateDirectory(dir, true);
    await syncDirectory(root); await syncDirectory(dirname(root));
    // Recover transactions before listening; never advertise partially recovered readiness.
    for (const name of await readdir(pending)) {
      if (!name.endsWith('.txn')) continue;
      const id = name.slice(0, -4); if (!UUID.test(id)) throw new Failure(409);
      const origin = JSON.parse(await privateText(paths(id).origin));
      if (!NODE_ID.test(origin.nodeId)) throw new Failure(409);
      await get(id, origin.nodeId, false);
    }
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  } catch (error) { await unlock(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('invalid listener');
  return { port: address.port, url: `http://127.0.0.1:${address.port}`,
    close: async () => { await new Promise<void>((ok, fail) => { server.close(error => error ? fail(error) : ok()); server.closeIdleConnections(); }); await tail; await unlock(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const adopt = process.argv[2] === 'adopt-restored';
    if (process.argv.length !== (adopt ? 4 : 3)) throw new Error('configuration path required');
    const config = await loadConfiguration<CollectorConfiguration>(process.argv[adopt ? 3 : 2]);
    if (!config || typeof config.root !== 'string' || !config.root || config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.keysFile !== 'string' || !config.keysFile) throw new Error('invalid configuration');
    if (adopt) { console.log(JSON.stringify(await adoptRestoredCollector(config.root))); process.exit(0); }
    const collector = await startCollector({ root: config.root, keys: await loadKeys(config.keysFile), port: config.port,
      reserveBytes: config.reserveBytes, spoolLimitBytes: config.maxBytes });
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void collector.close().catch(() => { process.exitCode = 1; }); } });
  } catch { console.error('inference archive collector stopped; check private configuration, capacity and journal integrity'); process.exitCode = 1; }
}
