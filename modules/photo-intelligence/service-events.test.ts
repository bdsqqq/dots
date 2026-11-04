import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServiceEvent } from "../service-events/events.ts";
import { Catalog, discoverMedia, intelligenceServer, jobLoop, scanLoop } from "./photo-intelligence-server.mjs";

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
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY|secret-query|authorization|\.jpg|med_/);
  return records;
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("event or state did not arrive");
}
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "intelligence-events-"));
  const source = join(temporary, "PRIVATE_CANARY");
  await mkdir(source);
  await writeFile(join(source, ".sentinel"), "PRIVATE_CANARY");
  const catalog = new Catalog(join(temporary, "catalog.sqlite"), source, ".sentinel");
  return { temporary, source, catalog, async close() { catalog.close(); await rm(temporary, { recursive: true, force: true }); } };
}

test("real HTTP responses retain readiness policy and record browser/probe distinctions privately", async () => {
  const fixture_ = await fixture();
  const { catalog } = fixture_;
  const server = intelligenceServer(catalog);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await capture(async (records) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${origin}/health/ready`, { headers: { "user-agent": "Mozilla/5.0" } })).status, 503);
      for (const agent of ["Mozilla/5.0", "tailnet-registry/1", "cloudflare-origin-probe/1"]) {
        const response = await fetch(`${origin}/timeline?secret-query=PRIVATE_CANARY`, { headers: { "user-agent": agent, authorization: "PRIVATE_CANARY" } });
        assert.equal(response.status, 200); await response.text();
      }
      assert.equal((await fetch(`${origin}/status?PRIVATE_CANARY`, { method: "POST", body: "PRIVATE_CANARY" })).status, 405);
      assert.equal((await fetch(`${origin}/PRIVATE_CANARY.jpg`)).status, 404);
      catalog.reconcile([]);
      catalog.scanFailed(new Error("PRIVATE_CANARY"));
      const response = await fetch(`${origin}/health/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "degraded" });
      assert.deepEqual(records.slice(0, 4).map((event) => event.traffic), ["probe", "browser", "probe", "probe"]);
      assert.equal(records.at(-1).outcome, "degraded");
      assert.equal(records.at(-1).context.ready, true);
      assert.equal(records.at(-1).context.readiness, "degraded");
      assert.equal(records.length, 7);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    await fixture_.close();
  }
});

test("scan loop records recurring missing-source attempts, recovery and watcher failures without stacks", async () => {
  const fixture_ = await fixture();
  const { catalog, source } = fixture_;
  const abort = new AbortController();
  let loop;
  try {
    await writeFile(join(source, "PRIVATE_CANARY.jpg"), "private-photo-content");
    const entries = await discoverMedia(source, ".sentinel");
    catalog.reconcile(entries); catalog.reconcile(entries);
    await rm(join(source, ".sentinel"));
    await capture(async (records) => {
      let watcher;
      const watcherFactory = () => {
        watcher = new EventEmitter(); watcher.close = () => {};
        return watcher;
      };
      const config = { source, sentinel: ".sentinel", retryIntervalMs: 10, scanIntervalMs: 60_000, settleIntervalMs: 10, watchDebounceMs: 5 };
      loop = scanLoop(config, catalog, abort.signal, watcherFactory);
      await waitFor(() => records.filter((event) => event.operation === "source.scan").length >= 2);
      const failures = records.filter((event) => event.operation === "source.scan");
      assert.equal(catalog.status().source.generation, 2);
      assert.equal(catalog.timeline().itemCount, 1);
      assert.equal(catalog.status().source.state, "degraded");
      assert.deepEqual(failures.slice(0, 2).map((event) => event.context.attempt), [1, 2]);
      assert.ok(failures.every((event) => event.context.errorCode === "ENOENT" && event.context.reasonCode === "SOURCE_UNAVAILABLE" && event.context.sourceAvailable === false && event.context.retryInMs === 10));
      await writeFile(join(source, ".sentinel"), "PRIVATE_CANARY");
      await waitFor(() => catalog.status().source.state === "ready" && watcher);
      assert.ok(records.some((event) => event.operation === "source.scan" && event.outcome === "succeeded" && event.context.sourceAvailable === true));
      watcher.emit("error", Object.assign(new Error("PRIVATE_CANARY"), { code: "EIO" }));
      await waitFor(() => records.filter((event) => event.operation === "source.watch").length === 2);
      assert.ok(records.some((event) => event.operation === "source.watch_failure" && event.context.errorCode === "EIO" && event.context.retryInMs === 10));
      abort.abort(); await loop;
    });
  } finally { abort.abort(); await loop; await fixture_.close(); }
});

test("actual hash worker records successful indexing, retry and attempt exhaustion without media identity", async () => {
  const fixture_ = await fixture();
  const { source, catalog } = fixture_;
  const abort = new AbortController();
  let loop;
  try {
    await writeFile(join(source, "a-PRIVATE_CANARY.jpg"), "private-photo-content");
    await writeFile(join(source, "b-PRIVATE_CANARY.jpg"), "private-photo-content-2");
    const entries = await discoverMedia(source, ".sentinel");
    catalog.reconcile(entries); catalog.reconcile(entries);
    await rm(join(source, "b-PRIVATE_CANARY.jpg"));
    await capture(async (records) => {
      loop = jobLoop(catalog, abort.signal);
      await waitFor(() => records.length === 2);
      abort.abort(); await loop;
      assert.equal(records[0].outcome, "succeeded");
      assert.equal(records[1].outcome, "failed");
      assert.equal(records[1].context.errorCode, "ENOENT");
      assert.equal(records[1].context.reasonCode, "RETRY_SCHEDULED");
      assert.equal(records[1].context.retryInMs, 2000);
      catalog.db.prepare("UPDATE jobs SET attempts = 4, available_at = ? WHERE state = 'queued'").run(new Date(0).toISOString());
      const secondAbort = new AbortController();
      const secondLoop = jobLoop(catalog, secondAbort.signal);
      try {
        await waitFor(() => records.length === 3);
      } finally { secondAbort.abort(); await secondLoop; }
      assert.equal(records[2].context.attempt, 5);
      assert.equal(records[2].context.reasonCode, "ATTEMPTS_EXHAUSTED");
      assert.equal(records[2].context.retryInMs, undefined);
      assert.equal(catalog.status().jobs.failed, 1);
    });
  } finally { abort.abort(); await loop; await fixture_.close(); }
});
