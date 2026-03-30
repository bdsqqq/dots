/**
 * edit tool — replaces pi's built-in with tracked multi-edit behavior.
 *
 * differences from pi's built-in:
 * - mutex-locked per file path (prevents partial writes from concurrent edits)
 * - escape sequence fallback (\n, \t when exact match fails)
 * - redaction check (rejects edits introducing placeholder markers)
 * - file change tracking for undo_edit via lib/file-tracker
 * - BOM/CRLF preservation
 * - legacy `old_str` / `new_str` calls are folded into modern `edits[]`
 *
 * shadows pi's built-in `edit` tool via same-name registration.
 * public schema matches pi 0.63+ multi-edit shape so resumed sessions keep
 * working, while `prepareArguments()` preserves amp-style legacy calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  formatBoxesWindowed,
  osc8Link,
  type BoxSection,
  type BoxBlock,
  type BoxLine,
  type Excerpt,
} from "@bds_pi/box-format";
import { Type } from "@sinclair/typebox";
import * as fileTracker from "@bds_pi/file-tracker";
import { withFileLock } from "@bds_pi/mutex";
import { resolveToAbsolute, resolveWithVariants } from "@bds_pi/fs";
import * as permissions from "@bds_pi/permissions";

// --- BOM / CRLF ---

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// --- escape handling ---

/**
 * LLMs sometimes emit literal \n / \t in JSON strings when they mean
 * actual whitespace. the JSON parser produces backslash + letter, not
 * a real newline. this function converts those back.
 */
function unescapeStr(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\");
}

// --- fuzzy matching ---

/**
 * trailing whitespace + unicode normalization.
 * mirrors pi's edit-diff.ts normalizeForFuzzyMatch so we get the same
 * fallback behavior the model is used to from the built-in tool.
 */
function normalizeForFuzzy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(content: string, searchStr: string): number {
  if (searchStr.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(searchStr, pos)) !== -1) {
    count++;
    pos += searchStr.length;
  }
  return count;
}

// --- redaction check ---

/**
 * patterns that indicate the LLM replaced real content with a placeholder.
 * checked against new_str only when the pattern is absent from old_str
 * (so legitimate test strings containing these phrases pass through).
 */
const REDACTION_PATTERNS = [
  /\[REDACTED\]/i,
  /\[\.\.\.omitted.*?\]/i,
  /\[rest of .{1,40} unchanged\]/i,
  /\[remaining .{1,40} unchanged\]/i,
  /\/\/ \.\.\.( rest| remaining)? (of )?(the )?(file|code|content|implementation)( remains?)? (unchanged|the same|as before|omitted)/i,
  /\/\/ \.\.\. existing (code|content|implementation)/i,
  /# \.\.\. existing (code|content|implementation)/i,
];

function hasNewRedactionMarkers(oldStr: string, newStr: string): string | null {
  for (const pattern of REDACTION_PATTERNS) {
    if (pattern.test(newStr) && !pattern.test(oldStr)) {
      const match = newStr.match(pattern);
      return match?.[0] ?? "redaction marker";
    }
  }
  return null;
}

// --- diff → box sections ---

/**
 * parse unified diff output into BoxSection[] for box-format rendering.
 * each hunk becomes a BoxBlock. +/- lines are highlighted, context lines dim.
 */
function parseDiffToSections(filename: string, diffText: string): BoxSection[] {
  const lines = diffText.split("\n");
  const blocks: BoxBlock[] = [];
  let currentLines: BoxLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // skip --- / +++ headers
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    // @@ hunk header — start a new block
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch && hunkMatch[1] && hunkMatch[2]) {
      if (currentLines.length > 0) {
        blocks.push({ lines: currentLines });
        currentLines = [];
      }
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      continue;
    }

    if (line.startsWith("-")) {
      currentLines.push({
        gutter: String(oldLine),
        text: line,
        highlight: true,
      });
      oldLine++;
    } else if (line.startsWith("+")) {
      currentLines.push({
        gutter: String(newLine),
        text: line,
        highlight: true,
      });
      newLine++;
    } else {
      // context line
      currentLines.push({
        gutter: String(oldLine),
        text: line,
        highlight: false,
      });
      oldLine++;
      newLine++;
    }
  }

  if (currentLines.length > 0) {
    blocks.push({ lines: currentLines });
  }

  return [{ header: filename, blocks }];
}

// --- diff stats ---

interface DiffStats {
  added: number;
  removed: number;
  modified: number;
}

/**
 * compute +added/~modified/-removed from diff lines.
 * adjacent - then + blocks are paired as modifications;
 * the min count is ~modified, excess is pure +/-.
 */
function computeDiffStats(sections: BoxSection[]): DiffStats {
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const section of sections) {
    for (const block of section.blocks) {
      let i = 0;
      while (i < block.lines.length) {
        const line = block.lines[i];
        if (!line) {
          i++;
          continue;
        }
        if (line.text.startsWith("-")) {
          // count consecutive - lines
          let delCount = 0;
          while (
            i < block.lines.length &&
            block.lines[i]?.text.startsWith("-")
          ) {
            delCount++;
            i++;
          }
          // count consecutive + lines immediately after
          let addCount = 0;
          while (
            i < block.lines.length &&
            block.lines[i]?.text.startsWith("+")
          ) {
            addCount++;
            i++;
          }
          const paired = Math.min(delCount, addCount);
          modified += paired;
          removed += delCount - paired;
          added += addCount - paired;
        } else if (line.text.startsWith("+")) {
          added++;
          i++;
        } else {
          i++;
        }
      }
    }
  }

  return { added, removed, modified };
}

function formatStats(stats: DiffStats, theme: any): string {
  const parts: string[] = [];
  if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
  if (stats.modified > 0) parts.push(theme.fg("warning", `~${stats.modified}`));
  if (stats.removed > 0)
    parts.push(theme.fg("toolDiffRemoved", `-${stats.removed}`));
  return parts.length > 0 ? parts.join(" ") : theme.fg("dim", "no changes");
}

// --- tool factory ---

type EditInput = {
  oldText: string;
  newText: string;
};

interface EditFileParams {
  path: string;
  edits: EditInput[];
}

interface PreparedEdit extends EditInput {
  unescapedOldText: string;
  unescapedNewText: string;
  fuzzyOldText: string;
  fuzzyNewText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function prepareEdit(edit: EditInput): PreparedEdit {
  const oldText = normalizeToLF(edit.oldText);
  const newText = normalizeToLF(edit.newText);
  const unescapedOldText = unescapeStr(oldText);
  const unescapedNewText = unescapeStr(newText);
  return {
    oldText,
    newText,
    unescapedOldText,
    unescapedNewText,
    fuzzyOldText: normalizeForFuzzy(unescapedOldText),
    fuzzyNewText: normalizeForFuzzy(unescapedNewText),
  };
}

function getNotFoundMessage(fileName: string, editIndex: number, total: number): string {
  return total === 1
    ? `could not find oldText in ${fileName}. the text must match exactly including whitespace and newlines.`
    : `could not find edits[${editIndex}].oldText in ${fileName}. the text must match exactly including whitespace and newlines.`;
}

function getDuplicateMessage(
  fileName: string,
  editIndex: number,
  total: number,
  occurrences: number,
): string {
  return total === 1
    ? `found ${occurrences} occurrences of oldText in ${fileName}. add more context to make the match unique.`
    : `found ${occurrences} occurrences of edits[${editIndex}].oldText in ${fileName}. each match must be unique; add more context.`;
}

function getIdenticalMessage(editIndex: number, total: number): string {
  return total === 1
    ? "oldText and newText are identical. no changes needed."
    : `edits[${editIndex}] has identical oldText and newText. remove the no-op edit.`;
}

function getEmptyOldTextMessage(fileName: string, editIndex: number, total: number): string {
  return total === 1
    ? `oldText must not be empty in ${fileName}.`
    : `edits[${editIndex}].oldText must not be empty in ${fileName}.`;
}

function getOverlapMessage(
  fileName: string,
  previousIndex: number,
  currentIndex: number,
): string {
  return `edits[${previousIndex}] and edits[${currentIndex}] overlap in ${fileName}. merge them into one edit or target disjoint regions.`;
}

/**
 * resolves every edit against the original file snapshot, then applies the
 * replacements back-to-front. that keeps offsets stable without inventing a
 * merge policy for ambiguous or overlapping edits.
 */
function applyEditsToContent(
  normalizedContent: string,
  edits: EditInput[],
  fileName: string,
):
  | { ok: true; baseContent: string; newContent: string }
  | { ok: false; message: string } {
  if (edits.length === 0) {
    return { ok: false, message: "at least one edit is required." };
  }

  const preparedEdits = edits.map(prepareEdit);
  for (let i = 0; i < preparedEdits.length; i++) {
    const edit = preparedEdits[i];
    if (!edit) continue;
    if (edit.oldText.length === 0) {
      return {
        ok: false,
        message: getEmptyOldTextMessage(fileName, i, preparedEdits.length),
      };
    }
    if (edit.oldText === edit.newText) {
      return {
        ok: false,
        message: getIdenticalMessage(i, preparedEdits.length),
      };
    }
  }

  const fuzzyContent = normalizeForFuzzy(normalizedContent);
  const useFuzzyContent = preparedEdits.some((edit, index) => {
    const exactIndex = normalizedContent.indexOf(edit.oldText);
    if (exactIndex !== -1) return false;
    const unescapedIndex = normalizedContent.indexOf(edit.unescapedOldText);
    if (unescapedIndex !== -1) return false;
    return fuzzyContent.indexOf(edit.fuzzyOldText) !== -1;
  });

  const baseContent = useFuzzyContent ? fuzzyContent : normalizedContent;
  const matchedEdits: MatchedEdit[] = [];

  for (let i = 0; i < preparedEdits.length; i++) {
    const edit = preparedEdits[i];
    if (!edit) continue;

    const searchText = useFuzzyContent
      ? edit.fuzzyOldText
      : normalizedContent.indexOf(edit.oldText) !== -1
        ? edit.oldText
        : edit.unescapedOldText;
    const replacementText = useFuzzyContent
      ? edit.fuzzyNewText
      : searchText === edit.oldText
        ? edit.newText
        : edit.unescapedNewText;

    const matchIndex = baseContent.indexOf(searchText);
    if (matchIndex === -1) {
      return {
        ok: false,
        message: getNotFoundMessage(fileName, i, preparedEdits.length),
      };
    }

    const occurrences = countOccurrences(baseContent, searchText);
    if (occurrences > 1) {
      return {
        ok: false,
        message: getDuplicateMessage(fileName, i, preparedEdits.length, occurrences),
      };
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex,
      matchLength: searchText.length,
      newText: replacementText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (!previous || !current) continue;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      return {
        ok: false,
        message: getOverlapMessage(fileName, previous.editIndex, current.editIndex),
      };
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    if (!edit) continue;
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (newContent === baseContent) {
    return {
      ok: false,
      message: "no changes made — replacements produced identical content.",
    };
  }

  return { ok: true, baseContent, newContent };
}

export function createEditFileTool(): ToolDefinition {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Make edits to a text file.\n\n" +
      "Uses `edits[]` for one or more exact text replacements in the given file.\n\n" +
      "Returns a diff showing the changes made.\n\n" +
      "The file specified by `path` MUST exist.\n\n" +
      "Each `edits[].oldText` MUST exist exactly once in the original file.\n\n" +
      "Each `edits[].oldText` and `edits[].newText` pair MUST differ.\n\n" +
      "All edits are matched against the original file, not incrementally. Overlapping or ambiguous matches fail loudly; merge nearby changes into one edit instead.\n\n" +
      "When changing an existing file, use this tool. Only use the write tool for files that do not exist yet.",

    parameters: Type.Object({
      path: Type.String({
        description:
          "The absolute path to the file (MUST be absolute, not relative). File must exist.",
      }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description: "Text to search for. Must match exactly.",
          }),
          newText: Type.String({
            description: "Text to replace oldText with.",
          }),
        }),
        {
          minItems: 1,
          description:
            "One or more exact text replacements to apply against the original file contents.",
        },
      ),
    }),

    /**
     * resumed sessions may still contain our historical amp-style payload.
     * keep that compatibility here so old session files still replay after the
     * public tool schema moved to pi's edits[] shape.
     */
    prepareArguments(args: unknown) {
      if (!args || typeof args !== "object") return args as EditFileParams;
      const input = args as {
        path?: string;
        edits?: Array<{ oldText?: unknown; newText?: unknown }>;
        old_str?: unknown;
        new_str?: unknown;
      };

      if (
        typeof input.old_str === "string" &&
        typeof input.new_str === "string" &&
        (!Array.isArray(input.edits) || input.edits.length === 0)
      ) {
        return {
          path: input.path ?? "",
          edits: [{ oldText: input.old_str, newText: input.new_str }],
        };
      }

      return args as EditFileParams;
    },

    renderCall(args: any, theme: any) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, shortened)
        : shortened;
      return new Text(
        theme.fg("toolTitle", theme.bold("Edit ")) + theme.fg("dim", linked),
        0,
        0,
      );
    },

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as EditFileParams;
      const requestedPath = resolveToAbsolute(p.path, ctx.cwd);
      const verdict = permissions.evaluatePermission(
        "edit",
        {
          path: requestedPath,
          sessionCwd: ctx.cwd,
        },
        permissions.loadPermissions(),
      );
      if (verdict.action === "reject") {
        return {
          content: [
            {
              type: "text" as const,
              text: verdict.message
                ? `path rejected: ${verdict.message}`
                : "path rejected by permission rule.",
            },
          ],
          isError: true,
        } as any;
      }

      const resolved = resolveWithVariants(p.path, ctx.cwd);

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            { type: "text" as const, text: `file not found: ${resolved}` },
          ],
          isError: true,
        } as any;
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${resolved} is a directory, not a file.`,
            },
          ],
          isError: true,
        } as any;
      }

      for (const edit of p.edits) {
        const redactionMarker = hasNewRedactionMarkers(edit.oldText, edit.newText);
        if (redactionMarker) {
          return {
            content: [
              {
                type: "text" as const,
                text: `rejected: newText contains a redaction marker ("${redactionMarker}"). provide the actual content instead of placeholders.`,
              },
            ],
            isError: true,
          } as any;
        }
      }

      return withFileLock(resolved, async () => {
        const rawContent = fs.readFileSync(resolved, "utf-8");
        const { bom, text: bomStripped } = stripBom(rawContent);
        const originalEnding = detectLineEnding(bomStripped);
        const normalized = normalizeToLF(bomStripped);
        const applied = applyEditsToContent(
          normalized,
          p.edits,
          path.basename(resolved),
        );

        if (!applied.ok) {
          return {
            content: [{ type: "text" as const, text: applied.message }],
            isError: true,
          } as any;
        }

        const finalContent =
          bom + restoreLineEndings(applied.newContent, originalEnding);
        fs.writeFileSync(resolved, finalContent, "utf-8");

        // track change for undo_edit
        const sessionId = ctx.sessionManager.getSessionId();
        const trackingDiff = fileTracker.simpleDiff(
          resolved,
          rawContent,
          finalContent,
        );
        fileTracker.saveChange(sessionId, toolCallId, {
          uri: `file://${resolved}`,
          before: rawContent,
          after: finalContent,
          diff: trackingDiff,
          isNewFile: false,
          timestamp: Date.now(),
        });

        // build result from the matched base content so fuzzy edits diff cleanly
        const text = fileTracker.simpleDiff(
          resolved,
          applied.baseContent,
          applied.newContent,
        );

        return {
          content: [{ type: "text" as const, text }],
          details: {
            filePath: resolved,
          },
        } as any;
      });
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text(theme.fg("dim", "(no output)"), 0, 0);

      const diffText = content.text;
      const filenameMatch = diffText.match(/^---\s+(\S+)/m);
      const filename = filenameMatch?.[1] ?? "file";
      const filePath: string | undefined = result.details?.filePath;

      const sections = parseDiffToSections(filename, diffText);
      if (!sections?.length || !sections[0]?.blocks.length)
        return new Text(theme.fg("dim", "(no changes)"), 0, 0);

      // compute stats from unwindowed sections (accurate counts)
      const stats = computeDiffStats(sections);
      const statsText = formatStats(stats, theme);

      /** 25 visual lines per hunk: head 12 + tail 13 */
      const HUNK_EXCERPTS: Excerpt[] = [
        { focus: "head", context: 12 },
        { focus: "tail", context: 13 },
      ];

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          lines.push(statsText);

          // collapsed: last hunk only; expanded: all hunks
          const displaySections = sections.map((s) => {
            const blocks =
              !expanded && s.blocks.length > 1 ? s.blocks.slice(-1) : s.blocks;

            const header = filePath
              ? osc8Link(`file://${filePath}`, s.header ?? "")
              : s.header;

            return { ...s, header, blocks };
          });

          const boxOutput = formatBoxesWindowed(
            displaySections,
            {
              maxSections: expanded ? undefined : 1,
              excerpts: HUNK_EXCERPTS,
            },
            undefined,
            width,
          );
          lines.push(...boxOutput.split("\n"));

          return lines;
        },
        invalidate() {},
      };
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createEditFileTool()));
}

if (import.meta.vitest) {
  const { afterEach, beforeEach, describe, expect, it, vi } = import.meta.vitest;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-file-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("edit-file matching", () => {
    it("applies disjoint edits against the original content", () => {
      const result = applyEditsToContent(
        "alpha\nbeta\ngamma\ndelta\n",
        [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "delta", newText: "DELTA" },
        ],
        "test.txt",
      );

      expect(result).toEqual({
        ok: true,
        baseContent: "alpha\nbeta\ngamma\ndelta\n",
        newContent: "ALPHA\nbeta\ngamma\nDELTA\n",
      });
    });

    it("rejects duplicate matches before applying edits", () => {
      const result = applyEditsToContent(
        "alpha\nbeta\nalpha\n",
        [{ oldText: "alpha", newText: "ALPHA" }],
        "test.txt",
      );

      expect(result).toEqual({
        ok: false,
        message:
          "found 2 occurrences of oldText in test.txt. add more context to make the match unique.",
      });
    });

    it("rejects overlapping edits", () => {
      const result = applyEditsToContent(
        "abcdef\n",
        [
          { oldText: "abcd", newText: "ABCD" },
          { oldText: "cdef", newText: "CDEF" },
        ],
        "test.txt",
      );

      expect(result).toEqual({
        ok: false,
        message:
          "edits[0] and edits[1] overlap in test.txt. merge them into one edit or target disjoint regions.",
      });
    });

    it("supports escaped multiline legacy-style text after normalization", () => {
      const result = applyEditsToContent(
        "one\ntwo\nthree\n",
        [{ oldText: "one\\ntwo", newText: "ONE\\nTWO" }],
        "test.txt",
      );

      expect(result).toEqual({
        ok: true,
        baseContent: "one\ntwo\nthree\n",
        newContent: "ONE\nTWO\nthree\n",
      });
    });
  });

  describe("edit-file rendering", () => {
    it("renders distant hunks without dumping the unchanged middle", () => {
      const tool = createEditFileTool();
      const renderable = tool.renderResult?.(
        {
          content: [
            {
              type: "text",
              text: fileTracker.simpleDiff(
                "test.txt",
                Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
                [
                  "line 1 updated",
                  ...Array.from({ length: 38 }, (_, i) => `line ${i + 2}`),
                  "line 40 updated",
                ].join("\n"),
              ),
            },
          ],
          details: { filePath: "/tmp/test.txt" },
        } as any,
        { expanded: false, isPartial: false },
        {
          fg: (_token: string, text: string) => text,
          bold: (text: string) => text,
        } as any,
        {} as any,
      );

      const output = renderable?.render(80).join("\n") ?? "";
      expect(output).toContain("line 40 updated");
      expect(output).not.toContain("line 20");
    });
  });

  describe("edit-file permissions", () => {
    it("rejects disallowed paths before filesystem checks", async () => {
      const tool = createEditFileTool();
      const evaluatePermissionSpy = vi
        .spyOn(permissions, "evaluatePermission")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(permissions, "loadPermissions").mockReturnValue([]);

      const result = (await tool.execute!(
        "test-id",
        {
          path: "../sibling/file.txt",
          edits: [{ oldText: "before", newText: "after" }],
        },
        undefined,
        undefined,
        { cwd: "/repo/project" } as any,
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("path rejected: workspace only");
      expect(evaluatePermissionSpy).toHaveBeenCalledWith(
        "edit",
        { path: "/repo/sibling/file.txt", sessionCwd: "/repo/project" },
        [],
      );
    });

    it("applies multi-edit changes and records them as one tracked change", async () => {
      const tool = createEditFileTool();
      const filePath = path.join(tmpDir, "sample.txt");
      fs.writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n", "utf-8");
      vi.spyOn(permissions, "evaluatePermission").mockReturnValue({ action: "allow" });
      vi.spyOn(permissions, "loadPermissions").mockReturnValue([]);
      const saveChangeSpy = vi.spyOn(fileTracker, "saveChange");

      const result = (await tool.execute!(
        "tool-1",
        {
          path: filePath,
          edits: [
            { oldText: "alpha", newText: "ALPHA" },
            { oldText: "delta", newText: "DELTA" },
          ],
        },
        undefined,
        undefined,
        {
          cwd: tmpDir,
          sessionManager: { getSessionId: () => "session-1" },
        } as any,
      )) as any;

      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
      expect(result.content[0].text).toContain("@@");
      expect(result.details.filePath).toBe(filePath);
      expect(saveChangeSpy).toHaveBeenCalledTimes(1);
    });
  });
}
