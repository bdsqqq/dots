import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { ServiceEvent } from "./events.ts";

for (const [service, variable, args] of [
  ["files-browser", "FILES_BROWSER_BINARY", ["--source", "/PRIVATE_CANARY-missing", "--state", "/PRIVATE_CANARY-unused"]],
  ["photo-gallery", "PHOTO_GALLERY_BINARY", ["--source", "/PRIVATE_CANARY-missing", "--state", "/PRIVATE_CANARY-unused"]],
  ["photo-intelligence", "PHOTO_INTELLIGENCE_BINARY", ["--source", "/PRIVATE_CANARY-missing"]],
  ["tailnet-registry", "TAILNET_REGISTRY_BINARY", ["--config", "/PRIVATE_CANARY-missing", "--state-dir", "/PRIVATE_CANARY-unused"]],
  ["hue-control", "HUE_CONTROL_BINARY", ["--port", "PRIVATE_CANARY-invalid"]],
] as const) {
  const binary = process.env[variable];
  test(`built ${service} package retains logger and reports safe startup failure`, { skip: !binary }, () => {
    const script = service === "hue-control" ? process.env.HUE_CONTROL_SCRIPT : undefined;
    if (service === "hue-control") assert.ok(script, "HUE_CONTROL_SCRIPT must name the bundled daemon entrypoint");
    const result = spawnSync(binary!, [...(script ? [script] : []), ...args], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1, result.stderr);
    const records: ServiceEvent[] = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ok(records.some(event => event.service === service && event.operation === "service.start" && event.outcome === "failed"));
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("PRIVATE_CANARY"));
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

for (const [service, variable] of [["html-stuff", "HTML_STUFF_BINARY"], ["company-money-portal", "MONEY_PORTAL_BINARY"]] as const) {
  const binary = process.env[variable];
  test(`built ${service} package imports logger and emits private request completions`, { skip: !binary }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "service-package-"));
    const port = await unusedPort();
    await mkdir(join(directory, "ledger"));
    await writeFile(join(directory, "private-artifact.html"), "<title>fixture</title>fixture");
    // The packaged portal wrapper already supplies its bundled assets; duplicate flags are rejected.
    const args = service === "html-stuff" ? ["--directory", directory, "--port", String(port)] : [
      "--root", join(directory, "ledger"), "--port", String(port),
    ];
    const child = spawn(binary!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let startupError: Error | undefined;
    child.once("error", error => { startupError = error; });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
    const records = (): ServiceEvent[] => output.split("\n").filter(line => line.startsWith('{"schemaVersion":')).map(line => JSON.parse(line));
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate() && Date.now() < deadline && child.exitCode === null && !startupError) await sleep(20);
      if (startupError) throw startupError;
      assert.ok(predicate(), `package did not emit expected events: ${errors}; ${JSON.stringify(records())}`);
    };
    try {
      await wait(() => records().some(event => event.operation === "service.start" && event.outcome === "succeeded"));
      const origin = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(origin, { headers: { "user-agent": "Mozilla/5.0" } })).status, 200);
      assert.equal((await fetch(origin, { headers: { "user-agent": "tailnet-registry/1" } })).status, 200);
      const failing = service === "html-stuff" ? "/private-missing.html?private-query" : "/api/tally?private-query";
      assert.ok((await fetch(origin + failing)).status >= 400);
      await wait(() => records().filter(event => event.operation === "http.request").length === 3);
      const requests = records().filter(event => event.operation === "http.request");
      assert.deepEqual(requests.map(event => event.traffic), ["browser", "probe", "unknown"]);
      assert.equal(requests[2].outcome, "failed");
      assert.ok(requests.every(event => event.service === service && event.operationId && event.durationMs >= 0));
      assert.ok(!output.includes("private-missing"));
      assert.ok(!output.includes("private-query"));
      assert.ok(!output.includes(directory));
    } finally {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3_000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
