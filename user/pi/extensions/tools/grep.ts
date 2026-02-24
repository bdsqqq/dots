/**
 * grep tool — replaces pi's built-in with tighter limits and context lines.
 *
 * differences from pi's built-in:
 * - per-file match limit (10, prevents one noisy file from consuming quota)
 * - 200-char line truncation (vs pi's 500)
 * - caseSensitive param (default case-sensitive)
 * - suggests literal:true when pattern contains regex metacharacters
 * - spawns rg directly (no ensureTool — nix provides rg on PATH)
 * - includes ±1 context lines around matches (via rg --context) so
 *   the LLM sees surrounding code and show() has natural gaps to elide
 *
 * shadows pi's built-in `grep` tool via same-name registration.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { headTail } from "./lib/output-buffer";
import { formatBoxes, type BoxSection, type BoxLine } from "./lib/box-format";

const MAX_TOTAL_MATCHES = 100;
const MAX_COLLECT_MATCHES = 200;
const MAX_PER_FILE = 10;
const MAX_LINE_CHARS = 200;
const RG_CONTEXT_LINES = 1;
/** max files shown in collapsed display */
const COLLAPSED_MAX_FILES = 3;
/** max match groups per file in collapsed display */
const COLLAPSED_MAX_BLOCKS = 1;

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return line.slice(0, MAX_LINE_CHARS) + "...";
}

function looksLikeRegex(pattern: string): boolean {
	return /[{}()\[\]|\\+*?^$]/.test(pattern);
}

// --- structured data for visual rendering ---

interface GrepMatch {
	lineNum: number;
	text: string;
	isContext: boolean;
}

interface GrepFile {
	path: string;
	matches: GrepMatch[];
	hitLimit: boolean;
}

/**
 * convert GrepFile[] to BoxSection[] for box-format rendering.
 * each file becomes a section, contiguous match groups become blocks.
 */
function grepToSections(files: GrepFile[]): BoxSection[] {
	return files.map((f) => {
		const blocks: { lines: BoxLine[] }[] = [];
		let current: BoxLine[] = [];
		let lastLineNum = -2;

		for (const m of f.matches) {
			// gap > 1 line means new block
			if (lastLineNum >= 0 && m.lineNum > lastLineNum + 1) {
				if (current.length > 0) {
					blocks.push({ lines: current });
					current = [];
				}
			}
			current.push({
				gutter: String(m.lineNum),
				text: m.text,
				highlight: !m.isContext,
			});
			lastLineNum = m.lineNum;
		}
		if (current.length > 0) blocks.push({ lines: current });

		return {
			header: f.path + (f.hitLimit ? ` [${MAX_PER_FILE} match limit]` : ""),
			blocks,
		};
	});
}

interface RgEvent {
	kind: "match" | "context";
	filePath: string;
	lineNumber: number;
	lineText: string;
}

export function createGrepTool(): ToolDefinition {
	return {
		name: "grep",
		label: "Grep",
		description:
			"Search for exact text patterns in files using ripgrep, a fast keyword search tool.\n\n" +
			"# When to use\n" +
			"- Finding exact text matches (variable names, function calls, specific strings)\n\n" +
			"# Constraints\n" +
			`- Results are limited to ${MAX_TOTAL_MATCHES} matches (up to ${MAX_PER_FILE} per file)\n` +
			`- Lines are truncated at ${MAX_LINE_CHARS} characters\n\n` +
			"# Strategy\n" +
			"- Use 'path' or 'glob' to narrow searches; run multiple focused calls rather than one broad search\n" +
			"- Uses Rust-style regex (escape `{` and `}`); use `literal: true` for literal text search\n",

		parameters: Type.Object({
			pattern: Type.String({
				description: "The pattern to search for (regex by default).",
			}),
			path: Type.Optional(
				Type.String({
					description: "The file or directory path to search in. Cannot be used with glob.",
				}),
			),
			glob: Type.Optional(
				Type.String({
					description: "The glob pattern to filter files (e.g., '**/*.ts'). Cannot be used with path.",
				}),
			),
			caseSensitive: Type.Optional(
				Type.Boolean({
					description: "Whether to search case-sensitively (default: true).",
				}),
			),
			literal: Type.Optional(
				Type.Boolean({
					description: "Whether to treat the pattern as a literal string instead of a regex.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = params.path
				? path.isAbsolute(params.path)
					? params.path
					: path.resolve(ctx.cwd, params.path)
				: ctx.cwd;

			return new Promise((resolve) => {
				const args = [
					"--json", "--line-number", "--color=never", "--hidden",
					"--context", String(RG_CONTEXT_LINES),
				];

				if (params.caseSensitive === false) {
					args.push("--ignore-case");
				}
				if (params.literal) {
					args.push("--fixed-strings");
				}
				if (params.glob) {
					args.push("--glob", params.glob);
				}

				args.push("--", params.pattern, searchPath);

				const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout! });

				let stderr = "";
				let totalMatches = 0;
				let killedDueToLimit = false;
				let aborted = false;
				/** all match + context events, in stream order */
				const events: RgEvent[] = [];

				const onAbort = () => {
					aborted = true;
					if (!child.killed) child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					if (!line.trim() || killedDueToLimit) return;

					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type !== "match" && event.type !== "context") return;

					const filePath: string | undefined = event.data?.path?.text;
					const lineNumber: number | undefined = event.data?.line_number;
					const lineText: string = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
					if (!filePath || typeof lineNumber !== "number") return;

					if (event.type === "match") {
						totalMatches++;
					}

					events.push({
						kind: event.type as "match" | "context",
						filePath,
						lineNumber,
						lineText,
					});

					if (totalMatches >= MAX_COLLECT_MATCHES) {
						killedDueToLimit = true;
						if (!child.killed) child.kill();
					}
				});

				child.on("error", (err) => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
					resolve({
						content: [{ type: "text" as const, text: `grep error: ${err.message}` }],
						isError: true,
					} as any);
				});

				child.on("close", (code) => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);

					if (aborted) {
						resolve({
							content: [{ type: "text" as const, text: "search aborted" }],
							isError: true,
						} as any);
						return;
					}

					if (!killedDueToLimit && code !== 0 && code !== 1) {
						resolve({
							content: [{ type: "text" as const, text: stderr.trim() || `ripgrep exited with code ${code}` }],
							isError: true,
						} as any);
						return;
					}

					if (totalMatches === 0) {
						let text = "no matches found";
						if (!params.literal && looksLikeRegex(params.pattern)) {
							text += "\n\n(pattern contains regex characters — try literal: true if searching for exact text)";
						}
						resolve({ content: [{ type: "text" as const, text }] } as any);
						return;
					}

					// --- phase 2: build output from collected events ---

					// group events by file, preserving order
					const fileOrder: string[] = [];
					const fileEvents = new Map<string, RgEvent[]>();
					for (const ev of events) {
						if (!fileEvents.has(ev.filePath)) {
							fileOrder.push(ev.filePath);
							fileEvents.set(ev.filePath, []);
						}
						fileEvents.get(ev.filePath)!.push(ev);
					}

					const outputLines: string[] = [];
					/** output line indices that are actual matches (not context) */
					const matchLineIndices: number[] = [];
					/** index of first match line per file — focus points for collapsed display */
					const firstMatchPerFile: number[] = [];
					const perFileMatchCount = new Map<string, number>();
					const fileGroups: GrepFile[] = [];

					for (let fi = 0; fi < fileOrder.length; fi++) {
						const filePath = fileOrder[fi];
						const fileEvts = fileEvents.get(filePath)!;

						// determine which matches to include (per-file limit)
						const includedMatchLines = new Set<number>();
						let matchesInFile = 0;
						for (const ev of fileEvts) {
							if (ev.kind === "match") {
								matchesInFile++;
								if (matchesInFile <= MAX_PER_FILE) {
									includedMatchLines.add(ev.lineNumber);
								}
							}
						}
						perFileMatchCount.set(filePath, Math.min(matchesInFile, MAX_PER_FILE));

						// include context lines only if adjacent to an included match
						const includedLines = new Set<number>();
						for (const ln of includedMatchLines) {
							includedLines.add(ln);
							// include context lines within RG_CONTEXT_LINES distance
							for (let d = 1; d <= RG_CONTEXT_LINES; d++) {
								includedLines.add(ln - d);
								includedLines.add(ln + d);
							}
						}

						// blank separator between file groups
						if (fi > 0) {
							outputLines.push("");
						}

						const rel = path.relative(searchPath, filePath).replace(/\\/g, "/");
						const displayPath = rel && !rel.startsWith("..") ? rel : path.basename(filePath);

						const grepFile: GrepFile = {
							path: displayPath,
							matches: [],
							hitLimit: matchesInFile > MAX_PER_FILE,
						};

						let lastOutputLineNum = -Infinity;
						let isFirstMatchInFile = true;

						for (const ev of fileEvts) {
							if (!includedLines.has(ev.lineNumber)) continue;
							// deduplicate (rg can emit same line as both context for
							// adjacent matches — we only want it once)
							if (ev.lineNumber <= lastOutputLineNum) continue;

							// insert "--" separator for non-contiguous groups within file
							// (gap > 1 means there's a break in line numbers)
							if (lastOutputLineNum >= 0 && ev.lineNumber > lastOutputLineNum + 1) {
								outputLines.push("--");
							}

							const idx = outputLines.length;
							outputLines.push(`${displayPath}:${ev.lineNumber}: ${truncateLine(ev.lineText)}`);
							lastOutputLineNum = ev.lineNumber;

							grepFile.matches.push({
								lineNum: ev.lineNumber,
								text: truncateLine(ev.lineText),
								isContext: ev.kind === "context",
							});

							if (includedMatchLines.has(ev.lineNumber)) {
								matchLineIndices.push(idx);
								if (isFirstMatchInFile) {
									firstMatchPerFile.push(idx);
									isFirstMatchInFile = false;
								}
							}
						}
						fileGroups.push(grepFile);
					}

					// apply head+tail if over display limit
					let output: string;
					const notices: string[] = [];
					let finalMatchIndices: number[];

					if (outputLines.length > MAX_TOTAL_MATCHES * 3) {
						// with context lines, the threshold is higher
						const limit = MAX_TOTAL_MATCHES * 2;
						const { head, tail, truncatedCount } = headTail(outputLines, limit);
						output = [
							...head,
							"",
							`... [${truncatedCount} lines truncated] ...`,
							"",
							...tail,
						].join("\n");
						// remap match indices into the truncated output
						const headLen = head.length;
						const gapLen = 3; // blank + marker + blank
						const tailStart = outputLines.length - tail.length;
						finalMatchIndices = matchLineIndices
							.map((i) => {
								if (i < headLen) return i;
								if (i >= tailStart) return headLen + gapLen + (i - tailStart);
								return -1; // truncated
							})
							.filter((i) => i >= 0);
						notices.push(`${truncatedCount} lines truncated, showing first and last ${limit / 2}`);
					} else {
						output = outputLines.join("\n");
						finalMatchIndices = matchLineIndices;
					}

					if (killedDueToLimit) {
						notices.push(`stopped at ${MAX_COLLECT_MATCHES} matches — refine pattern`);
					}

					const filesAtLimit = Array.from(perFileMatchCount.values()).filter((c) => c >= MAX_PER_FILE).length;
					if (filesAtLimit > 0) {
						notices.push(
							`${filesAtLimit} file${filesAtLimit > 1 ? "s" : ""} hit the ${MAX_PER_FILE}-per-file limit`,
						);
					}

					if (notices.length > 0) {
						output += `\n\n[${notices.join(". ")}]`;
					}

					resolve({
						content: [{ type: "text" as const, text: output }],
						details: { fileGroups, notices, matchLineIndices: finalMatchIndices, firstMatchPerFile },
					} as any);
				});
			});
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
			const fileGroups: GrepFile[] | undefined = result.details?.fileGroups;
			const notices: string[] = result.details?.notices ?? [];

			// fallback for old results or error results without fileGroups
			if (!fileGroups?.length) {
				const text = result.content?.[0]?.text ?? "(no output)";
				return new Text(text, 0, 0);
			}

			const sections = grepToSections(fileGroups);

			let cachedWidth: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedLines: string[] | undefined;

			return {
				render(width: number): string[] {
					if (cachedLines !== undefined && cachedExpanded === expanded && cachedWidth === width) {
						return cachedLines;
					}
					const visual = formatBoxes(
						sections,
						expanded
							? {}
							: { maxSections: COLLAPSED_MAX_FILES, maxBlocks: COLLAPSED_MAX_BLOCKS },
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
		},
	};
}
