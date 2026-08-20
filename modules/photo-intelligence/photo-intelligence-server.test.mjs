import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Catalog,
  discoverMedia,
  intelligenceServer,
  parseArgs,
  runHashJob,
} from "./photo-intelligence-server.mjs";

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "photo-intelligence-test-"));
  const source = join(temporary, "photos");
  await mkdir(join(source, "2026", "08", "20"), { recursive: true });
  await writeFile(join(source, ".library-sentinel"), "library\n");
  return {
    temporary,
    source,
    catalog: new Catalog(join(temporary, "catalog.sqlite"), source, ".library-sentinel"),
  };
}

test("parses daemon options", () => {
  assert.deepEqual(
    parseArgs(["--source", "/photos", "--state", "/state", "--sentinel", ".catalog"]),
    {
      source: "/photos",
      state: "/state",
      sentinel: ".catalog",
      host: "127.0.0.1",
      port: 3924,
      scanIntervalMs: 15000,
    }
  );
});

test("publishes only stable media and marks deletions after a complete scan", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    const path = join(source, "2026", "08", "20", "photo.jpg");
    await writeFile(path, "photo");
    const first = await discoverMedia(source, ".library-sentinel");
    assert.deepEqual(catalog.reconcile(first), { generation: 1, candidates: 1, present: 0, missing: 0 });
    assert.equal(catalog.timeline().itemCount, 0);

    const second = await discoverMedia(source, ".library-sentinel");
    assert.deepEqual(catalog.reconcile(second), { generation: 2, candidates: 0, present: 1, missing: 0 });
    assert.equal(catalog.timeline().itemCount, 1);

    await rm(path);
    assert.deepEqual(catalog.reconcile(await discoverMedia(source, ".library-sentinel")), {
      generation: 3,
      candidates: 0,
      present: 0,
      missing: 1,
    });
    assert.equal(catalog.timeline().itemCount, 0);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("failed discovery preserves the last complete generation", async () => {
  const { temporary, source, catalog } = await fixture();
  const unavailable = `${source}-unavailable`;
  try {
    await writeFile(join(source, "2026", "08", "20", "photo.jpg"), "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    await rename(source, unavailable);
    await assert.rejects(discoverMedia(source, ".library-sentinel"));
    catalog.scanFailed(new Error("source unavailable"));
    assert.equal(catalog.timeline().itemCount, 1);
    assert.equal(catalog.status().source.state, "degraded");
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("hash jobs bind duplicate content to one asset", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    await writeFile(join(source, "2026", "08", "20", "one.jpg"), "same content");
    await writeFile(join(source, "2026", "08", "20", "two.jpg"), "same content");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    const first = catalog.claimHashJob("test");
    await runHashJob(catalog, first);
    const second = catalog.claimHashJob("test");
    await runHashJob(catalog, second);
    assert.equal(catalog.status().jobs.complete, 2);
    assert.equal(catalog.db.prepare("SELECT count(*) AS count FROM assets").get().count, 1);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a replaced file supersedes stale work before it can commit", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    const path = join(source, "2026", "08", "20", "photo.jpg");
    await writeFile(path, "old");
    let entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    const stale = catalog.claimHashJob("test");

    await writeFile(path, "replacement content");
    entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    assert.equal(catalog.completeHash(stale, "not-the-current-content"), false);
    const replacement = catalog.claimHashJob("test");
    assert.notEqual(replacement.inputFingerprint, stale.inputFingerprint);
    assert.equal(catalog.db.prepare("SELECT count(*) AS count FROM assets").get().count, 0);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an identical location reappearing requeues its cancelled hash", async () => {
  const { temporary, source, catalog } = await fixture();
  const path = join(source, "2026", "08", "20", "photo.jpg");
  const parked = join(temporary, "parked.jpg");
  try {
    await writeFile(path, "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    await rename(path, parked);
    catalog.reconcile(await discoverMedia(source, ".library-sentinel"));
    assert.equal(catalog.status().jobs.cancelled, 1);

    await rename(parked, path);
    catalog.reconcile(await discoverMedia(source, ".library-sentinel"));
    catalog.reconcile(await discoverMedia(source, ".library-sentinel"));
    assert.ok(catalog.claimHashJob("test"));
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("source state gates hashing and missing locations cancel running work", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    const path = join(source, "2026", "08", "20", "photo.jpg");
    await writeFile(path, "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);

    catalog.scanStarted();
    assert.equal(catalog.claimHashJob("test"), null);
    catalog.scanFailed(new Error("source unavailable"));
    assert.equal(catalog.claimHashJob("test"), null);

    catalog.reconcile(entries);
    const running = catalog.claimHashJob("test");
    await rm(path);
    catalog.reconcile(await discoverMedia(source, ".library-sentinel"));
    assert.equal(catalog.status().jobs.cancelled, 1);
    catalog.failJob(running, new Error("file disappeared"));
    assert.equal(catalog.status().jobs.cancelled, 1);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("restart reclaims an interrupted hash job", async () => {
  const { temporary, source, catalog } = await fixture();
  const database = join(temporary, "catalog.sqlite");
  try {
    await writeFile(join(source, "2026", "08", "20", "photo.jpg"), "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    assert.ok(catalog.claimHashJob("first-process"));
    catalog.close();

    const restarted = new Catalog(database, source, ".library-sentinel");
    try {
      assert.ok(restarted.claimHashJob("second-process"));
    } finally {
      restarted.close();
    }
  } finally {
    if (catalog.db.isOpen) catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("serves health, status, and timeline APIs", async () => {
  const { temporary, source, catalog } = await fixture();
  const server = intelligenceServer(catalog);
  try {
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
    assert.equal((await fetch(`${origin}/health/ready`)).status, 503);

    await writeFile(join(source, "2026", "08", "20", "photo.jpg"), "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
    assert.equal((await (await fetch(`${origin}/timeline`)).json()).itemCount, 1);
    assert.equal((await (await fetch(`${origin}/status`)).json()).source.generation, 2);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
