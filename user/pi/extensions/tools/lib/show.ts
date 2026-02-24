/**
 * show() — render a text block showing only the regions declared by excerpts.
 *
 * ported from bdsqqq/pi-mono feat/excerpt-show-api branch. lives here so we
 * don't need to maintain a forked pi binary just to export this utility.
 *
 * multiple excerpts are sorted and merged when overlapping or adjacent.
 * gaps are replaced by "... (N lines) ..." elision markers (git-hunk style).
 * if excerpts is empty, returns all lines unchanged.
 *
 * focus semantics:
 *   "head"  — first `context` visual lines (one-sided from start)
 *   "tail"  — last `context` visual lines (one-sided from end)
 *   N       — ±context lines around visual line N (symmetric)
 *
 * uses @mariozechner/pi-tui Text for visual line expansion so wrapping and
 * ANSI sequences are handled consistently with pi's own rendering.
 */

import { Text } from "@mariozechner/pi-tui";

export interface Excerpt {
	focus: number | "head" | "tail";
	context: number;
}

export interface ShowResult {
	/** visual lines to render, with "... (N lines) ..." elision markers for gaps */
	visualLines: string[];
	/** ranges of visual lines omitted, as [startInclusive, endExclusive] pairs */
	skippedRanges: Array<[number, number]>;
}

export function show(text: string, excerpts: Excerpt[], width: number, paddingX = 0): ShowResult {
	if (!text) {
		return { visualLines: [], skippedRanges: [] };
	}

	const allVisualLines = new Text(text, paddingX, 0).render(width);
	const total = allVisualLines.length;

	if (excerpts.length === 0) {
		return { visualLines: allVisualLines, skippedRanges: [] };
	}

	// resolve each excerpt to an inclusive [start, end] range of visual lines
	const ranges: Array<[number, number]> = excerpts.map(({ focus, context }) => {
		if (focus === "head") {
			return [0, Math.min(context - 1, total - 1)];
		} else if (focus === "tail") {
			return [Math.max(0, total - context), total - 1];
		} else {
			return [Math.max(0, focus - context), Math.min(total - 1, focus + context)];
		}
	});

	// sort by start, then merge overlapping/adjacent ranges
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		if (merged.length === 0 || range[0] > merged[merged.length - 1][1] + 1) {
			merged.push([range[0], range[1]]);
		} else {
			merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
		}
	}

	const visualLines: string[] = [];
	const skippedRanges: Array<[number, number]> = [];
	let cursor = 0;

	for (const [start, end] of merged) {
		if (cursor < start) {
			const count = start - cursor;
			skippedRanges.push([cursor, start]);
			visualLines.push(`... (${count} ${count === 1 ? "line" : "lines"}) ...`);
		}
		for (let i = start; i <= end; i++) {
			visualLines.push(allVisualLines[i]);
		}
		cursor = end + 1;
	}

	if (cursor < total) {
		const count = total - cursor;
		skippedRanges.push([cursor, total]);
		visualLines.push(`... (${count} ${count === 1 ? "line" : "lines"}) ...`);
	}

	return { visualLines, skippedRanges };
}
