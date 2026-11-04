import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import type { ServiceEvent } from "../service-events/events.ts";
import { createPublicationManager, proxyServer, startBackend, stopBackend, waitForBackend } from "./files-browser-server.mjs";

// Capture the actual default JSON transport, not an imitation of the event schema.
async function capture(run: (records: ServiceEvent[]) => Promise<void>) {
  const records: ServiceEvent[] = [];
  const original = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (String(chunk).startsWith('{"schemaVersion":')) {
      records.push(JSON.parse(String(chunk)));
      return true;
    }
    return original.call(this, chunk, ...args);
  } as typeof process.stdout.write;
  try { await run(records); } finally { process.stdout.write = original; }
  assert.equal(new Set(records.map((event) => event.operationId)).size, records.length);
  for (const event of records) {
    assert.match(event.timestamp, /Z$/);
    assert.ok(event.durationMs >= 0);
    assert.ok(event.eventId && event.host);
  }
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY|authorization|secret-query|\.jpg/);
  return records;
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("event or state did not arrive");
}
const listen = (server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise<void>((resolve) => { server.close(resolve); server.closeAllConnections(); });

test("proxy emits one private completion for success, probes, failure and client/upstream abort", async () => {
  await capture(async (records) => {
    const upstream = createServer((incoming, outgoing) => {
      if (incoming.url.includes("upload-abort")) { incoming.resume(); return; }
      if (incoming.url.includes("abort")) {
        outgoing.writeHead(200).write("partial");
        if (incoming.url.includes("upstream-abort")) setTimeout(() => outgoing.destroy(), 10);
        return;
      }
      incoming.resume();
      outgoing.end("ok");
    });
    await listen(upstream);
    let backend = { port: upstream.address().port, inflight: 0 };
    const proxy = proxyServer(() => backend);
    await listen(proxy);
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    try {
      for (const [path, agent] of [["/PRIVATE_CANARY.jpg?secret-query", "Mozilla/5.0"], ["/", "tailnet-registry/1"], ["/", "cloudflare-origin-probe/1"], ["/healthz", "Mozilla/5.0"]]) {
        const response = await fetch(`${origin}${path}`, { headers: { "user-agent": agent, authorization: "PRIVATE_CANARY" } });
        assert.equal(await response.text(), "ok");
      }
      assert.deepEqual(records.map((event) => event.traffic), ["browser", "probe", "probe", "probe"]);
      backend = null;
      assert.equal((await fetch(origin)).status, 503);
      backend = { port: 1, inflight: 0 };
      assert.equal((await fetch(`${origin}/PRIVATE_CANARY.jpg`)).status, 502);
      backend = { port: upstream.address().port, inflight: 0 };
      await new Promise<void>((resolve, reject) => {
        const client = request(`${origin}/client-abort?PRIVATE_CANARY`, (response) => {
          response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
        });
        client.once("error", reject);
        client.end();
      });
      await waitFor(() => records.length === 7);
      assert.equal(records[6].context.reasonCode, "CLIENT_ABORTED");
      const interrupted = await fetch(`${origin}/upstream-abort?PRIVATE_CANARY`);
      await assert.rejects(interrupted.text());
      await waitFor(() => records.length === 8 && backend.inflight === 0);
      assert.equal(records[7].context.reasonCode, "UPSTREAM_INTERRUPTED");
      assert.deepEqual(records.slice(4).map((event) => event.outcome), ["failed", "failed", "failed", "failed"]);
      assert.equal(records[5].context.errorCode, "ECONNREFUSED");
      await new Promise<void>((resolve) => {
        const client = request(`${origin}/upload-abort?PRIVATE_CANARY`, { method: "POST", headers: { "content-length": "1024" } });
        client.on("error", () => {});
        client.write("PRIVATE_CANARY");
        setTimeout(() => { client.destroy(); resolve(); }, 10);
      });
      await waitFor(() => records.length === 9);
      assert.equal(records[8].context.reasonCode, "CLIENT_ABORTED");
      assert.equal(records[8].outcome, "failed");
    } finally { await close(proxy); await close(upstream); }
    assert.equal(records.length, 9);
  });
});

test("real publication refresh preserves the active generation on known failures", async () => {
  await capture(async (records) => {
    const temporary = await mkdtemp(join(tmpdir(), "files-events-"));
    const source = join(temporary, "PRIVATE_CANARY");
    const snapshots = join(temporary, "snapshots");
    await mkdir(source); await mkdir(snapshots);
    await writeFile(join(source, "PRIVATE_CANARY.jpg"), "private-photo-body");
    const copyparty = join(temporary, "backend.mjs");
    await writeFile(copyparty, `#!${process.execPath}\nimport { createServer } from 'node:http';\ncreateServer((req,res)=>res.end('ok')).listen(Number(process.argv[process.argv.indexOf('-p')+1]), '127.0.0.1');\n`);
    await chmod(copyparty, 0o700);
    let syncing = true;
    let fail = false;
    let sequence = 1;
    const api = createServer((incoming, outgoing) => {
      if (fail) return outgoing.writeHead(500).end("PRIVATE_CANARY");
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify(incoming.url.startsWith("/rest/db/status")
        ? { state: syncing ? "syncing" : "idle", needFiles: 0, needDirectories: 0, needSymlinks: 0, needBytes: 0, sequence }
        : [{ name: "PRIVATE_CANARY.jpg", type: "FILE_INFO_TYPE_FILE", modTime: "private", size: 18 }]));
    });
    await listen(api);
    const manager = createPublicationManager({ source, state: temporary, copyparty, apiKey: "PRIVATE_CANARY", syncthingUrl: `http://127.0.0.1:${api.address().port}` }, snapshots);
    try {
      await manager.refresh();
      assert.equal(manager.active, null);
      syncing = false;
      await manager.refresh();
      assert.ok(manager.active);
      const active = manager.active;
      await manager.refresh();
      fail = true;
      await assert.rejects(manager.refresh());
      assert.equal(manager.active, active);
      fail = false; sequence++;
      await rm(join(source, "PRIVATE_CANARY.jpg"));
      await assert.rejects(manager.refresh(), { code: "ENOENT" });
      assert.equal(manager.active, active);
      const refreshes = records.filter((event) => event.operation === "publication.refresh");
      assert.deepEqual(refreshes.map((event) => event.outcome), ["skipped", "succeeded", "skipped", "failed", "failed"]);
      assert.equal(refreshes[0].context.reasonCode, "SOURCE_SYNCING");
      assert.equal(refreshes[2].context.reasonCode, "UNCHANGED");
      assert.equal(refreshes[4].context.errorCode, "ENOENT");
      assert.equal(refreshes[4].context.ready, true);
      assert.ok(records.some((event) => event.operation === "backend.ready" && event.context.ready === true));
    } finally {
      await Promise.all([...manager.backends].map(stopBackend));
      await close(api);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

test("backend spawn failure emits safe startup, readiness and cleanup completions", async () => {
  const records = await capture(async () => {
    const temporary = await mkdtemp(join(tmpdir(), "files-spawn-events-"));
    try {
      const backend = startBackend({ state: temporary, copyparty: join(temporary, "PRIVATE_CANARY") }, 900, join(temporary, "snapshot"));
      await assert.rejects(waitForBackend(backend));
      await stopBackend(backend);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  assert.deepEqual(records.filter((event) => ["backend.start", "backend.ready"].includes(event.operation)).map((event) => event.context.errorCode), ["ENOENT", "ENOENT"]);
});

test("upgrade tunnels complete once on connection close or proxy failure without request targets", async () => {
  await capture(async (records) => {
    const upstream = createServer();
    upstream.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    await listen(upstream);
    let backend = { port: upstream.address().port, inflight: 0 };
    const proxy = proxyServer(() => backend);
    await listen(proxy);
    const upgrade = (agent: string) => new Promise<void>((resolve, reject) => {
      const client = connect(proxy.address().port, "127.0.0.1", () => {
        client.write(`GET /PRIVATE_CANARY?secret-query HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUser-Agent: ${agent}\r\nAuthorization: PRIVATE_CANARY\r\n\r\n`);
      });
      client.on("data", () => {});
      client.once("error", reject);
      client.once("close", resolve);
    });
    try {
      await upgrade("Mozilla/5.0");
      await waitFor(() => records.length === 1 && backend.inflight === 0);
      assert.equal(records[0].outcome, "succeeded");
      assert.equal(records[0].context.connected, true);
      backend = null;
      await upgrade("tailnet-registry/1");
      await waitFor(() => records.length === 2);
      assert.equal(records[1].traffic, "probe");
      assert.equal(records[1].context.reasonCode, "BACKEND_UNAVAILABLE");
      backend = { port: 1, inflight: 0 };
      await upgrade("unknown");
      await waitFor(() => records.length === 3 && backend.inflight === 0);
      assert.equal(records[2].outcome, "failed");
      assert.equal(records[2].context.errorCode, "ECONNREFUSED");
      assert.ok(records.every((event) => event.operation === "http.upgrade"));
    } finally { await close(proxy); await close(upstream); }
    assert.equal(records.length, 3);
  });
});
