import { homedir } from "node:os";
import { join } from "node:path";

import { safeErrorCode } from "../service-events/events.ts";
import { hueEvents } from "./events.ts";

import { WebBluetoothHueAdapter } from "./ble-adapter.ts";
import { HueRuntime } from "./runtime.ts";
import { createHueControlServer, listen } from "./server.ts";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const startup = hueEvents.begin("service.start");
try {
  const port = Number(option("--port", "8756"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1–65535");
  const statePath = option(
    "--state",
    join(homedir(), "Library", "Application Support", "hue-control", "state.json"),
  );

  const runtime = new HueRuntime(new WebBluetoothHueAdapter(), statePath);
  await runtime.start();
  const server = createHueControlServer(runtime);
  await listen(server, port);
  const snapshot = runtime.snapshot();
  startup.finish(snapshot.status === "available" ? "succeeded" : "degraded", {
    ready: snapshot.status === "available", readiness: snapshot.status, enrolled: snapshot.deviceId !== null,
  });

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const event = hueEvents.begin("service.stop");
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await runtime.stop();
      await closed;
      event.finish("succeeded", { ready: false });
    } catch (error) {
      event.finish("failed", { ready: false, errorCode: safeErrorCode(error) });
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  startup.finish("failed", { ready: false, errorCode: safeErrorCode(error) });
  process.exitCode = 1;
}
