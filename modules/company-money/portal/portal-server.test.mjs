import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
