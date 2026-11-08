import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startArchiveRouter } from './archive-router.ts';

test('archive prefix and SQL stay on separate fixed backends with byte-preserving bodies', async () => {
  const seen: { backend: string; path: string; auth: string; body: string }[] = [];
  const backend = (name: string) => http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ backend: name, path: req.url!, auth: String(req.headers.authorization ?? req.headers['x-clickhouse-key']), body });
    res.end(name);
  });
  const db = backend('database'), collector = backend('collector'), reservation = http.createServer();
  for (const s of [db, collector, reservation]) await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok));
  const port = (s: http.Server) => (s.address() as { port: number }).port;
  const routerPort = port(reservation); await new Promise<void>(ok => reservation.close(() => ok()));
  const router = await startArchiveRouter({ port: routerPort, databasePort: port(db), collectorPort: port(collector) });
  try {
    const root = `http://127.0.0.1:${routerPort}`;
    const query = await fetch(`${root}/?query=SELECT%201`, { method: 'POST', headers: { 'X-ClickHouse-Key': 'database-fixture' } });
    assert.equal(await query.text(), 'database');
    const upload = await fetch(`${root}/archive/v1/journals/fixture`, { method: 'POST', headers: { Authorization: 'Bearer collector-fixture' }, body: 'opaque\nbytes\n' });
    assert.equal(await upload.text(), 'collector');
    assert.deepEqual(seen, [
      { backend: 'database', path: '/?query=SELECT%201', auth: 'database-fixture', body: '' },
      { backend: 'collector', path: '/v1/journals/fixture', auth: 'Bearer collector-fixture', body: 'opaque\nbytes\n' },
    ]);
  } finally {
    await router.close();
    await Promise.all([db, collector].map(s => new Promise<void>(ok => s.close(() => ok()))));
  }
});
