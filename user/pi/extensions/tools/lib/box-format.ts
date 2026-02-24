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

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

/**
 * ANSI-aware visible width + truncation.
 * avoids depending on pi-tui (which lives in pi's global install,
 * not the extension's node_modules / nix store).
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

	/** truncate line to safe width if provided, otherwise pass through */
	const safeWidth = width != null ? Math.max(1, width - WIDTH_SAFETY_MARGIN) : undefined;
	const clamp = (line: string): string =>
		safeWidth != null ? truncateToWidth(line, safeWidth, "…") : line;

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
