import { readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { LoadedSession } from "@bds_pi/sessions";
import type * as C from "./contracts.js";
import { capture } from "./capture.js";
import { canonicalJSON, sha256 } from "./identity.js";
import { durableCreate, flushDirectory } from "./durability.js";
import { loadNativeSourceSnapshot, nativeSourceProducer } from "./pi-source.js";
import {
  observeNativeProject,
  nativeSessionSource,
  type NativeProjectContext,
} from "./project-context.js";

interface Progress {
  fingerprint: string;
  entryCount: number;
  prefixHash: string;
  branches: Record<
    string,
    {
      after: C.SourceSpan | null;
      last: C.SourceSpan | null;
      complete: boolean;
      pending?: { hash: string; commitId: C.CommitId; now: string };
    }
  >;
  complete: boolean;
}
interface Checkpoint {
  version: 1;
  directories: { path: string; after: string }[];
  files: Record<string, Progress>;
}
export interface CatchUpResult {
  files: number;
  windows: number;
  bounded: boolean;
  errors: { path: string; reason: string }[];
}
/** replace only operational progress. source files and store journals remain untouched. */
function save(path: string, state: Checkpoint): void {
  const temp = `${path}.${randomUUID()}`;
  durableCreate(temp, canonicalJSON(state));
  renameSync(temp, path);
  flushDirectory(dirname(path));
}

/**
 * directory and byte-span cursors survive process exit. a completed fingerprint is
 * cheap to revisit; an unfinished file never advances discovery past early data.
 * source windows retain the same identity and authored clocks as session capture.
 */
export async function catchUpNativeSources(input: {
  readonly store: C.MemoryStore;
  readonly root: string;
  readonly checkpoint: string;
  readonly scope: C.MemoryScope;
  readonly signal: AbortSignal;
  readonly snapshots?: readonly LoadedSession[];
  /** Supplied metadata bypasses discovery; null explicitly selects personal context. */
  readonly project?: NativeProjectContext | null;
  /** Live capture selects only this native branch; disk sweeps visit every leaf. */
  readonly throughEntryId?: C.EntryId;
  readonly maxFiles?: number;
  readonly maxEntries?: number;
  readonly maxWindows?: number;
}): Promise<CatchUpResult> {
  const maxFiles = input.maxFiles ?? 8;
  const maxEntries = input.maxEntries ?? 256;
  const maxWindows = input.maxWindows ?? 32;
  for (const n of [maxFiles, maxEntries, maxWindows])
    if (!Number.isSafeInteger(n) || n < 1 || n > 4096)
      throw new Error("invalid catch-up budget");
  let state: Checkpoint;
  try {
    state = JSON.parse(readFileSync(input.checkpoint, "utf8"));
    if (
      state.version !== 1 ||
      !Array.isArray(state.directories) ||
      !state.files
    )
      throw new Error("invalid source checkpoint");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = { version: 1, directories: [], files: {} };
  }
  const result: CatchUpResult = {
    files: 0,
    windows: 0,
    bounded: false,
    errors: [],
  };
  const consume = async (
    fingerprint: string,
    load: () => Promise<LoadedSession>,
  ): Promise<boolean> => {
    const snapshot = await load();
    const project = observeNativeProject(snapshot.header.cwd, input.project);
    const key = canonicalJSON({
      source: snapshot.header.id,
      scope: input.scope,
      project,
    });
    let progress = state.files[key];
    if (
      progress?.fingerprint === fingerprint &&
      (input.throughEntryId
        ? progress.branches[input.throughEntryId]?.complete
        : progress.complete)
    )
      return true;
    const prefixHash = (count: number): string =>
      sha256(
        JSON.stringify([snapshot.header, ...snapshot.entries.slice(0, count)]),
      );
    if (
      !progress ||
      !progress.branches ||
      progress.entryCount > snapshot.entries.length ||
      progress.prefixHash !== prefixHash(progress.entryCount)
    )
      progress = state.files[key] = {
        fingerprint,
        entryCount: 0,
        prefixHash: "",
        branches: {},
        complete: false,
      };
    progress.fingerprint = fingerprint;
    progress.entryCount = snapshot.entries.length;
    progress.prefixHash = prefixHash(snapshot.entries.length);
    const parents = new Set(snapshot.entries.map((e) => e.parentId));
    const leaves = input.throughEntryId
      ? snapshot.entries.filter((e) => e.id === input.throughEntryId)
      : snapshot.entries.filter((e) => !parents.has(e.id));
    if (input.throughEntryId && !leaves.length)
      throw new Error("selected native entry is unavailable");
    const entries = new Map(snapshot.entries.map((e) => [e.id, e]));
    const leaf = leaves.find((e) => !progress.branches[e.id]?.complete);
    if (!leaf) {
      progress.complete = true;
      return true;
    }
    let branch = progress.branches[leaf.id];
    if (!branch) {
      let ancestor = leaf.parentId;
      while (ancestor && !progress.branches[ancestor])
        ancestor = entries.get(ancestor)?.parentId ?? null;
      const prior = ancestor ? progress.branches[ancestor] : null;
      branch = progress.branches[leaf.id] = {
        after: prior?.complete ? prior.last : (prior?.after ?? null),
        last: prior?.last ?? null,
        complete: false,
      };
    }
    const source = nativeSessionSource(snapshot, project);
    const producer = nativeSourceProducer(
      { kind: "provided", snapshot },
      { capturedAt: snapshot.header.timestamp },
    );
    const page = await producer.read(
      {
        source,
        scope: input.scope,
        throughEntryId: leaf.id as C.EntryId,
        after: branch.after,
        maxWindowBytes: 8192,
        maxWindows,
      },
      input.signal,
    );
    const windows = page.windows;
    if (windows.length) {
      const hash = sha256(canonicalJSON(windows.map((w) => w.windowId)));
      if (branch.pending?.hash !== hash) {
        branch.pending = {
          hash,
          commitId: randomUUID() as C.CommitId,
          now: new Date().toISOString(),
        };
        // persist the first acceptance clock before publishing. replay needs the
        // identical payload, while pending age must not inherit source age.
        save(input.checkpoint, state);
      }
      const pending = branch.pending;
      const outcome = await capture(
        {
          source: {
            kind: "provided",
            windows: windows.map((w) => ({
              ...w,
              capturedAt: pending.now,
            })),
          },
          scope: input.scope,
          commitId: pending.commitId,
          now: pending.now,
        },
        { store: input.store },
      );
      if (outcome.kind !== "locally-committed" && outcome.kind !== "unchanged")
        throw new Error(`capture ${outcome.kind}: ${outcome.reason}`);
      result.windows += windows.length;
      delete branch.pending;
    }
    branch.last = windows.at(-1)?.excerpts.at(-1)?.span ?? branch.last;
    branch.after = page.next;
    branch.complete = page.complete;
    progress.complete = snapshot.entries
      .filter((e) => !parents.has(e.id))
      .every((e) => progress.branches[e.id]?.complete);
    if (input.throughEntryId) return branch.complete;
    return progress.complete;
  };
  if (input.snapshots !== undefined) {
    for (const snapshot of input.snapshots.slice(0, maxFiles)) {
      input.signal.throwIfAborted();
      result.files++;
      const complete = await consume(
        sha256(JSON.stringify(snapshot)),
        async () => snapshot,
      );
      result.bounded ||= !complete;
      save(input.checkpoint, state);
    }
    result.bounded ||= input.snapshots.length > maxFiles;
    return result;
  }
  if (!state.directories.length)
    state.directories.push({ path: "", after: "" });
  let visited = 0;
  while (
    state.directories.length &&
    result.files < maxFiles &&
    visited < maxEntries
  ) {
    input.signal.throwIfAborted();
    const directory = state.directories[0]!;
    if (relative(input.root, join(input.root, directory.path)).startsWith(".."))
      throw new Error("invalid discovery cursor");
    let entries;
    try {
      entries = readdirSync(join(input.root, directory.path), {
        withFileTypes: true,
      }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      state.directories.shift();
      continue;
    }
    let blocked = false;
    for (const entry of entries.filter(
      (e) => e.name.localeCompare(directory.after) > 0,
    )) {
      if (visited++ >= maxEntries || result.files >= maxFiles) {
        blocked = true;
        break;
      }
      const path = join(directory.path, entry.name);
      if (entry.isDirectory()) state.directories.push({ path, after: "" });
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const full = join(input.root, path);
        const stat = statSync(full, { bigint: true });
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
        result.files++;
        try {
          if (
            !(await consume(fingerprint, () =>
              loadNativeSourceSnapshot(full, input.signal),
            ))
          ) {
            blocked = true;
            break;
          }
        } catch (e) {
          result.errors.push({ path, reason: String(e) });
          // retry malformed/temporarily incomplete sessions on the next sweep.
        }
      }
      directory.after = entry.name;
      save(input.checkpoint, state);
    }
    if (blocked) break;
    state.directories.shift();
  }
  result.bounded = state.directories.length > 0;
  save(input.checkpoint, state);
  return result;
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { nativeSourceSnapshot } = await import("./pi-source.js");
  const { FileMemoryStore } = await import("./store.js");
  const { DEFAULT_BACKLOG_POLICY } = await import("./config.js");
  it("live selected capture reopens pending acceptance clocks, retains early UTF-8, and agrees with disk project identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-clock-"));
    const workspace = join(dir, "repo");
    mkdirSync(workspace);
    execFileSync("git", ["init", workspace]);
    execFileSync("git", [
      "-C",
      workspace,
      "remote",
      "add",
      "origin",
      "https://example.com/team/native.git",
    ]);
    const configuration = {
      root: join(dir, "notes"),
      data: join(dir, "data"),
      state: join(dir, "state"),
      owner: "fixture",
      replicaId: "fixture" as C.ReplicaId,
    };
    let store = new FileMemoryStore(configuration);
    const manager = SessionManager.inMemory(workspace);
    const earlyText = "dated personal judgment 🌿 ".repeat(1300);
    const early = manager.appendMessage({
      role: "user",
      content: earlyText,
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: "abandoned sibling",
      timestamp: 2,
    });
    manager.branch(early);
    const selected = manager.appendMessage({
      role: "user",
      content: "selected experience",
      timestamp: 3,
    });
    const snapshot = nativeSourceSnapshot(manager);
    for (const entry of snapshot.entries)
      entry.timestamp = "1970-01-01T00:00:00.001Z";
    const scope: C.MemoryScope = { kind: "personal", ownerId: "fixture" };
    const checkpoint = join(dir, "live.json");
    const input = {
      root: "/must-not-read",
      checkpoint,
      scope,
      signal: new AbortController().signal,
      snapshots: [snapshot],
      throughEntryId: selected as C.EntryId,
      maxWindows: 1,
    };
    try {
      const commit = store.commit.bind(store);
      const interrupted = new Proxy(store, {
        get(target, key) {
          if (key === "commit")
            return async (request: C.LocalChangeSet) => {
              await commit(request);
              throw new Error("fixture crash after durable acceptance");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(
        catchUpNativeSources({ ...input, store: interrupted }),
      ).rejects.toThrow("fixture crash");
      const pending = Object.values(
        JSON.parse(readFileSync(checkpoint, "utf8")).files,
      )[0] as Progress;
      const clock = pending.branches[selected]!.pending!.now;
      expect(Date.parse(clock)).toBeGreaterThan(Date.now() - 30_000);
      store.close();
      store = new FileMemoryStore(configuration);
      let bounded = true;
      for (let n = 0; bounded && n < 64; n++)
        bounded = (await catchUpNativeSources({ ...input, store })).bounded;
      expect(bounded).toBe(false);
      const windows = (await store.forPeer("audit").scan(null, 100)).flatMap(
        (c) => c.windows,
      );
      expect(
        windows
          .filter((w) => w.excerpts[0].span.entryId === early)
          .map((w) => w.excerpts[0].text)
          .join(""),
      ).toBe(earlyText);
      expect(
        windows.some((w) =>
          w.excerpts.some((e) => e.text === "abandoned sibling"),
        ),
      ).toBe(false);
      expect(windows[0]!.capturedAt).toBe(clock);
      expect(windows[0]!.excerpts[0].occurredAt).toBe(
        "1970-01-01T00:00:00.001Z",
      );
      expect(
        await store.plan({
          jobId: "fresh" as C.JobId,
          owner: "fixture",
          scope,
          now: new Date().toISOString(),
          policy: { ...DEFAULT_BACKLOG_POLICY, minWindows: 100 },
        }),
      ).toMatchObject({ kind: "idle", reason: "below-threshold" });
      const diskRoot = join(dir, "sessions");
      mkdirSync(diskRoot);
      writeFileSync(
        join(diskRoot, "native.jsonl"),
        [snapshot.header, ...snapshot.entries]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      const diskStore = new FileMemoryStore({
        ...configuration,
        root: join(dir, "disk-notes"),
        data: join(dir, "disk-data"),
        state: join(dir, "disk-state"),
      });
      try {
        let diskBounded = true;
        for (let n = 0; diskBounded && n < 64; n++)
          diskBounded = (
            await catchUpNativeSources({
              store: diskStore,
              root: diskRoot,
              checkpoint: join(dir, "disk.json"),
              scope,
              signal: input.signal,
            })
          ).bounded;
        expect(diskBounded).toBe(false);
        const disk = (await diskStore.forPeer("audit").scan(null, 100)).flatMap(
          (c) => c.windows,
        );
        for (const window of windows)
          expect(
            disk.find((w) => w.windowId === window.windowId)?.source,
          ).toEqual(window.source);
        expect(windows[0]!.source.origin).toEqual({
          kind: "session",
          sessionId: snapshot.header.id,
          project: { repositoryId: "example.com/team/native" },
        });
      } finally {
        diskStore.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
