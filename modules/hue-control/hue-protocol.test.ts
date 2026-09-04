import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBrightness,
  decodeColorTemperature,
  decodeColorXy,
  encodeBrightness,
  encodeColorTemperature,
  encodeColorXy,
  encodePower,
  HUE_CHARACTERISTICS,
  HueProtocolSession,
} from "./hue-protocol.ts";
import type { HueGattConnection } from "./hue-protocol.ts";

test("hue codecs match upstream protocol fixtures", () => {
  assert.deepEqual([...encodePower(true)], [0x01]);
  assert.deepEqual([...encodePower(false)], [0x00]);
  assert.deepEqual([...encodeBrightness(5)], [0x05]);
  assert.deepEqual([...encodeBrightness(0)], [0x01]);
  assert.deepEqual([...encodeBrightness(255)], [0xfe]);
  assert.equal(decodeBrightness(Uint8Array.of(0xfa)), 250);
  assert.deepEqual([...encodeColorTemperature(300)], [0x2c, 0x01]);
  assert.equal(decodeColorTemperature(Uint8Array.of(0x72, 0x01)), 370);
  assert.deepEqual([...encodeColorXy(0.7, 0.5)], [0x32, 0xb3, 0xff, 0x7f]);
  assert.deepEqual(decodeColorXy(Uint8Array.of(0x32, 0xb3, 0xff, 0x7f)), [
    0.6999923704890516,
    0.49999237048905165,
  ]);
});

test("hue codecs reject malformed or non-finite values", () => {
  assert.throws(() => encodeBrightness(Number.NaN), /finite/);
  assert.throws(() => encodeColorTemperature(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => encodeColorXy(-0.1, 0.5), /between zero and one/);
  assert.throws(() => decodeColorXy(Uint8Array.of(0x00)), /four bytes/);
});

class FakeGatt implements HueGattConnection {
  readonly listeners = new Map<string, (value: Uint8Array) => void>();
  readonly writes: Array<readonly [string, Uint8Array]> = [];
  readonly values = new Map<string, Uint8Array>([
    [HUE_CHARACTERISTICS.power, Uint8Array.of(1)],
    [HUE_CHARACTERISTICS.brightness, Uint8Array.of(100)],
    [HUE_CHARACTERISTICS.colorTemperature, Uint8Array.of(0x2c, 0x01)],
    [HUE_CHARACTERISTICS.colorXy, Uint8Array.of(0x32, 0xb3, 0xff, 0x7f)],
    [HUE_CHARACTERISTICS.model, new TextEncoder().encode("LCA011")],
    [HUE_CHARACTERISTICS.name, new TextEncoder().encode("desk")],
  ]);

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

  async write(characteristic: string, value: Uint8Array): Promise<void> {
    this.writes.push([characteristic, value]);
  }
}

class BlockingGatt extends FakeGatt {
  #releaseFirstWrite!: () => void;
  readonly firstWrite = new Promise<void>((resolve) => {
    this.#releaseFirstWrite = resolve;
  });

  override async write(characteristic: string, value: Uint8Array): Promise<void> {
    await super.write(characteristic, value);
    if (this.writes.length === 1) await this.firstWrite;
  }

  releaseFirstWrite(): void {
    this.#releaseFirstWrite();
  }
}

test("a session reads state, applies serialized controls, and follows notifications", async () => {
  const gatt = new FakeGatt();
  const session = new HueProtocolSession(gatt);
  const observed: number[] = [];
  session.onState((state) => observed.push(state.brightness));

  const initialized = await session.initialize();
  assert.equal(initialized.ok, true);
  assert.deepEqual(session.state(), {
    brightness: 100,
    colorTemperature: 300,
    colorXy: [0.6999923704890516, 0.49999237048905165],
    model: "LCA011",
    name: "desk",
    power: true,
  });

  const first = session.setBrightness(200);
  const second = session.setPower(false);
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(
    gatt.writes.map(([characteristic, value]) => [characteristic, [...value]]),
    [
      [HUE_CHARACTERISTICS.brightness, [200]],
      [HUE_CHARACTERISTICS.power, [0]],
    ],
  );

  gatt.listeners.get(HUE_CHARACTERISTICS.brightness)?.(Uint8Array.of(42));
  assert.equal(session.state()?.brightness, 42);
  assert.deepEqual(observed, [100, 200, 200, 42]);

  await session.close();
  assert.equal(gatt.listeners.size, 0);
});

test("a session bounds rapid writes by retaining only the latest pending value", async () => {
  const gatt = new BlockingGatt();
  const session = new HueProtocolSession(gatt);
  assert.equal((await session.initialize()).ok, true);

  const first = session.setBrightness(10);
  const superseded = Array.from({ length: 89 }, (_, index) => session.setBrightness(index + 11));
  assert.deepEqual(gatt.writes.map(([, value]) => [...value]), [[10]]);

  gatt.releaseFirstWrite();
  assert.equal((await first).ok, true);
  const results = await Promise.all(superseded);
  assert.deepEqual(gatt.writes.map(([, value]) => [...value]), [[10], [99]]);
  assert.equal(results.every((result) => result.ok && result.value.brightness === 99), true);
});

test("a session reports expected connection and command failures as values", async () => {
  const missing = new FakeGatt();
  missing.values.delete(HUE_CHARACTERISTICS.power);
  const unavailable = await new HueProtocolSession(missing).initialize();
  assert.deepEqual(unavailable, {
    error: "unavailable",
    message: `missing ${HUE_CHARACTERISTICS.power}`,
    ok: false,
  });

  const session = new HueProtocolSession(new FakeGatt());
  assert.deepEqual(await session.setBrightness(Number.NaN), {
    error: "invalid-command",
    message: "brightness must be finite",
    ok: false,
  });
  assert.deepEqual(await session.setPower(true), {
    error: "unavailable",
    message: "light is not connected",
    ok: false,
  });
});
