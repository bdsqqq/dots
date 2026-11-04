import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServiceEvent } from "../service-events/events.ts";
import { galleryServer } from "./photo-gallery-server.mjs";

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
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY|secret-query|\.jpg|authorization/);
  return records;
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("event did not arrive");
}
const listen = (server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise<void>((resolve) => { server.close(resolve); server.closeAllConnections(); });

test("gallery source emits bounded HTTP/proxy outcomes and distinguishes probe user agents", async () => {
  await capture(async (records) => {
    const upstream = createServer((incoming, outgoing) => {
      if (incoming.url.includes("upload-abort")) { incoming.resume(); return; }
      if (incoming.url.includes("abort")) {
        outgoing.writeHead(200).write("private-body");
        if (incoming.url.includes("upstream-abort")) setTimeout(() => outgoing.destroy(), 10);
        return;
      }
      outgoing.end("PRIVATE_CANARY-photo-body");
    });
    await listen(upstream);
    const gallery = galleryServer({ assets: { html: "PRIVATE_CANARY", css: "css", js: "js" }, backendPort: upstream.address().port, intelligenceUrl: "http://127.0.0.1:1" });
    await listen(gallery);
    const origin = `http://127.0.0.1:${gallery.address().port}`;
    try {
      for (const [path, agent] of [["/gallery/", "Mozilla/5.0"], ["/gallery/", "tailnet-registry/1"], ["/gallery/", "cloudflare-origin-probe/1"], ["/gallery/raw/PRIVATE_CANARY.jpg?secret-query", "Mozilla/5.0"]]) {
        const response = await fetch(`${origin}${path}`, { headers: { "user-agent": agent, authorization: "PRIVATE_CANARY" } });
        assert.equal(response.status, 200);
        await response.text();
      }
      assert.deepEqual(records.map((event) => event.traffic), ["browser", "probe", "probe", "browser"]);
      assert.equal(records[3].context.route, "media");
      assert.equal((await fetch(`${origin}/gallery/api/timeline?PRIVATE_CANARY`)).status, 502);
      assert.equal((await fetch(`${origin}/PRIVATE_CANARY`)).status, 404);
      await new Promise<void>((resolve, reject) => {
        const client = request(`${origin}/gallery/raw/client-abort?PRIVATE_CANARY`, (response) => {
          response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
        });
        client.once("error", reject); client.end();
      });
      await waitFor(() => records.length === 7);
      const response = await fetch(`${origin}/gallery/raw/upstream-abort?PRIVATE_CANARY`);
      await assert.rejects(response.text());
      await waitFor(() => records.length === 8);
      assert.equal(records[4].context.reasonCode, "PROXY_FAILED");
      assert.equal(records[4].context.errorCode, "ECONNREFUSED");
      assert.equal(records[6].context.reasonCode, "CLIENT_ABORTED");
      assert.equal(records[7].context.reasonCode, "UPSTREAM_INTERRUPTED");
      assert.ok(records.slice(4).every((event) => event.outcome === "failed"));
      await new Promise<void>((resolve) => {
        const client = request(`${origin}/gallery/raw/upload-abort?PRIVATE_CANARY`, { method: "POST", headers: { "content-length": "1024" } });
        client.on("error", () => {});
        client.write("PRIVATE_CANARY");
        setTimeout(() => { client.destroy(); resolve(); }, 10);
      });
      await waitFor(() => records.length === 9);
      assert.equal(records[8].context.reasonCode, "CLIENT_ABORTED");
      assert.equal(records[8].outcome, "failed");
    } finally { await close(gallery); await close(upstream); }
    assert.equal(records.length, 9);
  });
});

test("a missing backend still fails startup instead of being swallowed by instrumentation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gallery-start-events-"));
  const asset = join(temporary, "PRIVATE_CANARY.html");
  await writeFile(asset, "PRIVATE_CANARY");
  const child = spawn(process.execPath, [new URL("./photo-gallery-server.mjs", import.meta.url).pathname,
    "--source", temporary, "--state", temporary, "--copyparty", join(temporary, "PRIVATE_CANARY-missing"),
    "--html", asset, "--css", asset, "--js", asset, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let stderr = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 1_500);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 1, "backend spawn failure must not leave a listening server behind");
    const records = output.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.some(event => event.operation === "service.start" && event.outcome === "failed"));
    assert.ok(records.some(event => event.operation === "backend.start" && event.context.errorCode === "ENOENT"));
    assert.ok(!records.some(event => event.operation === "service.start" && event.outcome === "succeeded"));
    assert.doesNotMatch(output + stderr, /PRIVATE_CANARY/);
  } finally { clearTimeout(timer); child.kill("SIGTERM"); await rm(temporary, { recursive: true, force: true }); }
});

test("a gallery bind failure records startup and terminates its candidate backend", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gallery-bind-events-"));
  const busy = createServer();
  await listen(busy);
  const backend = join(temporary, "PRIVATE_CANARY-backend");
  const asset = join(temporary, "PRIVATE_CANARY.html");
  await writeFile(backend, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(backend, 0o700);
  await writeFile(asset, "PRIVATE_CANARY");
  const child = spawn(process.execPath, [new URL("./photo-gallery-server.mjs", import.meta.url).pathname,
    "--source", temporary, "--state", temporary, "--copyparty", backend,
    "--html", asset, "--css", asset, "--js", asset, "--port", String(busy.address().port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let stderr = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 3_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 1);
    const records = output.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.some(event => event.operation === "service.start" && event.outcome === "failed" && event.context.errorCode === "EADDRINUSE"));
    assert.ok(!records.some(event => event.operation === "service.start" && event.outcome === "succeeded"));
    assert.equal(stderr, "");
    assert.doesNotMatch(output, /PRIVATE_CANARY/);
  } finally { clearTimeout(timer); child.kill("SIGTERM"); await close(busy); await rm(temporary, { recursive: true, force: true }); }
});

test("source CLI records startup and unexpected backend exit without raw paths or stderr rewrites", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gallery-events-"));
  const backend = join(temporary, "PRIVATE_CANARY.mjs");
  await writeFile(backend, `#!${process.execPath}\nsetTimeout(() => process.exit(42), 100);\n`);
  await chmod(backend, 0o700);
  const asset = join(temporary, "PRIVATE_CANARY.html");
  await writeFile(asset, "PRIVATE_CANARY");
  try {
    const child = spawn(process.execPath, [new URL("./photo-gallery-server.mjs", import.meta.url).pathname,
      "--source", temporary, "--state", temporary, "--copyparty", backend,
      "--html", asset, "--css", asset, "--js", asset, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 1);
    const records = output.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.some((event) => event.operation === "backend.start" && event.outcome === "succeeded"));
    assert.ok(records.some((event) => event.operation === "backend.exit" && event.context.reasonCode === "UNEXPECTED_EXIT"));
    assert.ok(records.some((event) => event.operation === "service.start" && event.context.readiness === "listening"));
    assert.doesNotMatch(output + stderr, /PRIVATE_CANARY/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
