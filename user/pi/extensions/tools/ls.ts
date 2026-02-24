/**
 * ls tool shadow — redirects to read's directory listing.
 *
 * directory listing is part of Read.
 * pi has a built-in ls tool that models may call by habit. this shadow
 * does the listing (no wasted tool call) but steers the model toward
 * using read for future calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveWithVariants, listDirectory, type ReadLimits } from "./read";
import { osc8Link } from "./lib/box-format";

export function createLsTool(limits: ReadLimits): ToolDefinition {
	return {
		name: "ls",
		label: "List Directory",
		description:
			"List directory contents. Prefer using the read tool instead — it handles both files and directories.",

		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "The absolute path to the directory to list. Defaults to cwd.",
				}),
			),
		}),

		renderCall(args: any, theme: any) {
			const dirPath = args.path || ".";
			const home = os.homedir();
			const shortened = dirPath.startsWith(home) ? `~${dirPath.slice(home.length)}` : dirPath;
			const linked = dirPath.startsWith("/") ? osc8Link(`file://${dirPath}`, shortened) : shortened;
			return new Text(
				theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("dim", linked),
				0, 0,
			);
		},

		renderResult(result: any, _opts: { expanded: boolean }, theme: any) {
			const content = result.content?.[0];
			if (!content || content.type !== "text") return new Text(theme.fg("dim", "(no output)"), 0, 0);
			return new Text(theme.fg("toolOutput", content.text), 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path ?? ctx.cwd, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `directory not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const stat = fs.statSync(resolved);
			if (!stat.isDirectory()) {
				return {
					content: [{ type: "text" as const, text: `not a directory: ${resolved}. use the read tool for files.` }],
					isError: true,
				} as any;
			}

			try {
				let text = listDirectory(resolved, limits.maxDirEntries);

				text += "\n\n(note: prefer the read tool for directory listing — it handles both files and directories.)";

				return { content: [{ type: "text" as const, text }] } as any;
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: err.message }],
					isError: true,
				} as any;
			}
		},
	};
}
