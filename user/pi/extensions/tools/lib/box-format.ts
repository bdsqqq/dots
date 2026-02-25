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
 * pipeline: callers produce BoxSection[], optionally pass Excerpt[] for
 * per-block visual-line windowing. box-format computes chrome width,
 * expands content to visual lines at (width - chrome), applies
 * windowItems() from show.ts, then wraps the result in box chrome.
 *
 * IMPORTANT: all output lines are truncated to the provided `width`
 * via truncateToWidth() as a safety net. the TUI will crash if any
 * rendered line exceeds terminal width.
 */

import { Text } from "@mariozechner/pi-tui";
import { windowItems, type Excerpt } from "./show";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

/**
 * ANSI-aware visible width + truncation.
 * pi-tui exports these too (with better wide-char support), but we
 * keep local versions so box-format works in test environments where
 * pi-tui isn't available.
 */
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

/** tab stop width — terminals default to 8 but most code uses 4 */
const TAB_WIDTH = 4;

function visibleWidth(text: string): number {
	const stripped = text.replace(ANSI_RE, "");
	let w = 0;
	for (const ch of stripped) {
		w += ch === "\t" ? TAB_WIDTH : 1;
	}
	return w;
}

function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsisLen = ellipsis.length;
	const target = maxWidth - ellipsisLen;
	if (target <= 0) return ellipsis.slice(0, maxWidth);

	let visible = 0;
	let i = 0;
	while (i < text.length && visible < target) {
		// skip SGR escape sequences (\x1b[...m)
		if (text[i] === "\x1b" && text[i + 1] === "[") {
			const end = text.indexOf("m", i);
			if (end !== -1) { i = end + 1; continue; }
		}
		// skip OSC 8 hyperlink sequences (\x1b]8;;...\x07)
		if (text[i] === "\x1b" && text[i + 1] === "]") {
			const end = text.indexOf("\x07", i);
			if (end !== -1) { i = end + 1; continue; }
		}
		visible += text[i] === "\t" ? TAB_WIDTH : 1;
		i++;
	}

	return text.slice(0, i) + RST + ellipsis;
}

/**
 * defensive padding subtracted from width before truncating.
 * the pi TUI passes the content-area width to render(), but
 * border/padding chars can still cause off-by-one wrapping
 * that eats subsequent lines. 2 chars is conservative enough
 * to prevent wrapping without wasting visible space.
 */
const WIDTH_SAFETY_MARGIN = 2;

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

// --- visual-line-aware rendering (show + box-format pipeline) ---

/** re-export Excerpt so consumers import from box-format only */
export type { Excerpt };

/** intermediate visual line produced by expanding BoxLine text */
interface VisualBoxLine {
	text: string;
	gutter: string;
	highlight: boolean;
	isElision: boolean;
	isGap: boolean;
}

/**
 * expand a block's logical BoxLine[] to visual lines at contentWidth.
 * wrapping is done by pi-tui's Text.render(). first visual line of
 * a wrapped logical line gets the gutter; continuation lines get "".
 */
function expandBlock(block: BoxBlock, contentWidth: number): VisualBoxLine[] {
	const result: VisualBoxLine[] = [];
	for (const line of block.lines) {
		const visualLines = contentWidth > 0
			? new Text(line.text, 0, 0).render(contentWidth)
			: [line.text];

		for (let i = 0; i < visualLines.length; i++) {
			result.push({
				text: visualLines[i],
				gutter: i === 0 ? (line.gutter ?? "") : "",
				highlight: line.highlight ?? false,
				isElision: false,
				isGap: false,
			});
		}
	}
	return result;
}

/**
 * compute the chrome prefix width for a given gutter width.
 * with gutter:  "  42 │ " = gutterWidth + 3
 * without:      "│ "      = 2
 */
function chromeWidth(gutterWidth: number): number {
	return gutterWidth > 0 ? gutterWidth + 3 : 2;
}

export interface BoxWindowedOpts {
	/** max sections to show (rest get "… N more" footer) */
	maxSections?: number;
	/**
	 * excerpts applied independently to each block's visual lines.
	 * e.g., [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }]
	 * caps each block at 25 visual lines (head 12 + tail 13).
	 */
	excerpts?: Excerpt[];
}

/**
 * visual-line-aware box renderer.
 *
 * pipeline: compute chrome width → expand to visual lines at content width
 * → window per-block via excerpts → render chrome around the result.
 *
 * wraps content to fit width
 * via pi-tui Text.render(). truncateToWidth is kept as a safety net.
 *
 * usage:
 *   formatBoxesWindowed(
 *     sections,
 *     { excerpts: [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }] },
 *     ["some notice"],
 *     90,
 *   )
 */
export function formatBoxesWindowed(
	sections: BoxSection[],
	opts: BoxWindowedOpts = {},
	notices?: string[],
	width?: number,
): string {
	const maxSections = opts.maxSections ?? sections.length;
	const excerpts = opts.excerpts ?? [];
	const shown = sections.slice(0, maxSections);
	const out: string[] = [];

	const safeWidth = width != null ? Math.max(1, width - WIDTH_SAFETY_MARGIN) : undefined;
	const clamp = (line: string): string =>
		safeWidth != null ? truncateToWidth(line, safeWidth, "…") : line;

	for (let si = 0; si < shown.length; si++) {
		const section = shown[si];

		// compute gutter width from all lines (before any windowing)
		const allGutters = section.blocks.flatMap((b) => b.lines.map((l) => l.gutter ?? ""));
		const gw = Math.max(0, ...allGutters.map((g) => g.length));
		const pad = " ".repeat(gw);

		// compute content width for visual-line expansion
		const cw = chromeWidth(gw);
		const contentWidth = safeWidth != null ? Math.max(1, safeWidth - cw) : 80;

		if (si > 0) out.push("");

		// header
		out.push(clamp(`${DIM}╭─[${RST}${section.header}${DIM}]${RST}`));

		let anyBlockTruncated = false;

		for (let bi = 0; bi < section.blocks.length; bi++) {
			// gap marker between blocks
			if (bi > 0) {
				out.push(gw > 0 ? `${DIM}${pad} ·${RST}` : `${DIM}·${RST}`);
			}

			// expand to visual lines at content width
			const expanded = expandBlock(section.blocks[bi], contentWidth);

			// apply per-block excerpts
			const windowed = excerpts.length > 0
				? windowItems(expanded, excerpts, (count): VisualBoxLine => ({
					text: `· ··· ${count} more lines`,
					gutter: "",
					highlight: false,
					isElision: true,
					isGap: false,
				}))
				: { items: expanded, skippedRanges: [] as Array<[number, number]> };

			if (windowed.skippedRanges.length > 0) anyBlockTruncated = true;

			// render each visual line with chrome
			for (const vl of windowed.items) {
				if (vl.isElision) {
					const prefix = gw > 0 ? `${pad} ` : "";
					out.push(`${DIM}${prefix}${vl.text}${RST}`);
				} else if (gw > 0) {
					const gutter = vl.gutter.padStart(gw);
					if (vl.highlight) {
						out.push(clamp(`${gutter} ${DIM}│${RST} ${vl.text}`));
					} else {
						out.push(clamp(`${DIM}${gutter} │ ${vl.text}${RST}`));
					}
				} else {
					if (vl.highlight) {
						out.push(clamp(`${DIM}│${RST} ${vl.text}`));
					} else {
						out.push(clamp(`${DIM}│ ${vl.text}${RST}`));
					}
				}
			}
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
 * visual-line-aware boxRenderer. uses formatBoxesWindowed under the hood.
 * caches by (width, expanded).
 */
export function boxRendererWindowed(
	buildSections: () => BoxSection[],
	opts: { collapsed: BoxWindowedOpts; expanded: BoxWindowedOpts },
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
			const visual = formatBoxesWindowed(
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

/**
 * wrap visible text in an OSC 8 terminal hyperlink.
 * terminals that support OSC 8 render this as a clickable link;
 * others silently ignore the sequences and show plain text.
 */
export function osc8Link(url: string, text: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * standardized call-line component for renderCall.
 * renders: bold(label) dim(context)
 *
 * usage: renderCallLine("Edit", "~/path/to/file.ts", theme)
 */
export function renderCallLine(label: string, context: string, theme: any): { render(width: number): string[]; invalidate(): void } {
	const line = theme.fg("toolTitle", theme.bold(label)) + (context ? " " + theme.fg("dim", context) : "");
	return {
		render(_width: number): string[] {
			return [line];
		},
		invalidate() {},
	};
}
