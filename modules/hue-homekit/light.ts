import { Characteristic, HAPStatus, HapStatusError, Perms, Service, type CharacteristicValue } from "@homebridge/hap-nodejs";
import convert from "color-convert";

export function toXy(hue: number, saturation: number): [number, number] {
  const [x, y, z] = convert.rgb.xyz.raw(convert.hsv.rgb.raw([hue, saturation, 100]));
  return [x / (x + y + z), y / (x + y + z)];
}

export function fromXy([x, y]: readonly number[]): [number, number] {
  if (y <= 0) return [0, 0];
  // Normalize linear sRGB before gamma correction; clipping XYZ->RGB first
  // would change hue for saturated colors at this arbitrary luminance.
  const X = x / y;
  const Z = (1 - x - y) / y;
  const linear = [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
  const max = Math.max(...linear, 1);
  const rgb = linear.map((c) => {
    const n = Math.max(0, c / max);
    return 255 * (n <= 0.0031308 ? 12.92 * n : 1.055 * n ** (1 / 2.4) - 0.055);
  }) as [number, number, number];
  const [h, s] = convert.rgb.hsv.raw(rgb);
  return [h, s];
}

type Light = { power: boolean; brightness: number; colorXy: [number, number]; colorTemperature: number };

export class HomeKitLight {
  readonly service = new Service.Lightbulb("Desk Lamp");
  #light: Light | undefined;
  #hue = 0;
  #saturation = 0;
  #writes = 0;
  #revision = 0;
  readonly origin: string;
  readonly request: typeof fetch;

  constructor(origin: string, request: typeof fetch = fetch) {
    this.origin = origin;
    this.request = request;
    const bind = (type: typeof Characteristic.On, get: () => number | boolean, set: (value: CharacteristicValue) => Promise<void>) => {
      this.service.getCharacteristic(type).onGet(() => {
        if (!this.#light) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        return get();
      }).onSet(set);
    };
    bind(Characteristic.On, () => this.#light!.power, (v) => this.command({ power: Boolean(v) }));
    bind(Characteristic.Brightness, () => Math.round(this.#light!.brightness * 100 / 254), (v) =>
      this.command(Number(v) === 0 ? { power: false } : { brightness: Math.max(1, Math.round(Number(v) * 254 / 100)) }));
    bind(Characteristic.Hue, () => this.#hue, (v) => {
      this.#hue = Number(v);
      return this.command({ colorXy: toXy(this.#hue, this.#saturation) });
    });
    bind(Characteristic.Saturation, () => this.#saturation, (v) => {
      this.#saturation = Number(v);
      return this.command({ colorXy: toXy(this.#hue, this.#saturation) });
    });
    bind(Characteristic.ColorTemperature, () => this.temperature(), (v) => this.command({ colorTemperature: Number(v) }));
    this.service.getCharacteristic(Characteristic.ColorTemperature).setProps({ minValue: 153, maxValue: 500 });
  }

  private temperature(): number {
    // Hue reports 65535 while in XY mode; it is not a valid HAP temperature.
    const value = this.#light!.colorTemperature;
    return value >= 153 && value <= 500 ? value : 250;
  }

  async command(body: object): Promise<void> {
    this.#writes++;
    const revision = ++this.#revision;
    try {
      const response = await this.request(`${this.origin}/api/light`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`daemon returned ${response.status}`);
      const light = await response.json() as Light;
      if (revision === this.#revision) this.#light = light;
    } catch {
      this.#light = undefined;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.#writes--;
    }
  }

  async poll(): Promise<void> {
    if (this.#writes) return;
    const revision = this.#revision;
    try {
      const response = await this.request(`${this.origin}/api/state`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`daemon returned ${response.status}`);
      const state = await response.json() as { status: string; light: Light | null };
      if (revision !== this.#revision || this.#writes) return;
      if (state.status !== "available" || !state.light) throw new Error("bulb unavailable");
      this.#light = state.light;
      [this.#hue, this.#saturation] = fromXy(state.light.colorXy);
      for (const [type, value] of [
        [Characteristic.On, state.light.power],
        [Characteristic.Brightness, Math.round(state.light.brightness * 100 / 254)],
        [Characteristic.Hue, this.#hue], [Characteristic.Saturation, this.#saturation],
        [Characteristic.ColorTemperature, this.temperature()],
      ] as const) this.service.updateCharacteristic(type, value);
    } catch {
      if (revision !== this.#revision) return;
      this.#light = undefined;
      for (const characteristic of this.service.characteristics) {
        if (characteristic.props.perms.includes(Perms.NOTIFY)) {
          characteristic.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      }
    }
  }
}
