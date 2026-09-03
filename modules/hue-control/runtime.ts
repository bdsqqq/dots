import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { HueBleAdapter, HueBleConnection, HueDevice } from "./ble-adapter.ts";
import { HueProtocolSession } from "./hue-protocol.ts";
import type { HueResult, HueState } from "./hue-protocol.ts";

export type HueRuntimeStatus = "available" | "connecting" | "unavailable" | "unenrolled";

export interface HueRuntimeSnapshot {
  deviceId: string | null;
  lastError: string | null;
  light: HueState | null;
  status: HueRuntimeStatus;
}

interface PersistedConfiguration {
  deviceId: string;
}

const unavailable = (message: string): HueResult<never> => ({
  error: "unavailable",
  message,
  ok: false,
});

export class HueRuntime {
  readonly #adapter: HueBleAdapter;
  readonly #statePath: string;
  #connection: HueBleConnection | null = null;
  #connectPromise: Promise<void> | null = null;
  #deviceId: string | null = null;
  #lastError: string | null = null;
  #light: HueState | null = null;
  #reconnectDelay = 1_000;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #session: HueProtocolSession | null = null;
  #status: HueRuntimeStatus = "unenrolled";
  #stopped = false;

  constructor(adapter: HueBleAdapter, statePath: string) {
    this.#adapter = adapter;
    this.#statePath = statePath;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    try {
      const stored = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (
        typeof stored === "object" &&
        stored !== null &&
        "deviceId" in stored &&
        typeof stored.deviceId === "string" &&
        stored.deviceId.length > 0
      ) {
        this.#deviceId = stored.deviceId;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.#deviceId) void this.reconnect();
  }

  snapshot(): HueRuntimeSnapshot {
    return {
      deviceId: this.#deviceId,
      lastError: this.#lastError,
      light: this.#light,
      status: this.#status,
    };
  }

  discover(): Promise<HueDevice> {
    return this.#adapter.discover();
  }

  async enroll(deviceId: string): Promise<void> {
    if (!deviceId.trim()) throw new Error("device id is required");
    await mkdir(dirname(this.#statePath), { mode: 0o700, recursive: true });
    const temporary = `${this.#statePath}.tmp`;
    const configuration: PersistedConfiguration = { deviceId };
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#statePath);
    this.#deviceId = deviceId;
    await this.reconnect();
  }

  async reconnect(): Promise<void> {
    if (!this.#deviceId || this.#stopped) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#clearReconnect();
    this.#connectPromise = this.#connect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  setPower(power: boolean): Promise<HueResult<HueState>> {
    return this.#command((session) => session.setPower(power));
  }

  setBrightness(brightness: number): Promise<HueResult<HueState>> {
    return this.#command((session) => session.setBrightness(brightness));
  }

  setColorTemperature(colorTemperature: number): Promise<HueResult<HueState>> {
    return this.#command((session) => session.setColorTemperature(colorTemperature));
  }

  setColorXy(x: number, y: number): Promise<HueResult<HueState>> {
    return this.#command((session) => session.setColorXy(x, y));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearReconnect();
    await this.#disconnect();
  }

  async #connect(): Promise<void> {
    this.#status = "connecting";
    this.#lastError = null;
    await this.#disconnect();
    try {
      const connection = await this.#adapter.connect(this.#deviceId!, () => {
        if (this.#connection !== connection) return;
        void this.#lostConnection("bluetooth connection closed");
      });
      this.#connection = connection;
      const session = new HueProtocolSession(connection);
      this.#session = session;
      session.onState((state) => {
        this.#light = state;
      });
      const initialized = await session.initialize();
      if (!initialized.ok) throw new Error(initialized.message);
      this.#light = initialized.value;
      this.#status = "available";
      this.#reconnectDelay = 1_000;
    } catch (error) {
      await this.#lostConnection(error instanceof Error ? error.message : String(error));
    }
  }

  async #command(
    run: (session: HueProtocolSession) => Promise<HueResult<HueState>>,
  ): Promise<HueResult<HueState>> {
    if (!this.#session) return unavailable("light is unavailable");
    const result = await run(this.#session);
    if (!result.ok && result.error === "unavailable") await this.#lostConnection(result.message);
    return result;
  }

  async #lostConnection(message: string): Promise<void> {
    this.#status = "unavailable";
    this.#lastError = message;
    this.#light = null;
    await this.#disconnect();
    if (!this.#stopped && !this.#reconnectTimer) {
      const delay = this.#reconnectDelay;
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        void this.reconnect();
      }, delay);
      this.#reconnectTimer.unref();
    }
  }

  async #disconnect(): Promise<void> {
    const session = this.#session;
    const connection = this.#connection;
    this.#session = null;
    this.#connection = null;
    if (session) await session.close();
    if (connection) await connection.disconnect();
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}
