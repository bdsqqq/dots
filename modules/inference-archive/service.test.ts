import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startService } from './service.ts';
import type { ServiceConfig } from './service.ts';

const base: ServiceConfig = {
  root: '/unused-in-invalid-fixtures', edgePort: 18317, upstreamPort: 18318, healthPort: 18319,
  reserveBytes: 0, spoolLimitBytes: 1024 * 1024, maxPayloadBytes: 1024 * 1024,
  brokerOrigin: 'http://127.0.0.1:1', codexOrigin: 'https://chatgpt.com',
};

test('service rejects dynamic destinations, invalid listeners, and immutable storage', async () => {
  for (const change of [
    { root: '/nix/store/fixture' }, { root: '/' }, { edgePort: 0 }, { healthPort: base.edgePort },
    { brokerOrigin: 'http://evil.example.test' }, { brokerOrigin: 'http://127.0.0.1:8317/path' },
    { codexOrigin: 'https://chatgpt.com@evil.example.test' }, { codexOrigin: 'https://chatgpt.com?key=bad' },
  ]) await assert.rejects(startService({ ...base, ...change }));
});

test('two-lane service shares one writer and distinguishes live from ready', async () => {
  const reservations = [createServer(), createServer(), createServer()];
  for (const server of reservations) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const [edgePort, upstreamPort, healthPort] = reservations.map(server => (server.address() as { port: number }).port);
  for (const server of reservations) await new Promise<void>(resolve => server.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), 'inference-service-'));
  const service = await startService({ ...base, root, edgePort: edgePort!, upstreamPort: upstreamPort!, healthPort: healthPort! });
  try {
    const health = await fetch(`http://127.0.0.1:${healthPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ready: boolean }).ready, false);
    assert.equal((await fetch(`http://127.0.0.1:${healthPort}/ready`)).status, 503);
  } finally {
    await service.close();
    // A clean restart must not require deleting a lock by hand.
    const restarted = await startService({ ...base, root, edgePort: edgePort!, upstreamPort: upstreamPort!, healthPort: healthPort! });
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});
