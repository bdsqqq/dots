import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { acquireBackend, configurationFingerprint, inspectBackend, READINESS_PATH, type BackendObservation, type ExistingBackend } from "./lifecycle.ts";

const occupied = () => Object.assign(new Error("private unknown listener"), { code: "EADDRINUSE" });

test("compatible existing backend is observed, not killed or repeatedly started; loss permits takeover", async () => {
  const observations: BackendObservation[] = [];
  const sleeps: number[] = [];
  const states: ExistingBackend[] = ["ready", "ready", "degraded", "absent"];
  let starts = 0;
  const managed = { id: "managed" };
  const result = await acquireBackend({
    start() { if (++starts === 1) throw occupied(); return managed; },
    async inspect() { return states.shift()!; },
    async sleep(ms) { sleeps.push(ms); },
    observe: o => observations.push(o),
  });
  expect(result).toBe(managed);
  expect(starts).toBe(2);
  expect(sleeps).toEqual([30_000, 30_000, 30_000, 1000]);
  expect(observations.map(o => o.state)).toEqual(["adopted", "adopted_degraded", "port_conflict", "managed"]);
});

test("unknown process survives a port conflict and recovery exhausts a finite backoff budget", async () => {
  const child = spawn(process.execPath, ["-e", 'const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response("unknown backend")}});console.log(s.port)'], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout!.once("data", data => resolve(Number(data.toString().trim())));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fixture exited early")));
    });
    const origin = `http://127.0.0.1:${port}`;
    let starts = 0;
    const delays: number[] = [];
    const observations: BackendObservation[] = [];
    const result = await acquireBackend({
      start() { starts++; return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ours") }); },
      inspect: () => inspectBackend(origin, "expected-configuration"),
      async sleep(ms) { delays.push(ms); },
      observe: o => observations.push(o),
    });
    expect(result).toBeNull();
    expect(starts).toBe(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(observations.at(-1)).toEqual({ state: "recovery_exhausted", attempt: 5, retryInMs: 0 });
    expect(child.exitCode).toBeNull();
    expect(await (await fetch(origin)).text()).toBe("unknown backend");
  } finally {
    child.kill("SIGTERM"); // Only the child explicitly created by this test.
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
  }
});

test("adoption requires exact configuration/protocol identity, not just a successful HTTP response", async () => {
  const fingerprint = configurationFingerprint("/editable", "/state.json");
  const request = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;
  const identity = { service: "html-stuff", protocol: 1, configuration: fingerprint, ready: true };
  expect(await inspectBackend("http://localhost", fingerprint, request(identity))).toBe("ready");
  expect(await inspectBackend("http://localhost", fingerprint, request({ ...identity, ready: false }, 503))).toBe("degraded");
  expect(await inspectBackend("http://localhost", fingerprint, request({ ...identity, configuration: "different-root" }))).toBe("unknown");
  expect(await inspectBackend("http://localhost", fingerprint, request({ ready: true }))).toBe("unknown");
  expect(await inspectBackend("http://localhost", fingerprint, request({ ...identity, protocol: 2 }))).toBe("unknown");
  expect(await inspectBackend("http://localhost", fingerprint, request({ ...identity, padding: "x".repeat(5000) }))).toBe("unknown");
  expect(READINESS_PATH).toBe("/_html-stuff/ready");
});

test("non-collision startup failures remain failures for launchd's existing crash policy", async () => {
  await expect(acquireBackend({
    start() { throw Object.assign(new Error("private path"), { code: "EACCES" }); },
    inspect: async () => "absent", sleep: async () => {}, observe: () => {},
  })).rejects.toMatchObject({ code: "EACCES" });
});
