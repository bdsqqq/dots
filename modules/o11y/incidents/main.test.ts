import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Axiom } from "./axiom.ts";
import { IncidentStore } from "./state.ts";
import { main } from "./main.ts";
import { createEventLogger, type ServiceEvent } from "../../service-events/events.ts";

test("evaluation completion carries outcome, timing and counts without credentials or raw errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incident-events-"));
  const previous = process.exitCode;
  try {
    const rulesPath = join(directory, "rules.json");
    await writeFile(rulesPath, "[]");
    const database = join(directory, "incidents.sqlite");
    new IncidentStore(database).close();
    const config = { disks: {}, rulesPath, database };
    const records: ServiceEvent[] = [];
    const events = createEventLogger("host-incidents", { sink: event => records.push(event) });
    const client = new Axiom({ query: "secret-query", ingest: "secret-ingest", org: "secret-org" }, async url => {
      return new Response(JSON.stringify(String(url).includes("/ingest") ? { ingested: 1, failed: 0 } : { series: [] }));
    });
    await main("poll", config, client, events);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "incidents.evaluate");
    assert.equal(records[0].outcome, "succeeded");
    assert.equal(records[0].context.observationCount, 0);
    assert.equal(records[0].context.queryErrorCount, 0);
    assert.equal(records[0].context.transitionCount, 0);
    assert.equal(records[0].context.ready, true);
    assert.ok(!JSON.stringify(records).includes("secret"));

    const offline = new Axiom({ query: "secret-query", ingest: "secret-ingest", org: "secret-org" }, async () => {
      throw new Error("private transport detail and secret-query");
    });
    await assert.rejects(main("poll", config, offline, events));
    assert.equal(records.length, 2);
    assert.equal(records[1].outcome, "failed");
    assert.equal(records[1].context.queryErrorCount, 1);
    assert.equal(records[1].context.errorCode, "UNEXPECTED_ERROR");
    assert.ok(!JSON.stringify(records).includes("private transport"));
    assert.ok(!JSON.stringify(records).includes(directory));
    assert.ok(!JSON.stringify(records).includes("secret"));
  } finally {
    process.exitCode = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a disk condition no host declares any more closes as no longer monitored; other kinds wait for measurement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incident-retire-"));
  try {
    const rulesPath = join(directory, "rules.json");
    await writeFile(rulesPath, "[]");
    const database = join(directory, "incidents.sqlite");
    const seed = new IncidentStore(database);
    const at = Date.now() - 60_000;
    const disk = JSON.stringify(["hosts: filesystem nearly full (below 10% free)", "laptop.local", "/System/Volumes/Data"]);
    const other = JSON.stringify(["hosts: service readiness (hue)", "mmn-m4"]);
    for (const key of [disk, other]) {
      const opened = seed.observe({ key, kind: JSON.parse(key)[0], host: JSON.parse(key)[1], status: "bad", critical: true, observedAt: at, sampleAt: at, detail: {} })!;
      // both opens were already delivered; only the retirement is new.
      seed.noteAttempt(opened.eventId, at);
      seed.acknowledge(opened.eventId);
    }
    seed.close();
    const ingested: any[] = [];
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async (url, init) => {
      if (String(url).includes("/ingest")) { ingested.push(...JSON.parse(init!.body as string)); return Response.json({ ingested: 1, failed: 0 }); }
      return Response.json({ series: [] });
    });
    await main("poll", { disks: {}, rulesPath, database }, client, createEventLogger("host-incidents", { sink: () => {} }));
    const closed = ingested.filter(event => event.source === "host-incidents");
    assert.equal(closed.length, 1);
    assert.equal(closed[0].action, "Closed");
    assert.equal(closed[0].condition, "hosts: filesystem nearly full (below 10% free)");
    assert.match(closed[0].title, /^no longer monitored:/);
    const store = new IncidentStore(database);
    try { assert.deepEqual(store.openKeys(), [other]); } finally { store.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test("init adopts conditions that open immediately, never ones that must still earn their open by duration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incident-init-"));
  try {
    const rulesPath = join(directory, "rules.json");
    await writeFile(rulesPath, "[]");
    const database = join(directory, "incidents.sqlite");
    const GiB = 1024 ** 3;
    const at = Date.now() - 30_000;
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => Response.json({ series: [
      { tags: { "host.name": "server", mountpoint: "/" }, start: at / 1000, resolution: 30, data: [GiB] },
      { tags: { "host.name": "laptop.local", mountpoint: "/System/Volumes/Data" }, start: at / 1000, resolution: 30, data: [GiB] },
    ] }));
    const disks = {
      server: { profile: "server", mounts: { "/": { critical: { below: 2 * GiB, recover: 3 * GiB, afterMinutes: 0 }, low: null, capacity: null } } },
      "laptop.local": { profile: "workstation", mounts: { "/System/Volumes/Data": { critical: { below: 2 * GiB, recover: 3 * GiB, afterMinutes: 30 }, low: null, capacity: null } } },
    };
    const log = console.log;
    console.log = () => {};
    try { await main("init", { disks, rulesPath, database }, client, createEventLogger("host-incidents", { sink: () => {} })); }
    finally { console.log = log; }
    const store = new IncidentStore(database);
    try { assert.deepEqual(store.openKeys().map(key => JSON.parse(key)[1]), ["server"]); } finally { store.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test("a mounts-only config never retires a disk incident, since it can't express every declared level", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incident-no-retire-"));
  try {
    const rulesPath = join(directory, "rules.json");
    await writeFile(rulesPath, "[]");
    const database = join(directory, "incidents.sqlite");
    const seed = new IncidentStore(database);
    const at = Date.now() - 60_000;
    const key = JSON.stringify(["hosts: storage capacity running low", "relay", "/mnt/storage-01"]);
    const opened = seed.observe({ key, kind: "hosts: storage capacity running low", host: "relay", mount: "/mnt/storage-01", status: "bad", critical: true, observedAt: at, sampleAt: at, detail: {} })!;
    seed.noteAttempt(opened.eventId, at);
    seed.acknowledge(opened.eventId);
    seed.close();
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async url =>
      Response.json(String(url).includes("/ingest") ? { ingested: 1, failed: 0 } : { series: [] }));
    await main("poll", { mounts: { relay: ["/", "/mnt/storage-01"] }, rulesPath, database }, client, createEventLogger("host-incidents", { sink: () => {} }));
    const store = new IncidentStore(database);
    try { assert.deepEqual(store.openKeys(), [key]); } finally { store.close(); }
  } finally { await rm(directory, { recursive: true }); }
});
