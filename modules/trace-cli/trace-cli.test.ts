import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSpans, parseOtlp, percentiles, summarize, tree } from "./store.ts";

const sp = (spanId: string, parent: string | undefined, name: string, start: number, end: number, code = 1) => ({
  traceId: "t1", spanId, ...(parent ? { parentSpanId: parent } : {}), name,
  startTimeUnixNano: String(start * 1e6), endTimeUnixNano: String(end * 1e6), status: { code },
  attributes: [{ key: "seq", value: { intValue: "3" } }],
});
const body = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] }, scopeSpans: [{ spans: [sp("a", undefined, "root", 0, 100), sp("b", "a", "child", 10, 40, 2)] }] }] };

test("parses otlp json and builds tree", () => {
  const spans = parseOtlp(body);
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.service, "api");
  assert.equal(spans[1]!.status, "error");
  assert.equal(spans[0]!.attributes.seq, 3);
  assert.match(tree(spans, "t1"), /^root 100\.00ms \[api\] seq=3\n {2}child 30\.00ms ERROR/);
  assert.deepEqual(summarize(spans)[0], { traceId: "t1", root: "root", spans: 2, errors: 1, durationMs: 100, startNs: 0 });
});

test("stats and assertions", () => {
  const spans = parseOtlp(body);
  assert.equal(percentiles(spans).length, 2);
  assert.deepEqual(assertSpans(spans, [{ name: "root", minCount: 1, maxMedianMs: 200, minSamples: 1 }]), { failures: [], skipped: [] });
  assert.equal(assertSpans(spans, [{ name: "child", noErrors: true }, { name: "nope", minCount: 1 }]).failures.length, 2);
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { createEventLogger, type ServiceEvent } from "../service-events/events.ts";
import { ingest, pull, type AxiomRow } from "./ops.ts";
import { load } from "./store.ts";

const harness = () => {
  const emitted: ServiceEvent[] = [];
  return { emitted, events: createEventLogger("trace-cli", { sink: (e) => emitted.push(e) }), store: join(mkdtempSync(join(tmpdir(), "trace-cli-")), "spans.jsonl") };
};

test("ingest stores spans and emits one event without span content", async () => {
  const h = harness();
  const r = await ingest(h, Buffer.from(JSON.stringify(body)));
  assert.deepEqual(r, { status: "ingested", spanCount: 2, forwarded: false });
  assert.equal(load(h.store).length, 2);
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]!.operation, "ingest.batch");
  assert.equal(h.emitted[0]!.context.itemCount, 2);
  assert.doesNotMatch(JSON.stringify(h.emitted), /root|child|seq/);
});

test("ingest rejects protobuf and bad json without writing", async () => {
  const h = harness();
  assert.deepEqual(await ingest(h, Buffer.from("x"), "application/x-protobuf"), { status: "rejected", reasonCode: "PROTOBUF_UNSUPPORTED" });
  assert.deepEqual(await ingest(h, Buffer.from("{nope")), { status: "rejected", reasonCode: "INVALID_JSON" });
  assert.equal(load(h.store).length, 0);
  assert.deepEqual(h.emitted.map((e) => e.outcome), ["failed", "failed"]);
});

test("failed relay degrades but keeps the local spans", async () => {
  const h = harness();
  const r = await ingest({ ...h, forward: async () => { throw Object.assign(new Error("PRIVATE_CANARY"), { code: "ECONNREFUSED" }); } }, Buffer.from(JSON.stringify(body)));
  assert.deepEqual(r, { status: "ingested", spanCount: 2, forwarded: false });
  assert.equal(load(h.store).length, 2);
  assert.equal(h.emitted[0]!.outcome, "degraded");
  assert.equal(h.emitted[0]!.context.errorCode, "ECONNREFUSED");
  assert.doesNotMatch(JSON.stringify(h.emitted), /PRIVATE_CANARY/);
});

test("pull maps rows into the same store, and failure is a resolved failure", () => {
  const h = harness();
  const rows: AxiomRow[] = [{ trace_id: "t9", span_id: "s1", name: "db", _time: "2026-11-26T00:00:00Z", duration: 5e6, "status.code": "ERROR" }];
  assert.deepEqual(pull({ ...h, query: () => rows }, "traces", "1h"), { status: "pulled", spanCount: 1 });
  assert.equal(load(h.store)[0]!.status, "error");
  const bad = pull({ ...h, query: () => { throw new Error("PRIVATE_CANARY"); } }, "traces", "1h");
  assert.deepEqual(bad, { status: "failed", reasonCode: "QUERY_FAILED" });
  assert.doesNotMatch(JSON.stringify(h.emitted), /PRIVATE_CANARY/);
});

test("http adapter and cli ingest reach the same operation", async () => {
  const store = join(mkdtempSync(join(tmpdir(), "trace-cli-")), "spans.jsonl");
  const env = { ...process.env, TRACE_CLI_STORE: store };
  const port = await new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
  const child = spawn("node", [new URL("./trace-cli.ts", import.meta.url).pathname, "serve", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    // node may print warnings first; only the listen message means the server is up
    await new Promise<void>((ok) => { let seen = ""; child.stderr.on("data", (c) => { seen += c; if (seen.includes("receiver on")) ok(); }); });
    const post = (type: string, data: string) => fetch(`http://127.0.0.1:${port}/v1/traces`, { method: "POST", headers: { "content-type": type }, body: data });
    assert.equal((await post("application/json", JSON.stringify(body))).status, 200);
    assert.equal((await post("application/x-protobuf", "x")).status, 415);
    assert.equal((await post("application/json", "{")).status, 400);
    assert.equal(load(store).length, 2);
    let log = "";
    child.stdout.on("data", (c) => { log += c; });
    for (let i = 0; i < 50 && log.trim().split("\n").filter(Boolean).length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(log.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l).outcome).join(), "succeeded,failed,failed");

    // cli path: same operation, same store, nonzero exit on a resolved rejection
    const good = join(mkdtempSync(join(tmpdir(), "trace-cli-in-")), "in.json");
    writeFileSync(good, JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [sp("z", undefined, "cli", 0, 1)] }] }] }).replace('"t1"', '"t2"'));
    const bad = join(mkdtempSync(join(tmpdir(), "trace-cli-in-")), "bad.json");
    writeFileSync(bad, "{");
    const bin = new URL("./trace-cli.ts", import.meta.url).pathname;
    assert.equal(spawnSync("node", [bin, "ingest", good], { env }).status, 0);
    assert.equal(spawnSync("node", [bin, "ingest", bad], { env }).status, 1);
    assert.equal(load(store).length, 3);
  } finally { child.kill(); }
});

import { run } from "./ops.ts";

test("run nests under TRACEPARENT, hides argv, and records failing exits", async () => {
  const h = harness();
  let t = 0, ids = 0;
  const seen: Record<string, string | undefined>[] = [];
  const deps = { store: h.store, events: h.events, now: () => (t += 1e6), id: (n: number) => (++ids).toString(16).padStart(n * 2, "0"), exec: (_a: string[], env: Record<string, string | undefined>) => { seen.push(env); return seen.length === 1 ? 0 : 3; } };
  const outer = await run(deps, "outer", ["echo", "PRIVATE_CANARY"], {});
  assert.equal(outer.status, "ran");
  const child = await run(deps, "inner", ["false"], { TRACEPARENT: seen[0]!.TRACEPARENT });
  assert.equal(child.status === "ran" && child.exitCode, 3);
  const spans = load(h.store);
  assert.equal(spans[1]!.parentSpanId, spans[0]!.spanId);
  assert.equal(spans[1]!.traceId, spans[0]!.traceId);
  assert.equal(spans[1]!.status, "error");
  assert.doesNotMatch(JSON.stringify([spans, h.emitted]), /PRIVATE_CANARY/);
  assert.deepEqual(await run(deps, "x", [], {}), { status: "failed", reasonCode: "EMPTY_COMMAND" });
});

import { parseAxiomRows } from "./ops.ts";

test("axiom ndjson: zero, one, two rows, strings with braces, truncation", () => {
  assert.deepEqual(parseAxiomRows("[]\n"), []);
  assert.deepEqual(parseAxiomRows(""), []);
  assert.equal(parseAxiomRows('{"name":"a"}\n').length, 1);
  assert.equal(parseAxiomRows('{"name":"a"}\n{\n  "name": "b } \\" {"\n}\n').length, 2);
  assert.throws(() => parseAxiomRows('{"name":"a"'), /truncated/);
  assert.throws(() => parseAxiomRows("oops"), /unrecognized/);
});

test("ingest rejects spans readers cannot render, and a failed append is a resolved failure", async () => {
  const h = harness();
  const noIds = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x", startTimeUnixNano: "1", endTimeUnixNano: "2" }] }] }] };
  assert.deepEqual(await ingest(h, Buffer.from(JSON.stringify(noIds))), { status: "rejected", reasonCode: "INVALID_SPAN" });
  assert.equal(load(h.store).length, 0);
  const dirStore = mkdtempSync(join(tmpdir(), "trace-cli-dir-")); // a directory is not appendable
  const r = await ingest({ ...h, store: dirStore }, Buffer.from(JSON.stringify(body)));
  assert.deepEqual(r, { status: "failed", reasonCode: "STORE_WRITE_FAILED" });
  assert.equal(h.emitted.at(-1)!.outcome, "failed");
  assert.doesNotMatch(JSON.stringify(h.emitted), /trace-cli-dir/);
});

test("baseline fails on an empty store", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  assert.ok(assertSpans([], baseline).failures.length >= 3);
});

test("cli: run emits its event on stderr, serve refuses forwarding without a token, receiver survives a bad store", async () => {
  const store = join(mkdtempSync(join(tmpdir(), "trace-cli-")), "spans.jsonl");
  const bin = new URL("./trace-cli.ts", import.meta.url).pathname;
  const env = { ...process.env, TRACE_CLI_STORE: store, AXIOM_TOKEN: "" };
  const ran = spawnSync("node", [bin, "run", "echoer", "--", "echo", "hello"], { env, encoding: "utf8" });
  assert.equal(ran.stdout, "hello\n");
  assert.match(ran.stderr, /"operation":"run.command".*"outcome":"succeeded"/);
  const fwd = spawnSync("node", [bin, "serve", "--forward-axiom", "ds"], { env, encoding: "utf8" });
  assert.equal(fwd.status, 2);
  assert.match(fwd.stderr, /AXIOM_TOKEN/);

  const dirStore = mkdtempSync(join(tmpdir(), "trace-cli-dir-"));
  const port = await new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
  const child = spawn("node", [bin, "serve", "--port", String(port)], { env: { ...env, TRACE_CLI_STORE: dirStore }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((ok) => { let seen = ""; child.stderr.on("data", (c) => { seen += c; if (seen.includes("receiver on")) ok(); }); });
    const post = () => fetch(`http://127.0.0.1:${port}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post()).status, 500);
    assert.equal((await post()).status, 500); // still up
  } finally { child.kill(); }
});

test("axiom rows: trailing garbage and an unclosed array are rejected, arrays parse whole", () => {
  assert.throws(() => parseAxiomRows('{"name":"a"}\ngarbage'), /unrecognized/);
  assert.throws(() => parseAxiomRows('[{"name":"a"}'));
  assert.throws(() => parseAxiomRows('[1]'), /unrecognized/);
  assert.throws(() => parseAxiomRows('{"name":"a"}"extra"'), /unrecognized/);
  assert.throws(() => parseAxiomRows('{"name":"a"}}{'), /unrecognized/);
  assert.equal(parseAxiomRows('{"name":"a"}{"name":"b"}').length, 2);
  assert.equal(parseAxiomRows('[{"name":"a"},{"name":"b"}]').length, 2);
});

test("ingest rejects null and unformattable timestamps", async () => {
  const h = harness();
  const batch = (start: unknown, end: unknown) => Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "t", spanId: "s", name: "x", startTimeUnixNano: start, endTimeUnixNano: end }] }] }] }));
  for (const [a, b] of [[null, "2"], ["1", null], ["9".repeat(30), "9".repeat(30)], [undefined, undefined], ["  ", "2"], ["1", "\n"]]) {
    assert.deepEqual(await ingest(h, batch(a, b)), { status: "rejected", reasonCode: "INVALID_SPAN" });
  }
  assert.equal(load(h.store).length, 0);
  assert.equal((await ingest(h, batch("1700000000000000000", "1700000001000000000"))).status, "ingested");
});

test("run reports a store write failure with the command's exit code and an event", async () => {
  const h = harness();
  const dirStore = mkdtempSync(join(tmpdir(), "trace-cli-dir-"));
  const r = await run({ store: dirStore, events: h.events, exec: () => 0 }, "x", ["true"], {});
  assert.deepEqual(r, { status: "failed", reasonCode: "STORE_WRITE_FAILED", exitCode: 0 });
  assert.equal(h.emitted[0]!.outcome, "failed");
  assert.equal(h.emitted[0]!.context.reasonCode, "STORE_WRITE_FAILED");
  const bin = new URL("./trace-cli.ts", import.meta.url).pathname;
  const cli = spawnSync("node", [bin, "run", "x", "--", "true"], { env: { ...process.env, TRACE_CLI_STORE: dirStore }, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /"reasonCode":"STORE_WRITE_FAILED"/);
});

const span = (i: number, ms: number, status: "ok" | "error" = "ok") => ({ traceId: `t${i}`, spanId: `s${i}`, name: "step", startNs: i * 1e12, endNs: i * 1e12 + ms * 1e6, status, attributes: {} });

test("latency gate: a cold-start outlier does not fail, a sustained regression does, too few samples skip", () => {
  const gate = [{ name: "step", maxMedianMs: 1000, window: 5 }];
  const cold = [span(1, 6000), span(2, 800), span(3, 820), span(4, 790), span(5, 810)];
  assert.deepEqual(assertSpans(cold, gate), { failures: [], skipped: [] });
  const slow = [span(1, 800), span(2, 2000), span(3, 2100), span(4, 2200), span(5, 790)];
  assert.match(assertSpans(slow, gate).failures[0]!, /median 2000ms over the last 5 runs/);
  const few = assertSpans([span(1, 9999)], gate);
  assert.deepEqual(few.failures, []);
  assert.match(few.skipped[0]!, /needs 5 runs, have 1/);
});

test("noErrors looks at the recent window, so an old failure ages out", () => {
  const spans = [span(1, 10, "error"), ...[2, 3, 4, 5, 6].map((i) => span(i, 10))];
  assert.deepEqual(assertSpans(spans, [{ name: "step", noErrors: true, window: 5 }]).failures, []);
  assert.equal(assertSpans(spans, [{ name: "step", noErrors: true, window: 6 }]).failures.length, 1);
});

test("run does not block: two commands overlap", async () => {
  const h = harness();
  const wait = (ms: number) => new Promise<number>((r) => setTimeout(() => r(0), ms));
  const deps = { store: h.store, events: h.events, exec: () => wait(300) };
  const t0 = Date.now();
  await Promise.all([run(deps, "a", ["x"], {}), run(deps, "b", ["x"], {})]);
  assert.ok(Date.now() - t0 < 550, "ran serially"); // serial would take >= 600ms
  assert.equal(load(h.store).length, 2);
});
