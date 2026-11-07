import http from 'node:http';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { JournalError, JournalStore, sanitizeHeaders } from './journal.ts';
import type { Journal, JournalOptions, Lane, Reason } from './journal.ts';

export interface CaptureOptions extends JournalOptions {
  lane: Lane;
  /** Numeric loopback only, in both lanes. No public recorder or dynamic destination. */
  host?: '127.0.0.1' | '::1';
  port?: number;
  /** Fixed origin only; request targets can never override the upstream host. */
  upstream: string;
  /** Per direction, per exchange. Reaching the limit closes explicitly, never truncates successfully. */
  maxPayloadBytes?: number;
  /** Complete WS messages remain single journal records; larger messages close explicitly. Defaults to 8 MiB. */
  maxMessageBytes?: number;
  /** Optional shared writer/budget for both lanes. Its owner, not proxy.close(), must close it. */
  store?: JournalStore;
  /** Also bounds native /v1/models validation. */
  connectTimeoutMs?: number;
  /** Idle exchanges are interrupted, not marked complete. */
  idleTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface CaptureProxy {
  address: { host: string; port: number };
  close(): Promise<void>;
}

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardingHeaders(req: IncomingMessage, origin: URL, websocket = false, edgeRequestId?: string): OutgoingHttpHeaders {
  const excluded = new Set([...hop, ...(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  if (websocket) for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) excluded.add(key);
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) if (!excluded.has(key)) headers[key] = value;
  headers.host = origin.host;
  if (edgeRequestId) {
    headers['x-inference-archive-request-id'] = edgeRequestId;
    delete headers['x-inference-archive-parent'];
  }
  return headers;
}
function responseHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const excluded = new Set([...hop, ...(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(req.headers).filter(([k]) => !excluded.has(k)));
}
function target(req: IncomingMessage): { pathname: string; wire: string } {
  // Do not feed an absolute target or //host to URL resolution: that would enable SSRF.
  const raw = req.url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#') || /[\r\n\\]/.test(raw)) throw new Error('invalid-target');
  return { pathname: raw.split('?')[0], wire: raw };
}
function shouldCapture(lane: Lane, pathname: string): boolean {
  if (lane === 'codex-upstream') return true;
  return /^\/(?:v1|v1beta)\//.test(pathname) && !/^\/v1\/models(?:\/|$)/.test(pathname)
    && !/^\/v1beta\/models\/?$/.test(pathname);
}
function reason(error: unknown): Reason {
  return error instanceof JournalError ? (error.code === 'size-limit' ? 'size-limit' : 'storage-failure') : 'upstream-failure';
}
function fail(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
  res.end(message + '\n');
}
function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
async function writeChunk(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
  if ((stream as { destroyed?: boolean }).destroyed) throw new Error('peer-aborted');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { stream.off('drain', drained); stream.off('close', closed); stream.off('error', closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('peer-aborted')); };
    stream.once('drain', drained); stream.once('close', closed); stream.once('error', closed);
    if (stream.write(data)) drained();
  });
}
async function validateCredential(req: IncomingMessage, upstream: URL, timeout: number): Promise<boolean> {
  const transport = upstream.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const headers: OutgoingHttpHeaders = {};
    for (const key of ['authorization', 'x-api-key', 'api-key']) if (req.headers[key]) headers[key] = req.headers[key];
    const validation = transport.request(upstream, { method: 'GET', path: '/v1/models', headers, agent: false }, response => {
      const valid = response.statusCode === 200;
      response.destroy();
      resolve(valid);
    });
    const timer = setTimeout(() => validation.destroy(), timeout);
    validation.once('close', () => clearTimeout(timer));
    validation.on('error', () => resolve(false));
    validation.end();
  });
}

export async function startCaptureProxy(options: CaptureOptions): Promise<CaptureProxy> {
  let upstream: URL;
  try { upstream = new URL(options.upstream); } catch { throw new Error('invalid-capture-options'); }
  const host = options.host ?? '127.0.0.1';
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash
    || !['127.0.0.1', '::1'].includes(host) || !['client', 'codex-upstream'].includes(options.lane)) throw new Error('invalid-capture-options');
  const maxPayload = options.maxPayloadBytes ?? 8 * 1024 * 1024;
  const maxMessage = options.maxMessageBytes ?? Math.min(maxPayload, 8 * 1024 * 1024);
  const connectTimeout = options.connectTimeoutMs ?? 5000;
  const idleTimeout = options.idleTimeoutMs ?? 120000;
  const shutdownTimeout = options.shutdownTimeoutMs ?? 5000;
  for (const n of [maxPayload, maxMessage, connectTimeout, idleTimeout, shutdownTimeout]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error('invalid-capture-options');
  if (maxMessage > 16 * 1024 * 1024 || maxMessage > maxPayload) throw new Error('invalid-capture-options');
  const store = options.store ?? await JournalStore.open(options);
  const transport = upstream.protocol === 'https:' ? https : http;
  const sockets = new Set<Duplex>();
  const tasks = new Set<Promise<void>>();
  const stops = new Set<() => void>();
  let closing = false;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: maxMessage, perMessageDeflate: false, autoPong: false });

  function track(work: Promise<void>): void {
    tasks.add(work);
    void work.catch(() => {}).finally(() => tasks.delete(work));
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.pause();
    let journal: Journal | undefined;
    let sent = 0, received = 0;
    let stopped: Reason | undefined;
    let out: http.ClientRequest | undefined, incoming: IncomingMessage | undefined;
    const stop = (why: Reason) => { stopped ??= why; out?.destroy(); incoming?.destroy(); req.destroy(); res.destroy(); };
    const shutdown = () => stop('shutdown');
    stops.add(shutdown);
    req.on('error', () => stop('peer-aborted'));
    res.on('error', () => stop('peer-aborted'));
    req.on('aborted', () => stop('peer-aborted'));
    res.on('close', () => { if (!res.writableFinished) stop('peer-aborted'); });
    try {
      const route = target(req);
      if (req.method === 'GET' && ['/health', '/ready'].includes(route.pathname)) {
        let ready = !closing;
        try { await store.checkHealth(); } catch { ready = false; }
        res.writeHead(route.pathname === '/ready' && !ready ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ schemaVersion: 1, ready, lane: options.lane }));
        return;
      }
      const capture = shouldCapture(options.lane, route.pathname);
      if (capture && options.lane === 'client' && !(await validateCredential(req, upstream, connectTimeout))) { fail(res, 401, 'unauthorized'); return; }
      if (closing || stopped || req.destroyed) throw new Error('interrupted');
      const length = Number(req.headers['content-length']);
      if (capture && Number.isFinite(length) && length > maxPayload) { fail(res, 413, 'size-limit'); return; }
      if (capture) journal = await store.begin(options.lane, { kind: 'start', transport: 'http', method: req.method ?? 'GET', pathname: route.pathname, headers: sanitizeHeaders(req.headers), upstream: upstream.origin });
      if (closing || stopped) throw new Error('interrupted');
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        out = transport.request(upstream, { method: req.method, path: route.wire, headers: forwardingHeaders(req, upstream, false, options.lane === 'client' ? journal?.requestId ?? randomUUID() : undefined), agent: false }, resolve);
        const deadline = setTimeout(() => out?.destroy(), connectTimeout);
        out.once('socket', socket => {
          if (!socket.connecting) clearTimeout(deadline);
          else socket.once(upstream.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(deadline));
        });
        out.once('close', () => clearTimeout(deadline));
        out.setTimeout(idleTimeout, () => { stopped ??= 'upstream-failure'; out?.destroy(); });
        out.on('error', reject);
      });
      // Consume early error events even while request input is waiting for its next chunk.
      void response.catch(() => {});
      const sending = (async () => {
        try {
          for await (const chunk of req) {
            const data = Buffer.from(chunk);
            sent += data.length;
            if (journal && sent > maxPayload) throw new JournalError('size-limit');
            if (journal) await journal.data('request', data);
            if (stopped) throw new Error('interrupted');
            await writeChunk(out!, data);
          }
          out!.end();
        } catch (e) { out?.destroy(); throw e; }
      })();
      const receiving = (async () => {
        incoming = await response;
        incoming.on('error', () => {});
        if (journal) await journal.response(incoming.statusCode ?? 502, sanitizeHeaders(incoming.headers));
        res.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming));
        for await (const chunk of incoming) {
          const data = Buffer.from(chunk);
          received += data.length;
          if (journal && received > maxPayload) throw new JournalError('size-limit');
          if (journal) await journal.data('response', data);
          if (stopped) throw new Error('interrupted');
          await writeChunk(res, data);
        }
        if (!incoming.complete) throw new Error('interrupted');
      })();
      // A failure on either half must interrupt the other, rather than waiting indefinitely.
      const interrupt = (e: unknown) => { stopped ??= reason(e); out?.destroy(); incoming?.destroy(); req.destroy(); throw e; };
      await Promise.all([sending.catch(interrupt), receiving.catch(interrupt)]);
      if (stopped || !req.complete || !incoming?.complete) throw new Error('interrupted');
      if (journal) await journal.finish('complete');
      res.end();
    } catch (e) {
      const why = stopped ?? reason(e);
      out?.destroy(); incoming?.destroy();
      if (journal && !journal.finished) await journal.finish(why === 'peer-aborted' || why === 'shutdown' ? 'aborted' : 'error', why).catch(() => {});
      fail(res, why === 'size-limit' ? 413 : 503, why === 'size-limit' ? 'size-limit' : 'capture-unavailable');
    } finally { stops.delete(shutdown); }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.pause();
    let journal: Journal | undefined, upstreamWs: WebSocket | undefined, clientWs: WebSocket | undefined;
    let terminal = false, stopped: Reason | undefined;
    let chain: Promise<void> = Promise.resolve();
    let requestBytes = 0, responseBytes = 0;
    const shutdown = () => { stopped = 'shutdown'; upstreamWs?.terminate(); clientWs?.terminate(); socket.destroy(); };
    stops.add(shutdown);
    socket.on('error', () => {});
    const finish = async (complete: boolean, why?: Reason) => {
      if (terminal) return;
      terminal = true;
      if (journal) await journal.finish(complete ? 'complete' : why === 'peer-aborted' || why === 'shutdown' ? 'aborted' : 'error', why);
    };
    try {
      const route = target(req);
      const capture = shouldCapture(options.lane, route.pathname);
      if (capture && options.lane === 'client' && !(await validateCredential(req, upstream, connectTimeout))) { rejectUpgrade(socket, 401); return; }
      if (closing || socket.destroyed) throw new Error('interrupted');
      if (capture) journal = await store.begin(options.lane, { kind: 'start', transport: 'websocket', method: req.method ?? 'GET', pathname: route.pathname, headers: sanitizeHeaders(req.headers), upstream: upstream.origin });
      const wsUrl = new URL(upstream.origin);
      wsUrl.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
      // Assign path/search separately; URL resolution must never change the fixed origin.
      wsUrl.pathname = route.pathname;
      wsUrl.search = route.wire.includes('?') ? route.wire.slice(route.wire.indexOf('?')) : '';
      const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim()).filter(Boolean);
      // ws may parse a coalesced first frame immediately after upgrade. Pause native reads until listeners exist.
      upstreamWs = new WebSocket(wsUrl, protocols, { headers: forwardingHeaders(req, upstream, true, options.lane === 'client' ? journal?.requestId ?? randomUUID() : undefined), maxPayload: maxMessage, perMessageDeflate: false, autoPong: false, handshakeTimeout: connectTimeout });
      upstreamWs.on('error', () => {});
      let upgradeResponse: IncomingMessage | undefined;
      upstreamWs.on('upgrade', response => { upgradeResponse = response; });
      await new Promise<void>((resolve, reject) => {
        upstreamWs!.once('open', () => { upstreamWs!.pause(); resolve(); });
        upstreamWs!.once('error', () => reject(new Error('upstream-failure')));
        upstreamWs!.once('unexpected-response', (_request, response) => {
          // Non-101 responses are still captured, including their confidential error bodies.
          track((async () => {
            try {
              if (journal) await journal.response(response.statusCode ?? 502, sanitizeHeaders(response.headers));
              for await (const chunk of response) {
                const data = Buffer.from(chunk); responseBytes += data.length;
                if (responseBytes > maxPayload) throw new JournalError('size-limit');
                if (journal) await journal.data('response', data);
              }
              await finish(false, 'upstream-failure');
            } catch (e) { await finish(false, reason(e)).catch(() => {}); }
            finally { reject(new Error('upstream-failure')); upstreamWs?.terminate(); }
          })());
        });
      });
      if (journal) await journal.response(101, sanitizeHeaders(upgradeResponse?.headers ?? {}));
      if (closing || socket.destroyed) throw new Error('interrupted');
      // Relay only the selected protocol; never persist the offered protocol list (it can carry auth).
      const original = req.headers['sec-websocket-protocol'];
      if (upstreamWs.protocol) req.headers['sec-websocket-protocol'] = upstreamWs.protocol;
      else delete req.headers['sec-websocket-protocol'];
      websocketServer.handleUpgrade(req, socket, head, ws => { clientWs = ws; });
      if (original !== undefined) req.headers['sec-websocket-protocol'] = original;
      if (!clientWs) throw new Error('protocol-failure');
      const client = clientWs, remote = upstreamWs;
      client.on('error', () => {});
      let clientClosed = false, remoteClosed = false;
      let clientCode = 1006, remoteCode = 1006;
      let doneResolve!: () => void;
      const done = new Promise<void>(resolve => { doneResolve = resolve; });
      const timer = setTimeout(() => shutdown(), idleTimeout);
      timer.unref();
      const pending = new Map<WebSocket, number>();
      const enqueue = (source: WebSocket, destination: WebSocket, direction: 'request' | 'response', type: 'data' | 'ping' | 'pong' | 'close', data: Buffer, binary?: boolean, code?: number) => {
        source.pause();
        pending.set(source, (pending.get(source) ?? 0) + 1);
        chain = chain.then(async () => {
          if (stopped || terminal) throw new Error('interrupted');
          timer.refresh();
          if (type === 'data') {
            if (direction === 'request') requestBytes += data.length; else responseBytes += data.length;
            if ((direction === 'request' ? requestBytes : responseBytes) > maxPayload) throw new JournalError('size-limit');
            if (journal) await journal.data(direction, data, binary);
          } else if (journal) await journal.control(direction, type, data, code);
          if (type === 'close') {
            // ws automatically replies to an incoming close frame. This records the observed application close,
            // and propagates it only after durable capture; automatic local protocol replies are not payload capture.
            if (code === 1006) { stopped ??= 'peer-aborted'; destination.terminate(); }
            else if (destination.readyState === WebSocket.OPEN) destination.close(code === 1005 ? undefined : code, data);
          } else if (destination.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve, reject) => {
              const callback = (error?: Error) => error ? reject(new Error('upstream-failure')) : resolve();
              if (type === 'data') destination.send(data, { binary: binary ?? true }, callback);
              else if (type === 'ping') destination.ping(data, undefined, callback);
              else destination.pong(data, undefined, callback);
            });
          } else throw new Error('interrupted');
        }).catch(e => { stopped ??= reason(e); client.terminate(); remote.terminate(); }).finally(() => {
          const remaining = (pending.get(source) ?? 1) - 1;
          pending.set(source, remaining);
          // A single native read can emit many messages. Resume only after that entire batch drains.
          if (!remaining && !stopped && !terminal) source.resume();
        });
      };
      const bind = (source: WebSocket, destination: WebSocket, direction: 'request' | 'response') => {
        source.on('message', (data: RawData, binary: boolean) => enqueue(source, destination, direction, 'data', Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]), binary));
        source.on('ping', data => enqueue(source, destination, direction, 'ping', data));
        source.on('pong', data => enqueue(source, destination, direction, 'pong', data));
        source.on('error', () => { stopped ??= 'protocol-failure'; client.terminate(); remote.terminate(); });
        source.on('close', (code, data) => {
          if (direction === 'request') { clientClosed = true; clientCode = code; } else { remoteClosed = true; remoteCode = code; }
          enqueue(source, destination, direction, 'close', data, undefined, code);
          if (clientClosed && remoteClosed) doneResolve();
        });
      };
      bind(client, remote, 'request'); bind(remote, client, 'response');
      client.resume(); remote.resume(); socket.resume();
      await done;
      clearTimeout(timer);
      await chain;
      const complete = !stopped && clientCode !== 1006 && remoteCode !== 1006;
      await finish(complete, complete ? undefined : stopped ?? 'peer-aborted');
    } catch (e) {
      upstreamWs?.terminate(); clientWs?.terminate();
      await finish(false, stopped ?? reason(e)).catch(() => {});
      rejectUpgrade(socket, 503);
    } finally { stops.delete(shutdown); }
  }

  const server = http.createServer((req, res) => track(handleHttp(req, res)));
  server.on('upgrade', (req, socket, head) => track(handleUpgrade(req, socket, head)));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400));
  server.requestTimeout = idleTimeout;
  server.headersTimeout = Math.min(idleTimeout, 60000);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, host, resolve); });
  } catch { if (!options.store) await store.close(); throw new Error('listen-failure'); }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen-failure');
  let closePromise: Promise<void> | undefined;
  return {
    address: { host, port: address.port },
    close() {
      return closePromise ??= (async () => {
        closing = true;
        const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
        for (const stop of stops) stop();
        for (const socket of sockets) socket.destroy();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...tasks]), new Promise<void>(resolve => { timer = setTimeout(resolve, shutdownTimeout); })]);
        clearTimeout(timer);
        await serverClosed;
        if (!options.store) await store.close();
        websocketServer.close();
      })();
    },
  };
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'serve') throw new Error('usage: capture.ts serve [config.json]');
  const options = JSON.parse(process.argv[3] ? await readFile(process.argv[3], 'utf8') : process.env.INFERENCE_CAPTURE_CONFIG ?? '{}') as CaptureOptions;
  const proxy = await startCaptureProxy(options);
  process.stdout.write(JSON.stringify({ event: 'listening', address: proxy.address }) + '\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // A stuck kernel fsync cannot be cancelled; bound the process shutdown without claiming success.
    const timer = setTimeout(() => process.exit(1), (options.shutdownTimeoutMs ?? 5000) + 1000);
    void proxy.close().then(() => { clearTimeout(timer); }, () => { process.exitCode = 1; clearTimeout(timer); });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write('capture-failed\n'); process.exitCode = 1; });
}
