import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Axiom, logSampleTime, metricObservation, metricSeries, notification, observations, type Rule } from "./axiom.ts";
import { IncidentStore } from "./state.ts";
import { deliver } from "./delivery.ts";

const now = 1_800_000_000_000;
const GiB = 1024 ** 3;
const rule: Rule = { name: "hosts: low disk headroom (below 8 GiB)", type: "Threshold", threshold: 8 * GiB, rangeMinutes: 5, mplQuery: "disk | align using min" };
const relative = { ...rule, name: "hosts: filesystem nearly full (below 10% free)", threshold: 0.1 };
const observe = (value: number, at = now - 30_000, condition = rule) => metricObservation(condition, "host", "/", [{ value, at }], now);

test("disk recovery has hysteresis and never treats absent, stale, or invalid readings as healthy", () => {
  assert.equal(observe(7 * GiB).status, "bad");
  assert.equal(observe(9 * GiB).status, "unknown");
  assert.equal(observe(10 * GiB).status, "healthy");
  assert.equal(observe(10 * GiB, now - 180_000).status, "unknown");
  assert.equal(observe(-1).status, "unknown");
  assert.equal(observe(0.09, undefined, relative).status, "bad");
  assert.equal(observe(0.11, undefined, relative).status, "unknown");
  assert.equal(observe(0.12, undefined, relative).status, "healthy");
  assert.equal(observe(1.1, undefined, relative).status, "unknown");
  assert.equal(metricObservation(rule, "host", "/", [], now).status, "unknown");
});

test("metrics-v2 timestamps come from actual occupied buckets, not query-end or summary", () => {
  const result = metricSeries({ series: [{ tags: { "host.name": "host" }, start: now / 1000 - 90, resolution: 30, data: [2, null, 4, 1000], summary: 9999 }] }, now - 120_000, now);
  assert.deepEqual(result[0].points, [{ at: now - 90_000, value: 2 }, { at: now - 30_000, value: 4 }]);
  for (const broken of [{}, { series: null }, { series: [], status: { isPartial: true } }, { series: [{ tags: {}, start: 1, resolution: 1, data: ["4"] }] }]) assert.throws(() => metricSeries(broken, 0, now));
});

test("log sample timestamps normalize both native wire formats without parsing numeric text as a date", () => {
  assert.equal(logSampleTime(now * 1_000_000), now);
  assert.equal(logSampleTime(new Date(now).toISOString()), now);
  for (const invalid of [null, undefined, NaN, Infinity, "1.8e18"]) assert.ok(Number.isNaN(logSampleTime(invalid)));
});

test("Axiom ingest validates accepted counts and redacts arbitrary API failure content", async () => {
  for (const result of [{ ingested: 0, failed: 0 }, { ingested: 1, failed: 1 }, { ingested: 1 }]) {
    const client = new Axiom({ query: "private", ingest: "private", org: "private" }, async () => Response.json(result));
    await assert.rejects(client.ingest({}), /not fully accepted/);
  }
  const client = new Axiom({ query: "private", ingest: "private", org: "private" }, async () => new Response("private-secret-host-log", { status: 500 }));
  await assert.rejects(client.ingest({}), error => error instanceof Error && error.message === "axiom HTTP 500");
});

test("a real scalar count of zero is read from totals, not mistaken for missing data", async () => {
  const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => Response.json({
    status: { isPartial: false }, matches: [],
    buckets: { totals: [{ group: {}, aggregations: [{ op: "accepted", value: 0 }] }] },
  }));
  assert.deepEqual(await client.rows("| summarize accepted = count()", now - 60_000, now), [{ accepted: 0 }]);
  const store = new IncidentStore(":memory:");
  try { assert.equal(await client.accepted(opening(store, "fixture"), now), false); }
  finally { store.close(); }
});

test("grouped empty aggregates are not host rows, but actual group totals remain visible", async () => {
  for (const present of [false, true]) {
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => Response.json({
      status: { isPartial: false }, matches: [], request: { groupBy: ["host"] },
      buckets: { totals: [{ group: present ? { host: "host" } : {}, aggregations: [
        { op: "kills", value: present ? 1 : 0 }, { op: "sampled_at", value: present ? new Date(now).toISOString() : null },
      ] }] },
    }));
    const rows = await client.rows("| summarize kills = count(), sampled_at = max(_time) by host", now - 60_000, now);
    assert.deepEqual(rows, present ? [{ host: "host", kills: 1, sampled_at: new Date(now).toISOString() }] : []);
  }
});

test("independent lab availability policy uses fresh uptime and never sends raw notifications", async () => {
  const policies: (Rule & { notifierIds: string[] })[] = JSON.parse(readFileSync(new URL("../monitors.json", import.meta.url), "utf8"));
  const policy = policies.find(p => p.name === "hosts: telemetry missing (htz-lab)");
  assert.ok(policy);
  assert.deepEqual(policy.notifierIds, []);
  assert.equal(policy.rangeMinutes, 15);
  const directory = mkdtempSync(join(tmpdir(), "lab-availability-"));
  const rulesPath = join(directory, "rules.json");
  writeFileSync(rulesPath, JSON.stringify([policy]));
  try {
    for (const present of [true, false]) {
      const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => Response.json({
        series: present ? [{ tags: { "host.name": "htz-lab" }, start: now / 1000 - 30, resolution: 30, data: [123] }] : [],
      }));
      const result = await observations(client, { mounts: { "htz-lab": ["/"] }, rulesPath }, now);
      assert.deepEqual(result.errors, []);
      assert.equal(result.observations.length, 1);
      assert.equal(result.observations[0].host, "htz-lab");
      assert.equal(result.observations[0].status, present ? "healthy" : "bad");
    }
  } finally { rmSync(directory, { recursive: true }); }
});

function fixtureRules() {
  const directory = mkdtempSync(join(tmpdir(), "incident-adapter-"));
  const rulesPath = join(directory, "rules.json");
  writeFileSync(rulesPath, JSON.stringify([rule, relative,
    { name: "hosts: telemetry missing (host)", type: "Threshold", mplQuery: '`host.name` == "host"' },
    { name: "hosts: kernel killed a process for lack of memory", type: "Threshold" },
    { name: "hosts: storage guard unhealthy (htz-xfs)", type: "Threshold" },
  ]));
  return { directory, config: { mounts: { host: ["/"], "htz-xfs-lab": ["/"] }, rulesPath } };
}

test("empty successful queries mean disk unknown, expected-host absence bad, and no unproven OOM recovery", async () => {
  const fixture = fixtureRules();
  try {
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async url => Response.json(String(url).includes("_mpl") ? { series: [] } : { status: { isPartial: false }, matches: [] }));
    const result = await observations(client, fixture.config, now);
    assert.deepEqual(result.errors, []);
    const states = result.observations;
    assert.ok(states.filter(o => o.mount).every(o => o.status === "unknown"));
    assert.equal(states.find(o => o.kind.includes("telemetry missing"))?.status, "bad");
    assert.equal(states.find(o => o.kind.includes("storage guard"))?.status, "bad");
    assert.ok(states.filter(o => o.kind.includes("kernel killed")).every(o => o.status === "unknown"));
  } finally { rmSync(fixture.directory, { recursive: true }); }
});

test("query errors remain unknown rather than empty-result absence or recovery", async () => {
  const fixture = fixtureRules();
  try {
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => { throw new Error("timeout"); });
    const result = await observations(client, fixture.config, now);
    assert.equal(result.errors.length, 5);
    assert.ok(result.observations.every(o => o.status === "unknown"));
  } finally { rmSync(fixture.directory, { recursive: true }); }
});

test("guard uses the original sample timestamp, and queries are explicitly bounded", async () => {
  const fixture = fixtureRules();
  try {
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async (url, init) => {
      const body = JSON.parse(init!.body as string);
      if (String(url).includes("_mpl")) return Response.json({ series: [] });
      assert.match(body.apl, /where _time >= datetime/);
      if (body.apl.includes("working-storage-health.service")) {
        assert.match(body.apl, /sampled_at = _time/);
        assert.match(body.apl, /arg_max\(sampled_at, health\)/);
        return Response.json({ status: { isPartial: false }, matches: [{ _time: new Date(now - 900_000).toISOString(), data: { host: "htz-xfs-lab", sampled_at: new Date(now - 90_000).toISOString(), healthy: true } }] });
      }
      return Response.json({ status: { isPartial: false }, matches: [] });
    });
    const guard = (await observations(client, fixture.config, now)).observations.find(o => o.kind.includes("storage guard"))!;
    assert.equal(guard.status, "healthy");
    assert.equal(guard.sampleAt, now - 90_000);
  } finally { rmSync(fixture.directory, { recursive: true }); }
});

function opening(store: IncidentStore, key: string, at = now) {
  return store.observe({ key, kind: rule.name, host: "host", mount: "/", status: "bad", critical: true, observedAt: at, sampleAt: at, detail: { value: 1 } })!;
}

test("accepted-but-response-lost is reconciled after restart without retransmission; recovery cannot overtake its opening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "incident-delivery-"));
  const database = join(directory, "state.sqlite");
  let store = new IncidentStore(database, { recoverAfterMs: 0 });
  try {
    const open = opening(store, "one");
    store.observe({ key: "one", kind: rule.name, host: "host", status: "healthy", observedAt: now + 1, sampleAt: now + 1, detail: {} });
    const received: string[] = [];
    const transport = { accepted: async () => false, ingest: async (event: any) => { received.push(event.eventId); throw new Error("response lost"); } };
    assert.deepEqual(await deliver(store, transport, now + 2), { sent: 0, uncertain: 1, errors: 1 });
    assert.deepEqual(received, [open.eventId]);
    assert.equal(store.pending()[0].action, "Closed");
    store.close();
    store = new IncidentStore(database);
    await deliver(store, transport, now + 60_002);
    assert.deepEqual(received, [open.eventId]);
    const recovered: string[] = [];
    await deliver(store, { accepted: async () => true, ingest: async (event: any) => { recovered.push(event.action); } }, now + 120_002);
    assert.deepEqual(recovered, ["Closed"]);
    assert.equal(store.uncertain().length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("crash-before-send stays uncertain, exposes an overdue queue, and does not block another incident", async () => {
  const store = new IncidentStore(":memory:");
  try {
    const first = opening(store, "first");
    store.noteAttempt(first.eventId, now);
    const second = opening(store, "second", now + 1);
    const sent: string[] = [];
    await deliver(store, { accepted: async () => false, ingest: async (event: any) => { sent.push(event.eventId); } }, now + 120_000);
    assert.deepEqual(sent, [second.eventId]);
    assert.equal(store.overdue(now + 16 * 60_000), true);
    assert.equal(store.uncertain()[0].eventId, first.eventId);
  } finally { store.close(); }
});

test("delivery budgets persist and reserve capacity for two notification routes", async () => {
  const store = new IncidentStore(":memory:");
  try {
    for (let i = 0; i < 4; i++) opening(store, String(i), now + i);
    const sent: string[] = [];
    await deliver(store, { accepted: async () => false, ingest: async (event: any) => { sent.push(event.eventId); } }, now + 10);
    assert.equal(sent.length, 3);
    assert.equal(store.deliveryBudget(now + 11), 0);
    await deliver(store, { accepted: async () => false, ingest: async (event: any) => { sent.push(event.eventId); } }, now + 60_011);
    assert.equal(sent.length, 4);
  } finally { store.close(); }
});

test("slow evaluations cannot backdate submissions and defeat the rolling delivery budget", async () => {
  const store = new IncidentStore(":memory:");
  try {
    for (let n = 0; n < 4; n++) opening(store, String(n), now + n);
    let wall = now + 120_000;
    const sent: string[] = [];
    const transport = { accepted: async () => false, ingest: async (event: any) => { sent.push(event.eventId); } };
    await deliver(store, transport, now, () => wall);
    assert.equal(store.deliveryBudget(wall), 0);
    wall += 1000;
    await deliver(store, transport, now + 61_000, () => wall);
    assert.equal(sent.length, 3);
  } finally { store.close(); }
});

test("a single OOM kill opens immediately instead of waiting for another distinct kill timestamp", async () => {
  const fixture = fixtureRules();
  const store = new IncidentStore(":memory:");
  try {
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async (url, init) => {
      if (String(url).includes("_mpl")) return Response.json({ series: [] });
      const body = JSON.parse(init!.body as string);
      return Response.json({ status: { isPartial: false }, matches: body.apl.includes("kills = count()")
        ? [{ data: { host: "host", kills: 1, sampled_at: (now - 30_000) * 1_000_000 } }] : [] });
    });
    const observation = (await observations(client, fixture.config, now)).observations.find(o => o.host === "host" && o.kind.includes("kernel killed"))!;
    assert.equal(store.observe(observation)?.action, "Open");
    for (let n = 1; n < 5; n++) assert.equal(store.observe({ ...observation, observedAt: now + n * 60_000 }), null);
  } finally { store.close(); rmSync(fixture.directory, { recursive: true }); }
});

test("bounded reconciliation rotates past permanently absent attempts, including after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "incident-fairness-"));
  const database = join(directory, "state.sqlite");
  let store = new IncidentStore(database);
  try {
    const events = Array.from({ length: 4 }, (_, n) => opening(store, String(n), now + n));
    for (const event of events) store.noteAttempt(event.eventId, now);
    const checked: string[] = [];
    const transport = { accepted: async (event: any) => { checked.push(event.eventId); return event.eventId === events[3].eventId; }, ingest: async () => { throw new Error("must not send"); } };
    await deliver(store, transport, now + 60_000);
    assert.deepEqual(checked, events.slice(0, 3).map(e => e.eventId));
    store.close();
    store = new IncidentStore(database);
    await deliver(store, transport, now + 120_000);
    assert.equal(checked[3], events[3].eventId);
    assert.equal(store.uncertain().length, 3);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test("the webhook JSON contract uses measured recovery, not a match monitor's native Open action", () => {
  const matched = { action: "Closed", eventId: "fixture-event", incidentId: "fixture-incident", timestamp: new Date(now).toISOString(), host: "host", mountpoint: "/" };
  const variables: Record<string, string> = { ".Action": "Open", ".MonitorID": "fixture-monitor", ".Title": "transport-test: lifecycle", ...Object.fromEntries(Object.entries(matched).map(([key, value]) => [`.MatchedEvent.${key}`, value])) };
  // This verifies our JSON/schema fixture, not Go template execution. The
  // notifier's actual template must also pass the isolated native route test.
  const renderFixture = (template: string) => JSON.parse(template.replace("{{jsonObject .MatchedEvent}}", JSON.stringify(matched)).replace(/{{(\.[A-Za-z.]+)}}/g, (_, key) => {
    assert.ok(Object.hasOwn(variables, key), key);
    return variables[key];
  }));
  const template = readFileSync(new URL("webhook-body.tmpl", import.meta.url), "utf8");
  assert.equal(renderFixture(template).action, "Closed");
  assert.deepEqual(renderFixture(template).groupValues, ["host", "/"]);
  assert.throws(() => assert.equal(renderFixture(template.replace("{{.MatchedEvent.action}}", "{{.Action}}")).action, "Closed"));
});

test("watchdog notifications retain host, service, and signal context even when the count is zero", () => {
  const template = readFileSync(new URL("watchdog-body.tmpl", import.meta.url), "utf8");
  for (const [action, value] of [["Open", 0], ["Closed", 1]] as const) {
    const variables: Record<string, string> = { ".Action": action, ".Value": String(value), ".MonitorID": "watchdog", ".Timestamp": new Date(now).toISOString(), ".Title": "incident evaluator watchdog" };
    const payload = JSON.parse(template.replace(/{{(\.[A-Za-z]+)}}/g, (_, key) => variables[key]));
    assert.equal(payload.action, action);
    assert.equal(payload.value, value);
    assert.equal(payload.host, "htz-relay");
    assert.equal(payload.service, "axiom-incidents");
    assert.ok(payload.signal.length > 0);
    assert.ok(payload.groupValues.every((group: string) => group.length > 0));
  }
});

test("the canonical event preserves true lifecycle action, identifiers, measurement time, and transport-test classification", () => {
  const store = new IncidentStore(":memory:");
  try {
    const event = notification(opening(store, "one"), true);
    assert.equal(event.source, "host-incidents-test");
    assert.equal(event.action, "Open");
    assert.match(String(event.title), /^transport-test:/);
    assert.deepEqual(event.groupValues, ["host", "/"]);
    assert.equal(event.timestamp, new Date(now).toISOString());
  } finally { store.close(); }
});
