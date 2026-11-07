import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { scanJournal, verifyJournal } from './verify.ts';

export function fixture(id = 'request-a') {
  const base = { schemaVersion: 1, requestId: id, timestamp: '2026-11-07T00:00:00.000Z', lane: 'client' };
  return [
    { ...base, sequence: 0, kind: 'start', method: 'POST', pathname: '/v1/responses', transport: 'http', upstream: 'http://127.0.0.1:8317', headers: { 'x-inference-archive-parent': 'edge-parent' } },
    { ...base, sequence: 1, kind: 'data', direction: 'request', data: Buffer.from('hello coding world').toString('base64') },
    { ...base, sequence: 2, kind: 'control-future', payload: { preserve: true } },
    { ...base, sequence: 3, kind: 'finish', outcome: 'complete' },
  ].map(x => JSON.stringify(x) + '\n').join('');
}

test('sealed source SHA, parser and future control records', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'archive-verify-')), 'r.jsonl');
  const bytes = fixture(); await writeFile(file, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const receipt = await verifyJournal(file, hash);
  assert.equal(receipt.records, 4); assert.equal(receipt.bytes, Buffer.byteLength(bytes));
  await writeFile(file, bytes.replace('hello', 'other'));
  // Mutate semantic payload without breaking JSON or lifecycle.
  await writeFile(file, bytes.replace('coding', 'editing').replace('control-future', 'tampered-control'));
  await assert.rejects(verifyJournal(file, hash), /sha256/);
  await writeFile(file, bytes.slice(0, -2)); await assert.rejects(verifyJournal(file), /truncated/);
});

test('active incomplete last line waits; sealed rejects sequence gaps and missing finish', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'archive-active-')), 'r.open');
  const lines = fixture().split('\n'); await writeFile(file, lines[0] + '\n' + lines[1].slice(0, 20));
  const seen = []; for await (const line of scanJournal(file, false)) seen.push(line);
  assert.equal(seen.length, 1); await assert.rejects(verifyJournal(file), /truncated/);
  await writeFile(file, fixture().replace('"sequence":1', '"sequence":9'));
  await assert.rejects(verifyJournal(file), /sequence/);
});
