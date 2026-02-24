/**
 * grep tool — replaces pi's built-in with tighter limits and diagnostic-style output.
 *
 * differences from pi's built-in:
 * - per-file match limit (10, prevents one noisy file from consuming quota)
 * - 200-char line truncation (vs pi's 500)
 * - caseSensitive param (default case-sensitive)
 * - suggests literal:true when pattern contains regex metacharacters
 * - spawns rg directly (no ensureTool — nix provides rg on PATH)
 * - includes ±1 context lines around matches (via rg --context)
 * - renderResult shows miette/ariadne-style box-drawing format with
 *   muted chrome instead of flat file:line: lines. match lines get
 *   base-color line numbers; context lines stay fully dim.
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

interface Submatch {
	start: number;
	end: number;
}

interface RgEvent {
	kind: "match" | "context";
	filePath: string;
	lineNumber: number;
	lineText: string;
	submatches: Submatch[];
}

interface GrepLine {
	num: number;
	text: string;
	isMatch: boolean;
	submatches: Submatch[];
}

interface GrepBlock {
	lines: GrepLine[];
}

interface GrepFile {
	path: string;
	matchCount: number;
	blocks: GrepBlock[];
}

/**
 * build the diagnostic-style visual output from structured file groups.
 *
 * format:
 *   ╭─[path/to/file.ts]
 *    21 │ context line (all dim)
 *    22 │ match line (base-color line number, dim │)
 *    23 │ context line (all dim)
 *       ·
 *   100 │ another match group
 *   ╰────
 *
 * box-drawing chars and context gutter are DIM. match lines get
 * base-color line numbers so they pop against dim context.
 */
function formatGrepVisual(
	files: GrepFile[],
	opts: { maxFiles: number; maxBlocks: number },
	notices: string[],
): string {
	const shownFiles = files.slice(0, opts.maxFiles);
	const lines: string[] = [];

	for (let fi = 0; fi < shownFiles.length; fi++) {
		const file = shownFiles[fi];
		const shownBlocks = file.blocks.slice(0, opts.maxBlocks);

		// gutter width from max line number across shown blocks
		const maxLineNum = Math.max(
			...shownBlocks.flatMap((b) => b.lines.map((l) => l.num)),
		);
		const gw = maxLineNum.toString().length;
		const pad = " ".repeat(gw);

		// blank line between file boxes (not before first)
		if (fi > 0) lines.push("");

		// header
		lines.push(`${DIM}╭─[${RST}${file.path}${DIM}]${RST}`);

		for (let bi = 0; bi < shownBlocks.length; bi++) {
			// elision dot between non-contiguous blocks
			if (bi > 0) {
				lines.push(`${DIM}${pad} ·${RST}`);
			}

			for (const line of shownBlocks[bi].lines) {
				const num = line.num.toString().padStart(gw);
				if (line.isMatch) {
					// match line: base-color number, dim separator, base-color content
					lines.push(`${num} ${DIM}│${RST} ${truncateLine(line.text)}`);
				} else {
					// context line: everything dim
					lines.push(`${DIM}${num} │ ${truncateLine(line.text)}${RST}`);
				}
			}
		}

		// show elision if blocks were truncated
		if (file.blocks.length > opts.maxBlocks) {
			const remaining = file.blocks.length - opts.maxBlocks;
			lines.push(`${DIM}${pad} · ··· ${remaining} more ${remaining === 1 ? "group" : "groups"}${RST}`);
		}

		// footer
		lines.push(`${DIM}╰${"─".repeat(4)}${RST}`);
	}

	// remaining files count
	if (files.length > opts.maxFiles) {
		const remaining = files.length - opts.maxFiles;
		lines.push(`${DIM}… ${remaining} more ${remaining === 1 ? "file" : "files"}${RST}`);
	}

	if (notices.length) {
		lines.push("");
		lines.push(`${DIM}[${notices.join(". ")}]${RST}`);
	}

	return lines.join("\n");
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

					const submatches: Submatch[] = event.type === "match"
						? (event.data?.submatches ?? []).map((s: any) => ({
							start: s.start as number,
							end: s.end as number,
						}))
						: [];

					if (event.type === "match") {
						totalMatches++;
					}

					events.push({
						kind: event.type as "match" | "context",
						filePath,
						lineNumber,
						lineText,
						submatches,
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

					// --- phase 2: build structured data from collected events ---

					const fileOrder: string[] = [];
					const fileEventsMap = new Map<string, RgEvent[]>();
					for (const ev of events) {
						if (!fileEventsMap.has(ev.filePath)) {
							fileOrder.push(ev.filePath);
							fileEventsMap.set(ev.filePath, []);
						}
						fileEventsMap.get(ev.filePath)!.push(ev);
					}

					const fileGroups: GrepFile[] = [];
					const outputLines: string[] = []; // plain format for LLM
					const perFileMatchCount = new Map<string, number>();

					for (let fi = 0; fi < fileOrder.length; fi++) {
						const filePath = fileOrder[fi];
						const fileEvts = fileEventsMap.get(filePath)!;

						// per-file limit: determine which matches to include
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

						// include context lines adjacent to included matches
						const includedLines = new Set<number>();
						for (const ln of includedMatchLines) {
							includedLines.add(ln);
							for (let d = 1; d <= RG_CONTEXT_LINES; d++) {
								includedLines.add(ln - d);
								includedLines.add(ln + d);
							}
						}

						const rel = path.relative(searchPath, filePath).replace(/\\/g, "/");
						const displayPath = rel && !rel.startsWith("..") ? rel : path.basename(filePath);

						// build blocks (contiguous groups of lines)
						const blocks: GrepBlock[] = [];
						let currentBlock: GrepLine[] = [];
						let lastLineNum = -Infinity;

						// blank separator in plain output between file groups
						if (fi > 0) outputLines.push("");

						for (const ev of fileEvts) {
							if (!includedLines.has(ev.lineNumber)) continue;
							if (ev.lineNumber <= lastLineNum) continue; // dedup

							// non-contiguous gap → new block
							if (lastLineNum >= 0 && ev.lineNumber > lastLineNum + 1) {
								if (currentBlock.length) {
									blocks.push({ lines: currentBlock });
									currentBlock = [];
								}
								outputLines.push("--"); // plain format separator
							}

							const grepLine: GrepLine = {
								num: ev.lineNumber,
								text: ev.lineText,
								isMatch: includedMatchLines.has(ev.lineNumber),
								submatches: ev.submatches,
							};
							currentBlock.push(grepLine);
							lastLineNum = ev.lineNumber;

							// plain format for LLM
							outputLines.push(`${displayPath}:${ev.lineNumber}: ${truncateLine(ev.lineText)}`);
						}
						if (currentBlock.length) {
							blocks.push({ lines: currentBlock });
						}

						fileGroups.push({
							path: displayPath,
							matchCount: Math.min(matchesInFile, MAX_PER_FILE),
							blocks,
						});
					}

					// plain output for LLM (with head+tail if too large)
					let output: string;
					const notices: string[] = [];

					if (outputLines.length > MAX_TOTAL_MATCHES * 3) {
						const limit = MAX_TOTAL_MATCHES * 2;
						const { head, tail, truncatedCount } = headTail(outputLines, limit);
						output = [
							...head,
							"",
							`... [${truncatedCount} lines truncated] ...`,
							"",
							...tail,
						].join("\n");
						notices.push(`${truncatedCount} lines truncated`);
					} else {
						output = outputLines.join("\n");
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
						details: { fileGroups, notices },
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

			// cache by expanded state to avoid rebuilding every frame
			let cachedExpanded: boolean | undefined;
			let cachedLines: string[] | undefined;

			return {
				render(_width: number): string[] {
					if (cachedLines !== undefined && cachedExpanded === expanded) {
						return cachedLines;
					}
					const visual = formatGrepVisual(
						fileGroups,
						expanded
							? { maxFiles: fileGroups.length, maxBlocks: Infinity }
							: { maxFiles: COLLAPSED_MAX_FILES, maxBlocks: COLLAPSED_MAX_BLOCKS },
						notices,
					);
					cachedLines = visual.split("\n");
					cachedExpanded = expanded;
					return cachedLines;
				},
				invalidate() {
					cachedLines = undefined;
					cachedExpanded = undefined;
				},
			};
		},
	};
}
