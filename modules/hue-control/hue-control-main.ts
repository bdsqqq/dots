import { homedir } from "node:os";
import { join } from "node:path";

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
process.stdout.write(`hue-control listening on http://127.0.0.1:${port}\n`);

async function stop(): Promise<void> {
  server.close();
  await runtime.stop();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
