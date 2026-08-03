import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWideEvent, flushLogs } from "@bds_pi/log";
import { describe, expect, it, vi } from "vitest";
import {
  observeMemoryOperation,
  withMemoryWideEventFactory,
} from "./observability.js";

function capture() {
  const events: Array<{
    errors: Array<{ error: unknown; fields: unknown }>;
    finishes: Array<{ outcome: string; fields: unknown }>;
  }> = [];
  const factory = () => {
    const event: (typeof events)[number] = { errors: [], finishes: [] };
    events.push(event);
    return {
      id: `test-${events.length}`,
      set: vi.fn(),
      error: (error: unknown, fields: unknown) =>
        event.errors.push({ error, fields }),
      finish: (outcome: string, fields: unknown) =>
        event.finishes.push({ outcome, fields }),
    };
  };
  return { events, factory };
}

describe("memory operation observability", () => {
  it("emits one terminal event for synchronous success", () => {
    const { events, factory } = capture();
    const value = withMemoryWideEventFactory(factory, () =>
      observeMemoryOperation(
        {
          operation: "memory.test",
          result: (result) => ({ fields: { changed: result } }),
        },
        () => true,
      ),
    );

    expect(value).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.finishes).toEqual([
      { outcome: "success", fields: { changed: true } },
    ]);
  });

  it("emits one failure terminal and preserves the thrown value", () => {
    const { events, factory } = capture();
    const failure = new Error("private failure body");
    let thrown: unknown;
    try {
      withMemoryWideEventFactory(
        factory,
        () =>
          void observeMemoryOperation({ operation: "memory.test" }, () => {
            throw failure;
          }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(events[0]?.errors).toHaveLength(1);
    expect(events[0]?.finishes).toEqual([
      {
        outcome: "failure",
        fields: { errorType: "Error" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private failure body");
  });

  it("handles concurrent asynchronous operations independently", async () => {
    const { events, factory } = capture();
    const values = await withMemoryWideEventFactory(factory, () =>
      Promise.all([
        observeMemoryOperation({ operation: "memory.test-a" }, async () => 1),
        observeMemoryOperation({ operation: "memory.test-b" }, async () => 2),
      ]),
    );

    expect(values).toEqual([1, 2]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.finishes.length === 1)).toBe(true);
  });

  it("preserves asynchronous rejection without logging its message", async () => {
    const { events, factory } = capture();
    const failure = new Error("private asynchronous failure");

    await expect(
      withMemoryWideEventFactory(factory, () =>
        observeMemoryOperation({ operation: "memory.test" }, async () =>
          Promise.reject(failure),
        ),
      ),
    ).rejects.toBe(failure);
    expect(events[0]?.errors).toHaveLength(1);
    expect(events[0]?.finishes).toEqual([
      { outcome: "failure", fields: { errorType: "Error" } },
    ]);
    expect(JSON.stringify(events)).not.toContain(
      "private asynchronous failure",
    );
  });

  it("does not block the domain operation when logging fails", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory = () => {
      throw new Error("logger unavailable");
    };

    expect(
      withMemoryWideEventFactory(factory, () =>
        observeMemoryOperation({ operation: "memory.test" }, () => 42),
      ),
    ).toBe(42);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it("does not block the domain operation when terminal emission fails", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory = () => ({
      id: "test",
      set: vi.fn(),
      error: vi.fn(),
      finish: () => {
        throw new Error("drain unavailable");
      },
    });

    expect(
      withMemoryWideEventFactory(factory, () =>
        observeMemoryOperation({ operation: "memory.test" }, () => 42),
      ),
    ).toBe(42);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it("persists sanitized terminals through the production logger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-memory-observation-"));
    const previousDirectory = process.env.BDS_PI_LOG_DIR;
    process.env.BDS_PI_LOG_DIR = directory;
    try {
      withMemoryWideEventFactory(createWideEvent, () => {
        observeMemoryOperation(
          { operation: "memory.integration-success" },
          () => true,
        );
        try {
          void observeMemoryOperation(
            { operation: "memory.integration-failure" },
            () => {
              throw new Error("private integration failure");
            },
          );
        } catch {}
      });
      await flushLogs();

      const raw = readdirSync(directory)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFileSync(join(directory, name), "utf8"))
        .join("\n");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.outcome)).toEqual([
        { status: "success" },
        { status: "failure" },
      ]);
      expect(raw).not.toContain("private integration failure");
      expect(readdirSync(join(directory, "pending"))).toHaveLength(0);
    } finally {
      if (previousDirectory === undefined) delete process.env.BDS_PI_LOG_DIR;
      else process.env.BDS_PI_LOG_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
