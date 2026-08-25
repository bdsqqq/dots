/**
 * file change tracker — persists before/after content to disk for undo_edit.
 *
 * each edit writes a JSON file to
 * ~/.pi/file-changes/{sessionId}/{toolCallId}.json containing
 * the full before/after content and a unified diff.
 *
 * branch awareness comes from the conversation tree, not from
 * this module. tool call IDs live in assistant messages — when
 * the user navigates branches, only tool calls on the active
 * branch are visible. the undo_edit tool filters by active
 * tool call IDs before consulting the disk.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// allow test injection via global — checked at runtime, not import
const fileTrackerGlobal = globalThis as typeof globalThis & {
  __PI_FILE_CHANGES_DIR__?: string;
};
const getFileChangesDir = () =>
  fileTrackerGlobal.__PI_FILE_CHANGES_DIR__ ??
  path.join(os.homedir(), ".pi", "file-changes");

export interface FileChange {
  /** unique id for this change record */
  id: string;
  /** file:// URI of the changed file */
  uri: string;
  /** full content before the edit */
  before: string;
  /** full content after the edit */
  after: string;
  /** unified diff */
  diff: string;
  /** true if this was a newly created file */
  isNewFile: boolean;
  /** whether the path existed before and after the mutation */
  beforeExists?: boolean;
  afterExists?: boolean;
  /** permission bits before and after the mutation */
  beforeMode?: number;
  afterMode?: number;
  /** true if undo_edit has reverted this change */
  reverted: boolean;
  /** epoch ms when the edit occurred */
  timestamp: number;
}

function sessionDir(sessionId: string): string {
  return path.join(getFileChangesDir(), sessionId);
}

function changePath(
  sessionId: string,
  toolCallId: string,
  changeId: string,
): string {
  return path.join(sessionDir(sessionId), `${toolCallId}.${changeId}`);
}

export function canonicalFilePath(filePath: string): string {
  const suffix: string[] = [];
  let ancestor = path.resolve(filePath);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function canonicalFileUri(uri: string): string {
  return `file://${canonicalFilePath(uri.replace(/^file:\/\//, ""))}`;
}

const trackerFs = {
  writeFileSync(file: string, content: string): void {
    fs.writeFileSync(file, content, "utf-8");
  },
  renameSync(source: string, destination: string): void {
    fs.renameSync(source, destination);
  },
};

/** ensure the session's file-changes directory exists. */
function ensureDir(sessionId: string): void {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * record a file change to disk. call after performing the edit.
 * the toolCallId comes from the execute() function's first argument.
 * returns the change ID (UUID) for the written record.
 *
 * one tool call can produce multiple changes (e.g., delegate sub-agent
 * creating several files). each gets a unique UUID, stored as
 * {toolCallId}.{uuid}.
 */
export function saveChange(
  sessionId: string,
  toolCallId: string,
  change: Omit<FileChange, "id" | "reverted">,
): string {
  return saveChanges(sessionId, toolCallId, [change])[0]!;
}

/**
 * Persist every record for one tool call as a unit. A failed write removes
 * earlier records so callers can roll back the corresponding filesystem
 * transaction without leaving discoverable partial undo state.
 */
export function saveChanges(
  sessionId: string,
  toolCallId: string,
  changes: Array<Omit<FileChange, "id" | "reverted">>,
): string[] {
  ensureDir(sessionId);
  const records = changes.map((change) => {
    const id = crypto.randomUUID();
    return {
      path: changePath(sessionId, toolCallId, id),
      record: {
        ...change,
        uri: canonicalFileUri(change.uri),
        id,
        reverted: false,
      } satisfies FileChange,
    };
  });
  try {
    for (const { path: recordPath, record } of records) {
      writeRecord(recordPath, record);
    }
  } catch (error) {
    for (const { path: recordPath } of records) {
      fs.rmSync(recordPath, { force: true });
    }
    throw error;
  }
  return records.map(({ record }) => record.id);
}

function writeRecord(recordPath: string, record: FileChange): void {
  const temporary = `${recordPath}.tmp-${crypto.randomUUID()}`;
  try {
    trackerFs.writeFileSync(temporary, JSON.stringify(record, null, 2));
    trackerFs.renameSync(temporary, recordPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * load all change records for a tool call. one tool call can produce
 * multiple changes (different files), each with its own UUID.
 */
export function loadChanges(
  sessionId: string,
  toolCallId: string,
): FileChange[] {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return [];

  const prefix = `${toolCallId}.`;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(dir, f), "utf-8"),
          ) as FileChange;
        } catch {
          return null;
        }
      })
      .filter((c): c is FileChange => c !== null);
  } catch {
    return [];
  }
}

/**
 * mark a specific change as reverted and restore the file.
 * returns the change record, or null if not found / already reverted.
 */
export function revertChange(
  sessionId: string,
  toolCallId: string,
  changeId: string,
): FileChange | null {
  const p = changePath(sessionId, toolCallId, changeId);
  if (!fs.existsSync(p)) return null;

  let change: FileChange;
  try {
    change = JSON.parse(fs.readFileSync(p, "utf-8")) as FileChange;
  } catch {
    return null;
  }
  if (change.reverted) return null;

  const filePath = change.uri.replace(/^file:\/\//, "");
  const beforeExists = change.beforeExists ?? !change.isNewFile;
  const afterExists =
    change.afterExists ?? (fs.existsSync(filePath) || change.after !== "");
  assertTrackedAfterState(
    filePath,
    afterExists,
    change.after,
    change.afterMode,
  );
  restoreTrackedState(filePath, beforeExists, change.before, change.beforeMode);

  change.reverted = true;
  try {
    writeRecord(p, change);
  } catch (error) {
    restoreTrackedState(filePath, afterExists, change.after, change.afterMode);
    throw error;
  }

  return change;
}

function assertTrackedAfterState(
  filePath: string,
  expectedExists: boolean,
  expectedContent: string,
  expectedMode?: number,
): void {
  let current: fs.Stats | undefined;
  try {
    current = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current?.isSymbolicLink()) {
    throw new Error(`refusing to undo symbolic link: ${filePath}`);
  }
  if (current && current.nlink > 1) {
    throw new Error(`refusing to undo hard-linked file: ${filePath}`);
  }
  if (!expectedExists) {
    if (current) throw new Error(`refusing to undo changed path: ${filePath}`);
    return;
  }
  if (
    !current ||
    !current.isFile() ||
    fs.readFileSync(filePath, "utf-8") !== expectedContent ||
    (expectedMode !== undefined &&
      (current.mode & 0o7777) !== (expectedMode & 0o7777))
  ) {
    throw new Error(`refusing to undo changed file: ${filePath}`);
  }
}

function restoreTrackedState(
  filePath: string,
  exists: boolean,
  content: string,
  mode?: number,
): void {
  if (!exists) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  try {
    const current = fs.lstatSync(filePath);
    if (current.isSymbolicLink()) {
      throw new Error(`refusing to restore through symbolic link: ${filePath}`);
    }
    if (current.nlink > 1) {
      throw new Error(`refusing to restore a hard-linked file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  if (mode !== undefined) fs.chmodSync(filePath, mode);
}

/**
 * find the most recent non-reverted change for a file path,
 * filtered to only the given tool call IDs (branch awareness).
 *
 * the caller gets activeToolCallIds by scanning the current
 * session branch for file-mutation tool calls such as apply_patch.
 */
export function findLatestChange(
  sessionId: string,
  filePath: string,
  activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
  const uri = `file://${canonicalFilePath(filePath)}`;

  // check in reverse order (most recent first)
  for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
    const toolCallId = activeToolCallIds[i];
    if (!toolCallId) continue;
    const changes = loadChanges(sessionId, toolCallId);
    // within a tool call, find the matching file (most recent by timestamp)
    const match = changes
      .filter((change) => {
        if (change.reverted) return false;
        try {
          return canonicalFileUri(change.uri) === uri;
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (match) {
      return { toolCallId, change: match };
    }
  }

  return null;
}

/**
 * graceful require for the `diff` package — falls back to a naive
 * line-by-line diff when the package isn't resolvable.
 */
let createPatchFn:
  | ((
      fileName: string,
      oldStr: string,
      newStr: string,
      oldHeader?: string,
      newHeader?: string,
      options?: { context?: number },
    ) => string)
  | null = null;

try {
  const esmRequire = createRequire(import.meta.url);
  const diffLib = esmRequire("diff");
  createPatchFn = diffLib.createPatch;
} catch {
  /* diff not installed — use fallback */
}

/**
 * generate a unified diff between two strings.
 *
 * uses the `diff` npm package (Myers algorithm) when available for
 * proper hunk-based output with context lines. context=3 matches
 * git's default, producing gaps between distant changes that show()
 * can elide in collapsed display.
 *
 * falls back to a naive line-by-line comparison when `diff` isn't
 * installed (produces correct but less optimal output — every line
 * is either +, -, or context with no hunk headers).
 */
export function simpleDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  if (createPatchFn) {
    const patch = createPatchFn(
      path.basename(filePath),
      before,
      after,
      "original",
      "modified",
      { context: 3 },
    );
    // strip the Index: and === lines that createPatch prepends —
    // they add noise for LLM consumption and TUI display
    const lines = patch.split("\n");
    const startIdx = lines.findIndex((l) => l.startsWith("---"));
    return (startIdx > 0 ? lines.slice(startIdx) : lines).join("\n");
  }

  // fallback: naive line-by-line diff (no shortest-edit-distance)
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const lines: string[] = [
    `--- ${path.basename(filePath)}\toriginal`,
    `+++ ${path.basename(filePath)}\tmodified`,
  ];

  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (
      i < beforeLines.length &&
      j < afterLines.length &&
      beforeLines[i] === afterLines[j]
    ) {
      lines.push(` ${beforeLines[i]}`);
      i++;
      j++;
    } else if (
      i < beforeLines.length &&
      (j >= afterLines.length || beforeLines[i] !== afterLines[j])
    ) {
      lines.push(`-${beforeLines[i]}`);
      i++;
    } else {
      lines.push(`+${afterLines[j]}`);
      j++;
    }
  }

  return lines.join("\n");
}

// inline tests
if (import.meta.vitest) {
  const { describe, it, expect, beforeEach, afterEach, vi } = import.meta
    .vitest;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-file-tracker-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    sessionId = `test-session-${Date.now()}`;
    fileTrackerGlobal.__PI_FILE_CHANGES_DIR__ = tmpDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("simpleDiff", () => {
    it("generates unified diff for added lines", () => {
      const before = "line1\nline2";
      const after = "line1\nline2\nline3";
      const diff = simpleDiff("test.txt", before, after);

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("+line3");
    });

    it("generates unified diff for removed lines", () => {
      const before = "line1\nline2\nline3";
      const after = "line1\nline3";
      const diff = simpleDiff("test.txt", before, after);

      expect(diff).toContain("-line2");
      expect(diff).not.toContain("+line2");
    });

    it("generates unified diff for changed lines", () => {
      const before = "old content";
      const after = "new content";
      const diff = simpleDiff("file.txt", before, after);

      expect(diff).toContain("-old content");
      expect(diff).toContain("+new content");
    });

    it("handles identical content (no changes)", () => {
      const content = "same\nlines\nhere";
      const diff = simpleDiff("same.txt", content, content);

      expect(diff).toContain("--- same.txt");
      expect(diff).toContain("+++ same.txt");
      const lines = diff.split("\n");
      const changedLines = lines.filter(
        (l) => l.startsWith("-") && !l.startsWith("---"),
      );
      const addedLines = lines.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      );
      expect(changedLines).toHaveLength(0);
      expect(addedLines).toHaveLength(0);
    });

    it("handles empty before content", () => {
      const after = "new file content";
      const diff = simpleDiff("new.txt", "", after);

      expect(diff).toContain("+new file content");
    });

    it("handles empty after content", () => {
      const before = "deleted content";
      const diff = simpleDiff("del.txt", before, "");

      expect(diff).toContain("-deleted content");
    });

    it("includes file basename in diff header", () => {
      const diff = simpleDiff("/path/to/some/file.ts", "a", "b");
      expect(diff).toContain("--- file.ts");
      expect(diff).toContain("+++ file.ts");
    });
  });

  describe("saveChange and loadChanges", () => {
    it("saves a change record to disk and loads it back", () => {
      const toolCallId = "tc-123";
      const filePath = path.join(tmpDir, "test-file.txt");
      const content = "file content here";

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "",
        after: content,
        diff: simpleDiff(filePath, "", content),
        isNewFile: true,
        timestamp: Date.now(),
      });

      expect(changeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.id).toBe(changeId);
      expect(changes[0]!.uri).toBe(canonicalFileUri(`file://${filePath}`));
      expect(changes[0]!.before).toBe("");
      expect(changes[0]!.after).toBe(content);
      expect(changes[0]!.isNewFile).toBe(true);
      expect(changes[0]!.reverted).toBe(false);
    });

    it("supports multiple changes per tool call", () => {
      const toolCallId = "tc-multi";
      const file1 = path.join(tmpDir, "file1.txt");
      const file2 = path.join(tmpDir, "file2.txt");

      const id1 = saveChange(sessionId, toolCallId, {
        uri: `file://${file1}`,
        before: "",
        after: "content1",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      const id2 = saveChange(sessionId, toolCallId, {
        uri: `file://${file2}`,
        before: "",
        after: "content2",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      expect(id1).not.toBe(id2);

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(2);
      const uris = changes.map((c) => c.uri);
      expect(uris).toContain(canonicalFileUri(`file://${file1}`));
      expect(uris).toContain(canonicalFileUri(`file://${file2}`));
    });

    it("removes every record when a later batch write fails", () => {
      const toolCallId = "tc-atomic";
      let renames = 0;
      vi.spyOn(trackerFs, "renameSync").mockImplementation(
        (source, destination) => {
          renames++;
          if (renames === 2) throw new Error("injected tracker failure");
          fs.renameSync(source, destination);
        },
      );

      expect(() =>
        saveChanges(sessionId, toolCallId, [
          {
            uri: `file://${path.join(tmpDir, "one.txt")}`,
            before: "",
            after: "one",
            diff: "",
            isNewFile: true,
            timestamp: Date.now(),
          },
          {
            uri: `file://${path.join(tmpDir, "two.txt")}`,
            before: "",
            after: "two",
            diff: "",
            isNewFile: true,
            timestamp: Date.now(),
          },
        ]),
      ).toThrow("injected tracker failure");
      expect(loadChanges(sessionId, toolCallId)).toEqual([]);
    });

    it("returns empty array when no changes exist", () => {
      const changes = loadChanges(sessionId, "nonexistent-toolcall");
      expect(changes).toEqual([]);
    });

    it("persists changes across calls (real disk)", () => {
      const toolCallId = "tc-persist";
      const filePath = path.join(tmpDir, "persist.txt");

      saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "old",
        after: "new",
        diff: simpleDiff(filePath, "old", "new"),
        isNewFile: false,
        timestamp: Date.now(),
      });

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.before).toBe("old");
      expect(changes[0]!.after).toBe("new");
    });
  });

  describe("revertChange", () => {
    it("restores file to before state and marks reverted", () => {
      const toolCallId = "tc-revert";
      const filePath = path.join(tmpDir, "to-revert.txt");

      fs.writeFileSync(filePath, "original content", "utf-8");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "original content",
        after: "modified content",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      fs.writeFileSync(filePath, "modified content", "utf-8");
      expect(fs.readFileSync(filePath, "utf-8")).toBe("modified content");

      const result = revertChange(sessionId, toolCallId, changeId);

      expect(result).not.toBeNull();
      expect(result?.reverted).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("original content");

      const changes = loadChanges(sessionId, toolCallId);
      expect(changes[0]!.reverted).toBe(true);
    });

    it("returns null for nonexistent change", () => {
      const result = revertChange(sessionId, "tc-xxx", "nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns null for already reverted change", () => {
      const toolCallId = "tc-revert-twice";
      const filePath = path.join(tmpDir, "revert-once.txt");

      fs.writeFileSync(filePath, "before", "utf-8");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });
      fs.writeFileSync(filePath, "after", "utf-8");

      const first = revertChange(sessionId, toolCallId, changeId);
      expect(first).not.toBeNull();

      const second = revertChange(sessionId, toolCallId, changeId);
      expect(second).toBeNull();
    });

    it("works for newly created files (isNewFile: true)", () => {
      const toolCallId = "tc-newfile";
      const filePath = path.join(tmpDir, "brand-new.txt");

      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "",
        after: "new file content",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      fs.writeFileSync(filePath, "new file content", "utf-8");

      const result = revertChange(sessionId, toolCallId, changeId);

      expect(result).not.toBeNull();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("restores executable mode", () => {
      const toolCallId = "tc-mode";
      const filePath = path.join(tmpDir, "script.sh");
      fs.writeFileSync(filePath, "after\n", "utf-8");
      fs.chmodSync(filePath, 0o644);
      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before\n",
        after: "after\n",
        diff: "",
        isNewFile: false,
        beforeExists: true,
        afterExists: true,
        beforeMode: 0o755,
        afterMode: 0o644,
        timestamp: Date.now(),
      });

      revertChange(sessionId, toolCallId, changeId);

      expect(fs.readFileSync(filePath, "utf-8")).toBe("before\n");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o755);
    });

    it("refuses to restore through a symbolic link", () => {
      const toolCallId = "tc-symlink";
      const filePath = path.join(tmpDir, "tracked.txt");
      const target = path.join(tmpDir, "outside.txt");
      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before",
        after: "",
        diff: "",
        isNewFile: false,
        beforeExists: true,
        afterExists: false,
        timestamp: Date.now(),
      });
      fs.symlinkSync(target, filePath);

      expect(() => revertChange(sessionId, toolCallId, changeId)).toThrow(
        "symbolic link",
      );
      expect(fs.readlinkSync(filePath)).toBe(target);
      expect(fs.existsSync(target)).toBe(false);
      expect(loadChanges(sessionId, toolCallId)[0]?.reverted).toBe(false);
    });

    it("refuses to restore a file with hard-link aliases", () => {
      const toolCallId = "tc-hardlink";
      const filePath = path.join(tmpDir, "tracked.txt");
      const alias = path.join(tmpDir, "alias.txt");
      fs.writeFileSync(filePath, "after");
      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        beforeExists: true,
        afterExists: true,
        timestamp: Date.now(),
      });
      fs.linkSync(filePath, alias);

      expect(() => revertChange(sessionId, toolCallId, changeId)).toThrow(
        "hard-linked",
      );
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
      expect(fs.readFileSync(alias, "utf8")).toBe("after");
      expect(loadChanges(sessionId, toolCallId)[0]?.reverted).toBe(false);
    });

    it("refuses to overwrite changes made after the tracked mutation", () => {
      const toolCallId = "tc-diverged";
      const filePath = path.join(tmpDir, "tracked.txt");
      fs.writeFileSync(filePath, "v3");
      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "v1",
        after: "v2",
        diff: "",
        isNewFile: false,
        beforeExists: true,
        afterExists: true,
        timestamp: Date.now(),
      });

      expect(() => revertChange(sessionId, toolCallId, changeId)).toThrow(
        "changed file",
      );
      expect(fs.readFileSync(filePath, "utf8")).toBe("v3");
      expect(loadChanges(sessionId, toolCallId)[0]?.reverted).toBe(false);
    });

    it("restores the after state when marking the record reverted fails", () => {
      const toolCallId = "tc-mark-failure";
      const filePath = path.join(tmpDir, "tracked.txt");
      fs.writeFileSync(filePath, "after", "utf-8");
      const changeId = saveChange(sessionId, toolCallId, {
        uri: `file://${filePath}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        beforeExists: true,
        afterExists: true,
        timestamp: Date.now(),
      });
      vi.spyOn(trackerFs, "renameSync").mockImplementation(() => {
        throw new Error("injected mark failure");
      });

      expect(() => revertChange(sessionId, toolCallId, changeId)).toThrow(
        "injected mark failure",
      );
      expect(fs.readFileSync(filePath, "utf-8")).toBe("after");
      expect(loadChanges(sessionId, toolCallId)[0]?.reverted).toBe(false);
    });
  });

  describe("findLatestChange", () => {
    it("finds the most recent change for a file", () => {
      const tc1 = "tc-first";
      const tc2 = "tc-second";
      const filePath = path.join(tmpDir, "chain.txt");

      saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "v1",
        after: "v2",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 2000,
      });

      saveChange(sessionId, tc2, {
        uri: `file://${filePath}`,
        before: "v2",
        after: "v3",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 1000,
      });

      const result = findLatestChange(sessionId, filePath, [tc1, tc2]);

      expect(result).not.toBeNull();
      expect(result?.change.before).toBe("v2");
      expect(result?.change.after).toBe("v3");
      expect(result?.toolCallId).toBe(tc2);
    });

    it("matches equivalent paths through a symlinked parent", () => {
      const toolCallId = "tc-path-alias";
      const real = path.join(tmpDir, "real");
      const alias = path.join(tmpDir, "alias");
      fs.mkdirSync(real);
      fs.symlinkSync(real, alias);
      const realFile = path.join(real, "file.txt");
      fs.writeFileSync(realFile, "after");
      saveChange(sessionId, toolCallId, {
        uri: `file://${realFile}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      expect(
        findLatestChange(sessionId, path.join(alias, "file.txt"), [toolCallId])
          ?.change.after,
      ).toBe("after");
    });

    it("matches legacy records with non-canonical file URIs", () => {
      const toolCallId = "tc-legacy-alias";
      const real = path.join(tmpDir, "legacy-real");
      const alias = path.join(tmpDir, "legacy-alias");
      fs.mkdirSync(real);
      fs.symlinkSync(real, alias);
      const realFile = path.join(real, "file.txt");
      fs.writeFileSync(realFile, "after");
      ensureDir(sessionId);
      const record: FileChange = {
        id: "legacy",
        uri: `file://${path.join(alias, "file.txt")}`,
        before: "before",
        after: "after",
        diff: "",
        isNewFile: false,
        reverted: false,
        timestamp: Date.now(),
      };
      fs.writeFileSync(
        changePath(sessionId, toolCallId, record.id),
        JSON.stringify(record),
      );

      expect(
        findLatestChange(sessionId, realFile, [toolCallId])?.change.after,
      ).toBe("after");
    });

    it("skips reverted changes", () => {
      const tc1 = "tc-revert-skip";
      const filePath = path.join(tmpDir, "skip-reverted.txt");

      const changeId = saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "old",
        after: "new",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      // mark as reverted by updating the file
      const changes = loadChanges(sessionId, tc1);
      const change = { ...changes[0], reverted: true };
      const changeFilePath = path.join(tmpDir, sessionId, `${tc1}.${changeId}`);
      fs.writeFileSync(
        changeFilePath,
        JSON.stringify(change, null, 2),
        "utf-8",
      );

      const result = findLatestChange(sessionId, filePath, [tc1]);
      expect(result).toBeNull();
    });

    it("respects branch order (activeToolCallIds order)", () => {
      const tc1 = "tc-branch-1";
      const tc2 = "tc-branch-2";
      const filePath = path.join(tmpDir, "branch-order.txt");

      saveChange(sessionId, tc1, {
        uri: `file://${filePath}`,
        before: "a",
        after: "b",
        diff: "",
        isNewFile: false,
        timestamp: Date.now() - 1000,
      });

      saveChange(sessionId, tc2, {
        uri: `file://${filePath}`,
        before: "c",
        after: "d",
        diff: "",
        isNewFile: false,
        timestamp: Date.now(),
      });

      const result1 = findLatestChange(sessionId, filePath, [tc1, tc2]);
      expect(result1?.change.after).toBe("d");

      const result2 = findLatestChange(sessionId, filePath, [tc1]);
      expect(result2?.change.after).toBe("b");
    });

    it("returns null when file has no changes", () => {
      const result = findLatestChange(sessionId, "/nonexistent/file.txt", [
        "tc-x",
      ]);
      expect(result).toBeNull();
    });

    it("handles multiple changes to different files in same tool call", () => {
      const tc = "tc-multi-file";
      const file1 = path.join(tmpDir, "multi1.txt");
      const file2 = path.join(tmpDir, "multi2.txt");

      saveChange(sessionId, tc, {
        uri: `file://${file1}`,
        before: "",
        after: "f1",
        diff: "",
        isNewFile: true,
        timestamp: Date.now() - 1000,
      });

      saveChange(sessionId, tc, {
        uri: `file://${file2}`,
        before: "",
        after: "f2",
        diff: "",
        isNewFile: true,
        timestamp: Date.now(),
      });

      const result1 = findLatestChange(sessionId, file1, [tc]);
      const result2 = findLatestChange(sessionId, file2, [tc]);

      expect(result1?.change.after).toBe("f1");
      expect(result2?.change.after).toBe("f2");
    });
  });
}
