/**
 * finder tool — fast parallel code search via gemini flash sub-agent.
 *
 * replaces the generic subagent(agent: "finder", task: ...) pattern
 * with a dedicated tool. the model calls
 * finder(query: "...") instead of routing through the dispatcher.
 *
 * spawns `pi --mode json` with gemini flash, constrained to
 * read-only tools (read, grep, find, ls, glob). the finder agent
 * maximizes parallelism (8+ tool calls per turn) and completes
 * within ~3 turns.
 *
 * system prompt loaded from sops-decrypted prompts at init time
 * 
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "./lib/pi-spawn";
import { getFinalOutput, renderAgentTree, type SingleResult } from "./lib/sub-agent-render";

const MODEL = "openrouter/google/gemini-3-flash-preview";
const BUILTIN_TOOLS = ["read", "grep", "find", "ls"];
const EXTENSION_TOOLS = ["read", "grep", "glob", "ls"];

export interface FinderConfig {
	systemPrompt?: string;
}

export function createFinderTool(config: FinderConfig = {}): ToolDefinition {
	return {
		name: "finder",
		label: "Finder",
		description:
			"Intelligently search your codebase: Use it for complex, multi-step search tasks " +
			"where you need to find code based on functionality or concepts rather than exact matches. " +
			"Anytime you want to chain multiple grep calls you should use this tool.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- You must locate code by behavior or concept\n" +
			"- You need to run multiple greps in sequence\n" +
			"- You must correlate or look for connection between several areas of the codebase\n" +
			"- You must filter broad terms by context\n" +
			"- You need answers to questions like \"Where do we validate JWT headers?\"\n\n" +
			"WHEN NOT TO USE THIS TOOL:\n" +
			"- When you know the exact file path - use Read directly\n" +
			"- When looking for specific symbols or exact strings - use glob or Grep\n" +
			"- When you need to create, modify files, or run terminal commands\n\n" +
			"USAGE GUIDELINES:\n" +
			"1. Always spawn multiple search agents in parallel to maximise speed.\n" +
			"2. Formulate your query as a precise engineering request.\n" +
			"3. Name concrete artifacts, patterns, or APIs to narrow scope.\n" +
			"4. State explicit success criteria so the agent knows when to stop.\n" +
			"5. Never issue vague or exploratory commands.",

		parameters: Type.Object({
			query: Type.String({
				description:
					"The search query describing what to find. Be specific and include " +
					"technical terms, file types, or expected code patterns.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch { /* graceful */ }

			const singleResult: SingleResult = {
				agent: "finder",
				task: params.query,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: params.query,
				model: MODEL,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				systemPromptBody: config.systemPrompt,
				signal,
				sessionId,
				onUpdate: (partial) => {
					singleResult.messages = partial.messages;
					singleResult.usage = partial.usage;
					singleResult.model = partial.model;
					singleResult.stopReason = partial.stopReason;
					singleResult.errorMessage = partial.errorMessage;
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(searching...)" }],
							details: singleResult,
						} as any);
					}
				},
			});

			singleResult.exitCode = result.exitCode;
			singleResult.messages = result.messages;
			singleResult.usage = result.usage;
			singleResult.model = result.model;
			singleResult.stopReason = result.stopReason;
			singleResult.errorMessage = result.errorMessage;

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			const output = getFinalOutput(result.messages) || "(no output)";

			if (isError) {
				return {
					content: [{ type: "text" as const, text: result.errorMessage || result.stderr || output }],
					details: singleResult,
					isError: true,
				} as any;
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details: singleResult,
			} as any;
		},

		renderCall(args: any, theme: any) {
			const preview = args.query
				? (args.query.length > 80 ? `${args.query.slice(0, 80)}...` : args.query)
				: "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("finder ")) + theme.fg("dim", preview),
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			const container = new Container();
			renderAgentTree(details, container, expanded, theme, "finder");
			return container;
		},
	};
}
