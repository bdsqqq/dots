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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasToolCost } from "../tools/lib/tool-cost";

const execFileAsync = promisify(execFile);

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
	private borderCache: Record<"top" | "bottom", { key: string; line: string } | null> = {
		top: null,
		bottom: null,
	};

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

	private extractScrollIndicator(originalLine: string): string {
		if (!originalLine.includes("↑") && !originalLine.includes("↓")) return "";
		const match = originalLine.match(/[↑↓]\s+\d+\s+more/);
		return match ? match[0] : "";
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
		const scrollIndicator = this.extractScrollIndicator(originalLine);

		// combine right-side content
		const rightParts = [rightText, scrollIndicator].filter(Boolean);
		const rightCombined = rightParts.join(SEPARATOR);
		const cacheKey = `${outerWidth}|${position}|${leftText}|${rightCombined}`;
		const cached = this.borderCache[position];
		if (cached?.key === cacheKey) return cached.line;

		// layout: ╭─leftLabel────────rightLabel─╮
		// always ─ after left corner and before right corner
		const hasLeft = leftText.length > 0;
		const hasRight = rightCombined.length > 0;

		const leftLabelWidth = hasLeft ? visibleWidth(leftText) : 0;
		const rightLabelWidth = hasRight ? visibleWidth(rightCombined) : 0;

		// budget: outerWidth - 2 corners - 2 edge dashes (╭─...─╮)
		const innerWidth = outerWidth - 4;
		const fillWidth = innerWidth - leftLabelWidth - rightLabelWidth;

		const line = fillWidth < 0
			? this.dim(cornerLeft + HORIZONTAL.repeat(Math.max(0, outerWidth - 2)) + cornerRight)
			: this.dim(cornerLeft + HORIZONTAL) +
				(hasLeft ? leftText : "") +
				this.dim(HORIZONTAL.repeat(fillWidth)) +
				(hasRight ? rightCombined : "") +
				this.dim(HORIZONTAL + cornerRight);

		this.borderCache[position] = { key: cacheKey, line };
		return line;
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

function updateStatsLabels(editor: LabeledEditor | null, pi: ExtensionAPI, ctx: ExtensionContext, cachedLen?: { value: number }): void {
	if (!editor) return;

	// skip recomputation if branch length unchanged (cheap proxy for "nothing new happened")
	const branch = ctx.sessionManager.getBranch();
	if (cachedLen && branch.length === cachedLen.value) return;
	if (cachedLen) cachedLen.value = branch.length;

	// top-left: context usage + cost (parent model + sub-agents)
	const usage = ctx.getContextUsage();
	const model = ctx.model;

	let cost = 0;
	for (const entry of branch) {
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
		const estimatedTokens = estimateContextFromEntries(branch);
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


async function getGitDiffStats(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
			cwd,
			timeout: 3000,
		});
		const out = stdout.trim();
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

// ---------------------------------------------------------------------------
// animated activity spinner — renders rich status below the editor
// ---------------------------------------------------------------------------

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type ActivityPhase = "idle" | "thinking" | "tool" | "streaming";

interface ActivityState {
	phase: ActivityPhase;
	turnIndex: number;
	/** tool names currently in-flight (supports parallel tool calls) */
	activeTools: Map<string, string>;
	/** epoch ms when agent_start fired */
	startedAt: number;
	/** interval handle for spinner animation */
	intervalId: ReturnType<typeof setInterval> | null;
	/** current braille frame index */
	frame: number;
}

function createActivityState(): ActivityState {
	return {
		phase: "idle",
		turnIndex: 0,
		activeTools: new Map(),
		startedAt: 0,
		intervalId: null,
		frame: 0,
	};
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m${rem > 0 ? `${rem}s` : ""}`;
}

/**
 * shorten a tool name for display: "tool_execution" → "tool_execution",
 * but we also extract a meaningful arg when possible (e.g. file path).
 */
function describeToolCall(toolName: string, args: any): string {
	// common pi tools have a `path` or `pattern` arg — show it if short
	const hint = args?.path ?? args?.pattern ?? args?.query ?? args?.filePattern ?? args?.cmd;
	if (typeof hint === "string") {
		// just the basename or first 24 chars
		const short = hint.includes("/")
			? hint.split("/").pop()!
			: hint.length > 24
				? hint.slice(0, 24) + "…"
				: hint;
		return `${toolName}(${short})`;
	}
	return toolName;
}

function renderActivity(state: ActivityState): string {
	if (state.phase === "idle") return "";

	const parts: string[] = [];

	// animated spinner
	parts.push(BRAILLE_FRAMES[state.frame % BRAILLE_FRAMES.length]);

	// turn number (0-indexed from the event, display as 1-indexed)
	if (state.turnIndex > 0) {
		parts.push(`turn ${state.turnIndex + 1}`);
	}

	// phase-specific info
	if (state.activeTools.size > 0) {
		const toolDescs = [...state.activeTools.values()];
		// show up to 2 tool descriptions
		const shown = toolDescs.slice(0, 2).join(", ");
		const overflow = toolDescs.length > 2 ? ` +${toolDescs.length - 2}` : "";
		parts.push(shown + overflow);
	} else if (state.phase === "thinking") {
		parts.push("thinking");
	} else if (state.phase === "streaming") {
		parts.push("writing");
	}

	// elapsed time
	if (state.startedAt > 0) {
		const elapsed = Date.now() - state.startedAt;
		if (elapsed >= 1000) {
			parts.push(formatElapsed(elapsed));
		}
	}

	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	let editor: LabeledEditor | null = null;
	const statsCacheBranchLen = { value: -1 };
	let gitBranch: string | null = null;
	let branchUnsub: (() => void) | null = null;
	let statusRow: WidgetRowRegistry | null = null;
	const activity = createActivityState();

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// make tool call backgrounds transparent — removes the colored box
		// chrome that ToolExecutionComponent forces via Box(1,1,bgFn).
		// the Box padding (1char/1row) remains but is invisible against
		// the terminal's default background.
		const themeAny = ctx.ui.theme as any;
		if (themeAny.bgColors instanceof Map) {
			const transparent = "\x1b[49m"; // ANSI bg reset = terminal default
			themeAny.bgColors.set("toolPendingBg", transparent);
			themeAny.bgColors.set("toolSuccessBg", transparent);
			themeAny.bgColors.set("toolErrorBg", transparent);
		}

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
			return new HorizontalLineWidget(() => statusRow!.snapshot(), { gap: "  " }, () => statusRow!.version);
		}, { placement: "belowEditor" });

		// set initial bottom label with cwd
		function updateBottomLabel() {
			if (!editor) return;
			const cwd = shortenPath(ctx.cwd);
			const branchText = gitBranch ? `(${gitBranch})` : "";
			editor.setLabel("cwd", `${cwd} ${branchText}`.trim(), "bottom", "right");
		}

		updateBottomLabel();
		updateStatsLabels(editor!, pi, ctx, statsCacheBranchLen);
	});

	// --- animated activity spinner + git changes widget ---
	const ACTIVITY_SEGMENT = "activity";
	const GIT_SEGMENT = "git-changes";

	/** push current activity state into the widget row */
	const syncActivitySegment = (): void => {
		if (activity.phase === "idle") {
			statusRow?.remove(ACTIVITY_SEGMENT);
			return;
		}
		const text = renderActivity(activity);
		if (!text) return;
		statusRow?.set(ACTIVITY_SEGMENT, {
			align: "left",
			priority: 10,
			renderInline: () => renderActivity(activity),
		});
	};

	const startSpinner = (): void => {
		if (activity.intervalId) return;
		activity.intervalId = setInterval(() => {
			activity.frame = (activity.frame + 1) % BRAILLE_FRAMES.length;
			syncActivitySegment();
		}, 80);
	};

	const stopSpinner = (): void => {
		if (activity.intervalId) {
			clearInterval(activity.intervalId);
			activity.intervalId = null;
		}
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
		// suppress native spinner text — we render our own below the editor
		ctx.ui.setWorkingMessage(" ");

		activity.phase = "thinking";
		activity.turnIndex = 0;
		activity.activeTools.clear();
		activity.startedAt = Date.now();
		activity.frame = 0;
		startSpinner();
		syncActivitySegment();
	});

	pi.on("turn_start", async (event, _ctx) => {
		activity.turnIndex = event.turnIndex;
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
		syncActivitySegment();
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		activity.phase = "tool";
		activity.activeTools.set(event.toolCallId, describeToolCall(event.toolName, event.args));
		syncActivitySegment();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activity.activeTools.delete(event.toolCallId);
		activity.phase = activity.activeTools.size > 0 ? "tool" : "thinking";
		syncActivitySegment();
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
	});

	pi.on("message_start", async (event, _ctx) => {
		if ((event.message as any).role === "assistant") {
			activity.phase = activity.activeTools.size > 0 ? "tool" : "streaming";
			syncActivitySegment();
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinner();
		activity.phase = "idle";
		activity.activeTools.clear();
		statusRow?.remove(ACTIVITY_SEGMENT);
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);

		const diffStats = await getGitDiffStats(ctx.cwd);
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
		statsCacheBranchLen.value = -1;
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
	});

	pi.on("session_switch", async (_event, ctx) => {
		// editor component persists across session switches, just update stats
		branchUnsub?.();
		branchUnsub = null;
		gitBranch = null;
		stopSpinner();
		activity.phase = "idle";
		activity.activeTools.clear();
		statusRow?.clear();
		statsCacheBranchLen.value = -1;
		if (editor) updateStatsLabels(editor, pi, ctx, statsCacheBranchLen);
	});
}
