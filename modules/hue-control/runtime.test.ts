import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HueBleAdapter, HueBleConnection, HueDevice } from "./ble-adapter.ts";
import { HUE_CHARACTERISTICS } from "./hue-protocol.ts";
import { HueRuntime } from "./runtime.ts";

class FakeConnection implements HueBleConnection {
  readonly listeners = new Map<string, (value: Uint8Array) => void>();
  readonly values = new Map<string, Uint8Array>([
    [HUE_CHARACTERISTICS.power, Uint8Array.of(1)],
    [HUE_CHARACTERISTICS.brightness, Uint8Array.of(100)],
    [HUE_CHARACTERISTICS.colorTemperature, Uint8Array.of(0x2c, 0x01)],
    [HUE_CHARACTERISTICS.colorXy, Uint8Array.of(0x32, 0xb3, 0xff, 0x7f)],
    [HUE_CHARACTERISTICS.model, new TextEncoder().encode("LCA011")],
    [HUE_CHARACTERISTICS.name, new TextEncoder().encode("desk")],
  ]);
  failWrites = false;
  disconnected = false;

  async read(characteristic: string): Promise<Uint8Array> {
    const value = this.values.get(characteristic);
    if (!value) throw new Error(`missing ${characteristic}`);
    return value;
  }

  async subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    this.listeners.set(characteristic, listener);
    return async () => {
      this.listeners.delete(characteristic);
    };
  }

  async write(): Promise<void> {
    if (this.failWrites) throw new Error("radio disappeared");
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeAdapter implements HueBleAdapter {
  readonly connection = new FakeConnection();
  readonly connectedIds: string[] = [];
  failConnect = false;
  lost: (() => void) | null = null;

  async discover(): Promise<HueDevice> {
    return { id: "corebluetooth-id", name: "desk" };
  }

  async connect(deviceId: string, disconnected: () => void): Promise<HueBleConnection> {
    this.connectedIds.push(deviceId);
    this.lost = disconnected;
    if (this.failConnect) throw new Error("bulb not found");
    return this.connection;
  }
}

test("runtime enrolls one explicit device, persists it, and exposes live state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-runtime-"));
  const statePath = join(directory, "state.json");
  const adapter = new FakeAdapter();
  const runtime = new HueRuntime(adapter, statePath);
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().status, "unenrolled");
    assert.deepEqual(await runtime.discover(), { id: "corebluetooth-id", name: "desk" });

    await runtime.enroll("corebluetooth-id");
    assert.deepEqual(adapter.connectedIds, ["corebluetooth-id"]);
    assert.equal(runtime.snapshot().status, "available");
    assert.equal(runtime.snapshot().light?.model, "LCA011");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
      deviceId: "corebluetooth-id",
    });

    const changed = await runtime.setBrightness(42);
    assert.equal(changed.ok, true);
    assert.equal(runtime.snapshot().light?.brightness, 42);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("runtime restores identity and clears stale state after transport failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-runtime-"));
  const statePath = join(directory, "state.json");
  const firstAdapter = new FakeAdapter();
  const first = new HueRuntime(firstAdapter, statePath);
  try {
    await first.start();
    await first.enroll("saved-id");
    await first.stop();

    const adapter = new FakeAdapter();
    const runtime = new HueRuntime(adapter, statePath);
    await runtime.start();
    await runtime.reconnect();
    assert.deepEqual(adapter.connectedIds, ["saved-id"]);
    assert.equal(runtime.snapshot().status, "available");

    adapter.connection.failWrites = true;
    assert.deepEqual(await runtime.setPower(false), {
      error: "unavailable",
      message: "radio disappeared",
      ok: false,
    });
    assert.equal(runtime.snapshot().status, "unavailable");
    assert.equal(runtime.snapshot().light, null);
    assert.equal(adapter.connection.disconnected, true);
    await runtime.stop();
  } finally {
    await first.stop();
    await rm(directory, { recursive: true });
  }
});
