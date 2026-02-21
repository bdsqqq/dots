/**
 * grep tool — replaces pi's built-in with custom limits.
 *
 * differences from pi's built-in:
 * - per-file match limit (10, prevents one noisy file from consuming quota)
 * - 200-char line truncation (vs pi's 500)
 * - caseSensitive param (custom — default case-sensitive)
 * - suggests literal:true when pattern contains regex metacharacters
 * - spawns rg directly (no ensureTool — nix provides rg on PATH)
 * - no context lines param (amp doesn't expose this)
 *
 * shadows pi's built-in `grep` tool via same-name registration.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_TOTAL_MATCHES = 100;
const MAX_PER_FILE = 10;
const MAX_LINE_CHARS = 200;

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return line.slice(0, MAX_LINE_CHARS) + "...";
}

function looksLikeRegex(pattern: string): boolean {
	return /[{}()\[\]|\\+*?^$]/.test(pattern);
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
				const args = ["--json", "--line-number", "--color=never", "--hidden"];

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
				const perFileCount = new Map<string, number>();
				const outputLines: string[] = [];

				const onAbort = () => {
					aborted = true;
					if (!child.killed) child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					if (!line.trim() || totalMatches >= MAX_TOTAL_MATCHES) return;

					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					if (event.type !== "match") return;

					const filePath: string | undefined = event.data?.path?.text;
					const lineNumber: number | undefined = event.data?.line_number;
					const lineText: string = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
					if (!filePath || typeof lineNumber !== "number") return;

					// per-file limit
					const fileCount = perFileCount.get(filePath) ?? 0;
					if (fileCount >= MAX_PER_FILE) return;
					perFileCount.set(filePath, fileCount + 1);

					totalMatches++;

					const rel = path.relative(searchPath, filePath).replace(/\\/g, "/");
					const displayPath = rel && !rel.startsWith("..") ? rel : path.basename(filePath);
					outputLines.push(`${displayPath}:${lineNumber}: ${truncateLine(lineText)}`);

					if (totalMatches >= MAX_TOTAL_MATCHES) {
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

					// code 1 = no matches, code 0 = matches found, anything else = error
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

					let output = outputLines.join("\n");
					const notices: string[] = [];

					if (killedDueToLimit) {
						notices.push(`${MAX_TOTAL_MATCHES} match limit reached — refine pattern for more`);
					}

					const filesAtLimit = Array.from(perFileCount.values()).filter((c) => c >= MAX_PER_FILE).length;
					if (filesAtLimit > 0) {
						notices.push(
							`${filesAtLimit} file${filesAtLimit > 1 ? "s" : ""} hit the ${MAX_PER_FILE}-per-file limit`,
						);
					}

					if (notices.length > 0) {
						output += `\n\n[${notices.join(". ")}]`;
					}

					resolve({ content: [{ type: "text" as const, text: output }] } as any);
				});
			});
		},
	};
}
