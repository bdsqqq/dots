import { readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { LoadedSession } from "@bds_pi/sessions";
import type * as C from "./contracts.js";
import { capture } from "./capture.js";
import { canonicalJSON, sha256 } from "./identity.js";
import { durableCreate, flushDirectory } from "./durability.js";
import { loadNativeSourceSnapshot, nativeSourceProducer } from "./pi-source.js";

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
    key: string,
    fingerprint: string,
    load: () => Promise<LoadedSession>,
  ): Promise<boolean> => {
    let progress = state.files[key];
    if (progress?.fingerprint === fingerprint && progress.complete) return true;
    const snapshot = await load();
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
    const leaves = snapshot.entries.filter((e) => !parents.has(e.id));
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
    const source: C.SourceRef = {
      sourceId: snapshot.header.id as C.SourceId,
      producer: "pi-native",
      origin: { kind: "session", sessionId: snapshot.header.id as C.SessionId },
    };
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
    progress.complete = leaves.every((e) => progress.branches[e.id]?.complete);
    return progress.complete;
  };
  if (input.snapshots !== undefined) {
    for (const snapshot of input.snapshots.slice(0, maxFiles)) {
      input.signal.throwIfAborted();
      result.files++;
      const complete = await consume(
        `provided:${snapshot.header.id}`,
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
            !(await consume(path, fingerprint, () =>
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
