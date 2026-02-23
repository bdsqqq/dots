/**
 * glob tool — replaces pi's built-in find with enhanced file finding.
 *
 * differences from pi's built-in:
 * - uses rg --files (not fd — one less dependency)
 * - sorted by mtime (most recent first, via rg --sortr modified)
 * - pagination via offset + limit
 * - hidden files included by default (--hidden)
 * - .git/.jj excluded
 *
 * shadows pi's built-in `find` tool via same-name registration.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatHeadTail } from "./lib/output-buffer";

const DEFAULT_LIMIT = 500;

export function createGlobTool(): ToolDefinition {
	return {
		name: "find",
		label: "Find Files",
		description:
			"Fast file pattern matching tool that works with any codebase size.\n\n" +
			"Returns matching file paths sorted by most recent modification time first.\n\n" +
			"## Pattern syntax\n" +
			"- `**/*.js` — All JavaScript files in any directory\n" +
			"- `src/**/*.ts` — TypeScript files under src/\n" +
			"- `*.json` — JSON files in the current directory\n" +
			"- `**/*test*` — Files with \"test\" in their name\n" +
			"- `**/*.{js,ts}` — JavaScript and TypeScript files\n",

		parameters: Type.Object({
			filePattern: Type.String({
				description: 'Glob pattern like "**/*.js" or "src/**/*.ts" to match files.',
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return.",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Number of results to skip (for pagination).",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = ctx.cwd;
			const limit = params.limit ?? DEFAULT_LIMIT;
			const offset = params.offset ?? 0;

			return new Promise((resolve) => {
				const args = [
					"--files",
					"--hidden",
					"--color=never",
					"--sortr",
					"modified",
					"--glob",
					"!.git",
					"--glob",
					"!.jj",
					"--glob",
					params.filePattern,
					searchPath,
				];

				const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout! });

				let stderr = "";
				let aborted = false;
				const allPaths: string[] = [];

				const onAbort = () => {
					aborted = true;
					if (!child.killed) child.kill();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				rl.on("line", (line) => {
					const trimmed = line.trim();
					if (!trimmed) return;
					const rel = path.relative(searchPath, trimmed).replace(/\\/g, "/");
					if (rel && !rel.startsWith("..")) {
						allPaths.push(rel);
					}
				});

				child.on("error", (err) => {
					rl.close();
					signal?.removeEventListener("abort", onAbort);
					resolve({
						content: [{ type: "text" as const, text: `find error: ${err.message}` }],
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

					if (code !== 0 && code !== 1 && allPaths.length === 0) {
						resolve({
							content: [{ type: "text" as const, text: stderr.trim() || `rg exited with code ${code}` }],
							isError: true,
						} as any);
						return;
					}

					if (allPaths.length === 0) {
						resolve({
							content: [{ type: "text" as const, text: "no files found matching pattern" }],
						} as any);
						return;
					}

					const total = allPaths.length;

					// if paginating (offset > 0), use traditional pagination
					// otherwise use head+tail for first page
					let output: string;
					if (offset > 0) {
						const paginated = allPaths.slice(offset, offset + limit);
						output = paginated.join("\n");
						output += `\n\n(showing ${offset + 1}-${offset + paginated.length} of ${total} results)`;
					} else if (total > limit) {
						output = formatHeadTail(allPaths, limit, (n) =>
							`... [${n} more results, use a more specific pattern to narrow] ...`);
						output += `\n\n(${total} total results)`;
					} else {
						output = allPaths.join("\n");
					}

					resolve({ content: [{ type: "text" as const, text: output }] } as any);
				});
			});
		},
	};
}
