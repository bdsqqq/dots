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

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { CustomEditor, Theme, estimateTokens } from "@mariozechner/pi-coding-agent";
import type { TUI, EditorTheme } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { HorizontalLineWidget, WidgetRowRegistry } from "./widget-row";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { AgentMessage, AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import { hasToolCost } from "./tools/lib/tool-cost";

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
	private appTheme: Theme;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
		super(tui, editorTheme, keybindings);
		this.appTheme = appTheme;
	}

	/** always-dim color for box chrome (corners, lines, rails) */
	private dim(str: string): string {
		return this.appTheme.fg("dim", str);
	}

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
			return this.dim(cornerLeft + HORIZONTAL.repeat(Math.max(0, outerWidth - 2)) + cornerRight);
		}

		return (
			this.dim(cornerLeft + HORIZONTAL) +
			(hasLeft ? leftText : "") +
			this.dim(HORIZONTAL.repeat(fillWidth)) +
			(hasRight ? rightCombined : "") +
			this.dim(HORIZONTAL + cornerRight)
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

		// content lines — wrap with dim │ side rails
		for (let i = 1; i < bottomIdx; i++) {
			result.push(this.dim(VERTICAL) + lines[i] + this.dim(VERTICAL));
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

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function shortenPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
	return cwd;
}

/**
 * estimate context tokens from session entries using chars/4 heuristic.
 * fallback when provider hasn't reported usage yet (e.g., after compaction).
 */
function estimateContextFromEntries(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		switch (entry.type) {
			case "message":
				total += estimateTokens(entry.message as AgentMessage);
				break;
			case "custom_message": {
				const content = entry.content;
				const text = typeof content === "string"
					? content
					: content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("");
				total += Math.ceil(text.length / 4);
				break;
			}
			case "branch_summary":
				// branch summaries have a `summary` field
				if (entry.summary) {
					total += Math.ceil(entry.summary.length / 4);
				}
				break;
			case "compaction":
				// compaction entries also have a `summary` field
				if (entry.summary) {
					total += Math.ceil(entry.summary.length / 4);
				}
				break;
		}
	}
	return total;
}

function updateStatsLabels(editor: LabeledEditor, pi: ExtensionAPI, ctx: ExtensionContext): void {
	// top-left: context usage + cost (parent model + sub-agents)
	const usage = ctx.getContextUsage();
	const model = ctx.model;

	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role === "assistant") {
			cost += (msg as AssistantMessage).usage?.cost?.total ?? 0;
		} else if (msg.role === "toolResult") {
			const details = (msg as { details?: unknown }).details;
			if (hasToolCost(details)) cost += details.cost;
		}
	}

	const topLeftParts: string[] = [];

	// use provider-reported usage if available and meaningful, otherwise estimate from entries
	if (usage?.percent != null && usage.tokens != null && usage.tokens > 0) {
		topLeftParts.push(`${Math.round(usage.percent)}% of ${formatTokens(usage.contextWindow)}`);
	} else if (model?.contextWindow) {
		// fallback: estimate tokens from session entries
		const entries = ctx.sessionManager.getBranch();
		const estimatedTokens = estimateContextFromEntries(entries);
		const percent = (estimatedTokens / model.contextWindow) * 100;
		topLeftParts.push(`~${Math.round(percent)}% of ${formatTokens(model.contextWindow)}`);
	}

	if (cost > 0) {
		topLeftParts.push(`$${cost.toFixed(2)}`);
	}
	if (topLeftParts.length > 0) {
		editor.setLabel("stats", topLeftParts.join(" · "), "top", "left");
	}

	// top-right: model + thinking level
	const topRightParts: string[] = [];
	if (model) {
		const provider = model.provider ? `(${model.provider})` : "";
		topRightParts.push(`${provider} ${model.id}`.trim());
	}
	const thinkingLevel = pi.getThinkingLevel();
	if (thinkingLevel && thinkingLevel !== "off") {
		topRightParts.push(thinkingLevel);
	}
	if (topRightParts.length > 0) {
		editor.setLabel("model", topRightParts.join(" · "), "top", "right");
	}
}

function getGitDiffStats(cwd: string): string {
	try {
		const out = execSync("git diff --stat", { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
		if (!out) return "";
		// last line is summary: " N files changed, N insertions(+), N deletions(-)"
		const lines = out.split("\n");
		const summary = lines[lines.length - 1].trim();
		const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
		const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
		const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);
		if (!filesMatch) return "";
		const parts = [`${filesMatch[1]} files changed`];
		if (insMatch) parts.push(`+${insMatch[1]}`);
		if (delMatch) parts.push(`-${delMatch[1]}`);
		return parts.join(" ");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let editor: LabeledEditor | null = null;
	let gitBranch: string | null = null;
	let branchUnsub: (() => void) | null = null;
	let activeTools = 0;
	let statusRow: WidgetRowRegistry | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// replace editor with labeled box-drawing version
		ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
			editor = new LabeledEditor(tui, editorTheme, keybindings, ctx.ui.theme);
			return editor;
		});

		// replace footer with empty component — we show its data in the borders
		ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			branchUnsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				updateBottomLabel();
				tui.requestRender();
			});

			updateBottomLabel();

			return {
				dispose: () => { branchUnsub?.(); branchUnsub = null; },
				invalidate() {},
				render(_width: number): string[] { return []; },
			};
		});

		ctx.ui.setWidget("status-line", (tui) => {
			statusRow = new WidgetRowRegistry(tui);
			return new HorizontalLineWidget(() => statusRow!.snapshot(), { gap: "  " });
		}, { placement: "belowEditor" });

		// set initial bottom label with cwd
		function updateBottomLabel() {
			if (!editor) return;
			const cwd = shortenPath(ctx.cwd);
			const branchText = gitBranch ? `(${gitBranch})` : "";
			editor.setLabel("cwd", `${cwd} ${branchText}`.trim(), "bottom", "right");
		}

		updateBottomLabel();
		updateStatsLabels(editor!, pi, ctx);
	});

	// --- activity status + git changes widget ---
	const ACTIVITY_SEGMENT = "activity";
	const GIT_SEGMENT = "git-changes";

	const setActivitySegment = (text: string): void => {
		statusRow?.set(ACTIVITY_SEGMENT, {
			align: "left",
			priority: 10,
			renderInline: () => text,
		});
	};

	const clearActivitySegment = (): void => {
		statusRow?.remove(ACTIVITY_SEGMENT);
	};

	const updateGitSegment = (text?: string): void => {
		if (!text) {
			statusRow?.remove(GIT_SEGMENT);
			return;
		}
		statusRow?.set(GIT_SEGMENT, {
			align: "right",
			priority: 0,
			renderInline: () => text,
		});
	};

	pi.on("agent_start", async (_event, ctx) => {
		activeTools = 0;
		setActivitySegment(" ≈ thinking...");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools++;
		setActivitySegment(` ≈ ${event.toolName}...  Esc to cancel`);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		activeTools = Math.max(0, activeTools - 1);
		if (activeTools === 0) {
			setActivitySegment(" ≈ thinking...");
		}
		if (editor) updateStatsLabels(editor, pi, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeTools = 0;
		clearActivitySegment();
		if (editor) updateStatsLabels(editor, pi, ctx);

		const diffStats = getGitDiffStats(ctx.cwd);
		updateGitSegment(diffStats);
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

	pi.on("model_select", async (_event, ctx) => {
		// update model display when user changes model via /model or Ctrl+P
		if (editor) updateStatsLabels(editor, pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		// editor component persists across session switches, just update stats
		branchUnsub?.();
		branchUnsub = null;
		gitBranch = null;
		activeTools = 0;
		statusRow?.clear();
		if (editor) updateStatsLabels(editor, pi, ctx);
	});
}
