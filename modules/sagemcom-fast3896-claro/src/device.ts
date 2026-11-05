import { supportedDevice } from "./device.generated.ts";
import type { SupportedDevice } from "./device.generated.ts";
import { record } from "./protocol.ts";

export class UnsupportedDeviceError extends Error {
  readonly expected = supportedDevice;
  constructor() {
    super("device does not match the supported Sagemcom FAST3896_CLARO hardware/firmware profile");
    this.name = "UnsupportedDeviceError";
  }
}

/** pure compatibility check: supplied identity never causes a hidden network read. */
export function assertCompatibleDevice(identity: unknown): asserts identity is SupportedDevice {
  if (
    !record(identity) ||
    Object.entries(supportedDevice).some(([key, value]) => identity[key] !== value)
  )
    throw new UnsupportedDeviceError();
}
