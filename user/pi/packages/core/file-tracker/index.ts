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
const getFileChangesDir = () =>
  (globalThis as any).__PI_FILE_CHANGES_DIR__ ??
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
 * one tool call can produce multiple changes (e.g., Task sub-agent
 * creating several files). each gets a unique UUID, stored as
 * {toolCallId}.{uuid}.
 */
export function saveChange(
  sessionId: string,
  toolCallId: string,
  change: Omit<FileChange, "id" | "reverted">,
): string {
  ensureDir(sessionId);
  const id = crypto.randomUUID();
  const record: FileChange = {
    ...change,
    id,
    reverted: false,
  };
  fs.writeFileSync(
    changePath(sessionId, toolCallId, id),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return id;
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

  // restore the file to its pre-edit state
  const filePath = change.uri.replace(/^file:\/\//, "");
  fs.writeFileSync(filePath, change.before, "utf-8");

  // mark as reverted on disk
  change.reverted = true;
  fs.writeFileSync(p, JSON.stringify(change, null, 2), "utf-8");

  return change;
}

/**
 * find the most recent non-reverted change for a file path,
 * filtered to only the given tool call IDs (branch awareness).
 *
 * the caller gets activeToolCallIds by scanning the current
 * session branch for edit_file/create_file tool calls.
 */
export function findLatestChange(
  sessionId: string,
  filePath: string,
  activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
  const uri = `file://${path.resolve(filePath)}`;

  // check in reverse order (most recent first)
  for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
    const toolCallId = activeToolCallIds[i];
    if (!toolCallId) continue;
    const changes = loadChanges(sessionId, toolCallId);
    // within a tool call, find the matching file (most recent by timestamp)
    const match = changes
      .filter((c) => !c.reverted && c.uri === uri)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (match) {
      return { toolCallId, change: match };
    }
  }

  return null;
}

/**
 * graceful require for the `diff` package — falls back to a naive
 * line-by-line diff when the package isn't resolvable (same pattern
 * as cheerio in html-to-md.ts).
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
  const { describe, it, expect, beforeEach, afterEach } = import.meta.vitest;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `pi-file-tracker-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    sessionId = `test-session-${Date.now()}`;
    (globalThis as any).__PI_FILE_CHANGES_DIR__ = tmpDir;
  });

  afterEach(() => {
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
      expect(changes[0]!.uri).toBe(`file://${filePath}`);
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
      expect(uris).toContain(`file://${file1}`);
      expect(uris).toContain(`file://${file2}`);
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
      expect(fs.readFileSync(filePath, "utf-8")).toBe("");
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
