import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { SCHEMA, clickHouse } from './ingest.ts';

test('schema retention and dedup contract', () => {
  assert.match(SCHEMA.join('\n'), /ReplacingMergeTree ORDER BY \(request_id, sequence, event_id\)/);
  assert.doesNotMatch(SCHEMA.join('\n'), /\bTTL\b|SAMPLE BY|DROP TABLE/i);
  assert.match(SCHEMA.join('\n'), /fsync_after_insert = 1, fsync_part_directory = 1/);
});

test('HTTP sink requires complete synchronous ACK and uses separate authentication', async () => {
  let fail = false; const requests: { url: string; body: string; auth: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, body, auth: req.headers['x-clickhouse-key'] as string });
    res.writeHead(200); res.end(fail ? 'Code: 242. DB::Exception: disk full' : '');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number }; const db = clickHouse(`http://127.0.0.1:${address.port}`, 'archive', 'separate-db-password');
    await db.initialize(); assert.equal(requests.length, SCHEMA.length);
    assert.equal(requests[0].auth, 'separate-db-password');
    assert.match(requests[0].url, /async_insert=0/); assert.match(requests[0].url, /wait_end_of_query=1/);
    fail = true; await assert.rejects(db.insert([]), /unexpected database/);
  } finally { server.close(); server.closeAllConnections(); }
});

test('server seed has required default profile but no anonymous default user', async () => {
  const database = await readFile(new URL('./database.nix', import.meta.url), 'utf8');
  assert.match(database, /<profiles><default\/><archive>/);
  assert.match(database, /<users><archive><password_sha256_hex>/);
  assert.doesNotMatch(database, /<users><default/);
});

test('backup source allowlist, keep-all and independent schedule', async () => {
  const backup = await readFile(new URL('./backup.nix', import.meta.url), 'utf8');
  assert.match(backup, /paths = \[\s*"\$\{cfg.archiveRoot\}\/journal"\s*"\$\{cfg.archiveRoot\}\/receipts"\s*\]/);
  assert.match(backup, /policyKeepAll = true/); assert.match(backup, /maxFrequencyHours = cfg.intervalHours/);
  assert.match(backup, /hooks = \[ \]/); assert.doesNotMatch(backup, /volumeRoot|\/Volumes\/ssd-01|\.capture|cli-proxy-api/);
});
