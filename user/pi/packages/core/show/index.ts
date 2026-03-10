/**
 * show — excerpt-based windowing for tool output.
 *
 * two layers:
 *   windowItems<T>() — generic windowing primitive. operates on any array.
 *   show()           — text-specific wrapper: Text.render() → windowItems<string>().
 *
 * focus semantics:
 *   "head"  — first `context` items (one-sided from start)
 *   "tail"  — last `context` items (one-sided from end)
 *   N       — ±context items around index N (symmetric)
 *
 * multiple excerpts are sorted and merged when overlapping or adjacent.
 * gaps get an elision marker via the caller-provided makeElision factory.
 */

import { Text } from "@mariozechner/pi-tui";

export interface Excerpt {
  focus: number | "head" | "tail";
  context: number;
}

export interface WindowResult<T> {
  items: T[];
  skippedRanges: Array<[number, number]>;
}

/**
 * generic excerpt windowing. picks items to keep based on excerpts,
 * inserts caller-provided elision markers for gaps.
 *
 * if excerpts is empty, returns all items unchanged.
 */
export function windowItems<T>(
  items: T[],
  excerpts: Excerpt[],
  makeElision: (count: number) => T,
): WindowResult<T> {
  const total = items.length;
  if (total === 0 || excerpts.length === 0) {
    return { items: [...items], skippedRanges: [] };
  }

  // resolve each excerpt to an inclusive [start, end] range
  const ranges: Array<[number, number]> = excerpts.map(({ focus, context }) => {
    if (focus === "head") {
      return [0, Math.min(context - 1, total - 1)];
    } else if (focus === "tail") {
      return [Math.max(0, total - context), total - 1];
    } else {
      return [
        Math.max(0, focus - context),
        Math.min(total - 1, focus + context),
      ];
    }
  });

  // sort by start, then merge overlapping/adjacent ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const lastMerged = merged[merged.length - 1];
    if (merged.length === 0 || !lastMerged || range[0] > lastMerged[1] + 1) {
      merged.push([range[0], range[1]]);
    } else {
      lastMerged[1] = Math.max(lastMerged[1], range[1]);
    }
  }

  const result: T[] = [];
  const skippedRanges: Array<[number, number]> = [];
  let cursor = 0;

  for (const [start, end] of merged) {
    if (cursor < start) {
      skippedRanges.push([cursor, start]);
      result.push(makeElision(start - cursor));
    }
    for (let i = start; i <= end; i++) {
      const item = items[i];
      if (item !== undefined) result.push(item);
    }
    cursor = end + 1;
  }

  if (cursor < total) {
    skippedRanges.push([cursor, total]);
    result.push(makeElision(total - cursor));
  }

  return { items: result, skippedRanges };
}

// --- text-specific wrapper ---

export interface ShowResult {
  /** visual lines to render, with "... (N lines) ..." elision markers for gaps */
  visualLines: string[];
  /** ranges of visual lines omitted, as [startInclusive, endExclusive] pairs */
  skippedRanges: Array<[number, number]>;
}

/**
 * text-specific windowing: expands text to visual lines via pi-tui Text,
 * then applies excerpt windowing.
 */
export function show(
  text: string,
  excerpts: Excerpt[],
  width: number,
  paddingX = 0,
): ShowResult {
  if (!text) {
    return { visualLines: [], skippedRanges: [] };
  }

  const allVisualLines = new Text(text, paddingX, 0).render(width);

  if (excerpts.length === 0) {
    return { visualLines: allVisualLines, skippedRanges: [] };
  }

  const result = windowItems(
    allVisualLines,
    excerpts,
    (count) => `... (${count} ${count === 1 ? "line" : "lines"}) ...`,
  );

  return { visualLines: result.items, skippedRanges: result.skippedRanges };
}

// --- inline tests ---

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("windowItems", () => {
    it("returns all items when no excerpts", () => {
      const items = ["a", "b", "c"];
      const result = windowItems(items, [], (n) => `...${n}...`);
      expect(result.items).toEqual(["a", "b", "c"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      const result = windowItems(
        [],
        [{ focus: 0, context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual([]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("extracts head excerpt", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: "head", context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b", "...3..."]);
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("extracts tail excerpt", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: "tail", context: 2 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["...3...", "d", "e"]);
      expect(result.skippedRanges).toEqual([[0, 3]]);
    });

    it("extracts symmetric excerpt around index", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [{ focus: 2, context: 1 }],
        (n) => `...${n}...`,
      );
      // focus=2, context=1 → range [1,3] → keeps b,c,d, skips 1 at start and 1 at end
      expect(result.items).toEqual(["...1...", "b", "c", "d", "...1..."]);
      expect(result.skippedRanges).toEqual([
        [0, 1],
        [4, 5],
      ]);
    });

    it("merges overlapping excerpts", () => {
      const items = ["a", "b", "c", "d", "e", "f"];
      const result = windowItems(
        items,
        [
          { focus: 1, context: 1 }, // [0, 2]
          { focus: 3, context: 1 }, // [2, 4]
        ],
        (n) => `...${n}...`,
      );
      // merged to [0, 4], leaving [5, 6]
      expect(result.items).toEqual(["a", "b", "c", "d", "e", "...1..."]);
      expect(result.skippedRanges).toEqual([[5, 6]]);
    });

    it("merges adjacent excerpts", () => {
      const items = ["a", "b", "c", "d", "e"];
      const result = windowItems(
        items,
        [
          { focus: 0, context: 0 }, // [0, 0]
          { focus: 1, context: 0 }, // [1, 1]
        ],
        (n) => `...${n}...`,
      );
      // adjacent [0,0] and [1,1] merge to [0,1]
      expect(result.items).toEqual(["a", "b", "...3..."]);
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("clamps head context to available items", () => {
      const items = ["a", "b"];
      const result = windowItems(
        items,
        [{ focus: "head", context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("clamps tail context to available items", () => {
      const items = ["a", "b"];
      const result = windowItems(
        items,
        [{ focus: "tail", context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b"]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("clamps symmetric context to bounds", () => {
      const items = ["a", "b", "c"];
      const result = windowItems(
        items,
        [{ focus: 0, context: 5 }],
        (n) => `...${n}...`,
      );
      expect(result.items).toEqual(["a", "b", "c"]);
      expect(result.skippedRanges).toEqual([]);
    });
  });

  describe("show", () => {
    it("returns empty for empty text", () => {
      const result = show("", [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines).toEqual([]);
      expect(result.skippedRanges).toEqual([]);
    });

    it("returns all lines when no excerpts", () => {
      const result = show("a\nb\nc", [], 80);
      // Text.render() pads each line to width
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("a");
      expect(result.visualLines[1]?.trim()).toBe("b");
      expect(result.visualLines[2]?.trim()).toBe("c");
      expect(result.skippedRanges).toEqual([]);
    });

    it("applies head excerpt to visual lines", () => {
      const text = "line1\nline2\nline3\nline4\nline5";
      const result = show(text, [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("line1");
      expect(result.visualLines[1]?.trim()).toBe("line2");
      expect(result.visualLines[2]).toBe("... (3 lines) ...");
      expect(result.skippedRanges).toEqual([[2, 5]]);
    });

    it("uses singular 'line' for single skipped line", () => {
      const text = "line1\nline2\nline3";
      const result = show(text, [{ focus: "head", context: 2 }], 80);
      expect(result.visualLines.length).toBe(3);
      expect(result.visualLines[0]?.trim()).toBe("line1");
      expect(result.visualLines[1]?.trim()).toBe("line2");
      expect(result.visualLines[2]).toBe("... (1 line) ...");
    });

    it("wraps long lines at width", () => {
      const longLine = "a".repeat(100);
      const result = show(longLine, [], 50);
      // Text.render() wraps at 50 chars
      expect(result.visualLines.length).toBeGreaterThan(1);
    });
  });
}
