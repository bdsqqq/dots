import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { IncidentStore, type IncidentStoreOptions, type Observation, type Transition } from "./state.ts";

const epoch = 1_790_000_000_000;
function observation(at: number, status: Observation["status"], extra: Partial<Observation> = {}): Observation {
  return {
    key: "disk:host:/", kind: "disk", host: "host", mount: "/", status,
    observedAt: epoch + at, sampleAt: epoch + at, detail: { free: 10 }, ...extra,
  };
}

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "incident-state-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fixture(t: TestContext, options: IncidentStoreOptions = {}) {
  const filename = join(directory(t), "incidents.sqlite");
  let store = new IncidentStore(filename, options);
  t.after(() => store.close());
  return {
    filename,
    get store() { return store; },
    reopen() { store.close(); store = new IncidentStore(filename, options); },
  };
}

function open(store: IncidentStore, at = 0): Transition {
  const transition = store.observe(observation(at, "bad", { critical: true }));
  assert.equal(transition?.action, "Open");
  return transition!;
}

function recover(store: IncidentStore, start: number): Transition {
  for (let at = start; at < start + 600_000; at += 60_000) {
    assert.equal(store.observe(observation(at, "healthy")), null);
  }
  const transition = store.observe(observation(start + 600_000, "healthy"));
  assert.equal(transition?.action, "Closed");
  return transition!;
}

test("ordinary opens need distinct samples and elapsed source and evaluation time", t => {
  const f = fixture(t);
  assert.equal(f.store.observe(observation(0, "bad")), null);
  assert.equal(f.store.observe(observation(30_000, "bad", { sampleAt: epoch })), null);
  assert.equal(f.store.observe(observation(60_000, "bad", { sampleAt: epoch })), null);
  f.reopen();
  const opened = f.store.observe(observation(60_001, "bad"));
  assert.equal(opened?.action, "Open");
  assert.match(opened!.incidentId, /^[\da-f-]{36}$/);
  assert.match(opened!.eventId, /^[\da-f-]{36}$/);
  assert.equal(f.store.observe(observation(60_001, "healthy")), null);
  assert.equal(f.store.observe(observation(1, "bad", { critical: true })), null);
  assert.deepEqual(f.store.pending(), [opened]);
});

test("ordinary opening cannot accelerate by moving only evaluation time", t => {
  const { store } = fixture(t);
  assert.equal(store.observe(observation(0, "bad")), null);
  assert.equal(store.observe(observation(60_000, "bad", { sampleAt: epoch + 1 })), null);
  assert.equal(store.observe(observation(60_001, "bad"))?.action, "Open");
});

test("bad and unknown cycles never flap; real recovery closes once and reopening gets a new id", t => {
  const { store } = fixture(t);
  const opened = open(store);
  for (let n = 1; n <= 125; n++) {
    assert.equal(store.observe(observation(n * 60_000, n % 2 ? "unknown" : "bad", { critical: true })), null);
  }
  assert.deepEqual(store.pending(), [opened]);
  const closed = recover(store, 126 * 60_000);
  assert.equal(closed.incidentId, opened.incidentId);
  assert.notEqual(closed.eventId, opened.eventId);
  assert.equal(store.observe(observation(137 * 60_000, "healthy")), null);
  assert.equal(store.observe(observation(138 * 60_000, "unknown")), null);
  const reopened = open(store, 139 * 60_000);
  assert.notEqual(reopened.incidentId, opened.incidentId);
  assert.deepEqual(store.pending().map(event => event.action), ["Open", "Closed", "Open"]);
});

test("unknown resets near-threshold opening and recovery evidence", t => {
  const { store } = fixture(t);
  store.observe(observation(0, "bad"));
  store.observe(observation(59_999, "unknown"));
  assert.equal(store.observe(observation(60_000, "bad")), null);
  const opened = store.observe(observation(120_000, "bad"));
  assert.equal(opened?.action, "Open");
  for (let at = 180_000; at <= 720_000; at += 60_000) store.observe(observation(at, "healthy"));
  assert.equal(store.observe(observation(779_999, "unknown")), null);
  const closed = recover(store, 780_000);
  assert.equal(closed.incidentId, opened!.incidentId);
});

test("bad interrupts recovery even when its source timestamp is absent", t => {
  const { store } = fixture(t);
  open(store);
  for (let at = 60_000; at <= 600_000; at += 60_000) store.observe(observation(at, "healthy"));
  assert.equal(store.observe(observation(659_999, "bad", { sampleAt: undefined })), null);
  recover(store, 660_000);
});

test("healthy recovery persists over restart, but unknown after restart resets it", t => {
  const f = fixture(t);
  const opened = open(f.store);
  for (let at = 60_000; at <= 600_000; at += 60_000) f.store.observe(observation(at, "healthy"));
  f.reopen();
  assert.equal(f.store.observe(observation(600_000, "healthy")), null);
  assert.equal(f.store.observe(observation(599_999, "healthy")), null);
  assert.equal(f.store.observe(observation(630_000, "unknown", { sampleAt: undefined })), null);
  f.reopen();
  const closed = recover(f.store, 660_000);
  assert.equal(closed.incidentId, opened.incidentId);
});

test("restart and replay without an interruption retain valid recovery", t => {
  const f = fixture(t);
  const opened = open(f.store);
  for (let at = 60_000; at <= 600_000; at += 60_000) f.store.observe(observation(at, "healthy"));
  f.reopen();
  assert.equal(f.store.observe(observation(600_000, "unknown")), null);
  const closed = f.store.observe(observation(660_000, "healthy"));
  assert.equal(closed?.action, "Closed");
  assert.equal(closed!.incidentId, opened.incidentId);
  f.reopen();
  assert.equal(f.store.observe(observation(660_000, "healthy")), null);
  assert.equal(f.store.pending().length, 2);
});

test("a large evaluation gap resets recovery", t => {
  const { store } = fixture(t);
  open(store);
  for (let at = 60_000; at <= 600_000; at += 60_000) store.observe(observation(at, "healthy"));
  recover(store, 720_001);
});

test("a repeated fresh sample preserves evidence but cannot close", t => {
  const { store } = fixture(t, { recoverAfterMs: 120_000 });
  open(store);
  store.observe(observation(60_000, "healthy"));
  assert.equal(store.observe(observation(120_000, "healthy", { sampleAt: epoch + 60_000 })), null);
  assert.equal(store.observe(observation(180_000, "healthy", { sampleAt: epoch + 60_000 })), null);
  assert.equal(store.observe(observation(180_001, "healthy"))?.action, "Closed");
});

test("evaluation time alone cannot establish recovery with slowly advancing source time", t => {
  const { store } = fixture(t, { recoverAfterMs: 120_000 });
  open(store);
  store.observe(observation(60_000, "healthy"));
  store.observe(observation(120_000, "healthy", { sampleAt: epoch + 60_001 }));
  assert.equal(store.observe(observation(180_000, "healthy", { sampleAt: epoch + 60_002 })), null);
  assert.equal(store.observe(observation(180_001, "healthy"))?.action, "Closed");
});

for (const invalid of ["missing", "old", "future", "reordered", "nan"] as const) {
  test(`${invalid} healthy sample resets recovery and never closes`, t => {
    const { store } = fixture(t);
    const opened = open(store);
    for (let at = 60_000; at <= 600_000; at += 60_000) store.observe(observation(at, "healthy"));
    const sampleAt = {
      missing: undefined, old: epoch + 359_999, future: epoch + 720_001,
      reordered: epoch + 599_999, nan: NaN,
    }[invalid];
    assert.equal(store.observe(observation(660_000, "healthy", { sampleAt })), null);
    assert.deepEqual(store.pending(), [opened]);
    recover(store, 720_000);
  });
}

test("a repeated sample that becomes too old resets recovery", t => {
  const { store } = fixture(t, { sourceMaxAgeMs: 120_000 });
  open(store);
  store.observe(observation(60_000, "healthy"));
  store.observe(observation(120_000, "healthy", { sampleAt: epoch + 60_000 }));
  store.observe(observation(180_000, "healthy", { sampleAt: epoch + 60_000 }));
  store.observe(observation(180_001, "healthy", { sampleAt: epoch + 60_000 }));
  recover(store, 240_000);
});

test("critical opens are immediate without a sample, but supplied stale/future bad samples are unknown", t => {
  const { store } = fixture(t);
  assert.equal(store.observe(observation(0, "bad", { critical: true, sampleAt: epoch - 300_001 })), null);
  assert.equal(store.observe(observation(1, "bad", { critical: true, sampleAt: epoch + 60_002 })), null);
  assert.equal(store.observe(observation(2, "bad", { critical: true, sampleAt: undefined }))?.action, "Open");
});

test("ordinary bad without a sample never opens; configurable freshness supports the guard", t => {
  const { store } = fixture(t, { sourceMaxAgeMs: 900_000 });
  store.observe(observation(0, "bad", { sampleAt: undefined }));
  assert.equal(store.observe(observation(60_000, "bad", { sampleAt: undefined })), null);
  store.seedOpen(observation(1, "bad", { key: "guard" }));
  for (let at = 120_000; at < 720_000; at += 60_000) {
    assert.equal(store.observe(observation(at, "healthy", { key: "guard", sampleAt: epoch + at - 600_000 })), null);
  }
  // Older than the seed's source sample is reordered evidence, even within the larger age allowance.
  assert.equal(store.pending().length, 0);
  const other = "guard-with-lag";
  store.seedOpen(observation(0, "bad", { key: other, sampleAt: undefined }));
  for (let at = 60_000; at < 660_000; at += 60_000) {
    assert.equal(store.observe(observation(at, "healthy", { key: other, sampleAt: epoch + at - 600_000 })), null);
  }
  assert.equal(store.observe(observation(660_000, "healthy", { key: other, sampleAt: epoch + 60_000 }))?.action, "Closed");
});

test("bootstrap queues no open, is idempotent, and does not overwrite existing local state", t => {
  const f = fixture(t);
  f.store.seedOpen(observation(0, "bad"));
  f.store.seedOpen(observation(60_000, "bad"));
  assert.deepEqual(f.store.pending(), []);
  f.reopen();
  const closed = recover(f.store, 60_000);
  assert.deepEqual(f.store.pending(), [closed]);
  f.store.seedOpen(observation(720_000, "bad"));
  assert.equal(f.store.observe(observation(720_000, "healthy")), null);
  assert.equal(f.store.pending().length, 1);
});

test("merged disk conditions share a lifecycle; independent keys remain independent", t => {
  const { store } = fixture(t);
  const opened = store.observe(observation(0, "bad", { critical: true, detail: { condition: "bytes" } }));
  assert.equal(store.observe(observation(60_000, "bad", { critical: true, detail: { condition: "inodes" } })), null);
  assert.equal(store.observe(observation(120_000, "bad", { critical: true, detail: { condition: "forecast" } })), null);
  const other = store.observe(observation(0, "bad", { key: "disk:other:/", host: "other", critical: true }));
  assert.notEqual(other!.incidentId, opened!.incidentId);
  assert.equal(store.pending().length, 2);
});

test("outbox attempts and acknowledgments survive restart; only one claimant may send", t => {
  const f = fixture(t);
  const opened = open(f.store);
  f.reopen();
  assert.deepEqual(f.store.pending(), [opened]);
  f.store.acknowledge(opened.eventId);
  assert.deepEqual(f.store.pending(), [opened], "unattempted events cannot be acknowledged");
  f.store.noteAttempt(opened.eventId);
  const competitor = new IncidentStore(f.filename);
  try { assert.throws(() => competitor.noteAttempt(opened.eventId), /already attempted/); }
  finally { competitor.close(); }
  f.reopen();
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.store.uncertain(), [opened]);
  assert.throws(() => f.store.noteAttempt("missing"), /missing/);
  f.store.acknowledge(opened.eventId);
  f.store.acknowledge(opened.eventId);
  f.reopen();
  assert.deepEqual(f.store.pending(), []);
  assert.deepEqual(f.store.uncertain(), []);
  assert.throws(() => f.store.noteAttempt(opened.eventId), /already attempted/);
  assert.equal(recover(f.store, 60_000).incidentId, opened.incidentId);
});

test("incident write failure rolls back its outbox insertion; outbox failure preserves lifecycle", t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.filename);
  try {
    db.exec("CREATE TRIGGER fail_state BEFORE INSERT ON incidents BEGIN SELECT RAISE(ABORT, 'fixture state failure'); END");
    assert.throws(() => f.store.observe(observation(0, "bad", { critical: true })), /fixture state failure/);
    assert.deepEqual(f.store.pending(), []);
    db.exec("DROP TRIGGER fail_state");
    const opened = open(f.store);
    for (let at = 60_000; at <= 600_000; at += 60_000) f.store.observe(observation(at, "healthy"));
    db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'fixture outbox failure'); END");
    assert.throws(() => f.store.observe(observation(660_000, "healthy")), /fixture outbox failure/);
    assert.deepEqual(f.store.pending(), [opened]);
    db.exec("DROP TRIGGER fail_outbox");
    f.reopen();
    const closed = f.store.observe(observation(660_000, "healthy"));
    assert.equal(closed?.action, "Closed");
    assert.equal(closed!.incidentId, opened.incidentId);
  } finally { db.close(); }
});

test("sqlite full propagates without committing an incident or transition", t => {
  const f = fixture(t);
  // Constrain only this fixture connection, without filling the host filesystem.
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  const pages = db.prepare("PRAGMA page_count").get()!.page_count;
  db.exec(`PRAGMA max_page_count = ${pages}`);
  assert.throws(() => f.store.observe(observation(0, "bad", {
    critical: true, detail: { large: "x".repeat(1_000_000) },
  })), /database or disk is full/);
  assert.deepEqual(f.store.pending(), []);
  f.reopen();
  assert.deepEqual(f.store.pending(), []);
  open(f.store);
});

test("wrong, empty, incompatible, and corrupt existing databases fail closed", t => {
  const dir = directory(t);
  for (const [name, content] of [["empty", ""], ["corrupt", "not a sqlite database"]]) {
    const filename = join(dir, name);
    writeFileSync(filename, content);
    assert.throws(() => new IncidentStore(filename));
  }
  const wrong = join(dir, "wrong");
  const db = new DatabaseSync(wrong);
  db.exec("CREATE TABLE unrelated (id INTEGER)");
  db.close();
  assert.throws(() => new IncidentStore(wrong), /schema/);
  const f = fixture(t);
  const incompatible = new DatabaseSync(f.filename);
  incompatible.exec("PRAGMA user_version = 2");
  incompatible.close();
  assert.throws(() => new IncidentStore(f.filename), /schema/);
});

test("sqlite uniqueness forbids duplicate actions for one incident", t => {
  const f = fixture(t);
  const opened = open(f.store);
  const db = new DatabaseSync(f.filename);
  try {
    assert.throws(() => db.prepare("INSERT INTO outbox (eventId, incidentId, action, delivery, payload) VALUES (?, ?, 'Open', 'queued', '{}')")
      .run("another-event", opened.incidentId), /UNIQUE/);
  } finally { db.close(); }
});

test("the no-close-on-unknown verifier rejects a naive implementation", t => {
  function verify(observe: (o: Observation) => { action: string } | null): void {
    assert.equal(observe(observation(0, "bad", { critical: true }))?.action, "Open");
    for (let n = 1; n <= 125; n++) {
      assert.equal(observe(observation(n * 60_000, n % 2 ? "unknown" : "bad")), null,
        "unknown and repeated bad must preserve the open incident");
    }
  }
  const { store } = fixture(t);
  verify(o => store.observe(o));
  let isOpen = false;
  assert.throws(() => verify(o => {
    if (o.status === "bad" && !isOpen) { isOpen = true; return { action: "Open" }; }
    if (o.status !== "bad" && isOpen) { isOpen = false; return { action: "Closed" }; }
    return null;
  }), /unknown and repeated bad/);
});
