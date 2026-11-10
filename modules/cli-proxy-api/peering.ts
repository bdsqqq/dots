import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { readClient, type Client } from "./broker.ts";
import { isMain, privateFile } from "../tool-auth/process.ts";

export interface PeeringConfig {
  localClientFile: string;
  callerKeyFile: string;
  incoming: { nodeId: string; keyFile: string }[];
  peers: { nodeId: string; clientFile: string }[];
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  maxConcurrent?: number;
}
interface Options { nodeId: string; port: number; config: PeeringConfig; event?: (event: RouteEvent) => void }
interface RouteEvent { event: "inference.peer.route"; nodeId: string; delegationId: string; selected?: string; delegated: boolean; dispatched: boolean; status: number; elapsedMs: number }
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const credentials = new Set(["authorization", "x-api-key", "api-key", "cookie", "set-cookie"]);
const routeHeader = "x-inference-prefer-node";

function key(file: string): string {
  const value = privateFile(file).trim();
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(value)) throw new Error("invalid peering credential");
  return value;
}
function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
function authenticate(req: IncomingMessage, config: PeeringConfig, delegated: boolean): boolean {
  const match = /^Bearer ([a-zA-Z0-9_-]{32,128})$/.exec(req.headers.authorization ?? "");
  if (!match) return false;
  if (!delegated) return equal(match[1]!, key(config.callerKeyFile));
  return config.incoming.some(peer => {
    // Removing one peer's credential revokes that peer, not every other peer.
    try { return equal(match[1]!, key(peer.keyFile)); } catch { return false; }
  });
}
function localClient(config: PeeringConfig, port: number): Client {
  const client = readClient(config.localClientFile);
  const url = new URL(client.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port || 80) === port) {
    throw new Error("local execution requires a distinct loopback gateway");
  }
  return client;
}
export function validatePeering(config: PeeringConfig, nodeId: string, port: number): void {
  if (!idPattern.test(nodeId) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid peering listener");
  if (!Array.isArray(config.incoming) || !Array.isArray(config.peers)) throw new Error("invalid peer membership");
  key(config.callerKeyFile);
  localClient(config, port);
  for (const entries of [config.incoming, config.peers]) {
    const seen = new Set<string>();
    for (const peer of entries) {
      if (!idPattern.test(peer.nodeId) || peer.nodeId === nodeId || seen.has(peer.nodeId)) throw new Error("invalid or duplicate peer identity");
      seen.add(peer.nodeId);
    }
  }
  for (const peer of config.incoming) {
    if (equal(key(peer.keyFile), key(config.callerKeyFile))) throw new Error("caller and peer credentials must differ");
  }
  for (const peer of config.peers) readClient(peer.clientFile);
  for (const [value, maximum] of [[config.probeTimeoutMs, 10_000], [config.requestTimeoutMs, 900_000], [config.maxBodyBytes, 128 * 1024 * 1024], [config.maxConcurrent, 32]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum!)) throw new Error("invalid peering bound");
  }
}
function headers(message: IncomingMessage): OutgoingHttpHeaders {
  const excluded = new Set([...hop, ...credentials, ...(message.headers.connection ?? "").toLowerCase().split(",").map(s => s.trim())]);
  return Object.fromEntries(Object.entries(message.headers).filter(([name]) => !excluded.has(name) && name !== "host" && name !== "content-length" && name !== routeHeader && !name.startsWith("x-inference-peer-") && name !== "x-inference-delegation-id"));
}
function reply(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: { message, type: "peering_error" } }));
}
function connect(client: Client, pathname: string, method: string, signal: AbortSignal, body?: Buffer, extra?: OutgoingHttpHeaders): Promise<IncomingMessage> {
  const url = new URL(pathname, `${client.baseUrl}/`);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method, signal, agent: false,
      headers: { ...extra, authorization: `Bearer ${client.apiKey}`, ...(body ? { "content-length": body.length } : {}) },
    }, resolve);
    request.on("error", reject);
    request.end(body);
  });
}
async function models(client: Client, delegated: boolean, signal: AbortSignal, timeout: number): Promise<Buffer> {
  const response = await connect(client, delegated ? "/peer/v1/models" : "/v1/models", "GET", AbortSignal.any([signal, AbortSignal.timeout(timeout)]));
  if (response.statusCode !== 200) { response.destroy(); throw new Error("model discovery unavailable"); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of response) {
    size += part.length;
    if (size > 512 * 1024) { response.destroy(); throw new Error("model discovery too large"); }
    chunks.push(Buffer.from(part));
  }
  const bytes = Buffer.concat(chunks);
  const value = JSON.parse(bytes.toString()) as { data?: { id?: string }[] };
  if (!Array.isArray(value.data) || value.data.some(row => typeof row.id !== "string")) throw new Error("invalid model discovery");
  return bytes;
}

/** Delegation is an execution-only capability: a peer request never enters route
 * selection. Discovery may fail over; once a POST is attempted, no replay is safe
 * merely because a response or transport failed. Native gateways remain separate. */
export async function startPeering({ nodeId, port, config, event }: Options) {
  validatePeering(config, nodeId, port);
  const active = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const delegated = req.url === "/peer/v1/responses" || req.url === "/peer/v1/models";
    const isModels = req.url === "/v1/models" || req.url === "/peer/v1/models";
    const isResponse = req.url === "/v1/responses" || req.url === "/peer/v1/responses";
    if (req.url === "/health" && req.method === "GET") { res.end(JSON.stringify({ nodeId, live: true, inferenceTested: false })); return; }
    if ((!isModels && !isResponse) || req.method !== (isModels ? "GET" : "POST")) { reply(res, 404, "unsupported peering route"); return; }
    const started = Date.now();
    const suppliedId = req.headers["x-inference-delegation-id"];
    const delegationId = delegated && typeof suppliedId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(suppliedId) ? suppliedId : randomUUID();
    const record: RouteEvent = { event: "inference.peer.route", nodeId, delegationId, delegated, dispatched: false, status: 500, elapsedMs: 0 };
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!authenticate(req, config, delegated)) { record.status = 401; reply(res, 401, "inference credential required"); return; }
      if (active.size >= (config.maxConcurrent ?? 8)) { record.status = 503; reply(res, 503, "peering capacity unavailable"); return; }
      controller = new AbortController();
      active.add(controller);
      const abort = () => controller!.abort();
      req.once("aborted", abort);
      res.once("close", () => { if (!res.writableFinished) abort(); });
      timer = setTimeout(abort, config.requestTimeoutMs ?? 300_000).unref();
      const signal = controller.signal;
      signal.addEventListener("abort", () => { if (!req.complete) req.destroy(); }, { once: true });
      const timeout = config.probeTimeoutMs ?? 2000;
      if (isModels) {
        const bytes = await models(localClient(config, port), false, signal, timeout);
        record.selected = nodeId;
        record.status = 200;
        res.writeHead(200, { "content-type": "application/json" }); res.end(bytes); return;
      }
      if (req.headers["content-encoding"] || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) { record.status = 415; reply(res, 415, "an uncompressed JSON request is required"); return; }
      const maximum = config.maxBodyBytes ?? 16 * 1024 * 1024;
      if (Number(req.headers["content-length"]) > maximum) { record.status = 413; reply(res, 413, "request body too large"); return; }
      const parts: Buffer[] = [];
      let size = 0;
      req.setTimeout(30_000, abort);
      for await (const part of req) {
        size += part.length;
        if (size > maximum) { record.status = 413; reply(res, 413, "request body too large"); return; }
        parts.push(Buffer.from(part));
      }
      req.setTimeout(0);
      const body = Buffer.concat(parts);
      let model: unknown;
      try { model = (JSON.parse(body.toString()) as { model?: unknown }).model; } catch { /* report only our fixed message, never parser input */ }
      if (typeof model !== "string" || !model.length || model.length > 256) { record.status = 400; reply(res, 400, "a JSON model identifier is required"); return; }
      const preferred = req.headers[routeHeader];
      if (!delegated && preferred !== undefined && (typeof preferred !== "string" || (preferred !== nodeId && !config.peers.some(peer => peer.nodeId === preferred)))) { record.status = 400; reply(res, 400, "unknown preferred peer"); return; }
      const candidates = delegated ? [{ nodeId, file: config.localClientFile, peer: false }] : [
        { nodeId, file: config.localClientFile, peer: false },
        ...config.peers.map(peer => ({ nodeId: peer.nodeId, file: peer.clientFile, peer: true })),
      ];
      if (!delegated && typeof preferred === "string") candidates.sort((a, b) => Number(b.nodeId === preferred) - Number(a.nodeId === preferred));
      let selected: { nodeId: string; client: Client; peer: boolean } | undefined;
      for (const candidate of candidates) {
        if (signal.aborted) break;
        try {
          const client = candidate.peer ? readClient(candidate.file) : localClient(config, port);
          const available = JSON.parse((await models(client, candidate.peer, signal, timeout)).toString()) as { data: { id: string }[] };
          if (available.data.some(row => row.id === model)) { selected = { nodeId: candidate.nodeId, client, peer: candidate.peer }; break; }
        } catch { /* discovery is read-only: skipping an unavailable candidate cannot duplicate inference */ }
      }
      if (!selected) { record.status = 503; reply(res, 503, "no reachable execution owner for this model"); return; }
      record.selected = selected.nodeId;
      record.dispatched = true;
      const response = await connect(selected.client, selected.peer ? "/peer/v1/responses" : "/v1/responses", "POST", signal, body, {
        ...headers(req), "x-inference-delegation-id": delegationId, "x-correlation-id": delegationId,
      });
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) { response.destroy(); record.status = 502; reply(res, 502, "execution redirects are not supported"); return; }
      record.status = status;
      res.writeHead(status, { ...headers(response), "x-inference-executed-by": selected.nodeId, "x-inference-delegation-id": delegationId });
      await pipeline(response, res, { signal });
    } catch {
      record.status = 502;
      reply(res, 502, "execution interrupted; request was not replayed");
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) active.delete(controller);
      if (!isModels) { record.elapsedMs = Date.now() - started; event?.(record); }
    }
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as { port: number }).port,
    close() {
      return closing ??= (async () => {
        for (const controller of active) controller.abort();
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      })();
    },
  };
}

if (isMain(import.meta.url)) {
  const [nodeId, port, file] = process.argv.slice(2);
  try {
    if (!nodeId || !port || !file) throw new Error("usage: peering.ts node-id port private-config.json");
    const service = await startPeering({ nodeId, port: Number(port), config: JSON.parse(privateFile(file)) as PeeringConfig, event: record => console.log(JSON.stringify(record)) });
    console.log(JSON.stringify({ event: "inference.peer.ready", nodeId, port: service.port, websockets: false }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
  } catch { console.error("peering service failed; inspect private configuration and listener availability"); process.exitCode = 1; }
}

if (import.meta.vitest) {
  const { test, expect, afterEach } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cleanups: (() => Promise<unknown> | void)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  function privateState() {
    const dir = mkdtempSync(join(tmpdir(), "inference-peer-"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = (name: string, value: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
      return path;
    };
    return { file };
  }
  async function gateway(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
    const calls: { path?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "test-model" }] })); return; }
      let body = ""; for await (const part of req) body += part;
      calls.push({ path: req.url, headers: req.headers, body });
      if (handler) handler(req, res);
      else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"response.completed","output":[]}\n\n'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, server };
  }
  async function peer(nodeId: string, target: string, configure?: (config: PeeringConfig, file: ReturnType<typeof privateState>["file"]) => void) {
    const { file } = privateState();
    const caller = "caller_" + randomUUID().replaceAll("-", "");
    const incoming = "broker-" + randomBytes(32).toString("base64url");
    const localKey = "broker-" + randomBytes(32).toString("base64url");
    const config: PeeringConfig = {
      localClientFile: file("local.json", { version: 1, name: nodeId, baseUrl: target, apiKey: localKey }),
      callerKeyFile: file("caller.key", caller), incoming: [{ nodeId: "other", keyFile: file("incoming.key", incoming) }], peers: [],
      probeTimeoutMs: 100, requestTimeoutMs: 2000,
    };
    configure?.(config, file);
    const events: RouteEvent[] = [];
    const service = await startPeering({ nodeId, port: 0, config, event: value => events.push(value) });
    cleanups.push(() => service.close());
    return { ...service, url: `http://127.0.0.1:${service.port}`, caller, incoming, localKey, config, file, events };
  }
  const body = JSON.stringify({ model: "test-model", stream: true, input: "synthetic" });
  const send = (node: { url: string; caller: string }, extra: Record<string, string> = {}, pathname = "/v1/responses") => fetch(`${node.url}${pathname}`, { method: "POST", headers: { authorization: `Bearer ${node.caller}`, "content-type": "application/json", ...extra }, body });
  async function pair(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
    const aGateway = await gateway(); const bGateway = await gateway(handler);
    const b = await peer("node-b", bGateway.url);
    const a = await peer("node-a", aGateway.url, (config, file) => {
      config.peers.push({ nodeId: "node-b", clientFile: file("b.json", { version: 1, name: "node-b", baseUrl: b.url, apiKey: b.incoming }) });
    });
    // A cycle in membership is harmless: execution endpoints never route onward.
    b.config.peers.push({ nodeId: "node-a", clientFile: b.file("a.json", { version: 1, name: "node-a", baseUrl: a.url, apiKey: a.incoming }) });
    return { a, b, aGateway, bGateway };
  }
  test("one-hop delegation preserves SSE and body while keeping credentials at their owners", async () => {
    const { a, b, aGateway, bGateway } = await pair();
    const response = await send(a, { [routeHeader]: "node-b", cookie: "must-not-travel", "x-api-key": "must-not-travel" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"response.completed","output":[]}\n\n');
    expect(response.headers.get("x-inference-executed-by")).toBe("node-b");
    expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(1);
    expect(bGateway.calls[0]!.body).toBe(body);
    expect(bGateway.calls[0]!.headers.authorization).toBe(`Bearer ${b.localKey}`);
    expect(bGateway.calls[0]!.headers.cookie).toBeUndefined(); expect(bGateway.calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(b.events[0]?.delegated).toBe(true);
    expect(bGateway.calls[0]!.headers["x-correlation-id"]).toBe(response.headers.get("x-inference-delegation-id"));
  });
  test("a delegated request cannot forward onward even with a preferred peer and cyclic membership", async () => {
    const { a, b, aGateway, bGateway } = await pair();
    b.file("local.json", { version: 1, name: "node-b", baseUrl: "http://127.0.0.1:1", apiKey: b.localKey });
    const refused = await send(b, { authorization: `Bearer ${b.incoming}`, [routeHeader]: "node-a" }, "/peer/v1/responses");
    expect(refused.status).toBe(503); await refused.text();
    expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(0);
    const local = await send(a, { [routeHeader]: "node-b" }); expect(local.status).toBe(200); await local.text();
    expect(aGateway.calls).toHaveLength(1); expect(bGateway.calls).toHaveLength(0);
  });
  test("local-first is the default even with a reachable peer", async () => {
    const { a, aGateway, bGateway } = await pair(); const response = await send(a); await response.text();
    expect(aGateway.calls).toHaveLength(1); expect(bGateway.calls).toHaveLength(0);
  });
  test("a disconnected preferred peer falls back before any inference POST", async () => {
    const { a, b, aGateway, bGateway } = await pair(); await b.close();
    const response = await send(a, { [routeHeader]: "node-b" });
    expect(response.status).toBe(200); await response.text();
    expect(aGateway.calls).toHaveLength(1); expect(bGateway.calls).toHaveLength(0);
  });
  test("peer credentials cannot invoke the routing endpoint and caller credentials cannot execute as peers", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url);
    for (const [token, pathname] of [[node.incoming, "/v1/responses"], [node.caller, "/peer/v1/responses"], ["invalid", "/peer/v1/responses"]]) {
      const response = await send(node, { authorization: `Bearer ${token}` }, pathname); expect(response.status).toBe(401); await response.text();
    }
    expect(upstream.calls).toHaveLength(0);
  });
  test("an accepted peer response is never retried locally, including quota errors", async () => {
    const { a, aGateway, bGateway } = await pair((_req, res) => { res.writeHead(429); res.end("quota unavailable"); });
    const response = await send(a, { [routeHeader]: "node-b" }); expect(response.status).toBe(429); expect(await response.text()).toBe("quota unavailable");
    expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(1);
  });
  test("an ambiguous POST failure does not replay against another credential", async () => {
    const { a, aGateway, bGateway } = await pair((req) => req.socket.destroy());
    const response = await send(a, { [routeHeader]: "node-b" }); expect(response.status).toBe(502); await response.text();
    expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(1);
  });
  test("truncated streamed responses surface the failure without local replay", async () => {
    const { a, aGateway, bGateway } = await pair((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: partial\n\n");
      setTimeout(() => res.destroy(), 30);
    });
    const response = await send(a, { [routeHeader]: "node-b" }); const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: partial\n\n");
    await expect(reader.read()).rejects.toThrow();
    expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(1);
  });
  test("redirects cannot leak an inference credential to another origin", async () => {
    const outsider = await gateway();
    const { a, aGateway, bGateway } = await pair((_req, res) => { res.writeHead(307, { location: `${outsider.url}/v1/responses` }); res.end(); });
    const response = await send(a, { [routeHeader]: "node-b" }); expect(response.status).toBe(502); await response.text();
    expect(outsider.calls).toHaveLength(0); expect(aGateway.calls).toHaveLength(0); expect(bGateway.calls).toHaveLength(1);
  });
  test("invalid or oversized requests never reach an execution owner", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url, config => { config.maxBodyBytes = 10; });
    const response = await send(node); expect(response.status).toBe(413); await response.text(); expect(upstream.calls).toHaveLength(0);
  });
  test("caller disconnect cancels execution and releases the local concurrency slot", async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const upstream = await gateway((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: waiting\n\n");
      res.once("close", disconnected);
    });
    const node = await peer("node-a", upstream.url, config => { config.maxConcurrent = 1; });
    const first = await send(node);
    const overloaded = await send(node); expect(overloaded.status).toBe(503); await overloaded.text();
    expect(upstream.calls).toHaveLength(1);
    await first.body!.cancel();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("execution was not cancelled")), 1000))]);
  });
  test("a stalled request body is cancelled before inference dispatch", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url, config => { config.requestTimeoutMs = 50; });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${node.url}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${node.caller}`, "content-type": "application/json", "content-length": 100 } });
      const timer = setTimeout(() => { request.destroy(); reject(new Error("stalled body did not time out")); }, 1000);
      request.on("error", () => { clearTimeout(timer); resolve(); }); request.flushHeaders();
    });
    expect(upstream.calls).toHaveLength(0);
  });
  test("websocket upgrades are explicitly unsupported, never silently replayed as HTTP", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${node.url}/v1/responses`, { headers: { connection: "Upgrade", upgrade: "websocket", authorization: `Bearer ${node.caller}` } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end();
    });
    expect(status).toBe(501); expect(upstream.calls).toHaveLength(0);
  });
  test("invalid private membership and remote local execution targets fail closed", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url);
    expect(() => validatePeering({ ...node.config, incoming: [{ nodeId: "node-a", keyFile: node.config.incoming[0]!.keyFile }] }, "node-a", 0)).toThrow();
    node.file("remote.json", { version: 1, name: "node-a", baseUrl: "https://example.com", apiKey: node.localKey });
    expect(() => validatePeering({ ...node.config, localClientFile: node.file("remote.json", { version: 1, name: "node-a", baseUrl: "https://example.com", apiKey: node.localKey }) }, "node-a", 0)).toThrow();
    expect(() => validatePeering({ ...node.config, incoming: [{ nodeId: "other", keyFile: node.config.callerKeyFile }] }, "node-a", 0)).toThrow();
  });
  test("unknown peer preferences and management routes do not forward", async () => {
    const upstream = await gateway(); const node = await peer("node-a", upstream.url);
    const unknown = await send(node, { [routeHeader]: "not-enrolled" }); expect(unknown.status).toBe(400); await unknown.text();
    const management = await fetch(`${node.url}/v0/management/auth-files`, { headers: { authorization: `Bearer ${node.caller}` } });
    expect(management.status).toBe(404); await management.text(); expect(upstream.calls).toHaveLength(0);
  });
}
