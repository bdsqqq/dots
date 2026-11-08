import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rename, lstat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createReplicator, replicationClient } from './replicate.ts';
import { startCollector } from './collector.ts';
import { EMPTY_SHA, MAX_BATCH, sha256 } from './replication-protocol.ts';
import { startArchiveRouter } from './archive-router.ts';
import { ingestOnce } from './ingest.ts';

const token = 'a'.repeat(64), nodeId = 'macbook';
const temporary = async () => mkdtemp(join(await realpath(tmpdir()), 'archive-replicate-'));
async function source() { const root = await temporary(); await mkdir(join(root, 'journal'), { mode: 0o700 }); return root; }
function records(id: string, payload = 'asynchronous transcript') {
  const base = { schemaVersion: 1, requestId: id, timestamp: '2026-11-07T00:00:00Z', lane: 'client' };
  return [
    { ...base, sequence: 0, kind: 'start', method: 'POST', pathname: '/v1/responses', transport: 'websocket', upstream: 'http://127.0.0.1:8317' },
    { ...base, sequence: 1, kind: 'data', direction: 'response', data: Buffer.from(payload).toString('base64') },
    { ...base, sequence: 2, kind: 'finish', outcome: 'complete' },
  ].map(r => JSON.stringify(r) + '\n');
}
const collector = (root: string, port = 0) => startCollector({ root, keys: { [nodeId]: token }, port, reserveBytes: 0 });

test('active partial tail then growth and seal; raw bytes unchanged and current ingestOnce compatible', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const worker = await createReplicator({ root, endpoint: server.url, nodeId, token, batchBytes: 500 }); t.after(() => worker.close());
  const id = randomUUID(), lines = records(id), path = join(root, 'journal', id + '.open');
  await writeFile(path, lines[0] + lines[1].slice(0, 30), { mode: 0o600 });
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(await readFile(join(destination, 'journal', id + '.open'), 'utf8'), lines[0]);
  await appendFile(path, lines[1].slice(30) + lines[2].slice(0, 20));
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(await readFile(join(destination, 'journal', id + '.open'), 'utf8'), lines[0] + lines[1]);
  await appendFile(path, lines[2].slice(20)); await rename(path, path.replace('.open', '.jsonl'));
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(await readFile(join(destination, 'journal', id + '.jsonl'), 'utf8'), lines.join(''));
  assert.equal(await readFile(path.replace('.open', '.jsonl'), 'utf8'), lines.join(''));
  const receipt = JSON.parse(await readFile(join(root, 'replication-receipts', id + '.json'), 'utf8'));
  assert.equal(receipt.sealed, true); assert.equal(receipt.sha256, sha256(Buffer.from(lines.join(''))));
  assert.equal((await lstat(join(root, 'replication-receipts', id + '.json'))).mode & 0o777, 0o600);
  const rows: unknown[] = []; await ingestOnce(destination, async batch => { rows.push(...batch); }); assert.equal(rows.length, 3);
  await assert.rejects(createReplicator({ root, endpoint: server.url, nodeId, token }), /EADDRINUSE/);
});

test('offline backlog remains local; reconnect sends it without requiring capture or archive availability', async t => {
  const root = await source(), destination = await temporary(), initial = await collector(destination), port = initial.port;
  await initial.close();
  const id = randomUUID(), bytes = records(id).join(''); await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  const worker = await createReplicator({ root, endpoint: `http://127.0.0.1:${port}`, nodeId, token, timeoutMs: 1000 }); t.after(() => worker.close());
  assert.deepEqual(await worker.once(), { uploaded: 0, failed: 1 });
  assert.equal(await readFile(join(root, 'journal', id + '.jsonl'), 'utf8'), bytes);
  assert.deepEqual(await readdir(join(root, 'replication-receipts')), []);
  const restarted = await collector(destination, port); t.after(() => restarted.close());
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(await readFile(join(destination, 'journal', id + '.jsonl'), 'utf8'), bytes);
});

test('lost ACK after persistence is reconciled by status, never a premature durable receipt', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const id = randomUUID(), bytes = records(id).join(''); await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  let lose = true, posts = 0;
  const transport: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method === 'POST') { posts++; if (lose) { lose = false; await response.arrayBuffer(); throw new Error('lost ACK secret-canary'); } }
    return response;
  };
  const worker = await createReplicator({ root, endpoint: server.url, nodeId, token, fetch: transport }); t.after(() => worker.close());
  assert.deepEqual(await worker.once(), { uploaded: 0, failed: 1 });
  const firstReceipt = JSON.parse(await readFile(join(root, 'replication-receipts', id + '.json'), 'utf8'));
  assert.equal(firstReceipt.offset, 0); assert.equal(firstReceipt.sealed, false);
  assert.equal(await readFile(join(destination, 'journal', id + '.jsonl'), 'utf8'), bytes);
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 }); assert.equal(posts, 1);
  assert.equal(JSON.parse(await readFile(join(root, 'replication-receipts', id + '.json'), 'utf8')).sealed, true);
});

test('source mutation, invalid sealed journal, forged receipt and symlink are rejected without pruning', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const worker = await createReplicator({ root, endpoint: server.url, nodeId, token }); t.after(() => worker.close());
  const id = randomUUID(), path = join(root, 'journal', id + '.jsonl'), bytes = records(id).join(''); await writeFile(path, bytes, { mode: 0o600 });
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  await writeFile(path, bytes.replace('/v1/responses', '/v1/RESPONSES'));
  assert.deepEqual(await worker.once(), { uploaded: 0, failed: 1 });
  assert.equal(await readFile(join(destination, 'journal', id + '.jsonl'), 'utf8'), bytes);
  await writeFile(path, bytes);
  const receipt = join(root, 'replication-receipts', id + '.json');
  const forged = JSON.parse(await readFile(receipt, 'utf8')); forged.sha256 = EMPTY_SHA; await writeFile(receipt, JSON.stringify(forged));
  assert.deepEqual(await worker.once(), { uploaded: 0, failed: 1 });
  const bad = randomUUID(); await writeFile(join(root, 'journal', bad + '.jsonl'), records(bad)[0], { mode: 0o600 });
  const link = randomUUID(); await symlink(path, join(root, 'journal', link + '.open'));
  assert.deepEqual(await worker.once(), { uploaded: 0, failed: 3 });
  assert.equal((await readdir(join(root, 'journal'))).length, 3);
});

test('redirect leak canary: same-host and cross-port redirects are never followed', async t => {
  let leaked = false;
  const target = createServer((req, res) => { if (req.headers.authorization) leaked = true; res.end('{}'); });
  await new Promise<void>(ok => target.listen(0, '127.0.0.1', ok));
  const address = target.address(); assert.ok(address && typeof address !== 'string');
  const redirector = createServer((req, res) => {
    if (req.url === '/leak') { leaked = true; res.end('{}'); return; }
    res.writeHead(307, { location: req.url?.includes('11111111') ? '/leak' : `http://127.0.0.1:${address.port}/leak` }); res.end();
  });
  await new Promise<void>(ok => redirector.listen(0, '127.0.0.1', ok));
  t.after(() => { target.close(); redirector.close(); target.closeAllConnections(); redirector.closeAllConnections(); });
  const redirectAddress = redirector.address(); assert.ok(redirectAddress && typeof redirectAddress !== 'string');
  const c = replicationClient({ endpoint: `http://127.0.0.1:${redirectAddress.port}`, nodeId, token });
  for (const id of ['11111111-1111-4111-8111-111111111111', randomUUID()]) await assert.rejects(c.status(id), error => {
    assert.equal(String(error).includes(token), false); assert.equal((error as Error).cause, undefined); return true;
  });
  assert.equal(leaked, false);
  for (const endpoint of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?secret=1', 'https://example.com/encoded%2fpath']) assert.throws(() => replicationClient({ endpoint, nodeId, token }));
});

test('HTTP proofs reject malformed shapes and mismatched identity without a filesystem root', async () => {
  const id = randomUUID(), proof = { schemaVersion: 1, nodeId, requestId: id, offset: 0, sha256: EMPTY_SHA, sealed: false };
  let value: unknown = proof;
  const client = replicationClient({ endpoint: 'http://127.0.0.1:1', nodeId, token, fetch: async () => Response.json(value) });
  assert.deepEqual(await client.status(id), proof);
  for (const invalid of [null, [], {}, { ...proof, schemaVersion: 2 }, { ...proof, nodeId: 'other' },
    { ...proof, requestId: randomUUID() }, { ...proof, offset: -1 }, { ...proof, offset: 0.5 },
    { ...proof, sha256: 'not-a-hash' }, { ...proof, sealed: 'false' }]) {
    value = invalid;
    await assert.rejects(client.status(id), /archive replication failed/);
  }
});

test('endpoint base path survives the production archive router', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const reservation = createServer();
  await new Promise<void>(ok => reservation.listen(0, '127.0.0.1', ok));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(ok => reservation.close(() => ok()));
  const router = await startArchiveRouter({ port: address.port, collectorPort: server.port, databasePort: 1 });
  t.after(() => router.close());
  const id = randomUUID(), bytes = records(id).join(''); await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  const endpoint = `http://127.0.0.1:${address.port}/archive`;
  const worker = await createReplicator({ root, endpoint, nodeId, token }); t.after(() => worker.close());
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(JSON.parse(await readFile(join(root, 'replication-receipts', id + '.json'), 'utf8')).endpoint, endpoint);
  assert.equal(await readFile(join(destination, 'journal', id + '.jsonl'), 'utf8'), bytes);
  // A trailing slash is the same destination, not another receipt identity.
  assert.equal(replicationClient({ endpoint: endpoint + '/', nodeId, token }).endpoint, endpoint);
});

test('positional nonsecret configuration CLI loads private token and stops independently', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const id = randomUUID(), bytes = records(id).join(''); await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  const tokenFile = join(root, 'upload-token'); await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const config = join(root, 'uploader.json'); await writeFile(config, JSON.stringify({ root, endpoint: server.url, nodeId, tokenFile, intervalMs: 100, maxBatchBytes: MAX_BATCH }), { mode: 0o644 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./replicate.ts', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  let complete = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { complete = JSON.parse(await readFile(join(root, 'replication-receipts', id + '.json'), 'utf8')).sealed; } catch { /* atomic receipt may not exist yet */ }
    if (complete) break;
    await new Promise(ok => setTimeout(ok, 20));
  }
  assert.equal(complete, true); assert.equal(output.includes(token), false);
  const exit = once(child, 'exit'); child.kill('SIGTERM'); assert.deepEqual(await exit, [0, null]);
  assert.equal(await readFile(join(root, 'journal', id + '.jsonl'), 'utf8'), bytes);
});

test('large serialized record fits bounded 32MiB append; batches are LF complete', async t => {
  const root = await source(), destination = await temporary(), server = await collector(destination); t.after(() => server.close());
  const id = randomUUID(), bytes = records(id, 'x'.repeat(17 * 1024 * 1024)).join('');
  await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  const sizes: number[] = [];
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === 'POST') { const body = init.body as Uint8Array; sizes.push(body.byteLength); assert.equal(body[body.byteLength - 1], 10); }
    return fetch(url, init);
  };
  const worker = await createReplicator({ root, endpoint: server.url, nodeId, token, fetch: transport }); t.after(() => worker.close());
  assert.deepEqual(await worker.once(), { uploaded: 1, failed: 0 });
  assert.equal(sizes.length, 1); assert.ok(sizes[0] > 22 * 1024 * 1024 && sizes[0] <= MAX_BATCH);
  assert.equal(sha256(await readFile(join(destination, 'journal', id + '.jsonl'))), sha256(Buffer.from(bytes)));
});
