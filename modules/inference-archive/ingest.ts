import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, rename, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanJournal } from './verify.ts';
import { NODE_ID, UUID } from './replication-protocol.ts';
import type { JournalLine } from './verify.ts';

export const SCHEMA = [
  'CREATE DATABASE IF NOT EXISTS inference_archive',
  `CREATE TABLE IF NOT EXISTS inference_archive.events (
    request_id String, sequence UInt64, event_id FixedString(64), timestamp String,
    lane LowCardinality(String), kind LowCardinality(String), direction LowCardinality(String),
    method String, pathname String, parent_request_id String, payload_json String,
    data_base64 String, searchable_text String, source_prefix_sha256 FixedString(64)
  ) ENGINE = ReplacingMergeTree ORDER BY (request_id, sequence, event_id)`,
  "ALTER TABLE inference_archive.events ADD COLUMN IF NOT EXISTS source_node String DEFAULT ''",
  // ACK must follow part persistence, not merely a successful page-cache write.
  // Apply to an existing derived index as well as a newly created table.
  'ALTER TABLE inference_archive.events MODIFY SETTING fsync_after_insert = 1, fsync_part_directory = 1',
];

/** ReplacingMergeTree is eventually deduplicated; correctness queries MUST use FINAL.
 * event identity includes the exact serialized record, not lossy extracted text.
 */
export function eventRow(line: JournalLine, sourceNode = '') {
  const r = line.record;
  const payloadHash = createHash('sha256').update(line.raw).digest('hex');
  let searchable = '';
  // Per-chunk decoding is deliberately conservative: split UTF-8/binary stays raw-only.
  if (r.kind === 'data' && !r.binary) try { searchable = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(String(r.data), 'base64')); } catch { /* raw base64 is authoritative */ }
  const headers = r.headers as Record<string, unknown> | undefined;
  return { request_id: r.requestId, source_node: sourceNode, sequence: r.sequence,
    event_id: createHash('sha256').update(`${r.requestId}\0${r.sequence}\0${payloadHash}`).digest('hex'),
    timestamp: r.timestamp, lane: r.lane, kind: r.kind, direction: r.direction ?? '',
    method: r.method ?? '', pathname: r.pathname ?? '', parent_request_id: headers?.['x-inference-archive-parent'] ?? '',
    payload_json: line.raw, data_base64: r.kind === 'data' ? r.data : '', searchable_text: searchable,
    source_prefix_sha256: line.prefixSha256 };
}

export async function privateFile(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || (s.mode & 0o077)) throw new Error('runtime file must be private regular file');
  return readFile(path, 'utf8');
}

export type Sink = (rows: ReturnType<typeof eventRow>[]) => Promise<void>;
type Checkpoint = { offset: number; sequence: number; prefixSha256: string };
async function loadCheckpoint(path: string): Promise<Checkpoint | undefined> {
  try {
    const value = JSON.parse(await privateFile(path));
    if (!Number.isSafeInteger(value.offset) || value.offset <= 0 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !/^[a-f0-9]{64}$/.test(value.prefixSha256)) throw new Error('invalid checkpoint');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function durableJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path);
  const dir = await open(resolve(path, '..'), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/** Checkpoints follow synchronous inserts. A crash in between replays stable IDs.
 * Prefix validation also catches inode replacement/truncation instead of skipping bytes.
 * Only one indexer may own a root; the CLI holds a kernel-owned local TCP lock.
 */
export async function ingestFile(path: string, root: string, sink: Sink, batchSize = 100) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('invalid batch size');
  const sealed = path.endsWith('.jsonl');
  const stateDir = join(root, 'indexer'); const receipts = join(root, 'receipts');
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await mkdir(receipts, { recursive: true, mode: 0o700 });
  let checkpoint: Checkpoint | undefined, checkpointPath = '', matched = false, last: JournalLine | undefined;
  let rows: ReturnType<typeof eventRow>[] = [], batchLast: JournalLine | undefined, count = 0;
  let sourceNode = '';
  const flush = async () => {
    if (!rows.length || !batchLast) return;
    await sink(rows);
    const next = { offset: batchLast.end, sequence: batchLast.record.sequence, prefixSha256: batchLast.prefixSha256 };
    await durableJson(checkpointPath, next); checkpoint = next; matched = true; rows = [];
  };
  for await (const line of scanJournal(path, sealed)) {
    last = line; count++;
    if (!checkpointPath) {
      // Hash filenames: journal request IDs are data, never trusted path segments.
      checkpointPath = join(stateDir, createHash('sha256').update(line.record.requestId).digest('hex') + '.json');
      checkpoint = await loadCheckpoint(checkpointPath); matched = !checkpoint;
      // Legacy journals may have non-UUID IDs; never turn those into paths.
      if (UUID.test(line.record.requestId)) {
        try {
          const origin = JSON.parse(await privateFile(join(root, 'origins', `${line.record.requestId}.json`)));
          if (origin.schemaVersion !== 1 || origin.requestId !== line.record.requestId || typeof origin.nodeId !== 'string' || !NODE_ID.test(origin.nodeId)) throw new Error('invalid journal origin');
          sourceNode = origin.nodeId;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    if (checkpoint && line.end <= checkpoint.offset) {
      if (line.end === checkpoint.offset) {
        if (line.prefixSha256 !== checkpoint.prefixSha256 || line.record.sequence !== checkpoint.sequence) throw new Error('journal prefix changed');
        matched = true;
      }
      continue;
    }
    if (!matched) throw new Error('checkpoint is not a record boundary');
    rows.push(eventRow(line, sourceNode)); batchLast = line;
    if (rows.length >= batchSize) await flush();
  }
  if (checkpoint && !matched) throw new Error('source shorter than acknowledged checkpoint');
  await flush();
  if (sealed && last) await durableJson(join(receipts, createHash('sha256').update(last.record.requestId).digest('hex') + '.json'), {
    schemaVersion: 1, requestId: last.record.requestId, sourceNode, sha256: last.prefixSha256, bytes: last.end, records: count,
    source: path, indexedAt: new Date().toISOString(), querySemantics: 'inference_archive.events FINAL',
  });
}

export function clickHouse(endpoint: string, username: string, password: string) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('database needs HTTPS or loopback HTTP');
  if (!username || !password.trim()) throw new Error('database authentication required');
  const query = async (sql: string, body?: string) => {
    const target = new URL(url); target.searchParams.set('query', sql);
    // Explicitly override server/user async defaults: ACK must mean inserted.
    target.searchParams.set('async_insert', '0'); target.searchParams.set('wait_end_of_query', '1');
    const response = await fetch(target, { method: 'POST', redirect: 'error', headers: {
      'X-ClickHouse-User': username, 'X-ClickHouse-Key': password.trim(),
    }, body: body ?? '', signal: AbortSignal.timeout(60000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`database HTTP ${response.status}`); }
    // Body completion detects a server-side exception after HTTP headers were sent.
    const result = await response.text();
    if (result.trim()) throw new Error('unexpected database insertion response');
  };
  return { initialize: async () => { for (const sql of SCHEMA) await query(sql); },
    insert: (rows: ReturnType<typeof eventRow>[]) => query('INSERT INTO inference_archive.events FORMAT JSONEachRow', rows.map(row => JSON.stringify(row)).join('\n') + '\n') };
}

export type IngestCache = Map<string, { size: number; mtimeMs: number; ino: number }>;

/** A process verifies source prefixes once, then trusts unchanged file identity until
 * the next audit. Raw SHA receipts remain independently verifiable after restore.
 */
export async function ingestOnce(root: string, sink: Sink, cache?: IngestCache) {
  const seen = new Set<string>();
  for (const name of (await readdir(join(root, 'journal'))).sort()) {
    if (!/\.(open|jsonl)$/.test(name)) continue;
    const path = join(root, 'journal', name);
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('journal must be a private regular file');
    seen.add(path);
    const prior = cache?.get(path);
    if (prior && prior.size === info.size && prior.mtimeMs === info.mtimeMs && prior.ino === info.ino) continue;
    // Capture may seal between readdir and open; retry on next pass, never acknowledge.
    try {
      await ingestFile(path, root, sink);
      // Retain the PRE-read identity: a concurrent append must be revisited.
      cache?.set(path, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const path of cache?.keys() ?? []) if (!seen.has(path)) cache?.delete(path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name: string) => args[args.indexOf(name) + 1];
  try {
    for (const name of ['--root', '--endpoint', '--username', '--password-file']) if (!args.includes(name) || !arg(name)) throw new Error('missing CLI option');
    const root = resolve(arg('--root'));
    const { createServer } = await import('node:net');
    const lock = createServer();
    await new Promise<void>((ok, fail) => { lock.once('error', fail); lock.listen(Number(args.includes('--lock-port') ? arg('--lock-port') : 18924), '127.0.0.1', ok); });
    const db = clickHouse(arg('--endpoint'), arg('--username'), await privateFile(arg('--password-file')));
    try {
      await db.initialize();
      const cache: IngestCache = new Map();
      let auditAt = Date.now() + 24 * 60 * 60 * 1000;
      do {
        if (Date.now() >= auditAt) { cache.clear(); auditAt = Date.now() + 24 * 60 * 60 * 1000; }
        await ingestOnce(root, db.insert, cache);
        if (args.includes('--once')) break;
        await new Promise(ok => setTimeout(ok, 10_000));
      } while (true);
    } finally { lock.close(); }
  } catch { console.error('inference archive indexer stopped; source retained; check private configuration/database/journal integrity'); process.exitCode = 1; }
}
