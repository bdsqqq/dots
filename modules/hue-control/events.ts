import { createEventLogger } from "../service-events/events.ts";

export type HueEvents = ReturnType<typeof createEventLogger>;
export const hueEvents = createEventLogger("hue-control");

/** Adapter failures carry a code; never classify or emit a device-bearing error message. */
export function bluetoothReason(error: unknown): string {
  return error && typeof error === "object" && "code" in error && error.code === "BLUETOOTH_UNAVAILABLE"
    ? "bluetooth_unavailable"
    : "bluetooth_connection_failed";
}
