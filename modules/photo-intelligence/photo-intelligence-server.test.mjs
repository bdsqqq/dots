import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  Catalog,
  discoverMedia,
  intelligenceServer,
  migrate,
  parseArgs,
  runHashJob,
  scanLoop,
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
      scanIntervalMs: 600000,
      settleIntervalMs: 15000,
      watchDebounceMs: 2000,
      retryIntervalMs: 15000,
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
    const items = catalog.timeline().groups[0].items;
    assert.match(items[0].mediaId, /^med_[A-Za-z0-9_-]{24}$/);
    assert.equal(items[0].mediaId, items[1].mediaId);
    assert.equal(items[0].dateSource, "path");
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
    assert.notEqual(replacement.inputKey, stale.inputKey);
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
    const interrupted = catalog.claimHashJob("first-process");
    assert.ok(interrupted);
    catalog.close();

    const restarted = new Catalog(database, source, ".library-sentinel");
    try {
      const reclaimed = restarted.claimHashJob("second-process");
      assert.ok(reclaimed);
      assert.notEqual(reclaimed.leaseToken, interrupted.leaseToken);
    } finally {
      restarted.close();
    }
  } finally {
    if (catalog.db.isOpen) catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an expired lease cannot commit or fail replacement work", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    await writeFile(join(source, "2026", "08", "20", "photo.jpg"), "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    const expired = catalog.claimHashJob("expired-worker");
    catalog.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      expired.id
    );
    assert.equal(catalog.completeHash(expired, "stale"), false);
    assert.equal(catalog.failJob(expired, new Error("stale failure")), false);
    assert.equal(catalog.status().jobs.running, 1);
    assert.equal(catalog.db.prepare("SELECT count(*) AS count FROM assets").get().count, 0);
    const replacement = catalog.claimHashJob("replacement-worker");
    assert.notEqual(replacement.leaseToken, expired.leaseToken);
    assert.equal(catalog.completeHash(expired, "still-stale"), false);
    assert.equal(catalog.status().jobs.running, 1);
    assert.equal(catalog.completeHash(replacement, "current"), true);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("hash worker claims only its current supported stage spec", async () => {
  const { temporary, source, catalog } = await fixture();
  try {
    await writeFile(join(source, "2026", "08", "20", "photo.jpg"), "photo");
    const entries = await discoverMedia(source, ".library-sentinel");
    catalog.reconcile(entries);
    catalog.reconcile(entries);
    const now = new Date().toISOString();
    catalog.db.prepare(`
      INSERT INTO stage_specs
        (stage, spec_key, adapter_version, model_digest, config_digest, schema_version, created_at)
      VALUES ('thumbnail', 'thumbnail-test', 'test-v1', NULL, 'test', 1, ?)
    `).run(now);
    const location = catalog.db.prepare(`
      SELECT id, input_fingerprint AS inputKey FROM locations LIMIT 1
    `).get();
    const thumbnailSpec = catalog.db.prepare(`
      SELECT id FROM stage_specs WHERE spec_key = 'thumbnail-test'
    `).get();
    catalog.db.exec("UPDATE jobs SET state = 'cancelled' WHERE state = 'queued'");
    catalog.db.prepare(`
      INSERT INTO jobs
        (location_id, stage_spec_id, input_fingerprint, input_key, state,
         available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(location.id, thumbnailSpec.id, location.inputKey, location.inputKey, now, now, now);
    assert.equal(catalog.claimHashJob("hash-worker"), null);

    catalog.db.prepare(`
      INSERT INTO stage_specs
        (stage, spec_key, adapter_version, model_digest, config_digest, schema_version, created_at)
      VALUES ('content-hash', 'sha512-test', 'node-crypto-sha512-v1', NULL, 'sha512', 1, ?)
    `).run(now);
    const unsupported = catalog.db.prepare(`
      SELECT id FROM stage_specs WHERE spec_key = 'sha512-test'
    `).get();
    catalog.db.prepare(`
      UPDATE pipeline_slots SET stage_spec_id = ?, updated_at = ?
      WHERE slot = 'content-hash/current'
    `).run(unsupported.id, now);
    assert.throws(() => catalog.claimHashJob("hash-worker"), /unsupported by this worker/);
  } finally {
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("migrates v1 catalogs to immutable typed schema", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "photo-intelligence-v1-test-"));
  const path = join(temporary, "catalog.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY, hash_algorithm TEXT NOT NULL, content_hash TEXT NOT NULL,
        size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE locations (
        id INTEGER PRIMARY KEY, media_date TEXT NOT NULL
      );
      CREATE TABLE stage_specs (
        id INTEGER PRIMARY KEY, stage TEXT NOT NULL, spec_key TEXT NOT NULL UNIQUE,
        adapter_version TEXT NOT NULL, model_digest TEXT, config_digest TEXT NOT NULL,
        schema_version INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE artifacts (
        id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, stage_spec_id INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY, location_id INTEGER, asset_id INTEGER, stage_spec_id INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL, state TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT
      );
      INSERT INTO assets VALUES (1, 'sha256', 'digest', 4, '2026-08-20T00:00:00.000Z');
      INSERT INTO locations VALUES (1, '2026-08-20');
      INSERT INTO stage_specs VALUES
        (1, 'content-hash', 'sha256-v1', 'node-crypto-sha256-v1', NULL, 'sha256', 1, 1);
      INSERT INTO artifacts VALUES (1, 1, 1, 'asset-input');
      INSERT INTO jobs VALUES (1, 1, NULL, 1, 'job-input', 'complete', NULL, NULL);
      PRAGMA user_version = 1;
    `);
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.match(db.prepare("SELECT media_id AS mediaId FROM assets").get().mediaId, /^med_[A-Za-z0-9_-]{24}$/);
    assert.equal(db.prepare("SELECT input_key AS inputKey FROM artifacts").get().inputKey, "asset-input");
    assert.equal(db.prepare("SELECT input_key AS inputKey FROM jobs").get().inputKey, "job-input");
    assert.equal(
      db.prepare("SELECT slot FROM pipeline_slots").get().slot,
      "content-hash/current"
    );
    assert.throws(() => db.exec("UPDATE stage_specs SET active = 0"), /stage specs are immutable/);
    assert.throws(() => db.exec("UPDATE artifacts SET input_key = 'changed'"), /input_key is immutable/);
    assert.throws(() => db.exec("UPDATE jobs SET input_key = 'changed'"), /input_key is immutable/);
    assert.throws(() => db.prepare(`
      INSERT INTO jobs
        (id, location_id, asset_id, stage_spec_id, input_fingerprint, input_key, state)
      VALUES (2, 1, NULL, 1, 'different-legacy-value', 'job-input', 'queued')
    `).run(), /UNIQUE constraint failed/);
    db.prepare(`
      INSERT INTO stage_specs
        (stage, spec_key, adapter_version, model_digest, config_digest, schema_version, created_at)
      VALUES ('image-embedding', 'clip-test', 'hf-worker-v1', 'model-sha', 'config-sha', 1, ?)
    `).run("2026-08-20T00:00:00.000Z");
    const embeddingSpecId = db.prepare("SELECT id FROM stage_specs WHERE spec_key = 'clip-test'").get().id;
    assert.throws(() => db.prepare(`
      INSERT INTO embedding_contracts (stage_spec_id, element_type, dimensions, created_at)
      VALUES (?, 'float32-le', 1.5, '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId), /cannot store REAL value in INTEGER column/);
    db.prepare(`
      INSERT INTO embedding_contracts (stage_spec_id, element_type, dimensions, created_at)
      VALUES (?, 'float32-le', 1, '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId);
    assert.throws(() => db.prepare(`
      INSERT INTO embeddings
        (asset_id, stage_spec_id, input_key, element_type, dimensions, vector, created_at)
      VALUES (1, ?, 'short', 'float32-le', 1, ?, '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId, Buffer.alloc(3)), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`
      INSERT INTO embeddings
        (asset_id, stage_spec_id, input_key, element_type, dimensions, vector, created_at)
      VALUES (1, ?, 'text', 'float32-le', 1, 'abcd', '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId), /cannot store TEXT value in BLOB column/);
    assert.throws(() => db.prepare(`
      INSERT INTO embeddings
        (asset_id, stage_spec_id, input_key, element_type, dimensions, vector, created_at)
      VALUES (1, ?, 'mixed', 'float32-le', 2, ?, '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId, Buffer.alloc(8)), /FOREIGN KEY constraint failed/);
    db.prepare(`
      INSERT INTO embeddings
        (asset_id, stage_spec_id, input_key, element_type, dimensions, vector, created_at)
      VALUES (1, ?, 'key', 'float32-le', 1, ?, '2026-08-20T00:00:00.000Z')
    `).run(embeddingSpecId, Buffer.alloc(4));
    assert.throws(
      () => db.exec("UPDATE embeddings SET vector = zeroblob(4)"),
      /embeddings are immutable/
    );
    assert.throws(() => db.exec("DELETE FROM embeddings"), /embeddings are immutable/);
  } finally {
    db.close();
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

test("filesystem hints debounce scans and candidates receive a settling scan", async () => {
  const { temporary, source, catalog } = await fixture();
  const abort = new AbortController();
  const watcher = new EventEmitter();
  watcher.close = () => {};
  let notify;
  const watcherFactory = (_source, options, listener) => {
    assert.deepEqual(options, { recursive: true });
    notify = listener;
    return watcher;
  };
  const config = {
    source,
    sentinel: ".library-sentinel",
    scanIntervalMs: 60_000,
    settleIntervalMs: 20,
    watchDebounceMs: 10,
    retryIntervalMs: 10,
  };
  await writeFile(join(source, "2026", "08", "20", "one.jpg"), "one");
  const loop = scanLoop(config, catalog, abort.signal, watcherFactory);
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.fail("condition was not reached");
  };
  try {
    await waitFor(() => catalog.timeline().itemCount === 1);
    const settledGeneration = catalog.status().source.generation;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    assert.equal(catalog.status().source.generation, settledGeneration);

    await writeFile(join(source, "2026", "08", "20", "two.jpg"), "two");
    notify();
    notify();
    await waitFor(() => catalog.timeline().itemCount === 2);
    assert.equal(catalog.status().source.generation, settledGeneration + 2);
  } finally {
    abort.abort();
    await loop;
    catalog.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
