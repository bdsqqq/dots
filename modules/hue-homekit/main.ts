import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Accessory, Bridge, Categories, HAPStorage, MDNSAdvertiser, uuid } from "@homebridge/hap-nodejs";
import { HomeKitLight } from "./light.ts";

const [directory, origin = "http://127.0.0.1:8756", network = "en0", port = "51826", name = "Desk Light Bridge"] = process.argv.slice(2);
if (!directory) throw new Error("usage: hue-homekit STATE_DIRECTORY [DAEMON_URL] [INTERFACE] [PORT] [NAME]");
if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
HAPStorage.setCustomStoragePath(directory);
const pairingFile = join(directory, "pairing.json");
if (!existsSync(pairingFile)) {
  let pin: string;
  do { pin = String(randomInt(10000000, 99999999)); }
  while (/^(\d)\1{7}$/.test(pin) || ["12345678", "87654321"].includes(pin));
  writeFileSync(pairingFile, JSON.stringify({
    username: `02:${randomBytes(5).toString("hex").match(/../g)!.join(":").toUpperCase()}`,
    pincode: `${pin.slice(0, 3)}-${pin.slice(3, 5)}-${pin.slice(5)}`,
  }), { mode: 0o600, flag: "wx" });
}
const pairing = JSON.parse(readFileSync(pairingFile, "utf8"));
const bridge = new Bridge(name, uuid.generate("bdsqqq.hue.bridge"));
const accessory = new Accessory("Desk Lamp", uuid.generate("bdsqqq.hue.desk"));
const lamp = new HomeKitLight(origin);
accessory.addService(lamp.service);
bridge.addBridgedAccessory(accessory);
await lamp.poll();
bridge.on("listening", () => console.log("HomeKit listener started"));
bridge.on("advertised", () => console.log("HomeKit mDNS advertisement completed"));
await bridge.publish({ ...pairing, port: Number(port), category: Categories.BRIDGE, bind: network, advertiser: MDNSAdvertiser.CIAO });
let stopped = false;
let timer: ReturnType<typeof setTimeout>;
async function poll(): Promise<void> {
  await lamp.poll();
  if (!stopped) timer = setTimeout(() => void poll(), 2000);
}
void poll();
async function stop(): Promise<void> {
  stopped = true;
  clearTimeout(timer);
  await bridge.unpublish();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
console.log(`HomeKit bridge starting; pairing details: ${pairingFile}`);
