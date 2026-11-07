import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Axiom, observations } from "./axiom.ts";
import { deliver } from "./delivery.ts";
import { EXTERNAL_POLICY, fetchManifest, manifestObservations, upgradeObservation, validateExpectations, type ExternalExpectation } from "./external.ts";
import { IncidentStore, type Observation } from "./state.ts";

const MINUTE = 60_000;
const now = Date.parse("2026-11-07T04:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const expectation: ExternalExpectation = {
  host: "mmn-m4", metricsHost: "mmn-m4.local", enabledAt: iso(now - 120 * MINUTE),
  manifestUrl: "http://mmn-m4:5252/manifest.json", services: ["hue", "html-stuff", "files"],
};
function upgrade(at: number, reasonCode = "healthy", ready = reasonCode === "healthy") {
  return [{ host: "mmn-m4", sampled_at: iso(at), event: {
    schemaVersion: 1, service: "tailnet-registry", operation: "host.upgrade_health", host: "mmn-m4",
    timestamp: iso(at), context: { ready, reasonCode, readiness: reasonCode },
  } }];
}
const observeUpgrade = (reason: string, at = now) => upgradeObservation(expectation, upgrade(at, reason), at, at);

function ledger(): IncidentStore { return new IncidentStore(":memory:", { sourceMaxAgeMs: 15 * MINUTE }); }
async function replay(observe: (at: number) => Observation, badUntil = 8) {
  const store = ledger();
  const sent: Record<string, unknown>[] = [];
  const transport = { accepted: async () => false, ingest: async (event: Record<string, unknown>) => { sent.push(event); } };
  try {
    for (let minute = 0; minute <= badUntil; minute++) {
      const at = now + minute * MINUTE;
      store.observe(observe(at));
      await deliver(store, transport, at);
    }
    assert.equal(sent.length, 1, "sustained bad emits exactly one opening");
    assert.equal(sent[0].action, "Open");
    return { store, sent, transport };
  } catch (error) { store.close(); throw error; }
}

test("external expectations require an explicit existing always-on rule, bounded IDs and credential-free manifest URL", () => {
  validateExpectations([expectation], new Set([expectation.metricsHost]));
  for (const fixture of [
    { ...expectation, metricsHost: "sleeping-laptop.local" }, { ...expectation, enabledAt: "yesterday" },
    { ...expectation, manifestUrl: "file:///manifest.json" }, { ...expectation, manifestUrl: "http://secret:token@mmn-m4/manifest.json" },
    { ...expectation, services: ["hue", "hue"] }, { ...expectation, host: "mmn-m4'" },
  ]) assert.throws(() => validateExpectations([fixture], new Set([expectation.metricsHost])));
  assert.throws(() => validateExpectations([expectation, expectation], new Set([expectation.metricsHost])));
});

test("hung upgrades, stale applied state and dependency/state failures are bad; fresh building is not convergence or failure", () => {
  for (const reason of ["activation_overdue", "build_overdue", "dependency_repair_overdue", "verification_overdue", "attempt_failed", "convergence_stale", "partial_dependencies", "state_missing", "state_invalid"]) {
    assert.equal(observeUpgrade(reason).status, "bad", reason);
  }
  assert.equal(observeUpgrade("building").status, "unknown");
  assert.equal(observeUpgrade("healthy").status, "healthy");
  assert.equal(observeUpgrade("new_reason").status, "unknown");
  assert.equal(upgradeObservation(expectation, upgrade(now, "healthy", false), now, now).status, "unknown");
  assert.equal(upgradeObservation(expectation, upgrade(now, "attempt_failed", true), now, now).status, "unknown");
});

test("missing upgrade observations require fresh host evidence, complete query and 90-minute rollout grace", () => {
  assert.equal(upgradeObservation(expectation, [], now, now).status, "bad");
  assert.equal(upgradeObservation({ ...expectation, enabledAt: iso(now - 10 * MINUTE) }, upgrade(now, "state_missing"), now, now).status, "unknown");
  assert.equal(upgradeObservation({ ...expectation, enabledAt: iso(now - 89 * MINUTE) }, [], now, now).status, "unknown");
  assert.equal(upgradeObservation({ ...expectation, enabledAt: iso(now - 90 * MINUTE) }, [], now, now).status, "bad");
  for (const hostAt of [undefined, now - 3 * MINUTE, now + 1]) assert.equal(upgradeObservation(expectation, [], hostAt, now).status, "unknown");
  assert.equal(upgradeObservation(expectation, undefined, now, now).status, "unknown");
  const stale = upgrade(now - 16 * MINUTE);
  assert.equal(upgradeObservation(expectation, stale, now, now).status, "bad");
  // A newly ingested OLD report cannot close an open missing-reporter incident.
  stale[0].sampled_at = iso(now);
  assert.notEqual(upgradeObservation(expectation, stale, now, now).status, "healthy");
});

test("malformed, partial, repeated and future upgrade samples cannot supply recovery", () => {
  for (const rows of [
    [{ host: "mmn-m4", sampled_at: iso(now), event: null }],
    [{ ...upgrade(now)[0], sampled_at: "not-a-time" }],
    [{ ...upgrade(now)[0], event: { ...upgrade(now)[0].event, context: { ready: "true", reasonCode: "healthy", readiness: "healthy" } } }],
    [...upgrade(now), ...upgrade(now)], upgrade(now + 1),
  ]) assert.equal(upgradeObservation(expectation, rows, now, now).status, "unknown");
});

test("upgrade incident retains one ID across failures, missing/building reports, and then measured recovery through outbox", async () => {
  const { store, sent, transport } = await replay(at => observeUpgrade("activation_overdue", at));
  try {
    const id = sent[0].incidentId;
    for (let minute = 9; minute <= 22; minute++) {
      const at = now + minute * MINUTE;
      store.observe(minute % 2 ? upgradeObservation(expectation, undefined, at, at) : observeUpgrade("building", at));
      await deliver(store, transport, at);
    }
    assert.equal(sent.length, 1);
    for (let minute = 23; minute <= 33; minute++) {
      const at = now + minute * MINUTE;
      store.observe(observeUpgrade("healthy", at));
      await deliver(store, transport, at);
      assert.equal(sent.length, minute < 33 ? 1 : 2);
    }
    assert.equal(sent[1].action, "Closed");
    assert.equal(sent[1].incidentId, id);
    assert.notEqual(sent[0].eventId, sent[1].eventId);
  } finally { store.close(); }
});

test("opening qualification is five minutes of advancing evidence, not a default one-minute spike", () => {
  const store = ledger();
  try {
    for (let minute = 0; minute < 5; minute++) assert.equal(store.observe(observeUpgrade("attempt_failed", now + minute * MINUTE)), null);
    assert.equal(store.observe(observeUpgrade("attempt_failed", now + 5 * MINUTE))?.action, "Open");
  } finally { store.close(); }
  const invalid = ledger();
  try {
    for (const qualifyAfterMs of [-1, NaN, Infinity, 0.5]) assert.throws(() => invalid.observe({ ...observeUpgrade("attempt_failed"), qualifyAfterMs }), /invalid observation qualification/);
    const ordinary = { ...observeUpgrade("attempt_failed"), qualifyAfterMs: 0 };
    assert.equal(invalid.observe(ordinary), null);
    assert.equal(invalid.observe({ ...ordinary, observedAt: now + 1, sampleAt: now + 1 }), null, "a caller cannot shorten the ledger default");
  } finally { invalid.close(); }
  const repeated = ledger();
  try {
    for (let minute = 0; minute <= 8; minute++) assert.equal(repeated.observe({ ...observeUpgrade("attempt_failed"), observedAt: now + minute * MINUTE }), null);
  } finally { repeated.close(); }
});

function manifest(at: number, ready = true) {
  return { schemaVersion: 1, host: { name: "mmn-m4" }, reportedAt: iso(at), services: Object.fromEntries(expectation.services.map(id => [id, {
    health: { status: "up", checkedAt: iso(at), reachable: true, ready, readiness: ready ? "ready" : "not_ready", reasonCode: ready ? "ready" : "backend_not_ready" },
  }])) };
}
function serviceObservation(at: number, ready: boolean): Observation {
  return manifestObservations(expectation, manifest(at, ready), at, at)[1];
}

test("HTTP 200/legacy up never proves readiness; explicit fresh not-ready produces per-service failures", () => {
  const healthy = manifestObservations(expectation, manifest(now), now, now);
  assert.ok(healthy.every(o => o.status === "healthy"));
  const notReady = manifestObservations(expectation, manifest(now, false), now, now);
  assert.equal(notReady[0].status, "healthy", "complete reporting can coexist with bad apps");
  assert.ok(notReady.slice(1).every(o => o.status === "bad" && o.detail.reachable === true));
  for (const reachable of [true, false]) {
    const value = manifest(now, false);
    Object.assign(value.services.hue.health, { status: "down", reachable });
    assert.equal(manifestObservations(expectation, value, now, now)[1].status, "bad", "HTTP 5xx is reachable but still down");
  }
  for (const ready of [undefined, null, "true"]) {
    const value = manifest(now);
    Object.assign(value.services.hue.health, { ready });
    const result = manifestObservations(expectation, value, now, now);
    assert.equal(result[0].status, "bad", "an incomplete reporter has its own condition");
    assert.equal(result[1].status, "unknown", "unknown is not an app failure or recovery");
    assert.ok(result.slice(2).every(o => o.status === "healthy"));
  }
});

test("boolean-only producer uncertainty is a reporter failure, never measured app failure or recovery", () => {
  for (const reasonCode of ["readiness_not_configured", "readiness_unavailable", "stale_observation"]) {
    const store = ledger();
    try {
      for (let minute = 0; minute <= 6; minute++) {
        const at = now + minute * MINUTE;
        const value = manifest(at, false);
        Object.assign(value.services.hue.health, { reasonCode });
        const result = manifestObservations(expectation, value, at, at);
        assert.equal(result[0].status, "bad", reasonCode);
        assert.equal(result[1].status, "unknown", reasonCode);
        assert.equal(store.observe(result[1]), null);
      }
      assert.deepEqual(store.pending(), []);
      const inconsistent = manifest(now, true);
      Object.assign(inconsistent.services.hue.health, { reasonCode });
      assert.equal(manifestObservations(expectation, inconsistent, now, now)[1].status, "unknown");
    } finally { store.close(); }
  }
});

test("malformed, partial, stale and future manifests stay unknown for apps; reporter failure requires fresh host and grace", () => {
  for (const value of [null, [], {}, { ...manifest(now), schemaVersion: 2 }, { ...manifest(now), host: { name: "wrong-host" } },
    { ...manifest(now), services: {} }, manifest(now - 3 * MINUTE), manifest(now + 1)]) {
    const result = manifestObservations(expectation, value, now, now);
    assert.equal(result[0].status, "bad");
    assert.ok(result.slice(1).every(o => o.status === "unknown"));
    assert.ok(manifestObservations(expectation, value, undefined, now).every(o => o.status === "unknown"));
    assert.ok(manifestObservations({ ...expectation, enabledAt: iso(now) }, value, now, now).every(o => o.status === "unknown"));
  }
  for (const patch of [{ checkedAt: iso(now - 3 * MINUTE) }, { checkedAt: iso(now + 1) }, { reachable: false },
    { ready: true, readiness: "not_ready" }, { reasonCode: "private body content!" }, { status: "stale" }]) {
    const value = manifest(now);
    Object.assign(value.services.hue.health, patch);
    assert.equal(manifestObservations(expectation, value, now, now)[1].status, "unknown");
  }
});

test("readiness gets one incident despite healthy liveness, never closes with lost reporter, then closes on ten minutes of ready samples", async () => {
  const { store, sent, transport } = await replay(at => serviceObservation(at, false));
  try {
    for (let minute = 9; minute <= 22; minute++) {
      const at = now + minute * MINUTE;
      const unavailable = manifest(at, false);
      unavailable.services.hue.health.reasonCode = "readiness_unavailable";
      store.observe(manifestObservations(expectation, minute % 2 ? undefined : unavailable, at, at)[1]);
      await deliver(store, transport, at);
    }
    assert.equal(sent.length, 1);
    for (let minute = 23; minute <= 33; minute++) {
      const at = now + minute * MINUTE;
      store.observe(serviceObservation(at, true));
      await deliver(store, transport, at);
      assert.equal(sent.length, minute < 33 ? 1 : 2);
    }
    assert.equal(sent[1].action, "Closed");
    assert.equal(sent[1].incidentId, sent[0].incidentId);
  } finally { store.close(); }
});

test("bounded manifest fetch rejects non-200, redirects, oversize, invalid JSON and never exposes body contents", async () => {
  assert.deepEqual(await fetchManifest(expectation.manifestUrl, async (_url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    return Response.json({ schemaVersion: 1 });
  }), { schemaVersion: 1 });
  for (const response of [new Response("private content", { status: 503 }), new Response(null, { status: 302 }),
    new Response("private content", { headers: { "content-length": String(EXTERNAL_POLICY.maxBodyBytes + 1) } }),
    new Response(" ".repeat(EXTERNAL_POLICY.maxBodyBytes + 1)), new Response("private malformed content")]) {
    await assert.rejects(fetchManifest(expectation.manifestUrl, async () => response), error => !String(error).includes("private"));
  }
});

test("manifest deadline covers hung request and cancels a stalled response body", async () => {
  let cancelled = false;
  for (const request of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    })),
  ]) {
    const started = performance.now();
    await assert.rejects(fetchManifest(expectation.manifestUrl, request), /manifest deadline/);
    assert.ok(performance.now() - started < EXTERNAL_POLICY.requestTimeoutMs + 1500);
  }
  assert.equal(cancelled, true);
});

test("adapter integration bounds query/source times, preserves unknown on partial Axiom data and host loss, and redacts HTTP errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "external-integration-"));
  try {
    const rulesPath = join(directory, "rules.json");
    writeFileSync(rulesPath, JSON.stringify([{ type: "Threshold", name: "hosts: telemetry missing (mmn-m4)", mplQuery: '`host.name` == "mmn-m4.local"' }]));
    const config = { mounts: { "mmn-m4.local": ["/System/Volumes/Data"] }, rulesPath, externalExpectations: [expectation] };
    for (const mode of ["healthy", "during-query", "missing", "partial", "malformed", "offline", "http-failed"]) {
      const client = new Axiom({ query: "secret-query", ingest: "secret-ingest", org: "secret-org" }, async (url, init) => {
        if (String(url).includes("_mpl")) return Response.json({ series: mode === "offline" ? [] : [{ tags: { "host.name": expectation.metricsHost }, start: (now - 30_000) / 1000, resolution: 30, data: [100] }] });
        const body = JSON.parse(init!.body as string);
        assert.equal(body.startTime, iso(now - 15 * MINUTE)); assert.equal(body.endTime, iso(now));
        assert.match(body.apl, /where _time >= datetime/); assert.match(body.apl, /arg_max\(sampled_at, event\)/);
        return Response.json({ status: { isPartial: mode === "partial" }, matches: mode === "missing" ? [] : [{ data: mode === "malformed" ? { garbage: true } : upgrade(now - 30_000)[0] }] });
      });
      const request: typeof fetch = async (_url, init) => {
        assert.ok(!JSON.stringify(init?.headers).includes("secret"));
        if (mode === "http-failed") throw new Error("private body secret-query");
        return Response.json(manifest(mode === "during-query" ? now + 1500 : now - 30_000));
      };
      const measuredAt = mode === "during-query" ? now + 2000 : now;
      const result = await observations(client, config, now, request, () => measuredAt);
      assert.equal(result.observations.length, 6);
      const convergence = result.observations.find(o => o.kind === "hosts: upgrade convergence")!;
      assert.equal(convergence.status, mode === "missing" ? "bad" : ["partial", "malformed", "offline"].includes(mode) ? "unknown" : "healthy", mode);
      const reporter = result.observations.find(o => o.kind === "hosts: readiness reporter")!;
      assert.equal(reporter.status, mode === "http-failed" ? "bad" : mode === "offline" ? "unknown" : "healthy", mode);
      assert.equal(reporter.observedAt, measuredAt);
      assert.equal(result.errors.length, ["partial", "malformed"].includes(mode) ? 1 : 0);
      if (mode === "http-failed" || mode === "offline") assert.ok(result.observations.filter(o => o.kind.startsWith("hosts: service readiness")).every(o => o.status === "unknown"));
      assert.ok(!JSON.stringify(result).includes("private")); assert.ok(!JSON.stringify(result).includes("secret"));
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test("disabled expectations add no APL or HTTP polling; config never opts in sleeping inventory hosts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "external-config-"));
  try {
    const rulesPath = join(directory, "rules.json");
    writeFileSync(rulesPath, "[]");
    let calls = 0;
    const client = new Axiom({ query: "q", ingest: "i", org: "o" }, async () => { calls++; return Response.json({ series: [] }); });
    const noHttp: typeof fetch = async () => { throw new Error("HTTP forbidden"); };
    const result = await observations(client, { mounts: {}, rulesPath }, now, noHttp);
    assert.equal(calls, 1); assert.deepEqual(result, { observations: [], errors: [] });
    await assert.rejects(observations(client, { mounts: { "laptop.local": [] }, rulesPath, externalExpectations: [{ ...expectation, metricsHost: "laptop.local" }] }, now, noHttp), /invalid external expectation/);
  } finally { rmSync(directory, { recursive: true }); }
});
