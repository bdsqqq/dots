// Compiled, not executed. These are real call sites, not casts that bypass the public contract.
import {
  SagemcomFast3896Claro,
  identityFromDeviceInfo,
  wifiNetworkFromValues,
} from "../src/index.ts";
import type { Subscription, SupportedDevice } from "../src/index.ts";
// @ts-expect-error there is no generic router SDK alias
import type { RouterSdk } from "../src/index.ts";
function calls(router: SagemcomFast3896Claro) {
  const model: "FAST3896_CLARO" = router.supportedDevice.model;
  const profile: Promise<SupportedDevice> = router.assertCompatible();
  // @ts-expect-error the profile is not a cross-model string bag
  const otherModel: "another-model" = router.supportedDevice.model;
  void [model, profile, otherModel];
  const version: Promise<string> = router.model.get("Device/DeviceInfo/SoftwareVersion");
  const ssid: Promise<string> = router.model.get("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID");
  const enabled: Promise<boolean> = router.model.get("Device/WiFi/SSIDs/SSID[@uid='3']/Enable");
  router.model.set("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID", "guest");
  router.model.command("Device#ping", { Host: "example.invalid", Count: 1, Protocol: "IPV4" });
  router.node("Device/newFirmwareNode").get();
  // @ts-expect-error unknown typed path requires the explicit raw escape hatch
  router.model.get("Device/NotAdvertised");
  // @ts-expect-error list instance identity is required
  router.model.get("Device/WiFi/SSIDs/SSID/SSID");
  // @ts-expect-error wrong wire type
  router.model.set("Device/WiFi/SSIDs/SSID[Alias='WL_GUEST']/SSID", 123);
  // @ts-expect-error metadata marks this as status, not config
  router.model.set("Device/DeviceInfo/SoftwareVersion", "fake");
  // @ts-expect-error unknown command
  router.model.command("Device#madeUp", {});
  // @ts-expect-error typed command parameters must match the metadata
  router.model.command("Device#ping", { Host: 123 });
  // @ts-expect-error unknown command argument
  router.model.command("Device#ping", { NotAnInput: true });
  // @ts-expect-error unrelated output field
  router.model.command("Device#ping", {}).then((r) => r.outputs[0]?.DoesNotExist);
  // @ts-expect-error inference must remain string
  const wrong: Promise<number> = router.model.get("Device/DeviceInfo/SoftwareVersion");
  new SagemcomFast3896Claro({
    auth: {
      mode: "credentials",
      username: "u",
      password: "p",
      // @ts-expect-error credentials and supplied session are mutually exclusive
      session: { mode: "token", id: 1, token: "t", nextRequestId: 1 },
    },
  });
  // @ts-expect-error periodic subscription requires a timer
  const missingTimer: Subscription = { type: "periodic" };
  // @ts-expect-error delete subscriptions do not accept current-value behavior
  const incompatible: Subscription = { type: "delete-child", currentValue: true };
  identityFromDeviceInfo({ DeviceInfo: {} });
  wifiNetworkFromValues("", false);
  return [version, ssid, enabled, wrong, missingTimer, incompatible];
}
void calls;
