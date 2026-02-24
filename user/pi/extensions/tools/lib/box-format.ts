/**
 * box-format — shared diagnostic-style box renderer for tool output.
 *
 * produces miette/ariadne-style box-drawing output:
 *   ╭─[header text]
 *    42 │ highlighted line (base-color gutter)
 *    43 │ dim context line
 *       ·
 *   100 │ another block
 *   ╰────
 *
 * chrome (╭│╰─·) renders DIM. highlighted lines get base-color
 * gutter + content; non-highlighted lines are fully dim.
 * tools without line numbers omit the gutter column.
 *
 * IMPORTANT: all output lines are truncated to the provided `width`
 * via truncateToWidth() to satisfy the pi TUI renderer contract.
 * the TUI will crash if any rendered line exceeds terminal width.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

export interface BoxLine {
	/** optional gutter text (e.g., line number). right-aligned to gutter width. */
	gutter?: string;
	/** line content */
	text: string;
	/** when true, gutter + content render at base color instead of dim */
	highlight?: boolean;
}

export interface BoxBlock {
	lines: BoxLine[];
}

export interface BoxSection {
	/** text inside ╭─[...] */
	header: string;
	/** contiguous blocks. gaps between blocks show · elision marker. */
	blocks: BoxBlock[];
}

export interface BoxOpts {
	/** max sections to show (rest get "… N more" footer) */
	maxSections?: number;
	/** max blocks per section */
	maxBlocks?: number;
}

/**
 * render sections as box-drawing formatted output.
 *
 * every output line is truncated to `width` (when provided) to satisfy
 * the TUI renderer contract. callers MUST pass width from render(width).
 *
 * usage:
 *   formatBoxes(
 *     [{ header: "file.ts", blocks: [{ lines: [...] }] }],
 *     { maxSections: 3, maxBlocks: 1 },
 *     ["2 files hit limit"],
 *     90,
 *   )
 */
export function formatBoxes(
	sections: BoxSection[],
	opts: BoxOpts = {},
	notices?: string[],
	width?: number,
): string {
	const maxSections = opts.maxSections ?? sections.length;
	const maxBlocks = opts.maxBlocks ?? Infinity;
	const shown = sections.slice(0, maxSections);
	const out: string[] = [];

	/** truncate line to width if provided, otherwise pass through */
	const clamp = (line: string): string =>
		width != null ? truncateToWidth(line, width, "…") : line;

	for (let si = 0; si < shown.length; si++) {
		const section = shown[si];
		const shownBlocks = section.blocks.slice(0, maxBlocks);

		// compute gutter width from widest gutter string across shown blocks
		const allGutters = shownBlocks.flatMap((b) => b.lines.map((l) => l.gutter ?? ""));
		const gw = Math.max(0, ...allGutters.map((g) => g.length));
		const pad = " ".repeat(gw);

		// blank line between sections (not before first)
		if (si > 0) out.push("");

		// header
		out.push(clamp(`${DIM}╭─[${RST}${section.header}${DIM}]${RST}`));

		for (let bi = 0; bi < shownBlocks.length; bi++) {
			// elision dot between non-contiguous blocks
			if (bi > 0) {
				out.push(gw > 0 ? `${DIM}${pad} ·${RST}` : `${DIM}·${RST}`);
			}

			for (const line of shownBlocks[bi].lines) {
				if (gw > 0) {
					const gutter = (line.gutter ?? "").padStart(gw);
					if (line.highlight) {
						out.push(clamp(`${gutter} ${DIM}│${RST} ${line.text}`));
					} else {
						out.push(clamp(`${DIM}${gutter} │ ${line.text}${RST}`));
					}
				} else {
					// no gutter column
					if (line.highlight) {
						out.push(clamp(`${DIM}│${RST} ${line.text}`));
					} else {
						out.push(clamp(`${DIM}│ ${line.text}${RST}`));
					}
				}
			}
		}

		// block elision
		if (section.blocks.length > maxBlocks) {
			const rem = section.blocks.length - maxBlocks;
			const prefix = gw > 0 ? `${pad} ` : "";
			out.push(`${DIM}${prefix}· ··· ${rem} more ${rem === 1 ? "group" : "groups"}${RST}`);
		}

		// footer
		out.push(`${DIM}╰${"─".repeat(4)}${RST}`);
	}

	// section elision
	if (sections.length > maxSections) {
		const rem = sections.length - maxSections;
		out.push(`${DIM}… ${rem} more${RST}`);
	}

	if (notices?.length) {
		out.push("");
		out.push(clamp(`${DIM}[${notices.join(". ")}]${RST}`));
	}

	return out.join("\n");
}

/**
 * convenience: wrap a single text block in a box section with no gutter.
 * all lines get highlight=true (base color) by default.
 */
export function textSection(header: string, text: string, dim = false): BoxSection {
	return {
		header,
		blocks: [{
			lines: text.split("\n").map((line) => ({
				text: line,
				highlight: !dim,
			})),
		}],
	};
}

/**
 * build a show-renderer-compatible object from formatBoxes output.
 * caches by (width, expanded) to avoid rebuilding every frame.
 *
 * width is passed through to formatBoxes for line truncation —
 * this is critical to avoid TUI crashes from lines exceeding
 * terminal width.
 */
export function boxRenderer(
	buildSections: () => BoxSection[],
	opts: { collapsed: BoxOpts; expanded: BoxOpts },
	notices?: string[],
) {
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number, expanded: boolean): string[] {
			if (cachedLines !== undefined && cachedExpanded === expanded && cachedWidth === width) {
				return cachedLines;
			}
			const sections = buildSections();
			const visual = formatBoxes(
				sections,
				expanded ? opts.expanded : opts.collapsed,
				notices,
				width,
			);
			cachedLines = visual.split("\n");
			cachedExpanded = expanded;
			cachedWidth = width;
			return cachedLines;
		},
		invalidate() {
			cachedLines = undefined;
			cachedExpanded = undefined;
			cachedWidth = undefined;
		},
	};
}
