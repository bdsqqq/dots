import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { MermaidContextSlice } from "./extract";
import type { RenderCache } from "./render";
import { pickBestPreset } from "./render";

type DiagramEntry = {
	id: string;
	block: { code: string; blockIndex: number; startLine: number; endLine: number };
	context: MermaidContextSlice;
	source: "assistant" | "user" | "command";
};

/** fixed body height — overlay doesn't expose available height to render() */
const BODY_HEIGHT = 20;

/**
 * opens a pannable overlay for browsing rendered mermaid diagrams.
 * supports horizontal/vertical scrolling and multi-diagram navigation.
 */
export async function openMermaidViewer(args: {
	ctx: ExtensionContext;
	diagrams: DiagramEntry[];
	focusIndex?: number;
	cache: RenderCache;
}): Promise<void> {
	const { ctx, diagrams, cache } = args;
	if (!ctx.hasUI || diagrams.length === 0) return;

	const startIndex = args.focusIndex ?? diagrams.length - 1;

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const viewer = new MermaidViewer(diagrams, startIndex, cache, theme, tui, done);
			return {
				render: (w: number) => viewer.render(w),
				handleInput: (data: string) => {
					viewer.handleInput(data);
					tui.requestRender();
				},
				invalidate: () => viewer.invalidate(),
				get focused() {
					return viewer.focused;
				},
				set focused(v: boolean) {
					viewer.focused = v;
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: 100,
				minWidth: 40,
				maxHeight: "80%",
				offsetY: 1,
			},
		},
	);
}

// ── viewer component ────────────────────────────────────────────────────

class MermaidViewer {
	private activeIndex: number;
	private panX = 0;
	private panY = 0;
	focused = false;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		private diagrams: DiagramEntry[],
		initialIndex: number,
		private cache: RenderCache,
		private theme: Theme,
		private tui: { requestRender(): void },
		private done: () => void,
	) {
		this.activeIndex = Math.max(0, Math.min(initialIndex, diagrams.length - 1));
	}

	// ── input ──────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}

		// panning
		if (matchesKey(data, Key.left)) { this.panX -= 1; }
		else if (matchesKey(data, Key.right)) { this.panX += 1; }
		else if (matchesKey(data, Key.up)) { this.panY -= 1; }
		else if (matchesKey(data, Key.down)) { this.panY += 1; }
		// fast pan — shift or alt variants
		else if (matchesKey(data, Key.shift("left")) || matchesKey(data, Key.alt("left"))) { this.panX -= 10; }
		else if (matchesKey(data, Key.shift("right")) || matchesKey(data, Key.alt("right"))) { this.panX += 10; }
		else if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.alt("up"))) { this.panY -= 5; }
		else if (matchesKey(data, Key.shift("down")) || matchesKey(data, Key.alt("down"))) { this.panY += 5; }
		// home/end for horizontal extremes
		else if (matchesKey(data, Key.home)) { this.panX = 0; }
		else if (matchesKey(data, Key.end)) { this.panX = Infinity; } // clamped in render
		// diagram navigation
		else if (data === "[" || matchesKey(data, Key.shift("tab"))) {
			this.activeIndex = (this.activeIndex - 1 + this.diagrams.length) % this.diagrams.length;
			this.panX = 0;
			this.panY = 0;
		} else if (data === "]" || matchesKey(data, Key.tab)) {
			this.activeIndex = (this.activeIndex + 1) % this.diagrams.length;
			this.panX = 0;
			this.panY = 0;
		}

		this.invalidate();
	}

	// ── render ─────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const innerW = width - 4; // "│ " + content + " │"
		const dim = (s: string) => th.fg("dim", s);

		const entry = this.diagrams[this.activeIndex];
		const { rendered } = pickBestPreset(this.cache, entry.block.code, innerW);

		// build full content: context-before, diagram, context-after
		const content: string[] = [];
		for (const line of entry.context.beforeLines) {
			content.push(dim(line));
		}
		if (entry.context.beforeLines.length > 0) content.push("");

		for (const line of rendered.lines) {
			content.push(line);
		}

		if (entry.context.afterLines.length > 0) content.push("");
		for (const line of entry.context.afterLines) {
			content.push(dim(line));
		}

		// clamp pan
		const maxPanY = Math.max(0, content.length - BODY_HEIGHT);
		const maxPanX = Math.max(0, rendered.maxWidth - innerW);
		this.panY = Math.max(0, Math.min(this.panY, maxPanY));
		this.panX = Math.max(0, Math.min(this.panX, maxPanX));

		// slice viewport
		const visible = content.slice(this.panY, this.panY + BODY_HEIGHT);

		const lines: string[] = [];

		// header — total width = "┌" + (innerW + 2) dashes + "┐" = innerW + 4 = width
		const label = ` mermaid ${this.activeIndex + 1}/${this.diagrams.length} `;
		const topFill = "─".repeat(Math.max(0, innerW + 2 - label.length));
		lines.push(`┌${label}${topFill}┐`);

		// body rows
		for (let i = 0; i < BODY_HEIGHT; i++) {
			const raw = i < visible.length ? visible[i] : "";
			const sliced = sliceAnsiByColumns(raw, this.panX, innerW);
			const padded = padToWidth(sliced, innerW);
			lines.push(`│ ${padded} │`);
		}

		// separator + footer
		const footer = dim("←→↑↓ scroll • [] prev/next • esc close");
		lines.push(`├${"─".repeat(innerW + 2)}┤`);
		lines.push(`│ ${padToWidth(footer, innerW)} │`);
		lines.push(`└${"─".repeat(innerW + 2)}┘`);

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}
}

// ── ansi-safe column slicing ────────────────────────────────────────────

/**
 * slices a string containing ANSI escapes by visible column range.
 *
 * the naive approach (just use .slice()) breaks because ANSI escape
 * sequences are invisible but take string characters. we need to walk
 * the string, skip escapes from column counting, and only emit
 * characters within [startCol, startCol + maxCols).
 *
 * terminates with a reset to avoid color bleed from mid-sequence slicing.
 *
 * NOTE: treats each non-escape char as 1 column. this is correct for
 * mermaid ASCII output (box-drawing + latin) but would break on CJK
 * or emoji. acceptable tradeoff — beautiful-mermaid doesn't emit those.
 */
function sliceAnsiByColumns(line: string, startCol: number, maxCols: number): string {
	const ESC_RE = /\x1b\[[0-9;]*[A-Za-z]/;
	let col = 0;
	let out = "";
	let i = 0;

	while (i < line.length) {
		// check for ANSI escape at current position
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			const rest = line.slice(i);
			const match = rest.match(ESC_RE);
			if (match && match.index === 0) {
				// always copy escapes that appear in the visible window
				// (they set colors for subsequent characters)
				if (col >= startCol && col < startCol + maxCols) {
					out += match[0];
				}
				// also copy escapes before window — they may set colors
				// that apply to visible chars
				else if (col < startCol) {
					out += match[0];
				}
				i += match[0].length;
				continue;
			}
		}

		// visible character
		if (col >= startCol && col < startCol + maxCols) {
			out += line[i];
		}

		col++;
		if (col >= startCol + maxCols) {
			// past visible window — can stop scanning for visible chars
			// but we still need to check for trailing resets, skip for perf
			break;
		}
		i++;
	}

	return out + "\x1b[0m";
}

/** pads a string with spaces so its visible width reaches `target` */
function padToWidth(s: string, target: number): string {
	const w = visibleWidth(s);
	if (w >= target) return s;
	return s + " ".repeat(target - w);
}
