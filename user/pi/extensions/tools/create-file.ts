/**
 * create_file tool — replaces pi's built-in write with enhanced file creation.
 *
 * differences from pi's built-in:
 * - mutex-locked per file path (prevents concurrent writes)
 * - file change tracking for undo_edit via lib/file-tracker
 * - captures before-content when overwriting existing files
 *
 * shadows pi's built-in `write` tool via same-name registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants, resolveToAbsolute } from "./read";
import { boxRendererWindowed, textSection, osc8Link, type Excerpt } from "./lib/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
	{ focus: "head" as const, context: 3 },
	{ focus: "tail" as const, context: 5 },
];

export function createCreateFileTool(): ToolDefinition {
	return {
		name: "write",
		label: "Create File",
		description:
			"Create or overwrite a file in the workspace.\n\n" +
			"Use this tool to create a **new file** that does not yet exist.\n\n" +
			"For **existing files**, prefer the edit tool instead — even for extensive changes. " +
			"Only use this tool to overwrite an existing file when you are replacing nearly all " +
			"of its content AND the file is small (under ~250 lines).\n\n" +
			"Automatically creates parent directories if they don't exist.",

		parameters: Type.Object({
			path: Type.String({
				description: "The absolute path of the file to be created (must be absolute, not relative).",
			}),
			content: Type.String({
				description: "The content for the file.",
			}),
		}),

		renderCall(args: any, theme: any) {
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			const linked = filePath.startsWith("/") ? osc8Link(`file://${filePath}`, shortened) : shortened;
			return new Text(
				theme.fg("toolTitle", theme.bold("Write ")) + theme.fg("dim", linked),
				0, 0,
			);
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any) {
			const content = result.content?.[0];
			if (!content || content.type !== "text") return new Text("(no output)", 0, 0);
			const header = result.details?.header ?? "output";
			return boxRendererWindowed(
				() => [textSection(header, content.text)],
				{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
			);
		},

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveToAbsolute(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				// capture before-state for undo tracking
				const isNewFile = !fs.existsSync(resolved);
				const beforeContent = isNewFile ? "" : fs.readFileSync(resolved, "utf-8");

				// mkdirp
				const dir = path.dirname(resolved);
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}

				fs.writeFileSync(resolved, params.content, "utf-8");

				// track change for undo_edit
				const sessionId = ctx.sessionManager.getSessionId();
				const diff = simpleDiff(resolved, beforeContent, params.content);
				saveChange(sessionId, toolCallId, {
					uri: `file://${resolved}`,
					before: beforeContent,
					after: params.content,
					diff,
					isNewFile,
					timestamp: Date.now(),
				});

				const lines = params.content.split("\n").length;
				let result = isNewFile
					? `created ${path.basename(resolved)} (${lines} lines)`
					: `overwrote ${path.basename(resolved)} (${lines} lines)`;

				return { content: [{ type: "text" as const, text: result }], details: { header: resolved } } as any;
			});
		},
	};
}
