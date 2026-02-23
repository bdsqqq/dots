/**
 * edit tool — replaces pi's built-in with enhanced file editing.
 *
 * differences from pi's built-in:
 * - mutex-locked per file path (prevents partial writes from concurrent edits)
 * - replace_all mode for multiple occurrences
 * - escape sequence fallback (\n, \t when exact match fails)
 * - AGENTS.md discovery post-write
 * - redaction check (rejects edits introducing placeholder markers)
 * - file change tracking for undo_edit via lib/file-tracker
 * - BOM/CRLF preservation
 *
 * shadows pi's built-in `edit` tool via same-name registration.
 * uses model-compatible parameter names (old_str, new_str, replace_all)
 * rather than pi's (oldText, newText) — models produce these param
 * names naturally.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { makeShowRenderer } from "./lib/show-renderer";
import { Type } from "@sinclair/typebox";
import { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
import { generateDiffString } from "./lib/diff";
import { saveChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";

// --- BOM / CRLF ---

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// --- escape handling ---

/**
 * LLMs sometimes emit literal \n / \t in JSON strings when they mean
 * actual whitespace. the JSON parser produces backslash + letter, not
 * a real newline. this function converts those back.
 */
function unescapeStr(s: string): string {
	return s
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\\\/g, "\\");
}

// --- fuzzy matching ---

/**
 * trailing whitespace + unicode normalization.
 * mirrors pi's edit-diff.ts normalizeForFuzzyMatch so we get the same
 * fallback behavior the model is used to from the built-in tool.
 */
function normalizeForFuzzy(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface MatchStrategy {
	/** string to search for in `content` */
	searchStr: string;
	/** string to substitute into `content` */
	replaceStr: string;
	/** content variant that was matched (may be fuzzy-normalized) */
	content: string;
	/** character index of first match in `content` */
	index: number;
	matchLength: number;
}

/**
 * 3-tier matching: exact → unescaped → fuzzy-normalized.
 * returns the content variant + effective search/replace strings so the
 * caller can apply the replacement in the correct text space.
 */
function findMatchStrategy(
	content: string,
	oldStr: string,
	newStr: string,
): MatchStrategy | null {
	// tier 1: exact
	let idx = content.indexOf(oldStr);
	if (idx !== -1) {
		return { searchStr: oldStr, replaceStr: newStr, content, index: idx, matchLength: oldStr.length };
	}

	// tier 2: unescape \n, \t etc.
	const unescOld = unescapeStr(oldStr);
	const unescNew = unescapeStr(newStr);
	if (unescOld !== oldStr) {
		idx = content.indexOf(unescOld);
		if (idx !== -1) {
			return { searchStr: unescOld, replaceStr: unescNew, content, index: idx, matchLength: unescOld.length };
		}
	}

	// tier 3: fuzzy normalization (trailing whitespace + unicode)
	const fuzzyContent = normalizeForFuzzy(content);
	const fuzzyOld = normalizeForFuzzy(oldStr);
	idx = fuzzyContent.indexOf(fuzzyOld);
	if (idx !== -1) {
		return {
			searchStr: fuzzyOld,
			replaceStr: newStr,
			content: fuzzyContent,
			index: idx,
			matchLength: fuzzyOld.length,
		};
	}

	return null;
}

function countOccurrences(content: string, searchStr: string): number {
	if (searchStr.length === 0) return 0;
	let count = 0;
	let pos = 0;
	while ((pos = content.indexOf(searchStr, pos)) !== -1) {
		count++;
		pos += searchStr.length;
	}
	return count;
}

// --- redaction check ---

/**
 * patterns that indicate the LLM replaced real content with a placeholder.
 * checked against new_str only when the pattern is absent from old_str
 * (so legitimate test strings containing these phrases pass through).
 */
const REDACTION_PATTERNS = [
	/\[REDACTED\]/i,
	/\[\.\.\.omitted.*?\]/i,
	/\[rest of .{1,40} unchanged\]/i,
	/\[remaining .{1,40} unchanged\]/i,
	/\/\/ \.\.\.( rest| remaining)? (of )?(the )?(file|code|content|implementation)( remains?)? (unchanged|the same|as before|omitted)/i,
	/\/\/ \.\.\. existing (code|content|implementation)/i,
	/# \.\.\. existing (code|content|implementation)/i,
];

function hasNewRedactionMarkers(oldStr: string, newStr: string): string | null {
	for (const pattern of REDACTION_PATTERNS) {
		if (pattern.test(newStr) && !pattern.test(oldStr)) {
			const match = newStr.match(pattern);
			return match?.[0] ?? "redaction marker";
		}
	}
	return null;
}

// --- tool factory ---

export function createEditFileTool(): ToolDefinition {
	return {
		name: "edit",
		label: "Edit File",
		description:
			"Make edits to a text file.\n\n" +
			"Replaces `old_str` with `new_str` in the given file.\n\n" +
			"Returns a diff showing the changes made.\n\n" +
			"The file specified by `path` MUST exist.\n\n" +
			"`old_str` MUST exist in the file.\n\n" +
			"`old_str` and `new_str` MUST be different from each other.\n\n" +
			"Set `replace_all` to true to replace all occurrences of `old_str` in the file. " +
			"Otherwise, `old_str` MUST be unique within the file or the edit will fail. " +
			"Additional lines of context can be added to make the string more unique.\n\n" +
			"When changing an existing file, use this tool. Only use the write tool for files that do not exist yet.",

		parameters: Type.Object({
			path: Type.String({
				description: "The absolute path to the file (MUST be absolute, not relative). File must exist.",
			}),
			old_str: Type.String({
				description: "Text to search for. Must match exactly.",
			}),
			new_str: Type.String({
				description: "Text to replace old_str with.",
			}),
			replace_all: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to replace all occurrences of old_str. Otherwise, old_str must be unique.",
					default: false,
				}),
			),
		}),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `file not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) {
				return {
					content: [{ type: "text" as const, text: `${resolved} is a directory, not a file.` }],
					isError: true,
				} as any;
			}

			const redactionMarker = hasNewRedactionMarkers(params.old_str, params.new_str);
			if (redactionMarker) {
				return {
					content: [
						{
							type: "text" as const,
							text: `rejected: new_str contains a redaction marker ("${redactionMarker}"). provide the actual content instead of placeholders.`,
						},
					],
					isError: true,
				} as any;
			}

			return withFileLock(resolved, async () => {
				const rawContent = fs.readFileSync(resolved, "utf-8");
				const { bom, text: bomStripped } = stripBom(rawContent);
				const originalEnding = detectLineEnding(bomStripped);
				const normalized = normalizeToLF(bomStripped);
				const oldStr = normalizeToLF(params.old_str);
				const newStr = normalizeToLF(params.new_str);

				if (oldStr === newStr) {
					return {
						content: [{ type: "text" as const, text: "old_str and new_str are identical. no changes needed." }],
						isError: true,
					} as any;
				}

				const strategy = findMatchStrategy(normalized, oldStr, newStr);
				if (!strategy) {
					return {
						content: [
							{
								type: "text" as const,
								text: `could not find old_str in ${path.basename(resolved)}. the text must match exactly including whitespace and newlines.`,
							},
						],
						isError: true,
					} as any;
				}

				const occurrences = countOccurrences(strategy.content, strategy.searchStr);
				const replaceAll = params.replace_all ?? false;

				if (!replaceAll && occurrences > 1) {
					return {
						content: [
							{
								type: "text" as const,
								text: `found ${occurrences} occurrences of old_str in ${path.basename(resolved)}. set replace_all to true, or add more context to make the match unique.`,
							},
						],
						isError: true,
					} as any;
				}

				// perform replacement in the matched content space
				let newContent: string;
				if (replaceAll) {
					newContent = strategy.content.split(strategy.searchStr).join(strategy.replaceStr);
				} else {
					newContent =
						strategy.content.substring(0, strategy.index) +
						strategy.replaceStr +
						strategy.content.substring(strategy.index + strategy.matchLength);
				}

				if (strategy.content === newContent) {
					return {
						content: [{ type: "text" as const, text: "no changes made — replacement produced identical content." }],
						isError: true,
					} as any;
				}

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				fs.writeFileSync(resolved, finalContent, "utf-8");

				// track change for undo_edit
				const sessionId = ctx.sessionManager.getSessionId();
				const trackingDiff = simpleDiff(resolved, rawContent, finalContent);
				saveChange(sessionId, toolCallId, {
					uri: `file://${resolved}`,
					before: rawContent,
					after: finalContent,
					diff: trackingDiff,
					isNewFile: false,
					timestamp: Date.now(),
				});

				// build result
				const diffResult = generateDiffString(strategy.content, newContent);
				let text = diffResult.diff;

				if (replaceAll && occurrences > 1) {
					text += `\n\n(replaced ${occurrences} occurrences)`;
				}

				const guidanceText = formatGuidance(discoverAgentsMd(resolved, ctx.cwd));
				if (guidanceText) text += "\n\n" + guidanceText;

				return {
					content: [{ type: "text" as const, text }],
					details: {
						diff: diffResult.diff,
						firstChangedLine: diffResult.firstChangedLine,
					},
				} as any;
			});
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
			const text = result.content?.[0];
			if (text?.type !== "text") return new Text("(no output)", 0, 0);
			const diff: string = text.text;
			if (expanded) return new Text(diff, 0, 0);

			// collapsed: focus on the changed region. firstChangedLine is the
			// first diff output line (0-indexed) containing a +/- hunk line.
			// ±4 context shows the surrounding diff header + a few lines of change.
			const firstChangedLine: number | undefined = result.details?.firstChangedLine;
			if (firstChangedLine == null) return makeShowRenderer(diff, [{ focus: "head", context: 8 }]);
			return makeShowRenderer(diff, [{ focus: firstChangedLine, context: 4 }]);
		},
	};
}
