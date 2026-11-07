import http from 'node:http';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCaptureProxy } from './capture.ts';
import type { CaptureProxy } from './capture.ts';
import { JournalStore } from './journal.ts';

export interface ServiceConfig {
  root: string;
  edgePort: number;
  upstreamPort: number;
  healthPort: number;
  reserveBytes: number;
  spoolLimitBytes: number;
  maxPayloadBytes: number;
  maxMessageBytes?: number;
  brokerOrigin: string;
  codexOrigin: string;
}

function validate(config: ServiceConfig): void {
  if (typeof config.root !== 'string' || !config.root.startsWith('/') || config.root === '/' || config.root === '/nix/store' || config.root.startsWith('/nix/store/')) throw new Error('invalid capture storage');
  const ports = [config.edgePort, config.upstreamPort, config.healthPort];
  if (new Set(ports).size !== 3 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('invalid capture listener');
  for (const [value, protocol, hostname] of [[config.brokerOrigin, 'http:', '127.0.0.1'], [config.codexOrigin, 'https:', 'chatgpt.com']]) {
    const url = new URL(value);
    if (url.protocol !== protocol || url.hostname !== hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid fixed capture upstream');
  }
}

/** Both listeners share one writer, budget, and crash-recovery pass. */
export async function startService(config: ServiceConfig) {
  validate(config);
  const store = await JournalStore.open(config);
  try {
    const receipts = join(config.root, 'receipts');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    if (!(await lstat(receipts)).isDirectory()) throw new Error('receipt storage is not a directory');
  } catch {
    await store.close();
    throw new Error('receipt storage unavailable');
  }
  const proxies: CaptureProxy[] = [];
  const health = http.createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (req.method !== 'GET' || !['/health', '/ready'].includes(pathname ?? '')) { res.writeHead(404); res.end(); return; }
    let ready = false;
    try {
      await store.checkHealth();
      const backend = await fetch(`${config.brokerOrigin}/`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      await backend.body?.cancel();
      ready = backend.ok;
    } catch {}
    const result = {
      schemaVersion: 1,
      ready,
      capture: ready ? 'available' : 'unavailable',
      lanes: ['client', 'codex-upstream'],
      databaseAvailabilityBlocksCapture: false,
      coverage: 'broker-selected requests and configured Codex upstream attempts; direct routes are outside coverage',
    };
    res.writeHead(pathname === '/ready' && !ready ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  });
  const options = {
    root: config.root,
    reserveBytes: config.reserveBytes,
    spoolLimitBytes: config.spoolLimitBytes,
    maxPayloadBytes: config.maxPayloadBytes,
    maxMessageBytes: config.maxMessageBytes,
    store,
    idleTimeoutMs: 30 * 60 * 1000,
    shutdownTimeoutMs: 10_000,
  };
  try {
    proxies.push(await startCaptureProxy({ ...options, lane: 'codex-upstream', port: config.upstreamPort, upstream: config.codexOrigin }));
    proxies.push(await startCaptureProxy({ ...options, lane: 'client', port: config.edgePort, upstream: config.brokerOrigin }));
    await new Promise<void>((resolve, reject) => { health.once('error', reject); health.listen(config.healthPort, '127.0.0.1', resolve); });
  } catch {
    await Promise.allSettled(proxies.map(proxy => proxy.close()));
    await store.close().catch(() => {});
    throw new Error('capture startup failed');
  }
  let closePromise: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      return closePromise ??= (async () => {
        await new Promise<void>(resolve => health.close(() => resolve()));
        await Promise.all(proxies.map(proxy => proxy.close()));
        await store.close();
      })();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const started = new Date().toISOString();
  const emit = (outcome: string) => process.stdout.write(`${JSON.stringify({ schemaVersion: 1, operation: 'inference-capture.lifecycle', outcome, startedAt: started, timestamp: new Date().toISOString(), pid: process.pid })}\n`);
  try {
    if (process.argv.length !== 3) throw new Error('usage: service.ts CONFIG.json');
    const service = await startService(JSON.parse(await readFile(process.argv[2]!, 'utf8')) as ServiceConfig);
    emit('running');
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => { emit('shutdown-incomplete'); process.exit(1); }, 15_000);
      void service.close().then(() => { clearTimeout(deadline); emit('stopped'); }, () => { clearTimeout(deadline); emit('shutdown-failed'); process.exitCode = 1; });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch { emit('startup-failed'); process.exitCode = 1; }
}
