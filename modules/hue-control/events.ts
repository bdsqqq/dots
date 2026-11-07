import { createEventLogger } from "../service-events/events.ts";

export type HueEvents = ReturnType<typeof createEventLogger>;
export const hueEvents = createEventLogger("hue-control");

/** Adapter failures carry a code; never classify or emit a device-bearing error message. */
export function bluetoothReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const name = error instanceof Error ? error.name : undefined;
  if (code === "EACCES" || code === "EPERM" || name === "NotAllowedError" || name === "SecurityError") {
    return "bluetooth_permission_denied";
  }
  return code === "BLUETOOTH_UNAVAILABLE" ? "bluetooth_unavailable" : "bluetooth_connection_failed";
}
