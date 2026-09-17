import assert from "node:assert/strict";
import test from "node:test";
import { Characteristic } from "@homebridge/hap-nodejs";
import { HomeKitLight, fromXy, toXy } from "./light.ts";

test("color conversion matches sRGB primaries, not swapped xy or HSV channels", () => {
  const blue = toXy(240, 100);
  assert.ok(Math.abs(blue[0] - 0.15) < 0.001);
  assert.ok(Math.abs(blue[1] - 0.06) < 0.001);
  const green = fromXy([0.3, 0.6]);
  assert.ok(Math.abs(green[0] - 120) < 0.1);
  assert.ok(green[1] > 99);
  const white = fromXy([0.3127, 0.329]);
  assert.ok(white[1] < 0.1);
});

test("HomeKit translates commands, polls external state, and recovers from outages", async () => {
  let available = true;
  const light = { power: false, brightness: 127, colorTemperature: 65535, colorXy: [0.3, 0.6] };
  const writes: object[] = [];
  const lamp = new HomeKitLight("http://daemon", async (url, init) => {
    if (!available) return Response.json({}, { status: 503 });
    if (String(url).endsWith("/api/light")) {
      writes.push(JSON.parse(String(init?.body)));
      Object.assign(light, writes.at(-1));
      return Response.json(light);
    }
    return Response.json({ status: "available", light });
  });
  await lamp.poll();
  const c = (type: typeof Characteristic.On) => lamp.service.getCharacteristic(type);
  assert.equal(await c(Characteristic.On).handleGetRequest(), false);
  assert.equal(await c(Characteristic.Brightness).handleGetRequest(), 50);
  assert.equal(await c(Characteristic.ColorTemperature).handleGetRequest(), 250);
  await c(Characteristic.On).handleSetRequest(true);
  assert.equal(await c(Characteristic.On).handleGetRequest(), true);
  await c(Characteristic.Brightness).handleSetRequest(25);
  await c(Characteristic.Brightness).handleSetRequest(0);
  await c(Characteristic.ColorTemperature).handleSetRequest(400);
  await Promise.all([
    c(Characteristic.Hue).handleSetRequest(240),
    c(Characteristic.Saturation).handleSetRequest(100),
  ]);
  assert.deepEqual(writes.slice(0, 4), [{ power: true }, { brightness: 64 }, { power: false }, { colorTemperature: 400 }]);
  const xy = (writes.at(-1) as { colorXy: number[] }).colorXy;
  assert.ok(Math.abs(xy[0] - 0.15) < 0.001 && Math.abs(xy[1] - 0.06) < 0.001);
  light.power = true;
  light.brightness = 254;
  await lamp.poll();
  assert.equal(c(Characteristic.On).value, true);
  assert.equal(c(Characteristic.Brightness).value, 100);
  available = false;
  await lamp.poll();
  await assert.rejects(c(Characteristic.On).handleGetRequest());
  await assert.rejects(c(Characteristic.On).handleSetRequest(false));
  available = true;
  await lamp.poll();
  assert.equal(await c(Characteristic.On).handleGetRequest(), true);
});

test("a stale poll cannot overwrite hue while HomeKit sends separate hue/saturation writes", async () => {
  let finish!: (response: Response) => void;
  const writes: { colorXy: number[] }[] = [];
  const lamp = new HomeKitLight("http://daemon", async (_, init) => {
    if (!init?.method) return new Promise<Response>((resolve) => { finish = resolve; });
    writes.push(JSON.parse(String(init.body)));
    return Response.json({});
  });
  const poll = lamp.poll();
  await lamp.service.getCharacteristic(Characteristic.Hue).handleSetRequest(240);
  finish(Response.json({ status: "available", light: { power: true, brightness: 254, colorTemperature: 250, colorXy: [0.3, 0.6] } }));
  await poll;
  await lamp.service.getCharacteristic(Characteristic.Saturation).handleSetRequest(100);
  assert.ok(Math.abs(writes.at(-1)!.colorXy[0] - 0.15) < 0.001);
});
