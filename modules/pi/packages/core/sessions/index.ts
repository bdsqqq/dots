import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionManager,
  type FileEntry,
  type SessionHeader,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  HistoryDependencies,
  HistoryError,
  HistoryResult,
  ListSessionsInput,
  LoadedSession,
  ReadSessionInput,
  SessionHistory,
  SessionIdentity,
  SessionSummary,
} from "./contracts";

export type * from "./contracts";

class ParseError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SDK open/load can repair newlines and migrate files, and skips malformed JSON.
 * parse once, then give an in-memory SDK manager the entries instead.
 */
async function load(path: string, signal?: AbortSignal): Promise<FileEntry[]> {
  const text = await readFile(path, { encoding: "utf8", signal });
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const entry: FileEntry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string")
        throw new Error("expected a session entry");
      if (
        entry.type !== "session" &&
        (typeof entry.id !== "string" ||
          !(entry.parentId === null || typeof entry.parentId === "string"))
      )
        throw new Error("expected entry id and parentId");
      return [entry];
    } catch (error) {
      throw new ParseError(path, `line ${i + 1}: ${message(error)}`);
    }
  });
}

export const nativeHistoryDependencies: HistoryDependencies = {
  discover: (sessionDir, signal) =>
    sessionDir === undefined
      ? SessionManager.listAll(undefined, signal)
      : SessionManager.listAll(sessionDir, undefined, signal),
  load,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(
  error: unknown,
  signal?: AbortSignal,
  path?: string,
): HistoryError {
  if (signal?.aborted)
    return { code: "aborted", message: message(signal.reason) };
  if (error instanceof ParseError)
    return { code: "parse", path: error.path, message: error.message };
  return { code: "io", message: message(error), ...(path ? { path } : {}) };
}

function identity(
  header: SessionHeader,
  sessionFile: string | null,
): SessionIdentity {
  return {
    sessionId: header.id,
    workspace: header.cwd,
    sessionFile,
    sessionDir: sessionFile ? dirname(sessionFile) : null,
    parentSessionFile: header.parentSession ?? null,
  };
}

function summary(info: SessionInfo): SessionSummary {
  return {
    sessionId: info.id,
    workspace: info.cwd,
    sessionFile: info.path,
    sessionDir: dirname(info.path),
    parentSessionFile: info.parentSessionPath ?? null,
    name: info.name ?? null,
    firstMessage: info.firstMessage,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
  };
}

export async function listSessions(
  input: ListSessionsInput = {},
  deps: HistoryDependencies = nativeHistoryDependencies,
  signal?: AbortSignal,
): Promise<HistoryResult<SessionSummary[]>> {
  try {
    signal?.throwIfAborted();
    const sessions =
      input.sessions ?? (await deps.discover(input.sessionDir, signal));
    signal?.throwIfAborted();
    return {
      ok: true,
      value: sessions
        .filter(
          (s) =>
            !input.workspace || resolve(s.cwd) === resolve(input.workspace),
        )
        .map(summary)
        .sort(
          (a, b) =>
            b.modified.localeCompare(a.modified) ||
            a.sessionId.localeCompare(b.sessionId) ||
            (a.sessionFile ?? "").localeCompare(b.sessionFile ?? ""),
        ),
    };
  } catch (error) {
    return { ok: false, error: failure(error, signal, input.sessionDir) };
  }
}

export async function readSession(
  input: ReadSessionInput,
  deps: HistoryDependencies = nativeHistoryDependencies,
  signal?: AbortSignal,
): Promise<HistoryResult<SessionHistory>> {
  let path: string | undefined;
  try {
    signal?.throwIfAborted();
    let loaded: LoadedSession;
    if (input.source.kind === "loaded") {
      loaded = input.source.session;
    } else {
      if (input.source.kind === "id") {
        const result = await listSessions(
          {
            workspace: input.workspace,
            sessionDir: input.source.sessionDir,
          },
          deps,
          signal,
        );
        if (!result.ok) return result;
        const id = input.source.sessionId;
        const exact = result.value.filter((s) => s.sessionId === id);
        const matches = exact.length
          ? exact
          : result.value.filter(
              (s) => id.length > 0 && s.sessionId.startsWith(id),
            );
        if (!matches.length)
          return {
            ok: false,
            error: { code: "not_found", message: `session not found: ${id}` },
          };
        if (matches.length > 1)
          return {
            ok: false,
            error: {
              code: "ambiguous",
              message: `ambiguous session: ${id}`,
              candidates: matches,
            },
          };
        path = matches[0]?.sessionFile ?? undefined;
      } else {
        path = input.source.path;
      }
      if (!path) throw new Error("session has no file");
      const [header, ...entries] = await deps.load(path, signal);
      if (
        !header ||
        header.type !== "session" ||
        typeof header.id !== "string" ||
        typeof header.cwd !== "string" ||
        entries.some((entry) => entry.type === "session")
      )
        throw new ParseError(
          path,
          "expected one session header followed by entries",
        );
      // narrowing the header out of FileEntry[] preserves the SDK's entry types.
      loaded = {
        header,
        entries: entries.filter((entry) => entry.type !== "session"),
        sessionFile: path,
      };
    }
    signal?.throwIfAborted();
    if (resolve(loaded.header.cwd) !== resolve(input.workspace))
      return {
        ok: false,
        error: {
          code: "workspace_mismatch",
          message: "session belongs to another workspace",
        },
      };
    if (
      input.source.kind === "id" &&
      !loaded.header.id.startsWith(input.source.sessionId)
    )
      return {
        ok: false,
        error: {
          code: "not_found",
          message: "session identity changed during discovery",
        },
      };
    const ids = new Set<string>();
    for (const entry of loaded.entries) {
      if (
        ids.has(entry.id) ||
        (entry.parentId !== null && !ids.has(entry.parentId))
      )
        throw new ParseError(
          loaded.sessionFile ?? "<supplied>",
          "duplicate id or broken parent chain",
        );
      ids.add(entry.id);
    }
    const leafId =
      input.branch.kind === "entry"
        ? input.branch.entryId
        : input.branch.kind === "current"
          ? input.branch.leafId
          : (loaded.entries.at(-1)?.id ?? null);
    if (leafId !== null && !ids.has(leafId))
      return {
        ok: false,
        error: {
          code: "branch_not_found",
          message: `entry not found: ${leafId}`,
        },
      };
    const manager = SessionManager.inMemory(
      loaded.header.cwd,
      undefined,
      structuredClone([loaded.header, ...loaded.entries]),
    );
    const entries = leafId === null ? [] : manager.getBranch(leafId);
    return {
      ok: true,
      value: {
        ...identity(loaded.header, loaded.sessionFile),
        selection: input.branch.kind,
        leafId,
        rootEntryId: entries[0]?.id ?? null,
        entries,
      },
    };
  } catch (error) {
    return { ok: false, error: failure(error, signal, path) };
  }
}

if (import.meta.vitest) {
  const { it, expect, afterEach } = import.meta.vitest;
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "pi-history-")),
    );
    roots.push(root);
    const workspace = join(root, "workspace");
    const other = join(root, "workspace-other");
    const dir = join(root, "sessions");
    const manager = SessionManager.create(workspace, dir, {
      id: "shared-alpha",
    });
    const first = manager.appendMessage({
      role: "user",
      content: "common",
      timestamp: 1,
    });
    const left = manager.appendMessage({
      role: "user",
      content: "left only",
      timestamp: 2,
    });
    manager.branch(first);
    const right = manager.appendMessage({
      role: "user",
      content: "right only",
      timestamp: 3,
    });
    manager.branch(left); // navigation does not persist; disk still ends on right.
    const foreign = SessionManager.create(other, dir, { id: "shared-beta" });
    foreign.appendMessage({
      role: "user",
      content: "foreign secret",
      timestamp: 4,
    });
    const path = manager.getSessionFile()!;
    const header = manager.getHeader()!;
    return {
      root,
      workspace,
      other,
      dir,
      manager,
      first,
      left,
      right,
      path,
      header,
    };
  }
  it("discovers exact workspaces, orders deterministically, and rejects ambiguous prefixes", async () => {
    const f = await fixture();
    const all = await listSessions({ sessionDir: f.dir });
    expect(all.ok && all.value.map((s) => s.sessionId)).toEqual([
      "shared-beta",
      "shared-alpha",
    ]);
    const scoped = await listSessions({
      workspace: f.workspace,
      sessionDir: f.dir,
    });
    expect(scoped.ok && scoped.value.map((s) => s.sessionId)).toEqual([
      "shared-alpha",
    ]);
    const tied = await SessionManager.listAll(f.dir);
    tied.forEach((s) => {
      s.modified = new Date(0);
    });
    expect(await listSessions({ sessions: tied })).toEqual(
      await listSessions({ sessions: [...tied].reverse() }),
    );
    // duplicate IDs in separate physical files must not select arbitrarily.
    await fs.copyFile(f.path, join(f.dir, "duplicate.jsonl"));
    const ambiguous = await readSession({
      workspace: f.workspace,
      source: { kind: "id", sessionId: "shared", sessionDir: f.dir },
      branch: { kind: "persisted-last-entry" },
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "ambiguous" },
    });
    expect(
      await readSession({
        workspace: f.workspace,
        source: { kind: "id", sessionId: "missing", sessionDir: f.dir },
        branch: { kind: "persisted-last-entry" },
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await readSession({
        workspace: f.workspace,
        source: { kind: "id", sessionId: "shared-beta", sessionDir: f.dir },
        branch: { kind: "persisted-last-entry" },
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("keeps branches, forks, persisted selection and live selection distinct", async () => {
    const f = await fixture();
    const source = { kind: "file" as const, path: f.path };
    const [left, right, persisted] = await Promise.all([
      readSession({
        workspace: f.workspace,
        source,
        branch: { kind: "entry", entryId: f.left },
      }),
      readSession({
        workspace: f.workspace,
        source,
        branch: { kind: "entry", entryId: f.right },
      }),
      readSession({
        workspace: f.workspace,
        source,
        branch: { kind: "persisted-last-entry" },
      }),
    ]);
    expect(left.ok && left.value.entries.map((e) => e.id)).toEqual([
      f.first,
      f.left,
    ]);
    expect(right.ok && right.value.entries.map((e) => e.id)).toEqual([
      f.first,
      f.right,
    ]);
    expect(persisted.ok && persisted.value.leafId).toBe(f.right);
    expect(f.manager.getLeafId()).toBe(f.left);
    const fork = SessionManager.forkFrom(f.path, f.other, f.dir, {
      id: "fork-session",
    });
    const forked = await readSession({
      workspace: f.other,
      source: { kind: "file", path: fork.getSessionFile()! },
      branch: { kind: "entry", entryId: f.left },
    });
    expect(forked).toMatchObject({
      ok: true,
      value: {
        sessionId: "fork-session",
        parentSessionFile: f.path,
        rootEntryId: f.first,
        leafId: f.left,
      },
    });
    expect(
      await readSession({
        workspace: f.other,
        source,
        branch: { kind: "entry", entryId: f.left },
      }),
    ).toMatchObject({ ok: false, error: { code: "workspace_mismatch" } });
    expect(
      await readSession({
        workspace: f.workspace,
        source,
        branch: { kind: "entry", entryId: "absent" },
      }),
    ).toMatchObject({ ok: false, error: { code: "branch_not_found" } });
  });
  it("uses supplied entries/list without a second read, including empty snapshots", async () => {
    const f = await fixture();
    const sessions = await SessionManager.listAll(f.dir);
    expect(await listSessions({ sessions: [], sessionDir: f.dir })).toEqual({
      ok: true,
      value: [],
    });
    const loaded: LoadedSession = {
      header: f.header,
      entries: f.manager.getEntries(),
      sessionFile: f.path,
    };
    await fs.rm(f.dir, { recursive: true });
    const result = await readSession({
      workspace: f.workspace,
      source: { kind: "loaded", session: loaded },
      branch: { kind: "current", leafId: f.manager.getLeafId() },
    });
    expect(result.ok && result.value.entries.map((e) => e.id)).toEqual([
      f.first,
      f.left,
    ]);
    expect(await listSessions({ sessions, sessionDir: f.dir })).toMatchObject({
      ok: true,
      value: [{ sessionId: "shared-beta" }, { sessionId: "shared-alpha" }],
    });
    expect(await listSessions({ sessions: [], sessionDir: f.dir })).toEqual({
      ok: true,
      value: [],
    });
    expect(
      await readSession({
        workspace: f.workspace,
        source: { kind: "loaded", session: { ...loaded, entries: [] } },
        branch: { kind: "current", leafId: null },
      }),
    ).toMatchObject({
      ok: true,
      value: { entries: [], leafId: null, rootEntryId: null },
    });
    expect(
      await readSession({
        workspace: f.workspace,
        source: { kind: "file", path: f.path },
        branch: { kind: "persisted-last-entry" },
      }),
    ).toMatchObject({ ok: false, error: { code: "io" } });
  });
  it("reports real parse/I/O failures without repairing files and preserves cancellation", async () => {
    const f = await fixture();
    const read = () =>
      readSession({
        workspace: f.workspace,
        source: { kind: "file", path: f.path },
        branch: { kind: "persisted-last-entry" },
      });
    const text = await fs.readFile(f.path, "utf8");
    await fs.writeFile(f.path, text.trimEnd());
    expect((await read()).ok).toBe(true);
    expect(await fs.readFile(f.path, "utf8")).toBe(text.trimEnd());
    await fs.appendFile(f.path, "\n{broken");
    expect(await read()).toMatchObject({
      ok: false,
      error: { code: "parse", path: f.path },
    });
    expect(
      await readSession({
        workspace: f.workspace,
        source: { kind: "file", path: f.dir },
        branch: { kind: "persisted-last-entry" },
      }),
    ).toMatchObject({ ok: false, error: { code: "io" } });
    await fs.writeFile(f.path, "");
    expect(await read()).toMatchObject({ ok: false, error: { code: "parse" } });
    const signal = AbortSignal.abort("cancelled");
    expect(await listSessions({}, undefined, signal)).toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(
      await readSession(
        {
          workspace: f.workspace,
          source: { kind: "file", path: f.path },
          branch: { kind: "persisted-last-entry" },
        },
        undefined,
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "aborted" } });
  });
  it("discovers the native grouped root across workspaces without custom config", async () => {
    const f = await fixture();
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(f.root, "agent");
    try {
      for (const cwd of [f.workspace, f.other]) {
        SessionManager.create(cwd).appendMessage({
          role: "user",
          content: cwd,
          timestamp: 1,
        });
      }
      const result = await listSessions();
      expect(result.ok && result.value.map((s) => s.workspace).sort()).toEqual(
        [f.workspace, f.other].sort(),
      );
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });
}
