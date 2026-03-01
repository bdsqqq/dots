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
    if (merged.length === 0 || range[0] > merged[merged.length - 1][1] + 1) {
      merged.push([range[0], range[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        range[1],
      );
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
      result.push(items[i]);
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
