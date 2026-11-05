import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, TransportError, isJson, singleCallback } from "../src/protocol.ts";
import { identityFromDeviceInfo, wifiNetworkFromValues } from "../src/sdk.ts";
import { catalog } from "../src/catalog.generated.ts";
import { validateFieldValue } from "../src/discovery.ts";
import type { Json, WireRequest } from "../src/protocol.ts";
import { sdk, response, callback, ok } from "./helpers.ts";
const deviceInfo = {
  Manufacturer: "Sagemcom",
  ModelName: "fixture",
  ProductClass: "fixture-class",
  HardwareVersion: "fixture-hw",
  SoftwareVersion: "fixture-sw",
  GUIAPIVersion: "2.92",
};
const guest = "Device/WiFi/AccessPoints/AccessPoint[Alias='GUEST1']/Security/KeyPassphrase";

test("identity and Wi-Fi snapshots are pure; SDK helpers reuse the same adapters", async () => {
  const expected = identityFromDeviceInfo(deviceInfo);
  assert.deepEqual(identityFromDeviceInfo({ DeviceInfo: deviceInfo }), expected);
  assert.deepEqual(wifiNetworkFromValues("", false), { ssid: "", enabled: false });
  assert.throws(() => identityFromDeviceInfo({}), ProtocolError);
  let calls = 0;
  const router = sdk((r) => {
    calls++;
    return response(r, [{ DeviceInfo: deviceInfo }]);
  });
  assert.deepEqual(await router.identify(), expected);
  assert.equal(calls, 1);
});

test("typed model reads, validates and rejects JS bypasses before sending invalid writes", async () => {
  let calls = 0;
  const router = sdk(
    (r) => {
      calls++;
      return response(r, [r.actions[0]!.method === "getValue" ? "fixture" : "ok"]);
    },
    { allowMutations: true },
  );
  const model = await router.model.get("Device/DeviceInfo/SoftwareVersion");
  assert.equal(model, "fixture");
  await router.model.set("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID", "new name");
  assert.equal(calls, 2);
  await assert.rejects(router.model.get("Device/WiFi/SSIDs/SSID/SSID" as never), /selector/);
  assert.throws(
    () => router.model.set("Device/DeviceInfo/SoftwareVersion" as never, "oops" as never),
    /configurable/,
  );
  assert.throws(
    () => router.model.set("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID", 1 as never),
    TypeError,
  );
  assert.throws(
    () => router.model.set("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID", "x".repeat(33)),
    /maximum/,
  );
  assert.equal(calls, 2);
});

test("single reads cannot silently discard wildcard callbacks; readAll/model.getAll retain each", async () => {
  const router = sdk(
    () =>
      new Response(
        JSON.stringify({
          reply: {
            error: { code: 16777216, description: "ok" },
            actions: [{ id: 0, error: ok, callbacks: [callback("a"), callback("b")] }],
          },
        }),
      ),
  );
  await assert.rejects(router.get("Device/WiFi/SSIDs/*"), ProtocolError);
  assert.deepEqual(
    (await router.readAll("Device/WiFi/SSIDs/*")).map((r) => r.value),
    ["a", "b"],
  );
  assert.deepEqual(await router.model.getAll("Device/WiFi/SSIDs/SSID[*]/SSID"), ["a", "b"]);
  assert.throws(
    () => singleCallback({ error: { code: 16777216, description: "ok" }, actions: [] }),
    ProtocolError,
  );
});

test("model validates router output and does not mutate shared catalog through its public snapshot", async () => {
  const router = sdk((r) => response(r, [false]));
  await assert.rejects(router.model.get("Device/DeviceInfo/SoftwareVersion"), TypeError);
  const snapshot = router.model.catalog;
  snapshot.nodes.length = 0;
  assert.equal(router.model.catalog.nodes.length, catalog.nodes.length);
});

test("typed commands share raw call behavior and preserve declared output and raw extension data", async () => {
  const requests: WireRequest["request"][] = [];
  const router = sdk(
    (r) => {
      requests.push(r);
      return new Response(
        JSON.stringify({
          reply: {
            error: { code: 16777216, description: "ok" },
            actions: [
              {
                id: 0,
                error: ok,
                callbacks: [{ result: ok, parameters: { PacketsReceived: 3, extra: "raw-only" } }],
              },
            ],
          },
        }),
      );
    },
    { allowMutations: true },
  );
  const result = await router.model.command("Device#ping", { Host: "example.invalid", Count: 3 });
  assert.equal(result.outputs[0]?.PacketsReceived, 3);
  assert.equal(result.reply.actions[0]?.callbacks?.[0]?.parameters?.extra, "raw-only");
  assert.deepEqual(requests[0]?.actions, [
    { id: 0, method: "ping", xpath: "Device", parameters: { Host: "example.invalid", Count: 3 } },
  ]);
  await assert.rejects(router.model.command("Device#ping", { Host: 1 } as never), TypeError);
  await assert.rejects(router.model.command("Device#ping", { Unknown: true } as never), TypeError);
  await assert.rejects(router.model.command("Device#ping", { Count: 0 }), /bounds/);
  assert.equal(requests.length, 1);
});

test("rotation writes only the guest key; defaults are built from the configurable network helper", async () => {
  for (const custom of [false, true]) {
    const actions: WireRequest["request"]["actions"][] = [];
    const router = sdk(
      (r) => {
        actions.push(r.actions);
        return response(
          r,
          r.actions[0]?.method === "setValue"
            ? ["ok"]
            : r.actions.length === 2
              ? ["Bike-IoT", true]
              : ["new-password"],
        );
      },
      { allowMutations: true },
    );
    const network = custom
      ? router.wifi.network({ ssidAlias: "WL_GUEST", accessPointAlias: "GUEST1" })
      : router.wifi.guest;
    const result = await network.rotatePassword({
      password: "new-password",
      expectedSsid: "Bike-IoT",
    });
    assert.equal(result.status, "verified");
    assert.deepEqual(
      actions.filter((a) => a[0]?.method === "setValue"),
      [[{ id: 0, method: "setValue", xpath: guest, parameters: { value: "new-password" } }]],
    );
    assert.equal(actions.length, 3);
  }
});

test("rotation preconditions, accepted-only and verification failures do not report verified", async () => {
  let writes = 0;
  const make = (ssid: string, key: Json) =>
    sdk(
      (r) => {
        if (r.actions[0]?.method === "setValue") writes++;
        return response(r, r.actions.length === 2 ? [ssid, true] : [key]);
      },
      { allowMutations: true },
    );
  assert.deepEqual(
    await make("wrong", null).wifi.guest.rotatePassword({
      password: "new-password",
      expectedSsid: "Bike-IoT",
    }),
    { status: "ssid-mismatch", actualSsid: "wrong" },
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await make("Bike-IoT", "old-password").wifi.guest.rotatePassword({
        password: "new-password",
        expectedSsid: "Bike-IoT",
      })
    ).status,
    "verification-mismatch",
  );
  assert.equal(
    (
      await make("Bike-IoT", null).wifi.guest.rotatePassword({
        password: "new-password",
        expectedSsid: "Bike-IoT",
        verify: false,
      })
    ).status,
    "accepted",
  );
  assert.equal(writes, 2);
  let calls = 0;
  const locked = sdk((r) => {
    calls++;
    return response(r);
  });
  await assert.rejects(
    locked.wifi.guest.rotatePassword({ password: "new-password", expectedSsid: "Bike-IoT" }),
    /mutations disabled/,
  );
  for (const password of ["short", "é".repeat(32)])
    await assert.rejects(
      locked.wifi.guest.rotatePassword({ password, expectedSsid: "Bike-IoT" }),
      TypeError,
    );
  assert.equal(calls, 0);
});

test("rotation never retries a dropped write response or treats it as success", async () => {
  let calls = 0,
    writes = 0;
  const router = sdk(
    (r) => {
      calls++;
      if (r.actions[0]?.method === "setValue") {
        writes++;
        throw new Error("dropped");
      }
      return response(r, ["Bike-IoT", true]);
    },
    { allowMutations: true },
  );
  await assert.rejects(
    router.wifi.guest.rotatePassword({ password: "new-password", expectedSsid: "Bike-IoT" }),
    (e) => e instanceof TransportError && e.outcome === "unknown",
  );
  assert.equal(calls, 2);
  assert.equal(writes, 1);
});

test("file recipes preserve upstream multipart commands without executing a second implementation", async () => {
  const methods: string[] = [];
  const router = sdk(
    (r, init) => {
      assert.ok(init.body instanceof FormData);
      assert.ok(init.body.get("image") instanceof Blob);
      methods.push(r.actions[0]!.method);
      return response(r);
    },
    { allowMutations: true },
  );
  const file = { field: "image", filename: "fixture.bin", data: new Blob(["fixture"]) };
  await router.files.restore("Device", file, { cryptKey: "fixture-secret" });
  await router.files.firmwareUpgrade("Device", file);
  await router.files.docsisFirmwareUpgrade("Device", file, "3.1");
  assert.deepEqual(methods, ["restoreFrom", "download", "DownloadDocsisFirmware"]);
  assert.throws(() => router.files.firmwareUpgrade("Device", file, "invalid" as never), TypeError);
});

test("download URI helper validates returned origin and never navigates", async () => {
  const make = (uri: string) =>
    sdk(
      () =>
        new Response(
          JSON.stringify({
            reply: {
              error: { code: 16777216, description: "ok" },
              actions: [{ id: 0, error: ok, callbacks: [{ result: ok, parameters: { uri } }] }],
            },
          }),
        ),
      { allowMutations: true },
    );
  assert.equal(
    await make("/download?token=fixture").files.getDownloadUri("Device"),
    "http://router.invalid/download?token=fixture",
  );
  await assert.rejects(
    make("http://elsewhere.invalid/secret").files.getDownloadUri("Device"),
    ProtocolError,
  );
});

test("schema numeric/enum restrictions validate advertised boundaries without executing regexes", () => {
  const number = {
    name: "Count",
    type: "xmo:uint32 xmo:number xmo:value",
    flags: {},
    restrictions: { "min-value-inclusive": 1 },
  };
  for (const value of [0, -1, 1.5, 2 ** 32])
    assert.throws(() => validateFieldValue(number, value), TypeError);
  validateFieldValue(number, 1);
  const enumeration = {
    name: "Mode",
    type: "xmo:int32 xmo:number xmo:value",
    flags: {},
    restrictions: {
      "enum-values": [
        { name: "OFF", value: "0" },
        { name: "ON", value: "1" },
      ],
    },
  };
  for (const value of ["OFF", "0", 0]) validateFieldValue(enumeration, value);
  assert.throws(() => validateFieldValue(enumeration, 3), TypeError);
  const getters = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.equal(isJson(getters), false);
  const sparse = Object.assign(new Array(1), { extra: 1 });
  assert.equal(isJson(sparse), false);
});
