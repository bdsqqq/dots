import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("independent bridges listen concurrently and retain their own identity after restart", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hue-homekit-test-"));
  const stops: (() => Promise<void>)[] = [];
  const daemon = createServer((_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "available", light: {
      power: true, brightness: 127, colorTemperature: 250, colorXy: [0.3, 0.6],
    } }));
  });
  t.after(async () => {
    await Promise.all(stops.map((stop) => stop()));
    daemon.close();
    await rm(directory, { recursive: true, force: true });
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const origin = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
  async function unusedPort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  async function start(id: string, port: number) {
    const child = spawn(process.execPath, [
      new URL("./main.ts", import.meta.url).pathname, join(directory, id), origin,
      "127.0.0.1", String(port), `Test Bridge ${id}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    };
    stops.push(stop);
    let output = "";
    child.stderr.on("data", (chunk) => { output += chunk; });
    await Promise.race([
      new Promise<void>((resolve) => child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("HomeKit mDNS advertisement completed")) resolve();
      })),
      exited.then(() => { throw new Error(`bridge exited before advertising: ${output}`); }),
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/accessories`);
    assert.equal(response.status, 470, "unpaired clients cannot read accessories");
    await response.text();
    return stop;
  }
  const firstPort = await unusedPort();
  await start("first", firstPort);
  const secondPort = await unusedPort();
  const stopSecond = await start("second", secondPort);
  const pairing = async (id: string) => JSON.parse(await readFile(join(directory, id, "pairing.json"), "utf8"));
  const first = await pairing("first");
  const second = await pairing("second");
  assert.notEqual(first.username, second.username);
  assert.equal((await stat(join(directory, "second", "pairing.json"))).mode & 0o777, 0o600);
  await stopSecond();
  await start("second", secondPort);
  assert.deepEqual(await pairing("second"), second);
  assert.deepEqual(await pairing("first"), first);
  const response = await fetch(`http://127.0.0.1:${firstPort}/accessories`);
  assert.equal(response.status, 470, "restarting the second bridge leaves the first running");
  await response.text();
});
