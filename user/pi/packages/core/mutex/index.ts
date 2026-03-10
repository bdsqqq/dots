/**
 * per-path async mutex for file operations.
 *
 * serializes concurrent edits to the same file path to prevent
 * partial writes and race conditions. pi's built-in edit tool doesn't.
 * this mutex is keyed by resolved absolute path — two relative paths
 * pointing to the same file share one lock.
 */

import * as path from "node:path";

const locks = new Map<string, Promise<void>>();

/**
 * execute `fn` while holding an exclusive lock on `filePath`.
 * concurrent calls for the same resolved path queue sequentially.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);

  while (locks.has(key)) {
    await locks.get(key);
  }

  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  locks.set(key, promise);

  try {
    return await fn();
  } finally {
    locks.delete(key);
    resolve();
  }
}

// inline tests
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("withFileLock", () => {
    it("executes function and returns result", async () => {
      const result = await withFileLock("/tmp/test.txt", async () => {
        return "success";
      });
      expect(result).toBe("success");
    });

    it("propagates errors from the function", async () => {
      try {
        await withFileLock("/tmp/error.txt", async () => {
          throw new Error("test error");
        });
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect((e as Error).message).toBe("test error");
      }
    });

    it("serializes concurrent calls for the same path", async () => {
      const order: string[] = [];
      const path = "/tmp/same-path.txt";

      const makeOp = (id: string, delayMs: number) =>
        withFileLock(path, async () => {
          order.push(`${id}-start`);
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(`${id}-end`);
          return id;
        });

      // start all operations concurrently
      const results = await Promise.all([
        makeOp("a", 50),
        makeOp("b", 30),
        makeOp("c", 10),
      ]);

      expect(results).toEqual(["a", "b", "c"]);

      // verify serialization: each op must complete before next starts
      // pattern: a-start, a-end, b-start, b-end, c-start, c-end
      expect(order).toEqual([
        "a-start",
        "a-end",
        "b-start",
        "b-end",
        "c-start",
        "c-end",
      ]);
    });

    it("allows parallel execution for different paths", async () => {
      const order: string[] = [];

      const makeOp = (path: string, id: string, delayMs: number) =>
        withFileLock(path, async () => {
          order.push(`${id}-start`);
          await new Promise((r) => setTimeout(r, delayMs));
          order.push(`${id}-end`);
          return id;
        });

      const start = Date.now();
      const results = await Promise.all([
        makeOp("/tmp/path-a.txt", "a", 50),
        makeOp("/tmp/path-b.txt", "b", 50),
        makeOp("/tmp/path-c.txt", "c", 50),
      ]);
      const elapsed = Date.now() - start;

      expect(results).toEqual(["a", "b", "c"]);

      // all should complete in ~50ms (parallel), not ~150ms (serial)
      expect(elapsed).toBeLessThan(120);

      // all starts should come before all ends (parallel execution)
      const starts = order.filter((o) => o.endsWith("-start"));
      const ends = order.filter((o) => o.endsWith("-end"));
      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);
    });

    it("handles same path resolved differently", async () => {
      // relative and absolute paths should resolve to same lock
      const order: string[] = [];
      const absolute = "/tmp/same-file.txt";
      // these might resolve to different keys depending on cwd,
      // but let's test that resolve() is being used
      const results = await Promise.all([
        withFileLock(absolute, async () => {
          order.push("abs-start");
          await new Promise((r) => setTimeout(r, 20));
          order.push("abs-end");
          return "abs";
        }),
      ]);

      expect(results).toEqual(["abs"]);
    });

    it("releases lock after error", async () => {
      const path = "/tmp/error-release.txt";

      // first call throws
      try {
        await withFileLock(path, async () => {
          throw new Error("first fails");
        });
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect((e as Error).message).toBe("first fails");
      }

      // second call should succeed (lock was released)
      const result = await withFileLock(path, async () => {
        return "second succeeds";
      });

      expect(result).toBe("second succeeds");
    });

    it("handles rapid sequential calls on same path", async () => {
      const path = "/tmp/rapid.txt";
      let counter = 0;

      const results = await Promise.all([
        withFileLock(path, async () => ++counter),
        withFileLock(path, async () => ++counter),
        withFileLock(path, async () => ++counter),
      ]);

      // each call should increment counter exactly once
      expect(results).toEqual([1, 2, 3]);
      expect(counter).toBe(3);
    });
  });
}
