/**
 * format_file tool — runs a code formatter on a file.
 *
 * tries formatters in order: prettier, biome. uses whichever is
 * available on PATH (nix provides these). captures before/after
 * diff and tracks the change for undo_edit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";

type Formatter = { name: string; args: (file: string) => string[] };

const FORMATTERS: Formatter[] = [
	{
		name: "prettier",
		args: (file) => ["--write", "--log-level", "silent", file],
	},
	{
		name: "biome",
		args: (file) => ["format", "--write", file],
	},
];

function findFormatter(): Formatter | null {
	for (const fmt of FORMATTERS) {
		const result = spawnSync("which", [fmt.name], { encoding: "utf-8", timeout: 3000 });
		if (result.status === 0) return fmt;
	}
	return null;
}

export function createFormatFileTool(): ToolDefinition {
	return {
		name: "format_file",
		label: "Format File",
		description: "Run a code formatter (prettier or biome) on a file.",

		parameters: Type.Object({
			path: Type.String({
				description: "The absolute path to the file to format.",
			}),
		}),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `file not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const formatter = findFormatter();
			if (!formatter) {
				return {
					content: [
						{
							type: "text" as const,
							text: "no formatter found. install prettier or biome.",
						},
					],
					isError: true,
				} as any;
			}

			return withFileLock(resolved, async () => {
				const before = fs.readFileSync(resolved, "utf-8");

				const result = spawnSync(formatter.name, formatter.args(resolved), {
					encoding: "utf-8",
					timeout: 30_000,
					cwd: ctx.cwd,
				});

				if (result.status !== 0) {
					const err = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
					return {
						content: [{ type: "text" as const, text: `${formatter.name} failed: ${err}` }],
						isError: true,
					} as any;
				}

				const after = fs.readFileSync(resolved, "utf-8");

				if (before === after) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${path.basename(resolved)} is already formatted.`,
							},
						],
					} as any;
				}

				// track for undo_edit
				const sessionId = ctx.sessionManager.getSessionId();
				const diff = simpleDiff(resolved, before, after);
				saveChange(sessionId, toolCallId, {
					uri: `file://${resolved}`,
					before,
					after,
					diff,
					isNewFile: false,
					timestamp: Date.now(),
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `formatted ${path.basename(resolved)} with ${formatter.name}.\n\n${diff}`,
						},
					],
				} as any;
			});
		},
	};
}
