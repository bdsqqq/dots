import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createEventLogger } from "../service-events/events.ts";
import type { ServiceEvent } from "../service-events/events.ts";

import type { HueDevice } from "./ble-adapter.ts";
import type { HueResult, HueState } from "./hue-protocol.ts";
import type { HueRuntimeSnapshot } from "./runtime.ts";
import { createHueControlServer, listen } from "./server.ts";
import type { HueRuntimeApi, HueServerOptions } from "./server.ts";

const light: HueState = {
  brightness: 100,
  colorTemperature: 300,
  colorXy: [0.7, 0.5],
  model: "LCA011",
  name: "desk",
  power: true,
};

class FakeRuntime implements HueRuntimeApi {
  enrolled: string | null = null;
  available = true;

  async discover(): Promise<HueDevice> {
    if (!this.available) throw new Error("bluetooth unavailable");
    return { id: "device-id", name: "desk" };
  }

  async enroll(deviceId: string): Promise<void> {
    this.enrolled = deviceId;
  }

  async reconnect(): Promise<void> {}

  setBrightness(value: number): Promise<HueResult<HueState>> {
    return this.command({ ...light, brightness: value });
  }

  setColorTemperature(value: number): Promise<HueResult<HueState>> {
    return this.command({ ...light, colorTemperature: value });
  }

  setColorXy(x: number, y: number): Promise<HueResult<HueState>> {
    return this.command({ ...light, colorXy: [x, y] });
  }

  setPower(value: boolean): Promise<HueResult<HueState>> {
    return this.command({ ...light, power: value });
  }

  snapshot(): HueRuntimeSnapshot {
    return {
      deviceId: this.enrolled,
      lastError: this.available ? null : "bluetooth unavailable",
      light: this.available ? light : null,
      status: this.enrolled ? (this.available ? "available" : "unavailable") : "unenrolled",
    };
  }

  private async command(state: HueState): Promise<HueResult<HueState>> {
    return this.available
      ? { ok: true, value: state }
      : { error: "unavailable", message: "bluetooth unavailable", ok: false };
  }
}

async function withServer(
  run: (origin: string, runtime: FakeRuntime) => Promise<void>,
  options: HueServerOptions = {},
): Promise<void> {
  const runtime = new FakeRuntime();
  const server = createHueControlServer(runtime, options);
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, runtime);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("liveness stays healthy while readiness truthfully reports an unavailable light", async () => {
  await withServer(async (origin, runtime) => {
    const ready = async () => {
      const response = await fetch(`${origin}/ready`);
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await ready(), { status: 503, body: { ready: false, readiness: "unenrolled", reasonCode: "unenrolled" } });
    runtime.enrolled = "private-device";
    runtime.available = false;
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.deepEqual(await ready(), { status: 503, body: { ready: false, readiness: "unavailable", reasonCode: "unavailable" } });
    runtime.available = true;
    assert.deepEqual(await ready(), { status: 200, body: { ready: true, readiness: "available", reasonCode: "connected" } });
  });
});

test("server exposes UI, health, state, discovery, enrollment, and controls", async () => {
  await withServer(async (origin, runtime) => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /nearby light/);

    const health = await fetch(`${origin}/health`);
    assert.deepEqual(await health.json(), { lightAvailable: false, ok: true });

    const discovered = await fetch(`${origin}/api/discover`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.deepEqual(await discovered.json(), { id: "device-id", name: "desk" });

    const commissioned = await fetch(`${origin}/api/commission`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(commissioned.status, 200);
    assert.equal(runtime.enrolled, "device-id");

    const enrolled = await fetch(`${origin}/api/enroll`, {
      body: JSON.stringify({ deviceId: "device-id" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(enrolled.status, 200);
    assert.equal(runtime.enrolled, "device-id");

    const command = await fetch(`${origin}/api/light`, {
      body: JSON.stringify({ brightness: 42 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(command.status, 200);
    assert.equal((await command.json()).brightness, 42);
  });
});

test("server rejects malformed requests and maps transport failures to 503", async () => {
  await withServer(async (origin, runtime) => {
    const wrongType = await fetch(`${origin}/api/light`, { body: "{}", method: "POST" });
    assert.equal(wrongType.status, 400);

    const multiple = await fetch(`${origin}/api/light`, {
      body: JSON.stringify({ brightness: 42, power: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(multiple.status, 400);

    runtime.enrolled = "device-id";
    runtime.available = false;
    const command = await fetch(`${origin}/api/light`, {
      body: JSON.stringify({ power: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(command.status, 503);

    const discovery = await fetch(`${origin}/api/discover`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(discovery.status, 503);
  });
});

function captureEvents() {
  const lines: string[] = [];
  const events = createEventLogger("hue-control", {
    host: "test-host", sink: (event) => lines.push(JSON.stringify(event)),
  });
  return { events, lines, emitted: (): ServiceEvent[] => lines.map((line) => JSON.parse(line)) };
}

test("HTTP JSON events distinguish browser hints and probes, retain outcomes, and omit private input/output", async () => {
  const capture = captureEvents();
  await withServer(async (origin, runtime) => {
    const browser = { "user-agent": "Mozilla/5.0 private-browser" };
    assert.equal((await fetch(`${origin}/?secret=private-query`, { headers: browser })).status, 200);
    for (const agent of ["tailnet-registry/1 private-registry", "cloudflare-origin-probe/1 private-cloudflare"]) {
      assert.equal((await fetch(origin, { headers: { "user-agent": agent } })).status, 200);
    }
    const health = await fetch(`${origin}/health?private-query`, { headers: browser });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, lightAvailable: false });
    const enrolled = await fetch(`${origin}/api/enroll?private-query`, {
      method: "POST", body: JSON.stringify({ deviceId: "private-device-id" }),
      headers: { ...browser, "content-type": "application/json", authorization: "Bearer private-token", "x-request-id": "private-request-id" },
    });
    assert.equal(enrolled.status, 200);
    assert.equal((await enrolled.json()).deviceId, "private-device-id", "API identity is unchanged, only logs omit it");
    const command = await fetch(`${origin}/api/light`, {
      method: "POST", body: JSON.stringify({ brightness: 42 }),
      headers: { ...browser, "content-type": "application/json" },
    });
    assert.equal(command.status, 200);
    assert.equal((await command.json()).brightness, 42);
    const invalid = await fetch(`${origin}/api/light`, {
      method: "POST", body: '{"private-body":true}', headers: { "content-type": "application/json" },
    });
    assert.equal(invalid.status, 400);
    const missing = await fetch(`${origin}/private-path?private-query`);
    assert.equal(missing.status, 404);
    runtime.available = false;
    const unavailable = await fetch(`${origin}/api/light`, {
      method: "POST", body: '{"power":true}', headers: { "content-type": "application/json" },
    });
    assert.equal(unavailable.status, 503);
    runtime.discover = async () => { throw Object.assign(new Error("private-error-device-path"), { code: "ETIMEDOUT" }); };
    const failed = await fetch(`${origin}/api/discover`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).message, "private-error-device-path", "existing error response is preserved");
  }, capture);
  const emitted = capture.emitted();
  assert.equal(emitted.length, 10, "one completion per significant request, not finish+close duplicates");
  assert.deepEqual(emitted.slice(0, 4).map((event) => event.traffic), ["browser", "probe", "probe", "probe"]);
  assert.equal(emitted[3].outcome, "degraded");
  assert.equal(emitted[3].context.statusCode, 200);
  assert.equal(emitted[3].context.ready, false);
  assert.equal(emitted[4].context.enrolled, true);
  assert.equal(emitted[5].outcome, "succeeded");
  assert.equal(emitted[6].context.errorCode, "INVALID_REQUEST");
  assert.equal(emitted[7].context.route, "not_found");
  assert.equal(emitted[8].context.reasonCode, "unavailable");
  assert.equal(emitted[9].context.errorCode, "ETIMEDOUT");
  assert.equal(new Set(emitted.map((event) => event.operationId)).size, emitted.length);
  for (const event of emitted) {
    assert.equal(event.operation, "http.request");
    assert.equal(event.service, "hue-control");
    assert.ok(event.durationMs >= 0);
    assert.match(event.timestamp, /Z$/);
    assert.match(event.operationId, /^[0-9a-f-]{36}$/);
  }
  assert.doesNotMatch(capture.lines.join("\n"), /private-|deviceId|authorization|Mozilla|lastError|LCA011|desk|http:|\?secret/);
});

test("health/state poll summaries preserve readiness changes and per-traffic counts without poll spam", async () => {
  const capture = captureEvents();
  let clock = 0;
  await withServer(async (origin, runtime) => {
    const health = async () => (await fetch(`${origin}/health`)).json();
    await health();
    for (let i = 0; i < 5; i++) await health();
    assert.equal(capture.emitted().length, 1);
    clock = 60_000;
    await health();
    assert.equal(capture.emitted().length, 2);
    assert.equal(capture.emitted()[1].operation, "http.poll_summary");
    assert.equal(capture.emitted()[1].context.observationCount, 6);
    const state = async (agent = "Mozilla/5.0") => (await fetch(`${origin}/api/state`, {
      headers: { "user-agent": agent },
    })).json();
    await state();
    await state();
    await state();
    assert.equal(capture.emitted().length, 3);
    await state("tailnet-registry/1");
    assert.equal(capture.emitted().length, 4, "probe observations do not merge into browser-like traffic");
    runtime.enrolled = "private-device";
    await state();
    assert.equal(capture.emitted().length, 6, "pending old readiness flushes before changed state");
    assert.equal(capture.emitted()[4].context.observationCount, 2);
    assert.equal(capture.emitted()[4].outcome, "degraded");
    assert.equal(capture.emitted()[5].outcome, "succeeded");
    assert.equal(capture.emitted()[5].context.ready, true);
    await state();
    assert.equal(capture.emitted().length, 6);
  }, { ...capture, now: () => clock });
  assert.equal(capture.emitted().length, 7, "server close flushes pending poll summaries");
  const counts = capture.emitted().reduce((total, event) => total + event.context.observationCount!, 0);
  assert.equal(counts, 13);
  assert.doesNotMatch(capture.lines.join("\n"), /private-device|deviceId|desk|LCA011/);
});
