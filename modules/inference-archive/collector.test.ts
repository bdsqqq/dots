import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, writeFile, readdir, lstat, symlink, realpath, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adoptRestoredCollector, loadKeys, startCollector } from './collector.ts';
import { EMPTY_SHA, MAX_BATCH, sha256 } from './replication-protocol.ts';
import { loadConfiguration } from './replication-store.ts';
import { replicationClient } from './replicate.ts';

const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const keys = { macbook: token, other: otherToken };
const temporary = async () => mkdtemp(join(await realpath(tmpdir()), 'archive-collector-'));
function records(id: string, data = 'hello') {
  const base = { schemaVersion: 1, requestId: id, timestamp: '2026-11-07T00:00:00Z', lane: 'client' };
  return [
    { ...base, sequence: 0, kind: 'start', method: 'POST', pathname: '/v1/responses', transport: 'websocket', upstream: 'http://127.0.0.1:8317' },
    { ...base, sequence: 1, kind: 'data', direction: 'response', data: Buffer.from(data).toString('base64') },
    { ...base, sequence: 2, kind: 'finish', outcome: 'complete' },
  ].map(r => JSON.stringify(r) + '\n');
}
const client = (endpoint: string, nodeId = 'macbook') => replicationClient({ endpoint, nodeId, token: keys[nodeId as keyof typeof keys] });
const post = (c: ReturnType<typeof client>, id: string, bytes: Buffer, sealed = true) => c.append(id, { offset: 0, sha256: EMPTY_SHA }, { offset: bytes.length, sha256: sha256(bytes) }, bytes, sealed);

test('authenticated real HTTP, immutable origins, replay proof, ownership and prefix collision', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0 });
  t.after(() => server.close());
  const c = client(server.url), id = randomUUID(), bytes = Buffer.from(records(id).join(''));
  assert.equal((await c.status(id)).offset, 0);
  const proof = await post(c, id, bytes);
  assert.equal(proof.sealed, true); assert.equal(proof.sha256, sha256(bytes));
  assert.deepEqual(await post(c, id, bytes), proof);
  assert.deepEqual(await c.status(id), proof);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'origins', id + '.json'), 'utf8')), { schemaVersion: 1, nodeId: 'macbook', requestId: id });
  await assert.rejects(client(server.url, 'other').status(id), e => (e as {status: number}).status === 409);
  await assert.rejects(post(client(server.url, 'other'), id, bytes), e => (e as {status: number}).status === 409);
  const changed = Buffer.from(bytes); changed[changed.indexOf('/v1/responses')] ^= 1;
  await assert.rejects(post(c, id, changed), e => (e as {status: number}).status === 409);
  assert.deepEqual(await readFile(join(root, 'journal', id + '.jsonl')), bytes);
  for (const dir of ['', 'journal', 'origins', 'replication-state', 'replication-pending']) assert.equal((await lstat(join(root, dir))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'journal', id + '.jsonl'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'replication-pending')), []);
  await assert.rejects(startCollector({ root, keys, port: 0, reserveBytes: 0 }), /EADDRINUSE/);
});

test('raw-only backup restore explicitly rebuilds proofs and supports idempotent producer replay', async t => {
  const root = await temporary(), id = randomUUID(), bytes = Buffer.from(records(id).join(''));
  for (const dir of ['journal', 'origins']) await mkdir(join(root, dir), { mode: 0o700 });
  await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  await writeFile(join(root, 'origins', id + '.json'), JSON.stringify({ schemaVersion: 1, nodeId: 'macbook', requestId: id }), { mode: 0o600 });
  const before = await startCollector({ root, keys, port: 0, reserveBytes: 0 });
  await assert.rejects(client(before.url).status(id), e => (e as { status: number }).status === 409);
  await before.close();
  assert.deepEqual(await adoptRestoredCollector(root), { adopted: 1 });
  assert.deepEqual(await adoptRestoredCollector(root), { adopted: 0 });
  const after = await startCollector({ root, keys, port: 0, reserveBytes: 0 }); t.after(() => after.close());
  const proof = await client(after.url).status(id);
  assert.equal(proof.sha256, sha256(bytes)); assert.equal(proof.sealed, true);
  assert.deepEqual(await post(client(after.url), id, bytes), proof);
  assert.deepEqual(await readFile(join(root, 'journal', id + '.jsonl')), bytes);
});

test('restored provenance fsync failure publishes no derived acknowledgement', async () => {
  const root = await temporary(), id = randomUUID(), bytes = Buffer.from(records(id).join(''));
  for (const dir of ['journal', 'origins']) await mkdir(join(root, dir), { mode: 0o700 });
  await writeFile(join(root, 'journal', id + '.jsonl'), bytes, { mode: 0o600 });
  const origin = join(root, 'origins', id + '.json');
  await writeFile(origin, JSON.stringify({ schemaVersion: 1, nodeId: 'macbook', requestId: id }), { mode: 0o600 });
  const handle = await open(origin), identity = await handle.stat(), prototype = Object.getPrototypeOf(handle);
  const original = prototype.sync as FileHandle['sync']; await handle.close();
  prototype.sync = async function (this: FileHandle) {
    const current = await this.stat();
    if (current.dev === identity.dev && current.ino === identity.ino) throw new Error('origin fsync fixture');
    return original.call(this);
  };
  try { await assert.rejects(adoptRestoredCollector(root), /origin fsync fixture/); }
  finally { prototype.sync = original; }
  await assert.rejects(lstat(join(root, 'replication-state', id + '.json')), /ENOENT/);
  assert.deepEqual(await readFile(join(root, 'journal', id + '.jsonl')), bytes);
});

test('restored partial tails cannot become acknowledgements and are never truncated', async () => {
  const root = await temporary(), id = randomUUID(), bytes = Buffer.from(records(id)[0] + '{partial');
  for (const dir of ['journal', 'origins']) await mkdir(join(root, dir), { mode: 0o700 });
  const file = join(root, 'journal', id + '.open'); await writeFile(file, bytes, { mode: 0o600 });
  await writeFile(join(root, 'origins', id + '.json'), JSON.stringify({ schemaVersion: 1, nodeId: 'macbook', requestId: id }), { mode: 0o600 });
  await assert.rejects(adoptRestoredCollector(root), /partial/);
  assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(lstat(join(root, 'replication-state', id + '.json')), /ENOENT/);
});

test('empty authentication errors, strict paths, fixed health metadata, private key file', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0 });
  t.after(() => server.close());
  for (const authorization of [undefined, 'Bearer no', 'Bearer ' + 'x'.repeat(64)]) {
    const response = await fetch(server.url + '/v1/journals/' + randomUUID(), { headers: authorization ? { authorization, 'x-archive-node': 'macbook' } : {} });
    assert.equal(response.status, 401); assert.equal(await response.text(), '');
  }
  const response = await fetch(server.url + '/v1/journals/%2e%2e%2fsecret', { headers: { authorization: 'Bearer ' + token, 'x-archive-node': 'macbook' } });
  assert.equal(response.status, 400); assert.equal(await response.text(), '');
  assert.deepEqual(await (await fetch(server.url + '/health')).json(), { schemaVersion: 1, service: 'inference-archive-collector', healthy: true });
  assert.deepEqual(await (await fetch(server.url + '/ready')).json(), { schemaVersion: 1, ready: true });
  const keyFile = join(root, 'keys.json'); await writeFile(keyFile, JSON.stringify(keys), { mode: 0o600 });
  assert.deepEqual(await loadKeys(keyFile), keys);
  const linked = join(root, 'linked'); await symlink(keyFile, linked); await assert.rejects(loadKeys(linked)); await assert.rejects(loadConfiguration(linked));
  const config = join(root, 'nonsecret.json'); await writeFile(config, JSON.stringify({ keysFile: keyFile }), { mode: 0o644 });
  assert.deepEqual(await loadConfiguration(config), { keysFile: keyFile });
  await writeFile(keyFile, JSON.stringify({ macbook: 'short' })); await assert.rejects(loadKeys(keyFile));
  await writeFile(keyFile, '{"macbook":"' + token + '" BROKEN');
  await assert.rejects(loadKeys(keyFile), error => !String(error).includes(token));
});

test('rejects corrupt, partial, missing-finish and oversized records before accepting bytes', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0 });
  t.after(() => server.close()); const c = client(server.url);
  for (const shape of ['partial', 'unfinished', 'invalid', 'wrong-id']) {
    const id = randomUUID(), lines = records(shape === 'wrong-id' ? randomUUID() : id);
    const bytes = Buffer.from(shape === 'partial' ? lines.join('').slice(0, -1) : shape === 'unfinished' ? lines[0] : shape === 'invalid' ? 'not-json\n' : lines.join(''));
    await assert.rejects(post(c, id, bytes));
    assert.equal((await c.status(id)).offset, 0);
  }
  const response = await fetch(server.url + '/v1/journals/' + randomUUID(), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-archive-node': 'macbook', 'x-archive-offset': '0', 'x-archive-prefix-sha256': EMPTY_SHA, 'x-archive-sha256': EMPTY_SHA, 'x-archive-sealed': 'false', 'content-length': String(MAX_BATCH + 1) }, body: new Uint8Array(MAX_BATCH + 1) });
  assert.equal(response.status, 413);
});

test('capacity/reserve and raw tampering fail closed without success proof', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0, spoolLimitBytes: 40000 });
  t.after(() => server.close()); const c = client(server.url), id = randomUUID();
  await assert.rejects(post(c, id, Buffer.from(records(id, 'x'.repeat(30000)).join(''))), e => (e as {status: number}).status === 507);
  assert.equal((await c.status(id)).offset, 0);
  const bytes = Buffer.from(records(id).join('')); await post(c, id, bytes);
  await writeFile(join(root, 'journal', id + '.jsonl'), Buffer.from(bytes.toString().replace('response', 'RESPONSE')));
  await assert.rejects(c.status(id), e => (e as {status: number}).status === 409);
  const reserveRoot = await temporary(), reserved = await startCollector({ root: reserveRoot, keys, port: 0, reserveBytes: Number.MAX_SAFE_INTEGER });
  t.after(() => reserved.close());
  assert.equal((await fetch(reserved.url + '/ready')).status, 507);
});

test('restart completes interrupted append from durable transaction without truncating any tail', async t => {
  const root = await temporary(); let writes = 0;
  const first = await startCollector({ root, keys, port: 0, reserveBytes: 0, beforeIO: op => { if (op === 'data-write' && ++writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const id = randomUUID(), bytes = Buffer.from(records(id, 'x'.repeat(160000)).join(''));
  await assert.rejects(post(client(first.url), id, bytes), e => (e as {status: number}).status === 503);
  const partial = await readFile(join(root, 'journal', id + '.open'));
  assert.equal(partial.length, 65536); assert.deepEqual(partial, bytes.subarray(0, partial.length));
  assert.deepEqual(await readdir(join(root, 'replication-pending')), [id + '.txn']);
  await first.close();
  const restarted = await startCollector({ root, keys, port: 0, reserveBytes: 0 }); t.after(() => restarted.close());
  const proof = await client(restarted.url).status(id);
  assert.equal(proof.offset, bytes.length); assert.equal(proof.sha256, sha256(bytes)); assert.equal(proof.sealed, true);
  assert.deepEqual(await readFile(join(root, 'journal', id + '.jsonl')), bytes);
});

test('fsync failure never ACKs; retained transaction is retryable', async t => {
  const root = await temporary(); let failAt = 0, syncs = 0;
  const server = await startCollector({ root, keys, port: 0, reserveBytes: 0, beforeIO: op => { if (op === 'data-sync' && ++syncs === failAt) throw new Error('fsync failed'); } });
  t.after(() => server.close()); const c = client(server.url), id = randomUUID(), bytes = Buffer.from(records(id).join(''));
  // Establish origin and empty state before injecting at the actual append fsync.
  await post(c, id, Buffer.alloc(0), false);
  // get() first syncs the old proof; then recover() syncs the actual new bytes.
  failAt = syncs + 2; await assert.rejects(post(c, id, bytes));
  assert.deepEqual(await readdir(join(root, 'replication-pending')), [id + '.txn']);
  assert.equal((await c.status(id)).offset, bytes.length);
  await post(c, id, bytes); assert.equal((await c.status(id)).offset, bytes.length);
});

test('concurrent append replay is serialized, including finish uploaded before seal', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0 }); t.after(() => server.close());
  const c = client(server.url), id = randomUUID(), bytes = Buffer.from(records(id).join(''));
  const proofs = await Promise.all([post(c, id, bytes, false), post(c, id, bytes, false)]);
  assert.deepEqual(proofs[0], proofs[1]); assert.equal(proofs[0].sealed, false);
  const final = await c.append(id, { offset: bytes.length, sha256: sha256(bytes) }, { offset: bytes.length, sha256: sha256(bytes) }, Buffer.alloc(0), true);
  assert.equal(final.sealed, true); assert.deepEqual(await readFile(join(root, 'journal', id + '.jsonl')), bytes);
});

test('transaction tampering is rejected on restart without rewriting retained partial tail', async () => {
  const root = await temporary(); let writes = 0;
  const server = await startCollector({ root, keys, port: 0, reserveBytes: 0, beforeIO: op => { if (op === 'data-write' && ++writes === 2) throw new Error('interrupted'); } });
  const id = randomUUID(), bytes = Buffer.from(records(id, 'x'.repeat(100000)).join(''));
  await assert.rejects(post(client(server.url), id, bytes)); await server.close();
  const txn = join(root, 'replication-pending', id + '.txn'), raw = join(root, 'journal', id + '.open');
  const before = await readFile(raw), envelope = await readFile(txn); envelope[envelope.length - 2] ^= 1; await writeFile(txn, envelope);
  await assert.rejects(startCollector({ root, keys, port: 0, reserveBytes: 0 }));
  assert.deepEqual(await readFile(raw), before); assert.deepEqual(await readFile(txn), envelope);
});

test('collector rejects symlink journal and directory targets', async t => {
  const root = await temporary(), server = await startCollector({ root, keys, port: 0, reserveBytes: 0 }); t.after(() => server.close());
  const id = randomUUID(), target = join(root, 'target'); await writeFile(target, 'canary', { mode: 0o600 });
  await symlink(target, join(root, 'journal', id + '.open'));
  await assert.rejects(post(client(server.url), id, Buffer.from(records(id).join(''))));
  assert.equal(await readFile(target, 'utf8'), 'canary');
});
