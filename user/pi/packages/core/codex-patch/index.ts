export interface PatchChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath?: string;
      chunks: PatchChunk[];
    };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function fail(line: number, message: string): never {
  throw new Error(`invalid patch at line ${line}: ${message}`);
}

function unwrapPatch(input: string): string[] {
  let lines = input.trim().split(/\r?\n/);
  const first = lines[0];
  const last = lines.at(-1);
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith("EOF") &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== BEGIN) {
    throw new Error(`invalid patch: first line must be '${BEGIN}'`);
  }
  if (lines.at(-1)?.trim() !== END) {
    throw new Error(`invalid patch: last line must be '${END}'`);
  }
  return lines;
}

function headerPath(line: string, marker: string, lineNumber: number): string {
  const value = line.trim().slice(marker.length).trim();
  if (!value) fail(lineNumber, `${marker.trim()} requires a path`);
  if (value.includes("\0"))
    fail(lineNumber, "paths must not contain NUL bytes");
  return value;
}

function isOperationHeader(line: string): boolean {
  const value = line.trim();
  return (
    value === END ||
    value.startsWith(ADD) ||
    value.startsWith(DELETE) ||
    value.startsWith(UPDATE)
  );
}

export function parseCodexPatch(input: string): PatchOperation[] {
  const lines = unwrapPatch(input);
  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    const lineNumber = index + 1;

    if (line.startsWith(ADD)) {
      const path = headerPath(line, ADD, lineNumber);
      index++;
      const added: string[] = [];
      while (index < lines.length && !isOperationHeader(lines[index] ?? "")) {
        const addedLine = lines[index] ?? "";
        if (!addedLine.startsWith("+")) {
          fail(index + 1, "every Add File content line must start with '+'");
        }
        added.push(addedLine.slice(1));
        index++;
      }
      if (added.length === 0) fail(lineNumber, "Add File must contain content");
      operations.push({ type: "add", path, content: `${added.join("\n")}\n` });
      continue;
    }

    if (line.startsWith(DELETE)) {
      operations.push({
        type: "delete",
        path: headerPath(line, DELETE, lineNumber),
      });
      index++;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = headerPath(line, UPDATE, lineNumber);
      index++;
      let movePath: string | undefined;
      if ((lines[index] ?? "").trim().startsWith(MOVE)) {
        movePath = headerPath((lines[index] ?? "").trim(), MOVE, index + 1);
        index++;
      }

      const chunks: PatchChunk[] = [];
      let current: PatchChunk | undefined;
      const ensureChunk = (): PatchChunk => {
        current ??= { oldLines: [], newLines: [], endOfFile: false };
        if (!chunks.includes(current)) chunks.push(current);
        return current;
      };

      while (index < lines.length && !isOperationHeader(lines[index] ?? "")) {
        const updateLine = lines[index] ?? "";
        const trimmed = updateLine.trimEnd();
        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          if (
            current &&
            current.oldLines.length === 0 &&
            current.newLines.length === 0
          ) {
            fail(index + 1, "empty update chunk");
          }
          current = {
            ...(trimmed.length > 2 ? { context: trimmed.slice(3) } : {}),
            oldLines: [],
            newLines: [],
            endOfFile: false,
          };
          chunks.push(current);
        } else if (trimmed === END_OF_FILE) {
          const chunk = ensureChunk();
          if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
            fail(index + 1, "empty update chunk");
          }
          chunk.endOfFile = true;
        } else if (updateLine === "") {
          const chunk = ensureChunk();
          chunk.oldLines.push("");
          chunk.newLines.push("");
        } else if (updateLine.startsWith(" ")) {
          const value = updateLine.slice(1);
          const chunk = ensureChunk();
          chunk.oldLines.push(value);
          chunk.newLines.push(value);
        } else if (updateLine.startsWith("+")) {
          ensureChunk().newLines.push(updateLine.slice(1));
        } else if (updateLine.startsWith("-")) {
          ensureChunk().oldLines.push(updateLine.slice(1));
        } else {
          fail(
            index + 1,
            "update lines must start with ' ', '+', '-', '@@', or an end-of-file marker",
          );
        }
        index++;
      }

      if (
        current &&
        current.oldLines.length === 0 &&
        current.newLines.length === 0
      ) {
        fail(index, "empty update chunk");
      }
      if (chunks.length === 0 && !movePath) {
        fail(lineNumber, "Update File must contain a change or move");
      }
      operations.push({ type: "update", path, movePath, chunks });
      continue;
    }

    fail(
      lineNumber,
      "expected an Add File, Delete File, or Update File header",
    );
  }

  if (operations.length === 0)
    throw new Error("invalid patch: no file operations");
  return operations;
}

function normalizeFuzzy(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function equalAt(
  lines: string[],
  pattern: string[],
  index: number,
  normalize: (value: string) => string,
): boolean {
  return pattern.every(
    (line, offset) =>
      normalize(lines[index + offset] ?? "") === normalize(line),
  );
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const first = endOfFile ? lines.length - pattern.length : start;
  const last = lines.length - pattern.length;
  const normalizers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
    normalizeFuzzy,
  ];
  for (const normalize of normalizers) {
    for (let index = first; index <= last; index++) {
      if (equalAt(lines, pattern, index, normalize)) return index;
    }
  }
  return undefined;
}

export function applyPatchChunks(
  content: string,
  chunks: PatchChunk[],
  filePath: string,
): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? content.slice(1) : content;
  const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const normalized = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const replacements: Array<{
    index: number;
    oldLength: number;
    newLines: string[];
  }> = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = seekSequence(lines, [chunk.context], cursor, false);
      if (contextIndex === undefined) {
        throw new Error(
          `failed to find context '${chunk.context}' in ${filePath}`,
        );
      }
      cursor = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({
        index: lines.length,
        oldLength: 0,
        newLines: chunk.newLines,
      });
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let match = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (match === undefined && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      match = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (match === undefined) {
      throw new Error(
        `failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    replacements.push({
      index: match,
      oldLength: oldLines.length,
      newLines,
    });
    cursor = match + oldLines.length;
  }

  for (const replacement of [...replacements].sort(
    (a, b) => b.index - a.index,
  )) {
    lines.splice(
      replacement.index,
      replacement.oldLength,
      ...replacement.newLines,
    );
  }
  const result = `${lines.join("\n")}\n`;
  return bom + (lineEnding === "\r\n" ? result.replace(/\n/g, "\r\n") : result);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("parseCodexPatch", () => {
    it("parses add, delete, update, move, and multiple chunks", () => {
      const operations = parseCodexPatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Delete File: deleted.txt
*** Update File: old.txt
*** Move to: moved.txt
@@ first
-old
+new
@@
-tail
+done
*** End Patch`);
      expect(operations).toEqual([
        { type: "add", path: "added.txt", content: "hello\n" },
        { type: "delete", path: "deleted.txt" },
        {
          type: "update",
          path: "old.txt",
          movePath: "moved.txt",
          chunks: [
            {
              context: "first",
              oldLines: ["old"],
              newLines: ["new"],
              endOfFile: false,
            },
            {
              oldLines: ["tail"],
              newLines: ["done"],
              endOfFile: false,
            },
          ],
        },
      ]);
    });

    it("rejects malformed and empty patches", () => {
      expect(() => parseCodexPatch("not a patch")).toThrow("first line");
      expect(() => parseCodexPatch(`${BEGIN}\n${END}`)).toThrow(
        "no file operations",
      );
      expect(() => parseCodexPatch(`${BEGIN}\n${ADD}x\nplain\n${END}`)).toThrow(
        "must start with '+'",
      );
    });
  });

  describe("applyPatchChunks", () => {
    it("applies ordered chunks with context and fuzzy whitespace", () => {
      const result = applyPatchChunks(
        "function x() {\n  old  \n}\ntail\n",
        [
          {
            context: "function x() {",
            oldLines: ["old"],
            newLines: ["new"],
            endOfFile: false,
          },
          {
            oldLines: ["tail"],
            newLines: ["done"],
            endOfFile: true,
          },
        ],
        "x.ts",
      );
      expect(result).toBe("function x() {\nnew\n}\ndone\n");
    });

    it("preserves BOM and CRLF", () => {
      expect(
        applyPatchChunks(
          "\uFEFFa\r\nb\r\n",
          [{ oldLines: ["b"], newLines: ["c"], endOfFile: false }],
          "x.txt",
        ),
      ).toBe("\uFEFFa\r\nc\r\n");
    });

    it("fails without matching context", () => {
      expect(() =>
        applyPatchChunks(
          "a\n",
          [{ oldLines: ["missing"], newLines: ["x"], endOfFile: false }],
          "x.txt",
        ),
      ).toThrow("failed to find expected lines");
    });
  });
}
