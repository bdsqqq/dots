import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArgs, portalServer } from "./portal-server.mjs";

const assets = {
  html: "<!doctype html><title>company money</title>",
  css: ":root{color-scheme:dark}",
  js: "document.documentElement.dataset.ready = 'true'",
};

async function withServer(run, tally) {
  const server = portalServer(assets, tally);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let raw = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === "string" && chunk.startsWith('{"schemaVersion":')) {
      raw += chunk;
      args.find((value) => typeof value === "function")?.();
      return true;
    }
    return originalWrite.call(this, chunk, ...args);
  };
  try {
    await run(`http://127.0.0.1:${server.address().port}`, () => raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.stdout.write = originalWrite;
  }
  return raw;
}

test("parses an exact local server configuration", () => {
  assert.deepEqual(
    parseArgs([
      "--html", "/ui/index.html",
      "--css", "/ui/portal.css",
      "--js", "/ui/portal.js",
      "--root", "/synthetic",
      "--host", "0.0.0.0",
      "--port", "8090",
    ]),
    {
      html: "/ui/index.html",
      css: "/ui/portal.css",
      js: "/ui/portal.js",
      root: "/synthetic",
      host: "0.0.0.0",
      port: 8090,
    },
  );
  assert.throws(
    () => parseArgs(["--html", "one", "--html", "two", "--css", "css", "--js", "js"]),
    /duplicate argument/,
  );
  assert.throws(
    () => parseArgs(["--html", "one", "--css", "css", "--js", "js", "--port", "0"]),
    /invalid --port/,
  );
});

test("serves only static portal assets with restrictive browser policy", async () => {
  await withServer(async (origin) => {
    for (const [path, type, body] of [
      ["/", "text/html", assets.html],
      ["/portal.css", "text/css", assets.css],
      ["/portal.js", "text/javascript", assets.js],
      ["/healthz", "text/plain", "ok\n"],
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), new RegExp(`^${type}`));
      assert.equal(await response.text(), body);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    }

    const head = await fetch(`${origin}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const missing = await fetch(`${origin}/private-ledger.json`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");

    const post = await fetch(`${origin}/`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
});

test("portal assets contain no private boundary values or fake totals", async () => {
  const root = new URL("./", import.meta.url);
  const contents = await Promise.all(
    ["index.html", "portal.css", "portal.js"].map((name) => readFile(new URL(name, root), "utf8")),
  );
  const joined = contents.join("\n");
  assert.match(joined, /net movement is not your bank balance/);
  assert.match(joined, /ledger unavailable/);
  assert.doesNotMatch(joined, /\/Users\/|company-ledger\/config|IGOR BEDESQUI/);
  assert.doesNotMatch(joined, /innerHTML|WebSocket|EventSource/);
});

test("emitted JSON captures successes, HEAD, probes and failures without ledger or request data", async () => {
  const sensitive = { entity: "private-entity", currencies: [{ incoming: 987654321 }], transactions: [{ description: "private-counterparty" }] };
  const raw = await withServer(async (origin, records) => {
    const requests = [
      ["/api/tally?secret-query", { headers: { "user-agent": "Mozilla/5.0 private-user", authorization: "Bearer secret-token", "x-request-id": "private-correlation" } }, "ledger", "browser", 200],
      ["/", { method: "HEAD", headers: { "user-agent": "tailnet-registry/1" } }, "index", "probe", 200],
      ["/", { headers: { "user-agent": "cloudflare-origin-probe/1" } }, "index", "probe", 200],
      ["/healthz", { headers: { "user-agent": "Mozilla/5.0" } }, "healthz", "probe", 200],
      ["/private-ledger-name?secret-query", {}, "not_found", "unknown", 404],
      ["/api/tally", { method: "POST", body: "private-body" }, "ledger", "unknown", 405],
    ];
    for (const [path, options, route, traffic, statusCode] of requests) {
      const count = records().length;
      const response = await fetch(`${origin}${path}`, options);
      assert.equal(response.status, statusCode);
      await response.text();
      const emitted = records().slice(count);
      assert.equal(emitted.length, 1);
      const [event] = emitted;
      assert.equal(event.operation, "http.request");
      assert.equal(event.service, "company-money-portal");
      assert.equal(event.context.route, route);
      assert.equal(event.context.method, options.method ?? "GET");
      assert.equal(event.context.statusCode, statusCode);
      assert.equal(event.traffic, traffic);
      assert.equal(event.outcome, statusCode >= 400 ? "failed" : "succeeded");
      assert.match(event.timestamp, /Z$/);
      assert.match(event.eventId, /^[0-9a-f-]{36}$/);
      assert.match(event.operationId, /^[0-9a-f-]{36}$/);
      assert.ok(event.host);
      assert.ok(event.durationMs >= 0);
    }
    assert.equal(new Set(records().map((event) => event.eventId)).size, requests.length);
  }, async () => sensitive);
  assert.doesNotMatch(raw, /private-|secret-|987654321|counterparty|currencies|transactions/);

  const failed = await withServer(async (origin, records) => {
    assert.equal((await fetch(`${origin}/api/tally`)).status, 503);
    assert.equal(records().length, 1);
    assert.deepEqual(records()[0].context, { method: "GET", route: "ledger", errorCode: "ENOENT", reasonCode: "ledger_unavailable", statusCode: 503 });
    assert.equal(records()[0].outcome, "failed");
    // A readable HTTP shell remains live even when the ledger is unavailable.
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal(records().length, 2);
    assert.equal(records()[1].traffic, "probe");
  }, async () => { throw Object.assign(new Error("private-path private-financial-error"), { code: "ENOENT" }); });
  assert.doesNotMatch(failed, /private-|financial/);
});

test("CLI startup failure emits one sanitized completion", () => {
  const result = spawnSync(process.execPath, [new URL("./portal-server.mjs", import.meta.url).pathname, "--root", "/private-ledger-root"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "service.start");
  assert.equal(events[0].outcome, "failed");
  assert.deepEqual(events[0].context, { ready: false, errorCode: "UNEXPECTED_ERROR" });
  assert.doesNotMatch(result.stdout, /private-ledger-root|missing required/);
});

test("read-only tally is uncached; failures are sanitized", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/tally`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { kind: "synthetic" });
    assert.equal((await fetch(`${origin}/api/tally`, { method: "POST" })).status, 405);
  }, async () => ({ kind: "synthetic" }));
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/tally`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "ledger unavailable" });
  }, async () => { throw new Error("synthetic sensitive content"); });
});
