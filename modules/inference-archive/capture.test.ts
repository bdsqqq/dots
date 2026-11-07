import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { startCaptureProxy } from './capture.ts';
import type { CaptureOptions } from './capture.ts';
import { JournalStore } from './journal.ts';
import type { JournalRecord } from './journal.ts';

async function setup(t: TestContext, handler: http.RequestListener, overrides: Partial<CaptureOptions> = {}) {
  const root = overrides.root ?? await mkdtemp(join(tmpdir(), 'capture-test-'));
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const proxy = await startCaptureProxy({ root, upstream: `http://127.0.0.1:${address.port}`, lane: 'client', reserveBytes: 0, spoolLimitBytes: 1024 ** 2, idleTimeoutMs: 2000, shutdownTimeoutMs: 1000, ...overrides });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, server, proxy, port: proxy.address.port };
}
async function rows(root: string): Promise<JournalRecord[][]> {
  const names = await readdir(join(root, 'journal'));
  return Promise.all(names.sort().map(async name => (await readFile(join(root, 'journal', name), 'utf8')).trim().split('\n').map(s => JSON.parse(s))));
}
function call(port: number, path: string, body = '', headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', data => chunks.push(data)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function waitFinalized(root: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const names = await readdir(join(root, 'journal'));
    if (names.length && names.every(n => n.endsWith('.jsonl'))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('journal did not finalize');
}
function payload(records: JournalRecord[], direction: string): Buffer {
  return Buffer.concat(records.filter(r => r.kind === 'data' && r.direction === direction).map(r => Buffer.from((r as { data: string }).data, 'base64')));
}
const auth = { authorization: 'Bearer test-private-key' };
const spoofId = '00000000-0000-4000-8000-000000000000';
function native(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.url === '/v1/models') { res.writeHead(req.headers.authorization === auth.authorization ? 200 : 401); res.end('{}'); return true; }
  return false;
}

test('real streaming HTTP persists bytes before forwarding, captures failed responses, redacts metadata', async t => {
  let upstreamRequest = '', checkedRequest = false;
  const f = await setup(t, async (req, res) => {
    if (native(req, res)) return;
    for await (const chunk of req) {
      upstreamRequest += chunk.toString();
      const captured = (await rows(f.root))[0];
      assert.ok(payload(captured, 'request').includes(chunk)); checkedRequest = true;
      assert.equal(req.headers['x-inference-archive-request-id'], captured[0].requestId);
      assert.equal(req.headers['x-inference-archive-parent'], undefined);
    }
    res.writeHead(429, { 'content-type': 'text/event-stream', 'set-cookie': 'private-cookie', 'x-secret': 'provider-secret' });
    res.write('data: one\n\n');
    setTimeout(() => res.end('data: two\n\n'), 10);
  });
  const result = await call(f.port, '/v1/responses?token=query-secret', 'private-payload', { ...auth, cookie: 'private-cookie', 'x-api-key': 'private-api-key', 'content-type': 'application/json', 'x-custom': 'private-header', 'x-inference-archive-request-id': spoofId, 'x-inference-archive-parent': spoofId });
  assert.equal(result.status, 429); assert.equal(result.body, 'data: one\n\ndata: two\n\n');
  assert.equal(upstreamRequest, 'private-payload'); assert.ok(checkedRequest);
  const records = (await rows(f.root))[0];
  assert.equal(records[0].kind, 'start'); assert.equal((records[0] as { pathname: string }).pathname, '/v1/responses');
  assert.equal(records.at(-1)?.kind, 'finish'); assert.equal((records.at(-1) as { outcome: string }).outcome, 'complete');
  assert.equal(payload(records, 'response').toString(), result.body);
  assert.ok(!JSON.stringify(records).includes(spoofId));
  for (const secret of ['test-private-key', 'query-secret', 'private-cookie', 'private-api-key', 'private-header', 'provider-secret']) assert.ok(!JSON.stringify(records).includes(secret));
});

test('native validation observes revocation; discovery/management/static bypass capture', async t => {
  let allowed = true, modelRequests = 0, inference = 0;
  const f = await setup(t, (req, res) => {
    if (req.url === '/v1/models') { modelRequests++; res.writeHead(allowed ? 200 : 401); res.end('{}'); }
    else { if (req.url?.startsWith('/v1/responses')) inference++; res.end('ok'); }
  });
  assert.equal((await call(f.port, '/v1/responses', '{}', auth)).status, 200);
  allowed = false;
  assert.equal((await call(f.port, '/v1/responses', 'never journal this', auth)).status, 401);
  assert.equal(inference, 1); assert.equal(modelRequests, 2);
  for (const path of ['/v1/models', '/management.html', '/oauth/callback?code=secret', '/assets/app.js']) await call(f.port, path, '', {}, 'GET');
  assert.equal((await rows(f.root)).length, 1);
});

test('upstream lane records OAuth-bearing attempts without gateway-key validation', async t => {
  let count = 0;
  const f = await setup(t, (req, res) => { count++; assert.equal(req.url, '/backend-api/codex/responses?token=secret'); res.end('provider'); }, { lane: 'codex-upstream' });
  assert.equal((await call(f.port, '/backend-api/codex/responses?token=secret', 'transformed', { authorization: 'Bearer oauth-not-gateway' })).body, 'provider');
  assert.equal(count, 1);
  const records = (await rows(f.root))[0];
  assert.ok(!JSON.stringify(records).includes('oauth-not-gateway')); assert.ok(!JSON.stringify(records).includes('token=secret'));
  assert.equal(records[0].lane, 'codex-upstream');
});

test('oversized declared requests never dispatch and streaming overflow never reports complete', async t => {
  let calls = 0;
  const f = await setup(t, (req, res) => { if (native(req, res)) return; calls++; req.resume(); req.on('end', () => res.end('ok')); }, { maxPayloadBytes: 4 });
  assert.equal((await call(f.port, '/v1/responses', '12345', { ...auth, 'content-length': '5' })).status, 413);
  assert.equal(calls, 0);
  await call(f.port, '/v1/responses', '12345', auth).catch(() => {});
  const records = (await rows(f.root))[0];
  if (records) assert.notEqual((records.at(-1) as { outcome: string }).outcome, 'complete');
});

test('request data fsync failure forwards no unrecorded payload and keeps open evidence', async t => {
  let syncs = 0, accepted = '';
  const f = await setup(t, (req, res) => { if (native(req, res)) return; req.on('data', chunk => { accepted += chunk; }); req.on('end', () => res.end('ok')); }, {
    beforeIO(op) { if (op === 'sync' && ++syncs === 2) throw new Error('secret-native-error'); },
  });
  await call(f.port, '/v1/responses', 'must-not-forward', auth).catch(() => {});
  assert.equal(accepted, '');
  const files = await readdir(join(f.root, 'journal')); assert.ok(files[0].endsWith('.open'));
  const records = (await rows(f.root))[0]; assert.notEqual(records.at(-1)?.kind, 'finish');
});

test('response data fsync failure forwards no unrecorded response bytes', async t => {
  let syncs = 0;
  const f = await setup(t, (req, res) => { req.resume(); req.on('end', () => res.end('must-not-forward')); }, { lane: 'codex-upstream', beforeIO(op) { if (op === 'sync' && ++syncs === 3) throw new Error('disk failed'); } });
  let body = '';
  await new Promise<void>(resolve => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/' }, res => { res.on('data', b => { body += b; }); res.on('error', () => resolve()); res.on('end', resolve); });
    req.on('error', () => resolve());
  });
  assert.ok(!body.includes('must-not-forward'));
});

test('partial upstream response and shutdown are never complete', async t => {
  const f = await setup(t, (req, res) => { if (native(req, res)) return; res.write('partial'); setImmediate(() => res.destroy()); });
  await call(f.port, '/v1/responses', '{}', auth).catch(() => {});
  const records = (await rows(f.root))[0];
  assert.notEqual((records.at(-1) as { outcome: string }).outcome, 'complete');
  const hanging = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/responses', method: 'POST', headers: auth });
  hanging.on('error', () => {}); hanging.write('unfinished');
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.proxy.close(); hanging.destroy();
  const all = await rows(f.root); assert.ok(all.every(r => (r.at(-1) as { outcome?: string }).outcome !== 'complete'));
});

test('real websocket peers preserve text/binary, bidirectional ping/pong and normal close', async t => {
  const f = await setup(t, (req, res) => { if (!native(req, res)) res.end(); });
  const wss = new WebSocketServer({ server: f.server, autoPong: false });
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  wss.on('connection', (ws, req) => {
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      void rows(f.root).then(all => {
        assert.ok(payload(all[0], 'request').includes(Buffer.from(data as Buffer)));
        assert.equal(req.headers['x-inference-archive-request-id'], all[0][0].requestId);
        assert.equal(req.headers['x-inference-archive-parent'], undefined);
        ws.send(data, { binary });
      });
    });
    ws.on('ping', data => ws.pong(data));
    ws.on('pong', () => {});
    ws.ping('server-ping');
  });
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/v1/responses?token=secret`, { headers: { ...auth, 'x-inference-archive-request-id': spoofId, 'x-inference-archive-parent': spoofId }, autoPong: false });
  client.on('error', () => {}); client.on('ping', data => client.pong(data));
  await once(client, 'open');
  let message = once(client, 'message'); client.send('hello');
  let [data, binary] = await message; assert.equal(data.toString(), 'hello'); assert.equal(binary, false);
  message = once(client, 'message'); client.send(Buffer.from([0, 255]));
  [data, binary] = await message; assert.deepEqual(data, Buffer.from([0, 255])); assert.equal(binary, true);
  const echoed = new Promise<string[]>(resolve => {
    const messages: string[] = [];
    const listener = (data: Buffer) => { messages.push(data.toString()); if (messages.length === 32) { client.off('message', listener); resolve(messages); } };
    client.on('message', listener);
  });
  for (let i = 0; i < 32; i++) client.send(`burst-${i}`);
  assert.deepEqual(await echoed, Array.from({ length: 32 }, (_, i) => `burst-${i}`));
  const pong = once(client, 'pong'); client.ping('client-ping'); await pong;
  client.close(1000, 'done'); await once(client, 'close');
  await waitFinalized(f.root);
  await f.proxy.close();
  const records = (await rows(f.root))[0];
  assert.equal(payload(records, 'request').subarray(0, 5).toString(), 'hello');
  assert.ok(records.some(r => r.kind === 'control' && r.control === 'ping' && r.direction === 'response'));
  assert.ok(records.some(r => r.kind === 'control' && r.control === 'pong' && r.direction === 'request'));
  assert.equal((records.at(-1) as { outcome: string }).outcome, 'complete');
  assert.ok(!JSON.stringify(records).includes('test-private-key'));
});

test('interrupted websocket is recorded as incomplete, unauthorized upgrade creates no journal', async t => {
  const f = await setup(t, (req, res) => { if (!native(req, res)) res.end(); });
  const wss = new WebSocketServer({ server: f.server });
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  let unauthorizedStatus = 0;
  const bad = new WebSocket(`ws://127.0.0.1:${f.port}/v1/responses`);
  bad.on('error', () => {});
  await new Promise<void>(resolve => bad.on('unexpected-response', (_req, res) => { unauthorizedStatus = res.statusCode!; res.resume(); bad.terminate(); resolve(); }));
  assert.equal(unauthorizedStatus, 401); assert.equal((await rows(f.root)).length, 0);
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/v1/responses`, { headers: auth }); client.on('error', () => {});
  await once(client, 'open');
  const closed = once(client, 'close'); client.terminate(); await closed;
  await new Promise(resolve => setTimeout(resolve, 40)); await f.proxy.close();
  const records = (await rows(f.root))[0]; assert.notEqual((records.at(-1) as { outcome: string }).outcome, 'complete');
});

test('begin fsync failure and free-space reserve prevent upstream dispatch', async t => {
  for (const options of [{ beforeIO(op: string) { if (op === 'sync') throw new Error('disk'); } }, { reserveBytes: Number.MAX_SAFE_INTEGER }]) {
    let calls = 0;
    const f = await setup(t, (_req, res) => { calls++; res.end('no'); }, { lane: 'codex-upstream', ...options });
    assert.equal((await call(f.port, '/', 'private')).status, 503);
    assert.equal(calls, 0);
  }
});

test('oversized websocket messages are explicitly closed, never finalized complete', async t => {
  const f = await setup(t, (_req, res) => res.end(), { lane: 'codex-upstream', maxPayloadBytes: 4 });
  const wss = new WebSocketServer({ server: f.server });
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  let received = false;
  wss.on('connection', ws => { ws.on('message', () => { received = true; }); ws.on('error', () => {}); });
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/backend-api/codex/responses`); client.on('error', () => {});
  await once(client, 'open');
  const closed = once(client, 'close'); client.send('12345'); await closed;
  await waitFinalized(f.root);
  assert.equal(received, false);
  assert.notEqual(((await rows(f.root))[0].at(-1) as { outcome: string }).outcome, 'complete');
});

test('failed websocket HTTP upgrade captures status and body', async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(403, { 'content-type': 'text/plain', 'set-cookie': 'secret' }); res.end('provider refused'); }, { lane: 'codex-upstream' });
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/backend-api/codex/responses`); client.on('error', () => {});
  await new Promise<void>(resolve => client.on('unexpected-response', (_req, res) => { res.resume(); client.terminate(); resolve(); }));
  await waitFinalized(f.root);
  const records = (await rows(f.root))[0];
  assert.ok(records.some(r => r.kind === 'response' && r.status === 403));
  assert.equal(payload(records, 'response').toString(), 'provider refused');
  assert.ok(!JSON.stringify(records).includes('secret'));
  assert.equal((records.at(-1) as { outcome: string }).outcome, 'error');
});

test('both lanes can share one root, writer and budget without proxy close stealing ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capture-shared-'));
  const store = await JournalStore.open({ root, reserveBytes: 0, spoolLimitBytes: 1024 ** 2 });
  const f = await setup(t, (req, res) => { if (native(req, res)) return; req.resume(); req.on('end', () => res.end('edge')); }, { root, store, maxPayloadBytes: 128 * 1024 * 1024 });
  const g = await setup(t, (req, res) => { req.resume(); req.on('end', () => res.end('provider')); }, { root, store, lane: 'codex-upstream' });
  assert.equal((await call(f.port, '/v1/responses', '{}', auth)).body, 'edge');
  await f.proxy.close(); await store.checkHealth();
  assert.equal((await call(g.port, '/backend-api/codex/responses', '{}')).body, 'provider');
  await g.proxy.close(); await store.checkHealth();
  const all = await rows(root); assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map(r => r[0].lane)), new Set(['client', 'codex-upstream']));
  await store.close();
  await assert.rejects(store.checkHealth(), /storage-failure/);
});

test('local health metadata bypasses both inference and capture', async t => {
  for (const lane of ['client', 'codex-upstream'] as const) {
    let dispatches = 0;
    const f = await setup(t, (_req, res) => { dispatches++; res.end('unexpected'); }, { lane });
    for (const path of ['/health', '/ready?secret=never-store']) {
      const response = await call(f.port, path, '', {}, 'GET');
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).ready, true);
    }
    assert.equal(dispatches, 0); assert.equal((await rows(f.root)).length, 0);
  }
});

test('upstream attempts retain the generated edge lineage rather than a caller-supplied parent', async t => {
  const upstream = await setup(t, (req, res) => { req.resume(); req.on('end', () => res.end('provider')); }, { lane: 'codex-upstream' });
  const edge = await setup(t, (req, res) => {
    if (native(req, res)) return;
    req.resume();
    req.on('end', () => {
      void (async () => {
        const parent = req.headers['x-inference-archive-request-id'] as string;
        for (let i = 0; i < 2; i++) await call(upstream.port, '/backend-api/codex/responses', `attempt-${i}`, { 'x-inference-archive-parent': parent });
        res.end('edge');
      })();
    });
  });
  await call(edge.port, '/v1/responses', '{}', { ...auth, 'x-inference-archive-request-id': spoofId, 'x-inference-archive-parent': spoofId });
  const client = (await rows(edge.root))[0][0];
  const attempts = await rows(upstream.root); assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.equal((attempt[0] as { headers: Record<string, string> }).headers['x-inference-archive-parent'], client.requestId);
    assert.notEqual(attempt[0].requestId, client.requestId);
  }
});

test('CLI accepts environment JSON and exits cleanly on SIGTERM', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capture-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--experimental-strip-types', new URL('./capture.ts', import.meta.url).pathname, 'serve'], {
    env: { ...process.env, INFERENCE_CAPTURE_CONFIG: JSON.stringify({ root, lane: 'codex-upstream', upstream: 'http://127.0.0.1:1', reserveBytes: 0, shutdownTimeoutMs: 200 }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill('SIGKILL'); });
  const [ready] = await once(child.stdout, 'data');
  assert.equal(JSON.parse(ready.toString()).event, 'listening');
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('fixed destination rejects absolute/protocol-relative request targets and non-loopback binding', async t => {
  let calls = 0;
  const f = await setup(t, (_req, res) => { calls++; res.end('no'); }, { lane: 'codex-upstream' });
  assert.equal((await call(f.port, 'http://example.invalid/path')).status, 503);
  assert.equal((await call(f.port, '//example.invalid/path')).status, 503);
  assert.equal(calls, 0);
  await assert.rejects(startCaptureProxy({ root: f.root, lane: 'client', upstream: 'http://user:password@example.invalid', host: '0.0.0.0' as '127.0.0.1' }), /invalid-capture-options/);
});
