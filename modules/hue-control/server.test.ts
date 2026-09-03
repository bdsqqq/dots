import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { HueDevice } from "./ble-adapter.ts";
import type { HueResult, HueState } from "./hue-protocol.ts";
import type { HueRuntimeSnapshot } from "./runtime.ts";
import { createHueControlServer, listen } from "./server.ts";
import type { HueRuntimeApi } from "./server.ts";

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
): Promise<void> {
  const runtime = new FakeRuntime();
  const server = createHueControlServer(runtime);
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
