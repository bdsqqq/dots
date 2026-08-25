import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWideEvent,
  flushLogs,
  initializeLogs,
  registerLogDrain,
  type LogDrain,
} from "./index.js";

describe("shared pi logging", () => {
  it("fans private, redacted wide events into evlog's local drain", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bds-pi-log-"));
    const pending = join(directory, "pending");
    mkdirSync(pending);
    writeFileSync(
      join(pending, "interrupted-operation.json"),
      JSON.stringify({
        version: 1,
        service: "pi-test",
        operation: "test.interrupted",
        operationId: "interrupted-operation",
        startedAt: "2026-07-30T00:00:00.000Z",
        pid: 2_147_483_647,
      }),
    );
    const captured: unknown[] = [];
    const capture: LogDrain = ({ event }) => {
      captured.push(event);
    };
    initializeLogs({ directory, drain: capture });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const first = createWideEvent({
      service: "pi-memory",
      operation: "memory.test",
      operationId: "memory-operation",
      correlation: {
        runId: "run-123",
        token: "sk_test_12345678901234567890",
        api_key: "plain-api-key",
        credentialUrl: "https://user:password@example.com/private",
        private_key:
          "-----BEGIN TEST PRIVATE KEY-----\nsecret\n-----END TEST PRIVATE KEY-----",
        oversized: "x".repeat(50_000),
        circular,
        ghp_abcdefghijklmnopqrst: "credential-shaped key",
        ["k".repeat(2_000)]: "oversized key",
      },
      fields: {
        batches: 2,
        client_secret: "plain-client-secret",
        operationId: "field-override",
        outcome: { status: "field-override" },
      },
    });
    const markerRaw = readdirSync(pending)
      .map((name) => readFileSync(join(pending, name), "utf8"))
      .find((raw) => raw.includes("memory-operation"));
    expect(markerRaw).not.toContain("password@example.com");
    expect(markerRaw).not.toContain("PRIVATE KEY");
    expect(markerRaw).not.toContain("sk_test");
    expect(markerRaw).not.toContain("plain-api-key");
    expect(markerRaw).not.toContain("x".repeat(2_000));
    expect(markerRaw).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(markerRaw).not.toContain("k".repeat(200));
    expect(markerRaw).toContain("<circular>");
    first.finish("success", { outcome: { status: "finish-override" } });
    const second = createWideEvent({
      service: "pi-agent-message",
      operation: "message.test",
    });
    second.error(new Error("Bearer secret-value"));
    second.finish("failure");
    const victim = join(directory, "victim.json");
    writeFileSync(victim, "keep");
    const traversal = createWideEvent({
      service: "pi-test",
      operation: "test.traversal",
      operationId: "../../victim",
    });
    traversal.finish("success");
    const previousTimeout = process.env.BDS_PI_LOG_DRAIN_TIMEOUT_MS;
    process.env.BDS_PI_LOG_DRAIN_TIMEOUT_MS = "20";
    const unregister = registerLogDrain(() => new Promise(() => undefined));
    const hung = createWideEvent({
      service: "pi-test",
      operation: "test.hung-drain",
    });
    hung.finish("success");
    const pollution = createWideEvent({
      service: "pi-test",
      operation: "test.prototype-pollution",
    });
    pollution.set(
      JSON.parse(
        '{"__proto__":{"bdsPiPolluted":true},"constructor":{"prototype":{"bdsPiPolluted":true}}}',
      ) as Record<string, unknown>,
    );
    pollution.finish("success");
    await flushLogs();
    unregister();
    if (previousTimeout === undefined)
      delete process.env.BDS_PI_LOG_DRAIN_TIMEOUT_MS;
    else process.env.BDS_PI_LOG_DRAIN_TIMEOUT_MS = previousTimeout;

    const files = readdirSync(directory).filter((name) =>
      name.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(directory, files[0]!), "utf8");
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events).toHaveLength(6);
    expect(events).toContainEqual(
      expect.objectContaining({
        service: "pi-memory",
        operation: "memory.test",
        operationId: "memory-operation",
        correlation: expect.objectContaining({ runId: "run-123" }),
        outcome: { status: "success" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        service: "pi-test",
        operation: "test.traversal",
        operationId: expect.stringMatching(/^op_[0-9a-f]{64}$/),
        outcome: { status: "success" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        service: "pi-test",
        operation: "test.interrupted",
        outcome: { status: "interrupted" },
      }),
    );
    expect(raw).not.toContain("secret-value");
    expect(raw).not.toContain("sk_test");
    expect(raw).not.toContain("plain-api-key");
    expect(raw).not.toContain("plain-client-secret");
    expect(captured).toHaveLength(6);
    expect(({} as Record<string, unknown>).bdsPiPolluted).toBeUndefined();
    expect(existsSync(victim)).toBe(true);
    expect(readdirSync(pending)).toHaveLength(0);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
  });
});
