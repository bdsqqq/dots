/**
 * ls tool shadow — redirects to read's directory listing.
 *
 * directory listing is part of Read.
 * pi has a built-in ls tool that models may call by habit. this shadow
 * does the listing (no wasted tool call) but steers the model toward
 * using read for future calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
import { resolveWithVariants, listDirectory, type ReadLimits } from "./read";

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

				const guidanceText = formatGuidance(discoverAgentsMd(resolved, ctx.cwd));
				if (guidanceText) text += "\n\n" + guidanceText;

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
