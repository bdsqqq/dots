import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { safeErrorCode } from "../service-events/events.ts";
import { bluetoothReason, hueEvents } from "./events.ts";
import type { HueEvents } from "./events.ts";

import type { HueBleAdapter, HueBleConnection, HueDevice } from "./ble-adapter.ts";
import { HueProtocolSession } from "./hue-protocol.ts";
import type { HueResult, HueState } from "./hue-protocol.ts";

export type HueRuntimeStatus = "available" | "connecting" | "unavailable" | "unenrolled";

export interface HueRuntimeSnapshot {
  deviceId: string | null;
  lastError: string | null;
  light: HueState | null;
  status: HueRuntimeStatus;
  reasonCode?: string;
}

export interface HueRuntimeOptions {
  events?: HueEvents;
  now?: () => number;
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
  readonly #events: HueEvents;
  readonly #now: () => number;
  #reportedStatus: HueRuntimeStatus = "unenrolled";
  #lastConnectionFailure: string | null = null;
  #lastConnectionEventAt = 0;
  #pendingFailures: {
    event: ReturnType<HueEvents["begin"]>;
    count: number;
    reasonCode: string;
    errorCode: string;
    retryInMs: number;
  } | null = null;
  #connection: HueBleConnection | null = null;
  #connectPromise: Promise<void> | null = null;
  #deviceId: string | null = null;
  #lastError: string | null = null;
  #light: HueState | null = null;
  #reconnectDelay = 1_000;
  #retryAttempts = 0;
  #reasonCode = "unenrolled";
  #reconnectTimer: NodeJS.Timeout | null = null;
  #session: HueProtocolSession | null = null;
  #status: HueRuntimeStatus = "unenrolled";
  #stopped = false;

  constructor(adapter: HueBleAdapter, statePath: string, options: HueRuntimeOptions = {}) {
    this.#adapter = adapter;
    this.#statePath = statePath;
    this.#events = options.events ?? hueEvents;
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    const event = this.#events.begin("runtime.start");
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        event.finish("failed", { errorCode: safeErrorCode(error), ...this.#readiness() });
        throw error;
      }
    }
    if (this.#deviceId) void this.#backgroundReconnect();
    event.finish(this.#status === "available" ? "succeeded" : "degraded", this.#readiness());
  }

  snapshot(): HueRuntimeSnapshot {
    return {
      deviceId: this.#deviceId,
      lastError: this.#lastError,
      light: this.#light,
      status: this.#stopped ? "unavailable" : this.#status,
      reasonCode: this.#stopped ? "stopped" : this.#reasonCode,
    };
  }

  async discover(): Promise<HueDevice> {
    const event = this.#events.begin("runtime.discover");
    try {
      const device = await this.#adapter.discover();
      event.finish("succeeded", this.#readiness());
      return device;
    } catch (error) {
      event.finish("failed", {
        ...this.#readiness(), reasonCode: bluetoothReason(error), errorCode: safeErrorCode(error),
      });
      throw error;
    }
  }

  async enroll(deviceId: string): Promise<void> {
    const event = this.#events.begin("runtime.enroll");
    try {
      if (!deviceId.trim()) throw new Error("device id is required");
      await mkdir(dirname(this.#statePath), { mode: 0o700, recursive: true });
      const temporary = `${this.#statePath}.tmp`;
      const configuration: PersistedConfiguration = { deviceId };
      await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#statePath);
      this.#deviceId = deviceId;
      await this.reconnect();
      event.finish(this.#status === "available" ? "succeeded" : "degraded", this.#readiness());
    } catch (error) {
      event.finish("failed", { ...this.#readiness(), errorCode: safeErrorCode(error) });
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    if (!this.#deviceId || this.#stopped) {
      this.#events.begin("runtime.reconnect").finish("skipped", {
        ...this.#readiness(), reasonCode: this.#stopped ? "stopped" : "unenrolled",
      });
      return;
    }
    if (this.#connectPromise) return this.#connectPromise;
    // An explicit user reconnect starts a fresh, bounded recovery window.
    this.#retryAttempts = 0;
    this.#reconnectDelay = 1_000;
    return this.#attemptConnection();
  }

  async #backgroundReconnect(): Promise<void> {
    try {
      await this.#attemptConnection();
    } catch (error) {
      this.#events.begin("runtime.recovery").finish("degraded", {
        ...this.#readiness(), reasonCode: "cleanup_failed", action: "manual_intervention",
        errorCode: safeErrorCode(error),
      });
    }
  }

  async #attemptConnection(): Promise<void> {
    if (!this.#deviceId || this.#stopped || this.#connectPromise) return this.#connectPromise ?? undefined;
    this.#clearReconnect();
    this.#connectPromise = this.#connect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  setPower(power: boolean): Promise<HueResult<HueState>> {
    return this.#command("power", (session) => session.setPower(power));
  }

  setBrightness(brightness: number): Promise<HueResult<HueState>> {
    return this.#command("brightness", (session) => session.setBrightness(brightness));
  }

  setColorTemperature(colorTemperature: number): Promise<HueResult<HueState>> {
    return this.#command("color_temperature", (session) => session.setColorTemperature(colorTemperature));
  }

  setColorXy(x: number, y: number): Promise<HueResult<HueState>> {
    return this.#command("color_xy", (session) => session.setColorXy(x, y));
  }

  async stop(): Promise<void> {
    const event = this.#events.begin("runtime.stop");
    this.#stopped = true;
    this.#clearReconnect();
    this.#flushFailures();
    try {
      await this.#disconnect();
      event.finish("succeeded", {
        ...this.#readiness(), connected: false, ready: false, reasonCode: "stopped",
        fromState: this.#reportedStatus, toState: "stopped",
      });
    } catch (error) {
      event.finish("failed", { ...this.#readiness(), errorCode: safeErrorCode(error) });
      throw error;
    }
  }

  async #connect(): Promise<void> {
    const event = this.#events.begin("ble.connect", "background", { enrolled: true });
    // Repeated retry attempts do not manufacture unavailable→connecting→unavailable transitions.
    this.#transition("connecting", "connection_attempt", this.#reportedStatus === "unavailable");
    this.#lastError = null;
    try {
      await this.#disconnect();
    } catch (error) {
      // Cleanup failures historically reject reconnect; recording them must not turn them into retries.
      event.finish("failed", { ...this.#readiness(), reasonCode: "disconnect_failed", errorCode: safeErrorCode(error) });
      throw error;
    }
    let reasonCode = "bluetooth_connection_failed";
    try {
      const connection = await this.#adapter.connect(this.#deviceId!, () => {
        if (this.#connection !== connection) return;
        void this.#lostConnection("bluetooth connection closed", "connection_closed").catch((error) => {
          this.#events.begin("runtime.recovery").finish("degraded", {
            ...this.#readiness(), reasonCode: "cleanup_failed", action: "manual_intervention",
            errorCode: safeErrorCode(error),
          });
        });
      });
      if (this.#stopped) {
        await connection.disconnect();
        return;
      }
      this.#connection = connection;
      const session = new HueProtocolSession(connection);
      this.#session = session;
      session.onState((state) => {
        this.#light = state;
      });
      reasonCode = "initialization_failed";
      const initialized = await session.initialize();
      if (!initialized.ok) throw new Error(initialized.message);
      if (this.#stopped) {
        await this.#disconnect();
        return;
      }
      this.#light = initialized.value;
      this.#transition("available", "connected");
      this.#reconnectDelay = 1_000;
      this.#retryAttempts = 0;
      this.#flushFailures();
      this.#lastConnectionFailure = null;
      event.finish("succeeded", { ...this.#readiness(), observationCount: 1 });
    } catch (error) {
      if (reasonCode !== "initialization_failed") reasonCode = bluetoothReason(error);
      const retryInMs = this.#canRetry(reasonCode) ? this.#reconnectDelay : 0;
      try {
        await this.#lostConnection(error instanceof Error ? error.message : String(error), reasonCode);
      } finally {
        this.#recordConnectionFailure(event, reasonCode, safeErrorCode(error), retryInMs);
      }
    }
  }

  async #command(
    action: string,
    run: (session: HueProtocolSession) => Promise<HueResult<HueState>>,
  ): Promise<HueResult<HueState>> {
    const event = this.#events.begin("runtime.command", "background", { action });
    try {
      const result = this.#session ? await run(this.#session) : unavailable("light is unavailable");
      if (!result.ok && result.error === "unavailable" && this.#session) {
        await this.#lostConnection(result.message, "command_unavailable");
      }
      event.finish(result.ok ? "succeeded" : "failed", {
        ...this.#readiness(), ...(!result.ok ? { reasonCode: result.error } : {}),
      });
      return result;
    } catch (error) {
      event.finish("failed", { ...this.#readiness(), errorCode: safeErrorCode(error) });
      throw error;
    }
  }

  async #lostConnection(message: string, reasonCode: string): Promise<void> {
    const retryInMs = this.#canRetry(reasonCode) ? this.#reconnectDelay : 0;
    this.#transition("unavailable", reasonCode, false, retryInMs);
    this.#lastError = message;
    this.#light = null;
    await this.#disconnect();
    if (this.#canRetry(reasonCode) && !this.#reconnectTimer) {
      const delay = this.#reconnectDelay;
      this.#retryAttempts += 1;
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        void this.#backgroundReconnect();
      }, delay);
      this.#reconnectTimer.unref();
    } else if (!this.#stopped && !this.#reconnectTimer) {
      // launchd already recovers crashes. Hardware/permission failures need intervention,
      // not daemon restarts (which would merely reset this budget).
      this.#flushFailures();
      this.#events.begin("runtime.recovery").finish("degraded", {
        ...this.#readiness(), reasonCode, action: "manual_intervention",
        attempt: this.#retryAttempts, retryInMs: 0,
      });
    }
  }

  #canRetry(reasonCode: string): boolean {
    return !this.#stopped && this.#retryAttempts < 5
      && reasonCode !== "bluetooth_unavailable" && reasonCode !== "bluetooth_permission_denied";
  }

  #readiness() {
    return {
      enrolled: this.#deviceId !== null,
      connected: this.#session !== null && this.#status === "available",
      ready: !this.#stopped && this.#status === "available",
      readiness: this.#stopped ? "stopped" : this.#status,
    };
  }

  #transition(next: HueRuntimeStatus, reasonCode: string, quiet = false, retryInMs?: number): void {
    this.#status = next;
    this.#reasonCode = reasonCode;
    if (quiet || this.#reportedStatus === next) return;
    const fromState = this.#reportedStatus;
    this.#reportedStatus = next;
    this.#events.begin("runtime.readiness").finish(next === "available" ? "succeeded" : "degraded", {
      ...this.#readiness(), fromState, toState: next, reasonCode, retryInMs,
    });
  }

  /** First failure and reason changes are immediate; identical retries summarize at most once/minute.
   * Recovery and shutdown flush the pending count, so a short outage does not lose its retries.
   */
  #recordConnectionFailure(
    event: ReturnType<HueEvents["begin"]>, reasonCode: string, errorCode: string, retryInMs: number,
  ): void {
    const signature = `${reasonCode}:${errorCode}`;
    if (signature !== this.#lastConnectionFailure) {
      this.#flushFailures();
      this.#lastConnectionFailure = signature;
      this.#lastConnectionEventAt = this.#now();
      event.finish("failed", { ...this.#readiness(), reasonCode, errorCode, retryInMs, observationCount: 1 });
      return;
    }
    if (!this.#pendingFailures) {
      // A summary duration measures the retry window, not the latency of one BLE attempt.
      this.#pendingFailures = {
        event: this.#events.begin("ble.retry_summary"), count: 0, reasonCode, errorCode, retryInMs,
      };
    }
    this.#pendingFailures.count += 1;
    this.#pendingFailures.retryInMs = retryInMs;
    if (this.#now() - this.#lastConnectionEventAt >= 60_000) this.#flushFailures();
  }

  #flushFailures(): void {
    const pending = this.#pendingFailures;
    if (!pending) return;
    this.#pendingFailures = null;
    this.#lastConnectionEventAt = this.#now();
    pending.event.finish("failed", {
      enrolled: this.#deviceId !== null, ready: false, connected: false, readiness: "unavailable",
      reasonCode: pending.reasonCode, errorCode: pending.errorCode,
      retryInMs: pending.retryInMs, observationCount: pending.count,
    });
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
