import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capturedCredentials, readHar } from "./har.ts";

// Probe the built artifact, not a different source tree from the one consumers import.
const sdk: typeof import("../src/index.ts") = await import(
  new URL("../dist/index.js", import.meta.url).href
);
const index = process.argv.indexOf("--har");
const har = index < 0 ? undefined : process.argv[index + 1];
const credentials = har
  ? capturedCredentials(readHar(har))
  : {
      username: process.env.FAST3896_CLARO_USERNAME ?? "",
      password: process.env.FAST3896_CLARO_PASSWORD_FILE
        ? readFileSync(process.env.FAST3896_CLARO_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "")
        : "",
    };
const router = new sdk.SagemcomFast3896Claro({
  baseUrl: process.env.FAST3896_CLARO_URL ?? "http://192.168.0.1",
  auth: { mode: "credentials", ...credentials },
});
try {
  const identity = await router.assertCompatible();
  assert.equal(
    identity.softwareVersion,
    sdk.catalog.identity.SoftwareVersion,
    "firmware differs from generated profile",
  );
  const version = await router.model.get("Device/DeviceInfo/SoftwareVersion");
  assert.equal(version, identity.softwareVersion);
  const guest = await router.wifi.guest.get();
  assert.equal(await router.model.get("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID"), guest.ssid);
  assert.equal(
    await router.model.get("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/Enable"),
    guest.enabled,
  );
  const statuses = await router.model.getAll("Device/WiFi/SSIDs/SSID[*]/Status");
  assert.ok(statuses.length > 0);
  const defaultEnable = await router.getDefault("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/Enable");
  assert.equal(typeof defaultEnable, "boolean");
  assert.equal(router.allowMutations, false);
  // Only non-secret identity/status summaries leave this adapter.
  console.log(
    JSON.stringify({
      status: "passed",
      identity,
      guestEnabled: guest.enabled,
      wifiInstances: statuses.length,
      profileNodes: sdk.catalog.nodes.length,
    }),
  );
} finally {
  await router.logout();
}
