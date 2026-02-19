/**
 * editor extension — composable custom editor with box-drawing borders and label slots.
 *
 * replaces pi's default editor with ╭╮╰╯ borders. other extensions can inject
 * labels into the top/bottom border lines via the shared EventBus:
 *
 *   pi.events.emit("editor:set-label", { key: "handoff", text: "↳ handed off", position: "top", align: "left" })
 *   pi.events.emit("editor:remove-label", { key: "handoff" })
 *
 * multiple labels on the same border are separated by " · ". left labels fill
 * from the left edge, right labels from the right edge.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { TUI, EditorTheme } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";

interface Label {
	key: string;
	text: string;
	position: "top" | "bottom";
	align: "left" | "right";
}

interface SetLabelPayload {
	key: string;
	text: string;
	position?: "top" | "bottom";
	align?: "left" | "right";
}

interface RemoveLabelPayload {
	key: string;
}

const SEPARATOR = " · ";
const CORNER_TL = "╭";
const CORNER_TR = "╮";
const CORNER_BL = "╰";
const CORNER_BR = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

class LabeledEditor extends CustomEditor {
	private labels: Map<string, Label> = new Map();

	setLabel(key: string, text: string, position: "top" | "bottom" = "top", align: "left" | "right" = "left"): void {
		this.labels.set(key, { key, text, position, align });
	}

	removeLabel(key: string): void {
		this.labels.delete(key);
	}

	private getLabelsFor(position: "top" | "bottom", align: "left" | "right"): string {
		const matching = [...this.labels.values()].filter((l) => l.position === position && l.align === align);
		if (matching.length === 0) return "";
		return matching.map((l) => l.text).join(SEPARATOR);
	}

	/**
	 * build a border line like: ╭─ left label ─────── right label ─╮
	 *
	 * inherits scroll indicator text from the original border line if present.
	 * originalLine is the border super.render() produced — we check it for
	 * scroll indicators (↑/↓) and preserve that text as a right-aligned label.
	 */
	private buildBorderLine(
		outerWidth: number,
		cornerLeft: string,
		cornerRight: string,
		position: "top" | "bottom",
		originalLine: string,
	): string {
		const leftText = this.getLabelsFor(position, "left");
		const rightText = this.getLabelsFor(position, "right");

		// check if the original border had a scroll indicator
		let scrollIndicator = "";
		if (originalLine.includes("↑") || originalLine.includes("↓")) {
			// extract the indicator text like "↑ 3 more" or "↓ 2 more"
			const match = originalLine.match(/[↑↓]\s+\d+\s+more/);
			if (match) scrollIndicator = match[0];
		}

		// combine right-side content
		const rightParts = [rightText, scrollIndicator].filter(Boolean);
		const rightCombined = rightParts.join(SEPARATOR);

		// layout: ╭─leftLabel────────rightLabel─╮
		// always ─ after left corner and before right corner
		const hasLeft = leftText.length > 0;
		const hasRight = rightCombined.length > 0;

		const leftLabelWidth = hasLeft ? visibleWidth(leftText) : 0;
		const rightLabelWidth = hasRight ? visibleWidth(rightCombined) : 0;

		// budget: outerWidth - 2 corners - 2 edge dashes (╭─...─╮)
		const innerWidth = outerWidth - 4;
		const fillWidth = innerWidth - leftLabelWidth - rightLabelWidth;

		if (fillWidth < 0) {
			// too narrow — plain border, no labels
			return this.borderColor(cornerLeft + HORIZONTAL.repeat(Math.max(0, outerWidth - 2)) + cornerRight);
		}

		return (
			this.borderColor(cornerLeft + HORIZONTAL) +
			(hasLeft ? leftText : "") +
			this.borderColor(HORIZONTAL.repeat(fillWidth)) +
			(hasRight ? rightCombined : "") +
			this.borderColor(HORIZONTAL + cornerRight)
		);
	}

	/**
	 * find the bottom border index in the lines array from super.render().
	 * the bottom border is a full-width line of ─ characters (possibly with a scroll indicator).
	 * autocomplete lines appear after it and contain mixed content (not all ─).
	 *
	 * strategy: walk backward from the end, looking for a line whose stripped content
	 * is predominantly ─ characters. the first such line (from the end) is the bottom border.
	 */
	private findBottomBorderIndex(lines: string[]): number {
		for (let i = lines.length - 1; i >= 1; i--) {
			const stripped = lines[i]
				.replace(/\x1b\[[0-9;]*[mGKHJ]/g, "")
				.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
				.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
			if (stripped.length > 0 && stripped[0] === HORIZONTAL) {
				return i;
			}
		}
		return lines.length - 1;
	}

	render(width: number): string[] {
		// render the base editor at (width - 2) to leave room for │ side rails
		const innerWidth = width - 2;
		if (innerWidth < 4) return super.render(width); // too narrow, bail

		const lines = super.render(innerWidth);
		if (lines.length < 2) return lines;

		const bottomIdx = this.findBottomBorderIndex(lines);
		const result: string[] = [];

		// top border — replace line 0
		result.push(this.buildBorderLine(width, CORNER_TL, CORNER_TR, "top", lines[0]));

		// content lines — wrap with │ side rails
		for (let i = 1; i < bottomIdx; i++) {
			result.push(this.borderColor(VERTICAL) + lines[i] + this.borderColor(VERTICAL));
		}

		// bottom border
		result.push(this.buildBorderLine(width, CORNER_BL, CORNER_BR, "bottom", lines[bottomIdx]));

		// autocomplete lines (if any) — pass through, offset to align with inner content
		for (let i = bottomIdx + 1; i < lines.length; i++) {
			result.push(" " + lines[i] + " ");
		}

		return result;
	}
}

export default function (pi: ExtensionAPI) {
	let editor: LabeledEditor | null = null;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			editor = new LabeledEditor(tui, theme, keybindings);
			return editor;
		});
	});

	pi.events.on("editor:set-label", (data: unknown) => {
		const payload = data as SetLabelPayload;
		if (!payload.key || !payload.text) return;
		editor?.setLabel(payload.key, payload.text, payload.position ?? "top", payload.align ?? "left");
	});

	pi.events.on("editor:remove-label", (data: unknown) => {
		const payload = data as RemoveLabelPayload;
		if (!payload.key) return;
		editor?.removeLabel(payload.key);
	});

	pi.on("session_switch", async () => {
		editor = null;
	});
}
