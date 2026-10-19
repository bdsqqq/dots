import fs, { type FSWatcher } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface MemoryWorkResult {
  readonly progress: boolean;
  readonly failed?: boolean;
  /** absolute epoch milliseconds; filesystem activity cannot advance this. */
  readonly retryAt?: number;
}

export interface MemoryWakePolicy {
  readonly debounceMs: number;
  readonly idleInitialMs: number;
  readonly idleMaxMs: number;
  readonly failureInitialMs: number;
  readonly failureMaxMs: number;
  readonly jitterRatio: number;
}

export interface MemoryWakeEvent {
  readonly kind: "run" | "wait" | "watch-error" | "checkpoint-error";
  readonly at: number;
  readonly delayMs?: number;
  readonly progress?: boolean;
  readonly failed?: boolean;
  readonly watchers?: number;
}

export interface WatchMemoryWorkOptions {
  /** refreshed before and after work; only these paths and their existence guards are watched. */
  readonly roots: () => readonly string[];
  /** operational files/directories within roots; refreshed with roots. */
  readonly ignore?: () => readonly string[];
  /** replaceable, job-local operational state; never knowledge or a receipt. */
  readonly checkpoint: string;
  readonly signal: AbortSignal;
  /** owns cooperative cancellation through the supplied signal; no lifetime limit is imposed. */
  readonly run: () => Promise<MemoryWorkResult>;
  readonly report?: (event: MemoryWakeEvent) => void;
  readonly policy?: Partial<MemoryWakePolicy>;
  readonly now?: () => number;
  readonly random?: () => number;
}

const defaults: MemoryWakePolicy = {
  debounceMs: 250,
  idleInitialMs: 60_000,
  idleMaxMs: 30 * 60_000,
  failureInitialMs: 60_000,
  failureMaxMs: 60 * 60_000,
  jitterRatio: 0.2,
};

interface WakeCheckpoint {
  version: 1;
  idleMs: number;
  failureMs: number;
  nextRunAt: number;
  cooldownUntil: number;
}

function validCheckpoint(value: unknown): value is WakeCheckpoint {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    [state.idleMs, state.failureMs, state.nextRunAt, state.cooldownUntil].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    )
  );
}

/**
 * filesystem notifications are coalesced hints, not a durable queue. adaptive
 * recovery work covers lost events and unavailable watchers without scanning
 * retained content here. use one supervisor instance/checkpoint per job.
 *
 * events reset idle delay only. failure cooldowns and handler retryAt survive
 * both events and restarts. checkpoint writes are atomic replacements, without
 * the store's receipt or power-loss guarantees. callers choose roots that avoid
 * unrelated job bookkeeping; this loop excludes its own checkpoint and temp file.
 * resolves after abort and completion of current cooperative work.
 */
export async function watchMemoryWork(
  options: WatchMemoryWorkOptions,
): Promise<void> {
  const policy = { ...defaults, ...options.policy };
  for (const [key, value] of Object.entries(policy)) {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (key !== "jitterRatio" && value < 1)
    )
      throw new Error("invalid memory wake policy");
  }
  if (
    policy.idleMaxMs < policy.idleInitialMs ||
    policy.failureMaxMs < policy.failureInitialMs ||
    policy.jitterRatio > 1
  )
    throw new Error("invalid memory wake policy");
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const checkpoint = resolve(options.checkpoint);
  const temporary = `${checkpoint}.${process.pid}.tmp`;
  let state: WakeCheckpoint = {
    version: 1,
    idleMs: 0,
    failureMs: 0,
    nextRunAt: 0,
    cooldownUntil: 0,
  };
  let watchers: FSWatcher[] = [];
  let ignored: string[] = [];
  let pendingAt = Infinity;
  let interrupt: (() => void) | undefined;
  const report = (event: Omit<MemoryWakeEvent, "at">): void => {
    try {
      // an observer must not break scheduling, including an accidentally async one.
      void Promise.resolve(options.report?.({ ...event, at: now() })).catch(
        () => {},
      );
    } catch {
      /* diagnostic observers are optional */
    }
  };
  const ownPath = (path: string): boolean =>
    path === checkpoint || path === temporary;
  const ignoredPath = (path: string): boolean =>
    ignored.some(
      (entry) =>
        path === entry ||
        path.startsWith(entry.endsWith(sep) ? entry : `${entry}${sep}`),
    );
  const hint = (): void => {
    if (options.signal.aborted) return;
    pendingAt = now() + policy.debounceMs;
    state.idleMs = 0;
    interrupt?.();
  };
  const watch = (
    path: string,
    recursive: boolean,
    child?: string,
  ): FSWatcher | undefined => {
    try {
      const watcher = fs.watch(path, { recursive }, (event, filename) => {
        const changed =
          filename === null ? undefined : resolve(path, filename.toString());
        // fsevents can coalesce a checkpoint write into its directory's metadata.
        // keep watching entries there; only the directory event itself is ignored.
        if (
          changed &&
          (ownPath(changed) ||
            changed === dirname(checkpoint) ||
            ignoredPath(changed))
        )
          return;
        // parent guards only detect replacement/existence, never unrelated siblings.
        if (
          child &&
          (event !== "rename" || (changed && changed !== join(path, child)))
        )
          return;
        hint();
      });
      watcher.on("error", () => {
        watcher.close();
        report({ kind: "watch-error" });
        // recovery uses the existing adaptive timer, not another immediate hint.
      });
      return watcher;
    } catch {
      report({ kind: "watch-error" });
      return undefined;
    }
  };
  const refresh = async (): Promise<void> => {
    const replacement: FSWatcher[] = [];
    const attached = new Set<string>();
    const attach = (path: string, recursive: boolean, child?: string): void => {
      const key = `${path}\0${recursive}\0${child ?? ""}`;
      if (attached.has(key)) return;
      attached.add(key);
      const watcher = watch(path, recursive, child);
      if (watcher) replacement.push(watcher);
    };
    try {
      ignored = (options.ignore?.() ?? []).map((path) => resolve(path));
      for (const root of new Set(
        options.roots().map((path) => resolve(path)),
      )) {
        if (options.signal.aborted) break;
        if (ownPath(root) || ignoredPath(root)) continue;
        let candidate = root;
        while (true) {
          try {
            const info = await stat(candidate);
            if (candidate === root) {
              attach(root, info.isDirectory());
              if (dirname(root) !== root)
                attach(dirname(root), false, basename(root));
            } else if (info.isDirectory()) {
              const child = root
                .slice(candidate === sep ? 1 : candidate.length + 1)
                .split(sep)[0];
              attach(candidate, false, child);
            }
            break;
          } catch {
            const parent = dirname(candidate);
            if (parent === candidate) break;
            candidate = parent;
          }
        }
      }
    } finally {
      for (const watcher of watchers) watcher.close();
      watchers = replacement;
    }
  };
  const save = async (): Promise<void> => {
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, checkpoint);
    } catch {
      report({ kind: "checkpoint-error" });
      await unlink(temporary).catch(() => {});
    }
  };
  const delay = (base: number, maximum: number): number =>
    Math.max(
      1,
      Math.min(
        maximum,
        Math.round(base * (1 + policy.jitterRatio * (2 * random() - 1))),
      ),
    );
  const abort = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    interrupt?.();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) return;
    try {
      const saved: unknown = JSON.parse(await readFile(checkpoint, "utf8"));
      if (validCheckpoint(saved)) state = saved;
      else report({ kind: "checkpoint-error" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        report({ kind: "checkpoint-error" });
    }
    // create bookkeeping directories before attaching any watches.
    await mkdir(dirname(checkpoint), { recursive: true });
    await refresh();
    while (!options.signal.aborted) {
      const due = Math.max(
        state.cooldownUntil,
        Math.min(state.nextRunAt, pendingAt),
      );
      const remaining = due - now();
      if (remaining > 0) {
        report({ kind: "wait", delayMs: remaining, watchers: watchers.length });
        await new Promise<void>((done) => {
          const timer = setTimeout(finish, Math.min(remaining, 2_147_483_647));
          function finish(): void {
            clearTimeout(timer);
            interrupt = undefined;
            done();
          }
          interrupt = finish;
          if (options.signal.aborted) finish();
        });
        continue;
      }
      pendingAt = Infinity;
      await refresh();
      if (options.signal.aborted) break;
      let result: MemoryWorkResult;
      try {
        result = await options.run();
      } catch {
        result = { progress: false, failed: true };
      }
      const finished = now();
      if (result.failed) {
        state.failureMs = Math.min(
          policy.failureMaxMs,
          state.failureMs ? state.failureMs * 2 : policy.failureInitialMs,
        );
        state.cooldownUntil =
          finished + delay(state.failureMs, policy.failureMaxMs);
      } else {
        state.failureMs = 0;
        state.cooldownUntil = 0;
      }
      if (typeof result.retryAt === "number" && Number.isFinite(result.retryAt))
        state.cooldownUntil = Math.max(state.cooldownUntil, result.retryAt);
      if (result.progress) state.idleMs = policy.idleInitialMs;
      else if (!result.failed)
        state.idleMs = Math.min(
          policy.idleMaxMs,
          state.idleMs ? state.idleMs * 2 : policy.idleInitialMs,
        );
      state.nextRunAt = result.failed
        ? state.cooldownUntil
        : Math.max(
            state.cooldownUntil,
            finished + delay(state.idleMs, policy.idleMaxMs),
          );
      await save();
      await refresh();
      report({
        kind: "run",
        progress: result.progress,
        failed: result.failed === true,
      });
    }
  } finally {
    options.signal.removeEventListener("abort", abort);
    abort();
  }
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { setTimeout: sleep } = await import("node:timers/promises");
  const cleanups: (() => Promise<void>)[] = [];
  const until = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() >= deadline)
        throw new Error("wake condition did not arrive");
      await sleep(5);
    }
  };
  const fixture = async (policy: Partial<MemoryWakePolicy> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wakeup-"));
    const root = join(dir, "work");
    await mkdir(root);
    const checkpoint = join(dir, "state", "wake.json");
    const controller = new AbortController();
    const events: MemoryWakeEvent[] = [];
    let task: Promise<void> | undefined;
    const start = (
      run: WatchMemoryWorkOptions["run"],
      roots = () => [root],
    ) => {
      task = watchMemoryWork({
        roots,
        checkpoint,
        signal: controller.signal,
        run,
        report: (event) => {
          events.push(event);
        },
        policy: {
          debounceMs: 40,
          idleInitialMs: 800,
          idleMaxMs: 1600,
          failureInitialMs: 200,
          failureMaxMs: 800,
          jitterRatio: 0,
          ...policy,
        },
      });
      return task;
    };
    const stop = async () => {
      controller.abort();
      await task;
    };
    cleanups.push(async () => {
      await stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { dir, root, checkpoint, controller, events, start, stop };
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  describe("watchMemoryWork", () => {
    it("uses default exponential schedules with bounded jitter and replaceable state", async () => {
      const f = await fixture();
      let clock = 1000;
      const round = async (failed: boolean, random: number) => {
        const controller = new AbortController();
        await watchMemoryWork({
          roots: () => [],
          checkpoint: f.checkpoint,
          signal: controller.signal,
          now: () => clock,
          random: () => random,
          run: async () => {
            controller.abort();
            return { progress: false, failed };
          },
        });
        return JSON.parse(
          await readFile(f.checkpoint, "utf8"),
        ) as WakeCheckpoint;
      };
      let saved = await round(true, 0);
      expect(saved.failureMs).toBe(60_000);
      expect(saved.cooldownUntil - clock).toBe(48_000);
      clock = saved.nextRunAt + 1;
      saved = await round(true, 1);
      expect(saved.failureMs).toBe(120_000);
      expect(saved.cooldownUntil - clock).toBe(144_000);
      await unlink(f.checkpoint);
      saved = await round(false, 0.5);
      expect(saved.idleMs).toBe(60_000);
      expect(saved.nextRunAt - clock).toBe(60_000);
      clock = saved.nextRunAt + 1;
      saved = await round(false, 0.5);
      expect(saved.idleMs).toBe(120_000);
      expect(saved.failureMs).toBe(0);
    });

    it("coalesces real nested mutations and ignores its checkpoint", async () => {
      const f = await fixture();
      let runs = 0;
      void f.start(
        async () => {
          runs++;
          return { progress: false };
        },
        () => [f.dir],
      );
      await until(() => f.events.some((e) => e.kind === "run"));
      // fsevents may deliver the fixture's pre-watch mkdir events once.
      await sleep(100);
      const initial = runs;
      await sleep(120);
      expect(runs).toBe(initial);
      await mkdir(join(f.root, "nested"));
      for (let i = 0; i < 8; i++)
        await writeFile(join(f.root, "nested", "note"), String(i));
      await until(() => runs === initial + 1);
      await sleep(100);
      expect(runs).toBe(initial + 1);
      const saved = JSON.parse(await readFile(f.checkpoint, "utf8"));
      expect(saved.idleMs).toBe(800);
    });

    it("ignores caller-owned housekeeping without hiding adjacent work", async () => {
      const f = await fixture();
      const operational = join(f.root, "state");
      await mkdir(operational);
      let runs = 0;
      const task = watchMemoryWork({
        roots: () => [f.root],
        ignore: () => [operational],
        checkpoint: f.checkpoint,
        signal: f.controller.signal,
        policy: { debounceMs: 30, idleInitialMs: 1000 },
        run: async () => {
          runs++;
          return { progress: false };
        },
      });
      cleanups.push(async () => {
        f.controller.abort();
        await task;
      });
      await until(() => runs >= 1);
      await sleep(100);
      const initial = runs;
      for (let i = 0; i < 5; i++)
        await writeFile(join(operational, "registry-wal"), String(i));
      await sleep(100);
      expect(runs).toBe(initial);
      await writeFile(join(f.root, "state-note.md"), "meaningful change");
      await until(() => runs > initial);
    });

    it("runs singleflight and retains one debounced follow-up during long work", async () => {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      cleanups.push(async () => {
        release();
      });
      let runs = 0;
      let active = 0;
      let peak = 0;
      void f.start(async () => {
        runs++;
        active++;
        peak = Math.max(peak, active);
        if (runs === 1) await gate;
        active--;
        return { progress: true };
      });
      await until(() => runs === 1);
      for (let i = 0; i < 8; i++)
        await writeFile(join(f.root, "note"), String(i));
      await sleep(100);
      expect(runs).toBe(1);
      release();
      await until(() => runs === 2);
      await sleep(100);
      expect({ runs, peak }).toEqual({ runs: 2, peak: 1 });
    });

    it("persists failure and retryAt gates across restart despite new activity", async () => {
      const f = await fixture();
      let runs = 0;
      const retryAt = Date.now() + 650;
      void f.start(async () => {
        runs++;
        return { progress: false, failed: true, retryAt };
      });
      await until(() => f.events.some((e) => e.kind === "run"));
      await f.stop();
      const controller = new AbortController();
      const resumed = watchMemoryWork({
        roots: () => [f.root],
        checkpoint: f.checkpoint,
        signal: controller.signal,
        policy: { debounceMs: 20, jitterRatio: 0 },
        run: async () => {
          runs++;
          controller.abort();
          return { progress: false };
        },
      });
      cleanups.push(async () => {
        controller.abort();
        await resumed;
      });
      await sleep(50);
      await writeFile(join(f.root, "new"), "activity");
      await sleep(150);
      expect(runs).toBe(1);
      await until(() => runs === 2);
      expect(Date.now()).toBeGreaterThanOrEqual(retryAt);
      await resumed;
    });

    it("backs off repeated failures without letting filesystem activity bypass them", async () => {
      const f = await fixture({ failureInitialMs: 120, failureMaxMs: 240 });
      const starts: number[] = [];
      void f.start(async () => {
        starts.push(Date.now());
        if (starts.length === 3) f.controller.abort();
        throw new Error("private error must never enter diagnostics");
      });
      await until(() => f.events.some((e) => e.kind === "run"));
      await writeFile(join(f.root, "nudge"), "x");
      await until(() => starts.length === 3);
      await f.stop();
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(115);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(235);
      expect(JSON.stringify(f.events)).not.toContain("private");
    });

    it("recovers missed events and failed watchers with bounded adaptive scans", async () => {
      const f = await fixture({ idleInitialMs: 35, idleMaxMs: 140 });
      vi.spyOn(fs, "watch").mockImplementation(() => {
        throw new Error("unavailable");
      });
      const starts: number[] = [];
      void f.start(async () => {
        starts.push(Date.now());
        if (starts.length === 4) f.controller.abort();
        return { progress: false };
      });
      await until(() => starts.length === 4);
      await f.stop();
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(65);
      expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(135);
      expect(f.events.some((e) => e.kind === "watch-error")).toBe(true);
      expect(JSON.stringify(f.events)).not.toContain(f.dir);
    });

    it("attaches missing roots, re-arms replacements, supports files and dynamic roots", async () => {
      const f = await fixture();
      const missing = join(f.root, "absent", "nested");
      const file = join(f.dir, "settings.json");
      await writeFile(file, "{}");
      let roots = [missing];
      let runs = 0;
      void f.start(
        async () => {
          runs++;
          return { progress: false };
        },
        () => roots,
      );
      await until(() => f.events.some((e) => e.kind === "run"));
      await writeFile(join(f.root, "unrelated"), "ignored");
      await sleep(90);
      expect(runs).toBe(1);
      await mkdir(missing, { recursive: true });
      await until(() => runs >= 2);
      await sleep(70);
      const before = runs;
      await rename(missing, `${missing}-old`);
      await mkdir(missing);
      await until(() => runs > before);
      await sleep(70);
      const after = runs;
      await writeFile(join(missing, "note"), "new root");
      await until(() => runs > after);
      roots = [file];
      await writeFile(join(missing, "refresh"), "switch");
      await until(() => runs > after + 1);
      await sleep(70);
      const switched = runs;
      await writeFile(`${file}.new`, '{"updated":true}');
      await rename(`${file}.new`, file);
      await until(() => runs > switched);
      await sleep(70);
      const replaced = runs;
      await writeFile(file, "{}");
      await until(() => runs > replaced);
    });

    it("awaits cooperative work on abort, closes watchers, and contains observer errors", async () => {
      const f = await fixture();
      let started = false;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let settled = false;
      const task = watchMemoryWork({
        roots: () => [f.root],
        checkpoint: f.checkpoint,
        signal: f.controller.signal,
        run: async () => {
          started = true;
          await gate;
          return { progress: true };
        },
        report: () => {
          throw new Error("observer failed");
        },
      }).then(() => {
        settled = true;
      });
      cleanups.push(async () => {
        release();
        f.controller.abort();
        await task;
      });
      await until(() => started);
      f.controller.abort();
      await sleep(50);
      expect(settled).toBe(false);
      release();
      await task;
      expect(settled).toBe(true);
      await writeFile(join(f.root, "after-abort"), "x");
    });
  });
}
