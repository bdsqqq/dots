/**
 * makeShowRenderer — wraps show() in the width-aware caching pattern required
 * by the pi TUI renderer contract.
 *
 * pi calls render(width) on every frame and invalidate() when the component
 * must be re-evaluated. caching by width avoids recomputing visual-line
 * breaks on every frame (show() is O(lines)).
 *
 * usage:
 *   renderResult(result, { expanded }, theme) {
 *     const text = result.content?.[0]?.text ?? "";
 *     if (expanded) return new Text(text, 0, 0);
 *     return makeShowRenderer(text, [
 *       { focus: "head", context: 3 },
 *       { focus: "tail", context: 5 },
 *     ]);
 *   }
 */

import type { Excerpt } from "@mariozechner/pi-coding-agent";
import { show } from "@mariozechner/pi-coding-agent";

export interface ShowRenderer {
	render: (width: number) => string[];
	invalidate: () => void;
}

export function makeShowRenderer(text: string, excerpts: Excerpt[]): ShowRenderer {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (cachedLines === undefined || cachedWidth !== width) {
				cachedLines = show(text, excerpts, width).visualLines;
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}
