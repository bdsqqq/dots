import test from "node:test";
import assert from "node:assert/strict";
import * as entrypoint from "../src/index.ts";
import { supportedDevice } from "../src/device.generated.ts";
import { assertCompatibleDevice, UnsupportedDeviceError } from "../src/device.ts";
import { generate } from "../scripts/generate.ts";
import { catalog } from "../src/catalog.generated.ts";
import { sdk, response } from "./helpers.ts";

const info = {
  Manufacturer: supportedDevice.manufacturer,
  ModelName: supportedDevice.model,
  ProductClass: supportedDevice.productClass,
  HardwareVersion: supportedDevice.hardwareVersion,
  SoftwareVersion: supportedDevice.softwareVersion,
  GUIAPIVersion: supportedDevice.guiApiVersion,
};

test("public SDK names and supported profile identify FAST3896_CLARO explicitly", () => {
  assert.equal(entrypoint.SagemcomFast3896Claro.name, "SagemcomFast3896Claro");
  assert.equal(entrypoint.SagemcomXmoClient.name, "SagemcomXmoClient");
  assert.equal(entrypoint.Fast3896ClaroModel.name, "Fast3896ClaroModel");
  for (const old of ["RouterSdk", "RouterClient", "FirmwareModel"])
    assert.equal(old in entrypoint, false);
  assert.equal(supportedDevice.model, "FAST3896_CLARO");
  assert.equal(supportedDevice.productClass, "FAST3896-15");
  assert.ok(Object.isFrozen(supportedDevice));
});

test("compatibility checks every captured identity dimension without leaking the supplied identity", () => {
  assert.doesNotThrow(() => assertCompatibleDevice({ ...supportedDevice }));
  for (const key of Object.keys(supportedDevice)) {
    assert.throws(
      () => assertCompatibleDevice({ ...supportedDevice, [key]: "private-mismatch" }),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedDeviceError);
        assert.equal(error.expected, supportedDevice);
        assert.doesNotMatch(error.message + JSON.stringify(error), /private-mismatch/);
        return true;
      },
    );
  }
  for (const identity of [null, undefined, {}, "FAST3896_CLARO"])
    assert.throws(() => assertCompatibleDevice(identity), UnsupportedDeviceError);
});

test("explicit live compatibility uses one read; supplied identity causes no second fetch", async () => {
  let calls = 0;
  const router = sdk((r) => {
    calls++;
    return response(r, [{ DeviceInfo: info }]);
  });
  assert.deepEqual(await router.assertCompatible(), supportedDevice);
  assert.equal(calls, 1);
  const supplied = { ...supportedDevice };
  assert.equal(await router.assertCompatible(supplied), supplied);
  assert.equal(calls, 1);
  assert.equal(router.supportedDevice, supportedDevice);
  await assert.rejects(
    router.assertCompatible({ ...supplied, softwareVersion: "different-firmware" }),
    UnsupportedDeviceError,
  );
  assert.equal(calls, 1);
});

test("wrong connected model is rejected and catalogs from other model families cannot be generated", async () => {
  const router = sdk((r) => response(r, [{ DeviceInfo: { ...info, ModelName: "another-model" } }]));
  await assert.rejects(router.assertCompatible(), UnsupportedDeviceError);
  const wrong = structuredClone(catalog);
  wrong.identity.ModelName = "another-model";
  assert.throws(() => generate(wrong), /catalog must describe Sagemcom FAST3896_CLARO/);
});
