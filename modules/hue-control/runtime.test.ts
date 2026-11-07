import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventLogger } from "../service-events/events.ts";
import type { ServiceEvent } from "../service-events/events.ts";

import type { HueBleAdapter, HueBleConnection, HueDevice } from "./ble-adapter.ts";
import { HUE_CHARACTERISTICS } from "./hue-protocol.ts";
import { HueRuntime } from "./runtime.ts";

class FakeConnection implements HueBleConnection {
  readonly listeners = new Map<string, (value: Uint8Array) => void>();
  readonly values = new Map<string, Uint8Array>([
    [HUE_CHARACTERISTICS.power, Uint8Array.of(1)],
    [HUE_CHARACTERISTICS.brightness, Uint8Array.of(100)],
    [HUE_CHARACTERISTICS.colorTemperature, Uint8Array.of(0x2c, 0x01)],
    [HUE_CHARACTERISTICS.colorXy, Uint8Array.of(0x32, 0xb3, 0xff, 0x7f)],
    [HUE_CHARACTERISTICS.model, new TextEncoder().encode("LCA011")],
    [HUE_CHARACTERISTICS.name, new TextEncoder().encode("desk")],
  ]);
  failWrites = false;
  failDisconnect = false;
  disconnected = false;

  async read(characteristic: string): Promise<Uint8Array> {
    const value = this.values.get(characteristic);
    if (!value) throw new Error(`missing ${characteristic}`);
    return value;
  }

  async subscribe(
    characteristic: string,
    listener: (value: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    this.listeners.set(characteristic, listener);
    return async () => {
      this.listeners.delete(characteristic);
    };
  }

  async write(): Promise<void> {
    if (this.failWrites) throw new Error("radio disappeared");
  }

  async disconnect(): Promise<void> {
    if (this.failDisconnect) throw new Error("private-disconnect-failure");
    this.disconnected = true;
  }
}

class FakeAdapter implements HueBleAdapter {
  readonly connection = new FakeConnection();
  readonly connectedIds: string[] = [];
  failConnect = false;
  connectError: Error | null = null;
  lost: (() => void) | null = null;

  async discover(): Promise<HueDevice> {
    return { id: "corebluetooth-id", name: "desk" };
  }

  async connect(deviceId: string, disconnected: () => void): Promise<HueBleConnection> {
    this.connectedIds.push(deviceId);
    this.lost = disconnected;
    if (this.connectError) throw this.connectError;
    if (this.failConnect) throw new Error("bulb not found");
    return this.connection;
  }
}

test("runtime enrolls one explicit device, persists it, and exposes live state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-runtime-"));
  const statePath = join(directory, "state.json");
  const adapter = new FakeAdapter();
  const runtime = new HueRuntime(adapter, statePath);
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().status, "unenrolled");
    assert.deepEqual(await runtime.discover(), { id: "corebluetooth-id", name: "desk" });

    await runtime.enroll("corebluetooth-id");
    assert.deepEqual(adapter.connectedIds, ["corebluetooth-id"]);
    assert.equal(runtime.snapshot().status, "available");
    assert.equal(runtime.snapshot().light?.model, "LCA011");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
      deviceId: "corebluetooth-id",
    });

    const changed = await runtime.setBrightness(42);
    assert.equal(changed.ok, true);
    assert.equal(runtime.snapshot().light?.brightness, 42);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("runtime restores identity and clears stale state after transport failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-runtime-"));
  const statePath = join(directory, "state.json");
  const firstAdapter = new FakeAdapter();
  const first = new HueRuntime(firstAdapter, statePath);
  try {
    await first.start();
    await first.enroll("saved-id");
    await first.stop();

    const adapter = new FakeAdapter();
    const runtime = new HueRuntime(adapter, statePath);
    await runtime.start();
    await runtime.reconnect();
    assert.deepEqual(adapter.connectedIds, ["saved-id"]);
    assert.equal(runtime.snapshot().status, "available");

    adapter.connection.failWrites = true;
    assert.deepEqual(await runtime.setPower(false), {
      error: "unavailable",
      message: "radio disappeared",
      ok: false,
    });
    assert.equal(runtime.snapshot().status, "unavailable");
    assert.equal(runtime.snapshot().light, null);
    assert.equal(adapter.connection.disconnected, true);
    await runtime.stop();
  } finally {
    await first.stop();
    await rm(directory, { recursive: true });
  }
});

function captureEvents() {
  const lines: string[] = [];
  const events = createEventLogger("hue-control", {
    host: "test-host", sink: (event) => lines.push(JSON.stringify(event)),
  });
  return { events, lines, emitted: (): ServiceEvent[] => lines.map((line) => JSON.parse(line)) };
}

test("runtime JSON events explain commands and readiness without disclosing device state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-private-path-"));
  const adapter = new FakeAdapter();
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, join(directory, "private-state.json"), capture);
  try {
    await runtime.start();
    assert.equal(capture.emitted()[0].outcome, "degraded");
    assert.equal(capture.emitted()[0].context.enrolled, false);
    await runtime.reconnect();
    assert.equal(capture.emitted().at(-1)?.outcome, "skipped");
    await runtime.discover();
    await runtime.enroll("private-device-id");
    assert.equal((await runtime.setBrightness(42)).ok, true);
    assert.equal((await runtime.setBrightness(Infinity)).ok, false);
    adapter.connection.failWrites = true;
    assert.equal((await runtime.setPower(false)).ok, false);
    assert.equal(runtime.snapshot().lastError, "radio disappeared");
    await runtime.stop();

    const emitted = capture.emitted();
    const commands = emitted.filter((event) => event.operation === "runtime.command");
    assert.deepEqual(commands.map((event) => [event.outcome, event.context.action, event.context.reasonCode]), [
      ["succeeded", "brightness", undefined],
      ["failed", "brightness", "invalid-command"],
      ["failed", "power", "unavailable"],
    ]);
    const lost = emitted.find((event) => event.context.toState === "unavailable")!;
    assert.equal(lost.outcome, "degraded");
    assert.equal(lost.context.fromState, "available");
    assert.equal(lost.context.reasonCode, "command_unavailable");
    assert.equal(lost.context.retryInMs, 1000);
    assert.equal(lost.context.enrolled, true);
    assert.equal(lost.context.ready, false);
    assert.ok(emitted.some((event) => event.operation === "ble.connect" && event.outcome === "succeeded"));
    assert.equal(emitted.at(-1)?.operation, "runtime.stop");
    assert.equal(emitted.at(-1)?.context.ready, false);
    assert.equal(emitted.at(-1)?.context.readiness, "stopped");
    assert.equal(emitted.at(-1)?.context.toState, "stopped");
    assert.equal(new Set(emitted.map((event) => event.operationId)).size, emitted.length);
    for (const event of emitted) {
      assert.match(event.eventId, /^[0-9a-f-]{36}$/);
      assert.match(event.operationId, /^[0-9a-f-]{36}$/);
      assert.match(event.timestamp, /Z$/);
      assert.equal(event.host, "test-host");
      assert.ok(event.durationMs >= 0);
    }
    assert.doesNotMatch(capture.lines.join("\n"), /private-device-id|private-state|hue-private-path|corebluetooth-id|desk|LCA011|radio disappeared|deviceId|lastError|colorXy/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("identical transient BLE failures are counted, capped to one summary/minute, and flushed on recovery/stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-retry-"));
  const adapter = new FakeAdapter();
  adapter.connectError = Object.assign(new Error("private-radio-device-secret"), { code: "ECONNRESET" });
  const capture = captureEvents();
  let clock = 0;
  const runtime = new HueRuntime(adapter, join(directory, "state.json"), { ...capture, now: () => clock });
  const connections = () => capture.emitted().filter((event) => ["ble.connect", "ble.retry_summary"].includes(event.operation));
  try {
    await runtime.enroll("private-enrolled-id");
    assert.equal(runtime.snapshot().status, "unavailable");
    assert.equal(runtime.snapshot().lastError, "private-radio-device-secret");
    assert.equal(capture.emitted().find((event) => event.operation === "runtime.enroll")?.outcome, "degraded");
    assert.equal(connections().length, 1);
    assert.equal(connections()[0].context.reasonCode, "bluetooth_connection_failed");
    assert.equal(connections()[0].context.retryInMs, 1000);
    for (let i = 0; i < 10; i++) await runtime.reconnect();
    assert.equal(connections().length, 1, "no new log for every identical retry");
    assert.equal(capture.emitted().filter((event) => event.operation === "runtime.readiness").length, 2);
    clock = 60_000;
    await runtime.reconnect();
    assert.equal(connections().length, 2);
    assert.equal(connections()[1].operation, "ble.retry_summary");
    assert.equal(connections()[1].context.observationCount, 11);
    assert.equal(connections()[1].context.retryInMs, 1000);

    // A changed failure category is meaningful immediately, even inside the rate-limit window.
    await runtime.reconnect();
    adapter.connectError = Object.assign(new Error("private-timeout"), { code: "ETIMEDOUT" });
    await runtime.reconnect();
    assert.equal(connections().length, 4);
    assert.equal(connections()[2].context.observationCount, 1);
    assert.equal(connections()[3].context.errorCode, "ETIMEDOUT");
    assert.equal(connections()[3].context.reasonCode, "bluetooth_connection_failed");
    await runtime.reconnect();
    adapter.connectError = null;
    await runtime.reconnect();
    assert.equal(connections().at(-2)?.context.readiness, "unavailable");
    assert.equal(connections().at(-1)?.outcome, "succeeded");
    assert.equal(connections().at(-1)?.context.ready, true);
    const recovered = capture.emitted().filter((event) => event.operation === "runtime.readiness").at(-1)!;
    assert.equal(recovered.context.fromState, "unavailable");
    assert.equal(recovered.context.toState, "available");

    adapter.connectError = Object.assign(new Error("private-radio-device-secret"), { code: "ECONNRESET" });
    await runtime.reconnect();
    await runtime.reconnect();
    const beforeStop = connections().length;
    await runtime.stop();
    assert.equal(connections().length, beforeStop + 1);
    assert.equal(connections().reduce((count, event) => count + event.context.observationCount!, 0), adapter.connectedIds.length);
    assert.doesNotMatch(capture.lines.join("\n"), /private-radio|private-timeout|private-enrolled|deviceId|lastError/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("automatic BLE retry keeps exponential delay and emits only bounded completion summaries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const directory = await mkdtemp(join(tmpdir(), "hue-auto-retry-"));
  const adapter = new FakeAdapter();
  adapter.failConnect = true;
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, join(directory, "state.json"), capture);
  try {
    await runtime.enroll("private-id");
    assert.equal(adapter.connectedIds.length, 1);
    t.mock.timers.tick(1000);
    await runtime.reconnect(); // joins the attempt started by the timer
    assert.equal(adapter.connectedIds.length, 2);
    t.mock.timers.tick(1999);
    assert.equal(adapter.connectedIds.length, 2);
    t.mock.timers.tick(1);
    await runtime.reconnect();
    assert.equal(adapter.connectedIds.length, 3);
    assert.equal(capture.emitted().filter((event) => event.operation === "ble.connect").length, 1);
    await runtime.stop();
    const summary = capture.emitted().filter((event) => event.operation === "ble.retry_summary").at(-1)!;
    assert.equal(summary.context.observationCount, 2);
    assert.equal(summary.context.retryInMs, 4000);
    t.mock.timers.tick(60_000);
    assert.equal(adapter.connectedIds.length, 3, "stop cancels the pending retry");
  } finally {
    await runtime.stop();
    t.mock.timers.reset();
    await rm(directory, { recursive: true });
  }
});

test("automatic transient recovery has a finite budget and explicit reconnect can recover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const directory = await mkdtemp(join(tmpdir(), "hue-bounded-"));
  const adapter = new FakeAdapter();
  adapter.failConnect = true;
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, join(directory, "state.json"), capture);
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    await runtime.enroll("private-id");
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      t.mock.timers.tick(delay);
      await settle();
    }
    assert.equal(adapter.connectedIds.length, 6);
    t.mock.timers.tick(24 * 60 * 60_000);
    await settle();
    assert.equal(adapter.connectedIds.length, 6, "no retry loop after exhaustion");
    assert.equal(runtime.snapshot().status, "unavailable");
    assert.equal(capture.emitted().find(e => e.operation === "runtime.recovery")?.context.action, "manual_intervention");
    adapter.failConnect = false;
    await runtime.reconnect();
    assert.equal(runtime.snapshot().status, "available");
  } finally {
    await runtime.stop();
    t.mock.timers.reset();
    await rm(directory, { recursive: true });
  }
});

for (const [code, reasonCode] of [["BLUETOOTH_UNAVAILABLE", "bluetooth_unavailable"], ["EACCES", "bluetooth_permission_denied"], ["EPERM", "bluetooth_permission_denied"]]) {
  test(`${code} stays degraded and escalates without automatic hardware/process recovery`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const directory = await mkdtemp(join(tmpdir(), "hue-terminal-"));
    const adapter = new FakeAdapter();
    adapter.connectError = Object.assign(new Error("private-device-error"), { code });
    const capture = captureEvents();
    const runtime = new HueRuntime(adapter, join(directory, "state.json"), capture);
    try {
      await runtime.enroll("private-id");
      t.mock.timers.tick(24 * 60 * 60_000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(adapter.connectedIds.length, 1);
      assert.equal(runtime.snapshot().status, "unavailable");
      assert.equal(runtime.snapshot().reasonCode, reasonCode);
      const escalation = capture.emitted().find(e => e.operation === "runtime.recovery")!;
      assert.equal(escalation.context.action, "manual_intervention");
      assert.equal(escalation.context.retryInMs, 0);
      assert.equal(escalation.context.reasonCode, reasonCode);
      assert.doesNotMatch(capture.lines.join(""), /private-device|private-id/);
    } finally {
      await runtime.stop();
      t.mock.timers.reset();
      await rm(directory, { recursive: true });
    }
  });
}

test("initialization and persisted-state failures emit bounded categories without changing error results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-state-failure-"));
  const path = join(directory, "state.json");
  const adapter = new FakeAdapter();
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, path, capture);
  try {
    await writeFile(path, "private-invalid-json");
    await assert.rejects(runtime.start(), SyntaxError);
    assert.equal(capture.emitted()[0].operation, "runtime.start");
    assert.equal(capture.emitted()[0].outcome, "failed");
    assert.equal(capture.emitted()[0].context.errorCode, "UNEXPECTED_ERROR");
    adapter.connection.values.delete(HUE_CHARACTERISTICS.power);
    await runtime.enroll("private-device");
    const failed = capture.emitted().find((event) => event.operation === "ble.connect")!;
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.context.reasonCode, "initialization_failed");
    assert.equal(failed.context.ready, false);
    assert.doesNotMatch(capture.lines.join("\n"), /private-invalid-json|private-device|missing|932c32bd/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("a disconnect callback cleanup failure escalates without an unhandled rejection or restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-callback-"));
  const adapter = new FakeAdapter();
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, join(directory, "state.json"), capture);
  try {
    await runtime.enroll("private-id");
    adapter.connection.failDisconnect = true;
    adapter.lost!();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(runtime.snapshot().status, "unavailable");
    assert.equal(adapter.connectedIds.length, 1);
    const escalation = capture.emitted().find(e => e.operation === "runtime.recovery")!;
    assert.equal(escalation.context.reasonCode, "cleanup_failed");
    assert.equal(escalation.context.action, "manual_intervention");
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});

test("recording cleanup failures preserves reconnect rejection rather than silently retrying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-disconnect-failure-"));
  const adapter = new FakeAdapter();
  const capture = captureEvents();
  const runtime = new HueRuntime(adapter, join(directory, "state.json"), capture);
  try {
    await runtime.enroll("private-device");
    adapter.connection.failDisconnect = true;
    await assert.rejects(runtime.reconnect(), /private-disconnect-failure/);
    const failed = capture.emitted().filter((event) => event.operation === "ble.connect").at(-1)!;
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.context.reasonCode, "disconnect_failed");
    assert.equal(adapter.connectedIds.length, 1);
    assert.doesNotMatch(capture.lines.join("\n"), /private-device|private-disconnect-failure/);
  } finally {
    adapter.connection.failDisconnect = false;
    await runtime.stop();
    await rm(directory, { recursive: true });
  }
});
