/**
 * undo_edit tool — reverts the last edit made to a file.
 *
 * uses lib/file-tracker's disk-based change records to find and
 * revert the most recent non-reverted change for a given file.
 *
 * branch awareness: scans the current session branch (via
 * sessionManager.getBranch()) to extract tool call IDs, then
 * only considers changes from those IDs. this prevents undoing
 * edits from a different conversation branch.
 *
 * mutex-locked to prevent concurrent undo + edit on the same file.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { findLatestChange, revertChange, simpleDiff } from "./lib/file-tracker";
import { withFileLock } from "./lib/mutex";
import { resolveWithVariants } from "./read";

/**
 * extract tool call IDs from the current session branch.
 * session entries with type "message" and role "assistant" contain
 * tool_calls arrays. we collect all tool call IDs so findLatestChange
 * can filter to only branch-visible changes.
 *
 * falls back to empty array if getBranch() isn't available (e.g.,
 * running in a context where session tree access is restricted).
 */
function getActiveToolCallIds(sessionManager: any): string[] {
	try {
		const branch = sessionManager.getBranch?.();
		if (!Array.isArray(branch)) return [];

		const ids: string[] = [];
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg?.role !== "assistant") continue;

			// assistant messages store tool calls in content array
			// or in a tool_calls field depending on provider format
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					if (tc.id) ids.push(tc.id);
				}
			}
			// also check content array for tool_use blocks (anthropic format)
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && block.id) {
						ids.push(block.id);
					}
				}
			}
		}
		return ids;
	} catch {
		return [];
	}
}

export function createUndoEditTool(): ToolDefinition {
	return {
		name: "undo_edit",
		label: "Undo Edit",
		description:
			"Undo the last edit made to a file.\n\n" +
			"This command reverts the most recent edit made to the specified file.\n" +
			"It will restore the file to its state before the last edit was made.\n\n" +
			"Returns a diff showing the changes that were undone.",

		parameters: Type.Object({
			path: Type.String({
				description:
					"The absolute path to the file whose last edit should be undone (must be absolute, not relative).",
			}),
		}),

		renderCall(args: any, theme: any) {
			const filePath = args.path || "...";
			const home = os.homedir();
			const shortened = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
			return new Text(
				theme.fg("toolTitle", theme.bold("Undo ")) + theme.fg("dim", shortened),
				0, 0,
			);
		},

		renderResult(result: any, _opts: { expanded: boolean }, theme: any) {
			const content = result.content?.[0];
			if (!content || content.type !== "text") return new Text(theme.fg("dim", "(no output)"), 0, 0);
			return new Text(theme.fg("toolOutput", content.text), 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			return withFileLock(resolved, async () => {
				const sessionId = ctx.sessionManager.getSessionId();
				const activeIds = getActiveToolCallIds(ctx.sessionManager);

				if (activeIds.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "no edits found to undo (no tool calls in current branch).",
							},
						],
						isError: true,
					} as any;
				}

				const latest = findLatestChange(sessionId, resolved, activeIds);
				if (!latest) {
					return {
						content: [
							{
								type: "text" as const,
								text: `no edits found to undo for ${path.basename(resolved)}.`,
							},
						],
						isError: true,
					} as any;
				}

				const reverted = revertChange(sessionId, latest.toolCallId, latest.change.id);
				if (!reverted) {
					return {
						content: [
							{
								type: "text" as const,
								text: `failed to revert — change may have already been undone.`,
							},
						],
						isError: true,
					} as any;
				}

				// show reverse diff (after → before)
				const diff = simpleDiff(
					path.basename(resolved),
					reverted.after,
					reverted.before,
				);

				let result = diff;
				if (reverted.isNewFile) {
					result += `\n\n(file was created by the reverted edit — file restored to empty)`;
				}

				return { content: [{ type: "text" as const, text: result }] } as any;
			});
		},
	};
}
