import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rename, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventRow, ingestFile, clickHouse, ingestOnce } from './ingest.ts';
import { fixture } from './verify.test.ts';
import { scanJournal } from './verify.ts';
import { createServer } from 'node:http';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'archive-ingest-')); await mkdir(join(root, 'journal'), { mode: 0o700 });
  const path = join(root, 'journal', 'request-a.open'); return { root, path };
}
test('outage ACK ordering, retry identity, active tail, sealing rename and restart', async () => {
  const { root, path } = await setup(); const lines = fixture().split('\n');
  await writeFile(path, lines[0] + '\n' + lines[1].slice(0, 10), { mode: 0o600 });
  const rows: ReturnType<typeof eventRow>[] = [];
  await assert.rejects(ingestFile(path, root, async batch => { rows.push(...batch); throw new Error('DB outage after maybe-commit'); }));
  assert.deepEqual(await readdir(join(root, 'indexer')), []);
  await ingestFile(path, root, async batch => { rows.push(...batch); });
  assert.equal(rows[0].event_id, rows[1].event_id);
  await writeFile(path, fixture(), { mode: 0o600 });
  await ingestFile(path, root, async batch => { rows.push(...batch); }, 1);
  const sealed = path.replace('.open', '.jsonl'); await rename(path, sealed);
  const before = rows.length; await ingestOnce(root, async batch => { rows.push(...batch); }); assert.equal(rows.length, before);
  const receipts = await readdir(join(root, 'receipts'));
  const receipt = JSON.parse(await readFile(join(root, 'receipts', receipts[0]), 'utf8'));
  assert.equal(receipt.records, 4); assert.equal(receipt.querySemantics, 'inference_archive.events FINAL');
  await writeFile(sealed, fixture().replace('POST', 'PATCH'));
  await assert.rejects(ingestFile(sealed, root, async () => {}), /prefix changed|record boundary/);
});

test('source truncation fails closed and raw payload/base64 preserved', async () => {
  const { root, path } = await setup(); await writeFile(path, fixture(), { mode: 0o600 });
  const rows: ReturnType<typeof eventRow>[] = []; await ingestFile(path, root, async batch => { rows.push(...batch); });
  assert.equal(rows[1].searchable_text, 'hello coding world'); assert.equal(rows[0].parent_request_id, 'edge-parent');
  assert.equal(JSON.parse(rows[2].payload_json).payload.preserve, true);
  assert.equal(Buffer.from(String(rows[1].data_base64), 'base64').toString(), 'hello coding world');
  await writeFile(path, fixture().split('\n')[0] + '\n');
  await assert.rejects(ingestFile(path, root, async () => {}), /shorter/);
});

test('authenticated collector provenance becomes query metadata without rewriting raw records', async t => {
  const { root, path } = await setup(); t.after(() => rm(root, { recursive: true, force: true }));
  const id = '79e125e4-58f5-4bc7-8627-7ac8f59e6c61';
  await writeFile(path, fixture(id), { mode: 0o600 });
  await mkdir(join(root, 'origins'), { mode: 0o700 });
  const origin = join(root, 'origins', `${id}.json`);
  await writeFile(origin, JSON.stringify({ schemaVersion: 1, requestId: id, nodeId: 'mbp-m2' }), { mode: 0o600 });
  const rows: ReturnType<typeof eventRow>[] = [];
  await ingestFile(path, root, async batch => { rows.push(...batch); });
  assert.equal(rows.length, 4); assert.ok(rows.every(row => row.source_node === 'mbp-m2'));
  assert.equal(rows[0].payload_json, fixture(id).split('\n')[0]);
  await writeFile(origin, JSON.stringify({ schemaVersion: 1, requestId: id, nodeId: '../../unsafe' }), { mode: 0o600 });
  await assert.rejects(ingestFile(path, root, async () => {}), /invalid journal origin/);
});

test('unchanged-file cache skips receipts, changed sources revalidate acknowledged prefixes', async t => {
  const { root, path } = await setup(); t.after(() => rm(root, { recursive: true, force: true }));
  const sealed = path.replace('.open', '.jsonl');
  await writeFile(sealed, fixture(), { mode: 0o600 });
  const cache = new Map();
  await ingestOnce(root, async () => {}, cache);
  const receipt = join(root, 'receipts', (await readdir(join(root, 'receipts')))[0]);
  await writeFile(receipt, 'fixture-sentinel', { mode: 0o600 });
  await ingestOnce(root, async () => { throw new Error('unexpected replay'); }, cache);
  assert.equal(await readFile(receipt, 'utf8'), 'fixture-sentinel');
  await writeFile(sealed, fixture().replace('POST', 'PATCH'), { mode: 0o600 });
  await assert.rejects(ingestOnce(root, async () => {}, cache), /prefix changed|record boundary/);
});

test('database requests reject cross-origin redirects before credentials can leave', async () => {
  let observed: string | undefined;
  const destination = createServer((req, res) => { observed = String(req.headers['x-clickhouse-key'] ?? ''); res.end(); });
  await new Promise<void>(ok => destination.listen(0, '127.0.0.1', ok));
  const destinationPort = (destination.address() as { port: number }).port;
  const redirect = createServer((_, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/` }); res.end(); });
  await new Promise<void>(ok => redirect.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
  try {
    // Known-negative fixture: native Fetch DOES forward a custom key on redirect.
    await (await fetch(origin, { headers: { 'X-ClickHouse-Key': 'synthetic-fixture-key' } })).body?.cancel();
    assert.equal(observed, 'synthetic-fixture-key'); observed = undefined;
    await assert.rejects(clickHouse(origin, 'archive', 'synthetic-fixture-key').initialize());
    assert.equal(observed, undefined);
  } finally {
    await Promise.all([redirect, destination].map(server => new Promise<void>(ok => server.close(() => ok()))));
  }
});

test('binary and split UTF-8 never claim exact text; endpoint requires auth and TLS', async () => {
  const { path } = await setup(); await writeFile(path, fixture(), { mode: 0o600 });
  for await (const line of scanJournal(path)) if (line.record.kind === 'data') {
    line.record.data = '8J8='; assert.equal(eventRow(line).searchable_text, '');
    line.record.data = 'aGVsbG8='; line.record.binary = true; assert.equal(eventRow(line).searchable_text, '');
  }
  assert.throws(() => clickHouse('http://htz-lab:8123', 'archive', 'secret'), /HTTPS/);
  assert.throws(() => clickHouse('https://htz-lab', 'archive', ''), /authentication/);
});
