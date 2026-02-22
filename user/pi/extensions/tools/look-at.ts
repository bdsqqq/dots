/**
 * look_at tool — multimodal file analysis via gemini flash sub-agent.
 *
 * hooks into pi's existing read tool pipeline: the sub-agent calls
 * read(path) which returns images as base64 content parts. gemini
 * sees the image and analyzes it per the user's objective.
 *
 * for text files, the sub-agent reads and summarizes/extracts per
 * objective — useful when you need analyzed data, not raw contents.
 *
 * supports reference files for comparison (e.g., before/after
 * screenshots, two versions of a diagram).
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "./lib/pi-spawn";
import { getFinalOutput, renderAgentTree, tagCost, type SingleResult } from "./lib/sub-agent-render";

const MODEL = "openrouter/google/gemini-3-flash-preview";

/** read tool (for file access) + ls (for context if needed) */
const BUILTIN_TOOLS = ["read", "ls"];
const EXTENSION_TOOLS = ["read", "ls"];

const DEFAULT_SYSTEM_PROMPT = `Analyze the provided file and answer the user's question about it. Be concise and direct, reference specific locations. When comparing files, systematically identify differences.`;

export interface LookAtConfig {
	systemPrompt?: string;
}

export function createLookAtTool(config: LookAtConfig = {}): ToolDefinition {
	return {
		name: "look_at",
		label: "Look At",
		description:
			"Extract specific information from a local file (including images and other media).\n\n" +
			"Use this tool when you need to extract or summarize information from a file " +
			"without getting the literal contents. Always provide a clear objective.\n\n" +
			"Pass reference files when you need to compare two or more things.\n\n" +
			"## When to use this tool\n\n" +
			"- Analyzing images that the Read tool cannot interpret\n" +
			"- Extracting specific information or summaries from documents\n" +
			"- Describing visual content in images or diagrams\n" +
			"- When you only need analyzed/extracted data, not raw file contents\n\n" +
			"## When NOT to use this tool\n\n" +
			"- For source code or plain text files where you need exact contents — use Read instead\n" +
			"- When you need to edit the file afterward (you need literal content from Read)\n" +
			"- For simple file reading where no interpretation is needed",

		parameters: Type.Object({
			path: Type.String({
				description: "Workspace-relative or absolute path to the file to analyze.",
			}),
			objective: Type.String({
				description: "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).",
			}),
			context: Type.String({
				description: "The broader goal and context for the analysis.",
			}),
			referenceFiles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional list of paths to reference files for comparison.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch {}

			// build the task prompt: read file(s), then analyze
			const parts: string[] = [];

			parts.push(`Read the file at "${params.path}" using the read tool.`);

			if (params.referenceFiles && params.referenceFiles.length > 0) {
				for (const ref of params.referenceFiles) {
					parts.push(`Also read the reference file at "${ref}".`);
				}
			}

			parts.push("");
			parts.push(`Context: ${params.context}`);
			parts.push("");
			parts.push(`Analyze with this objective: ${params.objective}`);

			if (params.referenceFiles && params.referenceFiles.length > 0) {
				parts.push("");
				parts.push("Compare the main file against the reference file(s). Identify all differences and similarities.");
			}

			const fullTask = parts.join("\n");

			const singleResult: SingleResult = {
				agent: "look_at",
				task: params.objective,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: fullTask,
				model: MODEL,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				systemPromptBody: systemPrompt,
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
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(analyzing...)" }],
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
					content: [{ type: "text" as const, text: tagCost(result.errorMessage || result.stderr || output, singleResult.usage.cost) }],
					details: singleResult,
					isError: true,
				} as any;
			}

			return {
				content: [{ type: "text" as const, text: tagCost(output, singleResult.usage.cost) }],
				details: singleResult,
			} as any;
		},

		renderCall(args: any, theme: any) {
			const path = args.path || "...";
			const objective = args.objective
				? (args.objective.length > 60 ? `${args.objective.slice(0, 60)}...` : args.objective)
				: "";
			let text = theme.fg("toolTitle", theme.bold("look_at ")) + theme.fg("dim", path);
			if (objective) text += theme.fg("muted", ` — ${objective}`);
			if (args.referenceFiles?.length) {
				text += theme.fg("muted", ` (+${args.referenceFiles.length} ref${args.referenceFiles.length > 1 ? "s" : ""})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			const container = new Container();
			renderAgentTree(details, container, expanded, theme, "look_at");
			return container;
		},
	};
}
