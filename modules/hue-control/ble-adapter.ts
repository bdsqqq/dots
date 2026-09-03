import { Bluetooth } from "webbluetooth";

import {
  HUE_CHARACTERISTICS,
  HUE_SERVICE_UUID,
} from "./hue-protocol.ts";
import type { HueGattConnection } from "./hue-protocol.ts";

const DEVICE_INFORMATION_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
const LIGHT_CONTROL_SERVICE = "932c32bd-0000-47a2-835a-a8d455b859dd";

export interface HueDevice {
  id: string;
  name: string;
}

export interface HueBleConnection extends HueGattConnection {
  disconnect(): Promise<void>;
}

export interface HueBleAdapter {
  connect(deviceId: string, disconnected: () => void): Promise<HueBleConnection>;
  discover(): Promise<HueDevice>;
}

function requestOptions(): RequestDeviceOptions {
  return {
    filters: [{ services: [HUE_SERVICE_UUID] }],
    optionalServices: [DEVICE_INFORMATION_SERVICE, LIGHT_CONTROL_SERVICE],
  };
}

async function characteristics(
  server: BluetoothRemoteGATTServer,
): Promise<Map<string, BluetoothRemoteGATTCharacteristic>> {
  const result = new Map<string, BluetoothRemoteGATTCharacteristic>();
  for (const serviceUuid of [DEVICE_INFORMATION_SERVICE, LIGHT_CONTROL_SERVICE]) {
    const service = await server.getPrimaryService(serviceUuid);
    for (const characteristic of await service.getCharacteristics()) {
      result.set(characteristic.uuid.toLowerCase(), characteristic);
    }
  }
  return result;
}

function bytes(value: DataView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

class WebBluetoothConnection implements HueBleConnection {
  readonly #characteristics: Map<string, BluetoothRemoteGATTCharacteristic>;
  readonly #name: string;
  readonly #server: BluetoothRemoteGATTServer;

  constructor(
    server: BluetoothRemoteGATTServer,
    availableCharacteristics: Map<string, BluetoothRemoteGATTCharacteristic>,
    name: string,
  ) {
    this.#server = server;
    this.#characteristics = availableCharacteristics;
    this.#name = name;
  }

  async read(characteristic: string): Promise<Uint8Array> {
    if (
      characteristic.toLowerCase() === HUE_CHARACTERISTICS.name &&
      !this.#characteristics.has(HUE_CHARACTERISTICS.name)
    ) {
      return new TextEncoder().encode(this.#name);
    }
    try {
      return bytes(await this.#characteristic(characteristic).readValue());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to read ${characteristic}: ${message}`);
    }
  }

  async write(characteristic: string, value: Uint8Array): Promise<void> {
    await this.#characteristic(characteristic).writeValueWithResponse(Uint8Array.from(value).buffer);
  }

  async subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    const target = this.#characteristic(characteristic);
    const changed = (): void => {
      if (target.value) listener(bytes(target.value));
    };
    target.addEventListener("characteristicvaluechanged", changed);
    await target.startNotifications();
    return async () => {
      target.removeEventListener("characteristicvaluechanged", changed);
      if (this.#server.connected) await target.stopNotifications();
    };
  }

  async disconnect(): Promise<void> {
    this.#server.disconnect();
  }

  #characteristic(uuid: string): BluetoothRemoteGATTCharacteristic {
    const characteristic = this.#characteristics.get(uuid.toLowerCase());
    if (!characteristic) throw new Error(`light does not expose ${uuid}`);
    return characteristic;
  }
}

export class WebBluetoothHueAdapter implements HueBleAdapter {
  readonly #scanTime: number;

  constructor(scanTime = 10) {
    this.#scanTime = scanTime;
  }

  async discover(): Promise<HueDevice> {
    const bluetooth = new Bluetooth({
      deviceFound: () => true,
      scanTime: this.#scanTime,
    });
    const device = await bluetooth.requestDevice(requestOptions());
    return { id: device.id, name: device.name || "Hue light" };
  }

  async connect(deviceId: string, disconnected: () => void): Promise<HueBleConnection> {
    const bluetooth = new Bluetooth({
      deviceFound: (device) => device.id === deviceId,
      scanTime: this.#scanTime,
    });
    const device = await bluetooth.requestDevice(requestOptions());
    device.addEventListener("gattserverdisconnected", disconnected, { once: true });
    const server = await device.gatt.connect();
    const name = device.name?.startsWith("Unknown or Unsupported Device")
      ? "Hue light"
      : device.name || "Hue light";
    return new WebBluetoothConnection(server, await characteristics(server), name);
  }
}

export function expectedHueCharacteristics(): readonly string[] {
  return Object.values(HUE_CHARACTERISTICS);
}
