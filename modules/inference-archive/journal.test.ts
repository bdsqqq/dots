import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JournalStore, inspectJournal, sanitizeHeaders } from './journal.ts';

const start = { kind: 'start' as const, transport: 'http' as const, method: 'POST', pathname: '/v1/responses', headers: { 'content-type': 'application/json' }, upstream: 'http://127.0.0.1:8317' };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, reserveBytes: 0, spoolLimitBytes: 1024 ** 2 };
}

test('durable LF schema, payload reconstruction, permissions and terminal rename', async t => {
  const opts = await fixture(t), store = await JournalStore.open(opts);
  const j = await store.begin('client', start);
  const path = join(opts.root, 'journal', `${j.requestId}.open`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(opts.root, 'journal'))).mode & 0o777, 0o700);
  assert.equal((await stat(opts.root)).mode & 0o777, 0o700);
  assert.equal((await inspectJournal(path)).count, 1);
  await j.data('request', Buffer.from([0, 255, 10, 13]));
  await j.response(500, { 'content-type': 'application/json' });
  await j.data('response', Buffer.from('failed'));
  await j.finish('complete');
  assert.deepEqual(await readdir(join(opts.root, 'journal')), [`${j.requestId}.jsonl`]);
  const final = join(opts.root, 'journal', `${j.requestId}.jsonl`);
  assert.deepEqual(await inspectJournal(final), { count: 5, finished: true, lane: 'client', bytes: (await stat(final)).size });
  const rows = (await readFile(final, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(rows.map(r => r.sequence), [0, 1, 2, 3, 4]);
  assert.deepEqual(Buffer.from(rows[1].data, 'base64'), Buffer.from([0, 255, 10, 13]));
  await store.close();
});

test('allowlist redacts secrets, arbitrary headers and offered websocket protocols', () => {
  assert.deepEqual(sanitizeHeaders({ authorization: 'secret', cookie: 'secret', 'x-api-key': 'secret', 'x-request-id': 'secret', 'sec-websocket-protocol': 'secret', 'content-type': 'application/json', 'x-custom': 'secret' }), { 'content-type': 'application/json' });
});

test('unfinished exchanges recover, completed open files finalize, corrupt fixtures block startup', async t => {
  const opts = await fixture(t);
  let store = await JournalStore.open(opts);
  const j = await store.begin('codex-upstream', start);
  await j.data('request', Buffer.from('accepted'));
  await store.close();
  store = await JournalStore.open(opts);
  await store.close();
  const path = join(opts.root, 'journal', `${j.requestId}.jsonl`);
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.equal(rows.at(-1).outcome, 'recovered-incomplete');
  await appendFile(path, '{"torn":');
  await assert.rejects(JournalStore.open(opts), /corrupt-journal/);
});

test('sequence corruption and noncanonical base64 are rejected without repairing evidence', async t => {
  const opts = await fixture(t);
  const store = await JournalStore.open(opts);
  const j = await store.begin('client', start);
  await j.data('request', Buffer.from('hello'));
  await j.finish('complete'); await store.close();
  const path = join(opts.root, 'journal', `${j.requestId}.jsonl`);
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('"sequence":1', '"sequence":8'));
  await assert.rejects(inspectJournal(path), /corrupt-journal/);
  await writeFile(path, original.replace('aGVsbG8=', 'aGVsbG8'));
  await assert.rejects(inspectJournal(path), /corrupt-journal/);
});

test('quota rejects payload explicitly but leaves room for a failure terminal', async t => {
  const opts = await fixture(t), store = await JournalStore.open({ ...opts, spoolLimitBytes: 8192 });
  const j = await store.begin('client', start);
  await assert.rejects(j.data('request', Buffer.alloc(8192)), /storage-limit/);
  await j.finish('error', 'size-limit');
  assert.equal((await inspectJournal(join(opts.root, 'journal', `${j.requestId}.jsonl`))).finished, true);
  await store.close();
});

test('disk write/fsync failures poison the writer and never claim complete', async t => {
  for (const operation of ['write', 'sync'] as const) {
    const opts = await fixture(t); let armed = false;
    const store = await JournalStore.open({ ...opts, beforeIO(op) { if (armed && op === operation) throw new Error('sensitive native failure'); } });
    const j = await store.begin('client', start); armed = true;
    await assert.rejects(j.data('request', Buffer.from('private')), e => e instanceof Error && e.message === 'storage-failure' && !e.cause);
    await assert.rejects(j.finish('complete'), /storage-failure/);
    await store.close();
    assert.ok((await readdir(join(opts.root, 'journal')))[0].endsWith('.open'));
  }
});

test('second live writer is excluded and a real crashed writer is recovered on restart', async t => {
  const opts = await fixture(t);
  const script = `import {JournalStore} from ${JSON.stringify(new URL('./journal.ts', import.meta.url).href)}; const s=await JournalStore.open(${JSON.stringify(opts)}); await s.begin('client',${JSON.stringify(start)}); console.log('ready'); setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  await assert.rejects(JournalStore.open(opts), /writer-locked/);
  child.kill('SIGKILL'); await once(child, 'exit');
  const recovered = await JournalStore.open(opts); await recovered.close();
  const names = await readdir(join(opts.root, 'journal'));
  assert.equal(names.length, 1); assert.ok(names[0].endsWith('.jsonl'));
  assert.match(await readFile(join(opts.root, 'journal', names[0]), 'utf8'), /recovered-incomplete/);
});
