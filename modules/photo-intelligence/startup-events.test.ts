import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("port binding failure completes startup safely before background work begins", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "intelligence-start-events-"));
  const busy = createServer();
  await new Promise<void>(resolve => busy.listen(0, "127.0.0.1", resolve));
  const address = busy.address();
  assert.ok(address && typeof address !== "string");
  await mkdir(join(temporary, "PRIVATE_CANARY-source"));
  const child = spawn(process.execPath, [new URL("./photo-intelligence-server.mjs", import.meta.url).pathname,
    "--source", join(temporary, "PRIVATE_CANARY-source"), "--state", join(temporary, "PRIVATE_CANARY-state"),
    "--port", String(address.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let stderr = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 3_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 1);
    const records = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ok(records.some(event => event.operation === "service.start" && event.outcome === "failed" && event.context.errorCode === "EADDRINUSE"));
    assert.ok(!records.some(event => event.operation === "service.start" && event.outcome === "succeeded"));
    assert.equal(stderr, "");
    assert.doesNotMatch(output, /PRIVATE_CANARY/);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    await new Promise<void>(resolve => busy.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
