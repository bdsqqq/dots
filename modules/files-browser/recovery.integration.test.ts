import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { backendReadiness, closePublicationServer, createPublicationManager, proxyServer, startBackend } from "./files-browser-server.mjs";

async function fixture(recoveryIntervalMs = 100_000, copyparty?: string, recoveryDrainMs = 30_000) {
  const directory = await mkdtemp(join(tmpdir(), "files-recovery-http-"));
  const source = join(directory, "source"), snapshots = join(directory, "snapshots");
  await mkdir(source); await mkdir(snapshots);
  await writeFile(join(source, "indexed.txt"), "A");
  const executable = join(directory, "backend.mjs");
  await writeFile(executable, `#!${process.execPath}
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv.at(-1).slice(0, -3);
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
mkdirSync(process.argv[process.argv.indexOf('--hist') + 1], { recursive: true });
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    try { await access(join(process.env.HOME, 'unhealthy-' + port)); res.writeHead(503).end(); }
    catch { res.end('ready'); }
  } else if (req.url === '/slow') {
    res.write(await readFile(join(root, 'indexed.txt')));
    const timer = setInterval(async () => {
      try { await access(join(process.env.HOME, 'release-' + port)); clearInterval(timer); res.end(); } catch {}
    }, 10);
    res.once('close', () => clearInterval(timer));
  } else {
    try { res.end(await readFile(join(root, 'indexed.txt'))); }
    catch { res.writeHead(404).end(); }
  }
});
server.on('upgrade', (_req, socket) => socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n'));
server.listen(port, '127.0.0.1');
`);
  await chmod(executable, 0o700);
  const model = { state: "idle", sequence: 1, needFiles: 0, needDirectories: 0, needSymlinks: 0, needBytes: 0 };
  let invalidate = false, holdStatus: (() => void) | null = null;
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url!.startsWith("/rest/db/browse")) {
      if (invalidate) model.sequence++;
      response.end(JSON.stringify([{ name: "indexed.txt", type: "FILE_INFO_TYPE_FILE", size: 1, modTime: String(model.sequence) }]));
    } else if (holdStatus) {
      const release = holdStatus; holdStatus = null;
      release(); // the test releases this response separately
      pendingStatus = () => response.end(JSON.stringify(model));
    } else response.end(JSON.stringify(model));
  });
  let pendingStatus: (() => void) | null = null;
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  // Reserve distinct ephemeral ports so separate local/Nix test runs do not
  // reuse sockets still in TIME_WAIT under another build user.
  const reservations = await Promise.all(Array.from({ length: 8 }, async () => {
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    return server;
  }));
  let now = 0, rejectProbe = false, failStarts = false, starts = 0;
  let onClock: (() => void) | null = null;
  const manager = createPublicationManager({ source, state: directory, copyparty: copyparty ?? executable, apiKey: "fixture", syncthingUrl: `http://127.0.0.1:${api.address().port}` }, snapshots, {
    now: () => { const callback = onClock; onClock = null; callback?.(); return now; },
    readiness: backend => rejectProbe ? Promise.resolve({ ready: false, reasonCode: "fixture_failure" }) : backendReadiness(backend),
    start: (config, generation, snapshot) => {
      starts++;
      const reserved = reservations[generation - 1];
      const port = reserved.address().port; reserved.close();
      return startBackend(failStarts ? { ...config, copyparty: join(directory, "missing") } : config, port - 13_925, snapshot);
    },
    recoveryIntervalMs, recoveryDrainMs,
  });
  const proxy = proxyServer(() => manager.active);
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const content = async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/indexed.txt`);
    assert.equal(response.status, 200);
    return response.text();
  };
  return {
    manager, model, snapshots, directory, content,
    get starts() { return starts; },
    onClock: (callback: () => void) => { onClock = callback; },
    closeServer: () => closePublicationServer(proxy, manager),
    upgrade: async () => {
      const socket = connect(proxy.address().port, "127.0.0.1");
      await once(socket, "connect");
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      const [handshake] = await once(socket, "data");
      assert.match(handshake.toString(), /^HTTP\/1\.1 101 /);
      return socket;
    },
    tick: () => { now += 10_000; },
    failActive: () => writeFile(join(directory, `unhealthy-${manager.active.port}`), "fail"),
    failStarts: () => { failStarts = true; },
    slow: () => fetch(`http://127.0.0.1:${proxy.address().port}/slow`),
    releaseTransfer: (backend) => writeFile(join(directory, `release-${backend.port}`), "done"),
    probe: (fail: boolean) => { rejectProbe = fail; },
    invalidate: () => { invalidate = true; },
    stable: () => { invalidate = false; },
    hold: () => new Promise<void>(resolve => { holdStatus = resolve; }),
    release: () => pendingStatus?.(),
    replace: async () => { await writeFile(join(directory, "next"), "B"); await rename(join(directory, "next"), join(source, "indexed.txt")); model.sequence++; },
    close: async () => {
      pendingStatus?.();
      await closePublicationServer(proxy, manager);
      for (const server of reservations) server.close();
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("recovery did not converge within two seconds");
}

test("one failed probe while the source changes preserves the published child and snapshot", async () => {
  const f = await fixture();
  try {
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.replace(); f.probe(true);
    await f.manager.refresh();
    assert.equal(f.manager.active, a);
    assert.equal(await readFile(join(a.snapshot, "indexed.txt"), "utf8"), "A");
    assert.equal(await f.content(), "A");
    f.probe(false); await f.manager.refresh();
    assert.equal(f.manager.active, a);
  } finally { await f.close(); }
});

test("persistent HTTP probe failures replace from A before retiring its usable child; B waits for drain", async () => {
  const f = await fixture();
  try {
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.replace(); await f.failActive();
    for (let i = 0; i < 3; i++) await f.manager.recover();
    assert.equal(f.manager.active, a, "backoff must leave usable content routed");
    assert.equal(await f.content(), "A");
    const transferA = await f.slow();
    assert.equal(a.inflight, 1);
    f.tick(); await f.manager.recover();
    const recovered = f.manager.active;
    assert.notEqual(recovered, a);
    assert.equal(recovered.snapshot, a.snapshot);
    assert.equal(a.child.killed, false, "start-before-retire and inflight drain");
    assert.equal(await f.content(), "A");
    await f.releaseTransfer(a);
    assert.equal(await transferA.text(), "A");
    await eventually(() => !f.manager.backends.has(a));
    assert.equal(await readFile(join(recovered.snapshot, "indexed.txt"), "utf8"), "A");
    f.model.state = "idle"; f.invalidate();
    for (let i = 0; i < 4; i++) {
      await f.manager.refresh();
      assert.equal(f.manager.active, recovered);
      assert.equal(await f.content(), "A");
      assert.equal((await readdir(f.snapshots)).length, 1, "invalid candidates cannot erase publication");
    }
    const transferRecovered = await f.slow();
    assert.equal(recovered.inflight, 1);
    f.stable(); await f.manager.refresh(); const b = f.manager.active;
    assert.notEqual(b.snapshot, recovered.snapshot);
    assert.equal(await f.content(), "B");
    assert.equal(recovered.child.killed, false);
    assert.equal((await readdir(f.snapshots)).length, 2);
    await f.releaseTransfer(recovered);
    assert.equal(await transferRecovered.text(), "A");
    await eventually(async () => (await readdir(f.snapshots)).length === 1);
    const owned = [...f.manager.backends];
    await f.manager.shutdown();
    assert.equal(f.manager.backends.size, 0);
    assert.deepEqual(await readdir(f.snapshots), []);
    assert.deepEqual(await readdir(join(f.directory, "history")), []);
    for (const backend of owned) assert.ok(backend.child.signalCode || backend.child.exitCode !== null);
  } finally { await f.close(); }
});

test("a real child exit recovers A even while a changing source status request is blocked", async () => {
  const f = await fixture(25, process.env.FILES_BROWSER_TEST_COPYPARTY);
  try {
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.replace();
    const held = f.hold(), refreshing = f.manager.refresh();
    await held;
    a.child.kill("SIGKILL");
    await a.closed;
    await eventually(() => f.manager.active === null);
    await eventually(async () => JSON.parse(await readFile(join(f.directory, "backend-recovery.json"), "utf8").catch(() => "null"))?.failures === 1);
    f.tick();
    await eventually(() => f.manager.active !== null && f.manager.active !== a);
    assert.equal(await f.content(), "A");
    assert.equal(f.manager.active.snapshot, a.snapshot);
    f.release(); await refreshing;
    assert.equal(f.model.state, "syncing");
  } finally { await f.close(); }
});

test("failed recovery starts exhaust the persisted budget without losing A, and cooldown retries it", async () => {
  const f = await fixture();
  try {
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.replace(); f.failStarts();
    a.child.kill("SIGKILL"); await a.closed;
    await f.manager.recover(); // original exit's backoff
    for (let i = 0; i < 2; i++) {
      f.tick();
      await assert.rejects(f.manager.recover(), { code: "ENOENT" });
    }
    const before = JSON.parse(await readFile(join(f.directory, "backend-recovery.json"), "utf8"));
    assert.equal(before.failures, 3);
    f.tick(); await f.manager.recover();
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, "backend-recovery.json"), "utf8")), before);
    assert.equal(await readFile(join(a.snapshot, "indexed.txt"), "utf8"), "A");
    assert.equal(f.manager.active, null);
    for (let i = 0; i < 180; i++) f.tick();
    await assert.rejects(f.manager.recover(), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(f.directory, "backend-recovery.json"), "utf8")).failures, 1);
    await f.manager.shutdown();
    assert.deepEqual(await readdir(f.snapshots), []);
  } finally { await f.close(); }
});

test("shutdown cancels a blocked source refresh and cannot launch another child", async () => {
  const f = await fixture(25);
  try {
    await f.manager.refresh(); const a = f.manager.active;
    const held = f.hold(), refreshing = f.manager.refresh(); await held;
    const rejected = assert.rejects(refreshing);
    await f.manager.shutdown(); await rejected;
    assert.equal(f.manager.active, null);
    assert.equal(f.manager.backends.size, 0);
    assert.deepEqual(await readdir(f.snapshots), []);
    assert.ok(a.child.signalCode);
    await f.manager.refresh(); await f.manager.recover();
    assert.equal(f.manager.backends.size, 0);
  } finally { await f.close(); }
});

test("probe failure followed by child exit is charged once and still permits recovery", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "backend-recovery.json"), JSON.stringify({ failures: 1, windowAt: 0, nextAt: 0 }));
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.failActive();
    for (let i = 0; i < 3; i++) await f.manager.recover();
    a.child.kill("SIGKILL"); await a.closed;
    await f.manager.recover();
    assert.equal(JSON.parse(await readFile(join(f.directory, "backend-recovery.json"), "utf8")).failures, 2);
    f.tick(); await f.manager.recover();
    assert.ok(f.manager.active);
    assert.equal(await f.content(), "A");
  } finally { await f.close(); }
});

test("an unhealthy recovered predecessor has a bounded drain even if a real transfer stalls", async () => {
  const f = await fixture(100_000, undefined, 50);
  try {
    await f.manager.refresh(); const a = f.manager.active;
    f.model.state = "syncing"; await f.failActive();
    const stalled = await f.slow();
    const interrupted = assert.rejects(stalled.text());
    for (let i = 0; i < 3; i++) await f.manager.recover();
    f.tick(); await f.manager.recover();
    assert.notEqual(f.manager.active, a);
    await eventually(() => !f.manager.backends.has(a));
    await interrupted;
    assert.equal(await f.content(), "A");
  } finally { await f.close(); }
});

test("listener shutdown closes real upgrade tunnels and stops the recovery timer", async () => {
  const f = await fixture(25);
  try {
    await f.manager.refresh(); const a = f.manager.active;
    const socket = await f.upgrade();
    const disconnected = once(socket, "close");
    await f.closeServer();
    await disconnected;
    assert.equal(f.manager.active, null);
    assert.equal(f.manager.backends.size, 0);
    assert.ok(a.child.signalCode);
    assert.deepEqual(await readdir(f.snapshots), []);
  } finally { await f.close(); }
});

test("shutdown during the asynchronous permit check cannot launch a child", async () => {
  const f = await fixture();
  try {
    let stopping: Promise<void> | undefined;
    f.onClock(() => { stopping = f.manager.shutdown(); });
    await f.manager.refresh();
    await stopping;
    assert.equal(f.starts, 0, "do not launch and immediately reclaim a child after shutdown");
    assert.equal(f.manager.backends.size, 0);
    assert.equal(f.manager.active, null);
    assert.deepEqual(await readdir(f.snapshots), []);
    assert.equal(await readFile(join(f.directory, "backend-recovery.json"), "utf8").catch(() => ""), "");
  } finally { await f.close(); }
});
