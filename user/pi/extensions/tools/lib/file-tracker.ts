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

const FILE_CHANGES_DIR = path.join(os.homedir(), ".pi", "file-changes");

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
  return path.join(FILE_CHANGES_DIR, sessionId);
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
