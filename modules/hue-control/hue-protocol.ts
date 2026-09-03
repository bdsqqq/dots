export const HUE_SERVICE_UUID = "0000fe0f-0000-1000-8000-00805f9b34fb";

export const HUE_CHARACTERISTICS = {
  brightness: "932c32bd-0003-47a2-835a-a8d455b859dd",
  colorTemperature: "932c32bd-0004-47a2-835a-a8d455b859dd",
  colorXy: "932c32bd-0005-47a2-835a-a8d455b859dd",
  model: "00002a24-0000-1000-8000-00805f9b34fb",
  name: "97fe6561-0003-4f62-86e9-b71ee2da3d22",
  power: "932c32bd-0002-47a2-835a-a8d455b859dd",
} as const;

export interface HueState {
  brightness: number;
  colorTemperature: number;
  colorXy: readonly [number, number];
  model: string;
  name: string;
  power: boolean;
}

export type HueControlError = "invalid-command" | "unavailable" | "unsupported";

export type HueResult<T> =
  | { ok: true; value: T }
  | { error: HueControlError; message: string; ok: false };

export interface HueGattConnection {
  read(characteristic: string): Promise<Uint8Array>;
  subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
  ): Promise<() => Promise<void>>;
  write(characteristic: string, value: Uint8Array): Promise<void>;
}

const success = <T>(value: T): HueResult<T> => ({ ok: true, value });

const failure = (error: HueControlError, message: string): HueResult<never> => ({
  error,
  message,
  ok: false,
});

function bytes(value: DataView): Uint8Array {
  return new Uint8Array(value.buffer);
}

function integer(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function encodePower(power: boolean): Uint8Array {
  return Uint8Array.of(power ? 1 : 0);
}

export function decodePower(value: Uint8Array): boolean {
  if (value.byteLength !== 1) throw new Error("power value must contain one byte");
  return value[0] !== 0;
}

export function encodeBrightness(brightness: number): Uint8Array {
  if (!Number.isFinite(brightness)) throw new Error("brightness must be finite");
  return Uint8Array.of(integer(brightness, 1, 254));
}

export function decodeBrightness(value: Uint8Array): number {
  if (value.byteLength !== 1) throw new Error("brightness value must contain one byte");
  return value[0];
}

export function encodeColorTemperature(colorTemperature: number): Uint8Array {
  if (!Number.isFinite(colorTemperature)) {
    throw new Error("color temperature must be finite");
  }
  const value = new DataView(new ArrayBuffer(2));
  value.setUint16(0, integer(colorTemperature, 153, 500), true);
  return bytes(value);
}

export function decodeColorTemperature(value: Uint8Array): number {
  if (value.byteLength !== 2) {
    throw new Error("color temperature value must contain two bytes");
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(0, true);
}

export function encodeColorXy(x: number, y: number): Uint8Array {
  if (![x, y].every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) {
    throw new Error("color coordinates must be finite values between zero and one");
  }
  const value = new DataView(new ArrayBuffer(4));
  value.setUint16(0, Math.trunc(x * 0xffff), true);
  value.setUint16(2, Math.trunc(y * 0xffff), true);
  return bytes(value);
}

export function decodeColorXy(value: Uint8Array): readonly [number, number] {
  if (value.byteLength !== 4) throw new Error("color value must contain four bytes");
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return [view.getUint16(0, true) / 0xffff, view.getUint16(2, true) / 0xffff];
}

function decodeText(value: Uint8Array): string {
  return new TextDecoder("ascii").decode(value).replaceAll("\0", "");
}

export class HueProtocolSession {
  readonly #connection: HueGattConnection;
  readonly #listeners = new Set<(state: HueState) => void>();
  readonly #unsubscribers: Array<() => Promise<void>> = [];
  #state: HueState | null = null;
  #writeQueue = Promise.resolve();

  constructor(connection: HueGattConnection) {
    this.#connection = connection;
  }

  state(): HueState | null {
    return this.#state;
  }

  onState(listener: (state: HueState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initialize(): Promise<HueResult<HueState>> {
    try {
      await this.#subscribe(HUE_CHARACTERISTICS.power, "power", decodePower);
      await this.#subscribe(HUE_CHARACTERISTICS.brightness, "brightness", decodeBrightness);
      await this.#subscribe(
        HUE_CHARACTERISTICS.colorTemperature,
        "colorTemperature",
        decodeColorTemperature,
      );
      await this.#subscribe(HUE_CHARACTERISTICS.colorXy, "colorXy", decodeColorXy);

      // CoreBluetooth serializes GATT operations. Some adapters return an
      // empty native value instead of queueing concurrent reads.
      const power = decodePower(await this.#connection.read(HUE_CHARACTERISTICS.power));
      const brightness = decodeBrightness(
        await this.#connection.read(HUE_CHARACTERISTICS.brightness),
      );
      const colorTemperature = decodeColorTemperature(
        await this.#connection.read(HUE_CHARACTERISTICS.colorTemperature),
      );
      const colorXy = decodeColorXy(await this.#connection.read(HUE_CHARACTERISTICS.colorXy));
      const model = decodeText(await this.#connection.read(HUE_CHARACTERISTICS.model));
      const name = decodeText(await this.#connection.read(HUE_CHARACTERISTICS.name));
      this.#state = { brightness, colorTemperature, colorXy, model, name, power };
      this.#emit();
      return success(this.#state);
    } catch (error) {
      await this.close();
      return failure("unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  setPower(power: boolean): Promise<HueResult<HueState>> {
    return this.#write("power", HUE_CHARACTERISTICS.power, encodePower(power), power);
  }

  setBrightness(brightness: number): Promise<HueResult<HueState>> {
    try {
      const encoded = encodeBrightness(brightness);
      return this.#write(
        "brightness",
        HUE_CHARACTERISTICS.brightness,
        encoded,
        encoded[0],
      );
    } catch (error) {
      return Promise.resolve(
        failure("invalid-command", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  setColorTemperature(colorTemperature: number): Promise<HueResult<HueState>> {
    try {
      const encoded = encodeColorTemperature(colorTemperature);
      return this.#write(
        "colorTemperature",
        HUE_CHARACTERISTICS.colorTemperature,
        encoded,
        decodeColorTemperature(encoded),
      );
    } catch (error) {
      return Promise.resolve(
        failure("invalid-command", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  setColorXy(x: number, y: number): Promise<HueResult<HueState>> {
    try {
      const encoded = encodeColorXy(x, y);
      return this.#write(
        "colorXy",
        HUE_CHARACTERISTICS.colorXy,
        encoded,
        decodeColorXy(encoded),
      );
    } catch (error) {
      return Promise.resolve(
        failure("invalid-command", error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async close(): Promise<void> {
    const unsubscribers = this.#unsubscribers.splice(0);
    await Promise.allSettled(unsubscribers.map((unsubscribe) => unsubscribe()));
  }

  async #subscribe<K extends "power" | "brightness" | "colorTemperature" | "colorXy">(
    characteristic: string,
    key: K,
    decode: (value: Uint8Array) => HueState[K],
  ): Promise<void> {
    const unsubscribe = await this.#connection.subscribe(characteristic, (value) => {
      if (!this.#state) return;
      try {
        this.#state = { ...this.#state, [key]: decode(value) };
        this.#emit();
      } catch {
        // A malformed notification does not invalidate the last known state.
      }
    });
    this.#unsubscribers.push(unsubscribe);
  }

  #write<K extends "power" | "brightness" | "colorTemperature" | "colorXy">(
    key: K,
    characteristic: string,
    encoded: Uint8Array,
    value: HueState[K],
  ): Promise<HueResult<HueState>> {
    if (!this.#state) return Promise.resolve(failure("unavailable", "light is not connected"));
    const operation = this.#writeQueue.then(async () => {
      try {
        await this.#connection.write(characteristic, encoded);
        this.#state = { ...this.#state!, [key]: value };
        this.#emit();
        return success(this.#state);
      } catch (error) {
        return failure("unavailable", error instanceof Error ? error.message : String(error));
      }
    });
    this.#writeQueue = operation.then(() => undefined);
    return operation;
  }

  #emit(): void {
    if (!this.#state) return;
    for (const listener of this.#listeners) {
      try {
        listener(this.#state);
      } catch {
        // One consumer must not disrupt protocol state or other consumers.
      }
    }
  }
}
