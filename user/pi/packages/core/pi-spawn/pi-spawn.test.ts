import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { piSpawn } = await import("./index");

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin?: { write: ReturnType<typeof vi.fn> };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(options?: { autoCloseOnKill?: boolean }): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    if (options?.autoCloseOnKill !== false) {
      queueMicrotask(() => proc.emit("close", signal === "SIGTERM" ? 143 : 0));
    }
    return true;
  });
  return proc;
}

describe("piSpawn abort handling", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills the child process and reports an aborted result when the parent signal aborts", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    const controller = new AbortController();

    const resultPromise = piSpawn({
      cwd: "/tmp",
      task: "test abort",
      signal: controller.signal,
    });

    controller.abort();
    const result = await resultPromise;

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("removes the abort listener after close so late aborts do not kill finished children", async () => {
    const proc = createMockProc({ autoCloseOnKill: false });
    spawnMock.mockReturnValue(proc);
    const controller = new AbortController();

    const resultPromise = piSpawn({
      cwd: "/tmp",
      task: "test cleanup",
      signal: controller.signal,
    });

    proc.emit("close", 0);
    const result = await resultPromise;
    controller.abort();

    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
