/**
 * code_review tool — structured diff review via gemini sub-agent.
 *
 * spawns a gemini-2.5-pro sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files for context
 * 3. produces XML <codeReview> report with per-comment severity/type
 *
 * review system prompt defines the expert reviewer role. report format
 * is injected as a follow-up message after exploration via piSpawn's
 * RPC mode — follow-up injection after exploration completes.
 *
 * v1: main review agent only. checks system (parallel workspace-defined
 * .md checks via haiku) deferred.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, readAgentPrompt, zeroUsage } from "./lib/pi-spawn";
import { getFinalOutput, renderAgentTree, type SingleResult } from "./lib/sub-agent-render";

const MODEL = "openrouter/google/gemini-2.5-pro";

/** sub-agent needs bash (git diff), read/grep/glob (context), web tools (docs lookup) */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const EXTENSION_TOOLS = ["read", "grep", "glob", "ls", "bash", "web_search", "read_web_page"];

const SYSTEM_PROMPT_FILE = "prompt.amp.code-review-system.md";
const REPORT_FORMAT_FILE = "prompt.amp.code-review-report.md";

/** fallback if sops prompt files aren't available */
const DEFAULT_SYSTEM_PROMPT = `You are an expert code reviewer. Review the provided diff for bugs, security issues, and code quality. Report findings with file locations and severity.

Today's date: {date}
Current working directory (cwd): {cwd}`;

const DEFAULT_REPORT_FORMAT = `Emit findings as XML: <codeReview><comment> elements with filename, startLine, endLine, severity (critical/high/medium/low), commentType (bug/suggested_edit/compliment/non_actionable), text, why, and fix fields.`;

// --- XML parsing ---

interface ReviewComment {
	filename: string;
	startLine: number;
	endLine: number;
	severity: string;
	commentType: string;
	text: string;
	why: string;
	fix: string;
}

function parseReviewXml(output: string): ReviewComment[] {
	const comments: ReviewComment[] = [];
	const commentRegex = /<comment>([\s\S]*?)<\/comment>/g;
	let match: RegExpExecArray | null;

	while ((match = commentRegex.exec(output)) !== null) {
		const block = match[1];
		const get = (tag: string): string => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1].trim() : "";
		};
		comments.push({
			filename: get("filename"),
			startLine: parseInt(get("startLine"), 10) || 0,
			endLine: parseInt(get("endLine"), 10) || 0,
			severity: get("severity"),
			commentType: get("commentType"),
			text: get("text"),
			why: get("why"),
			fix: get("fix"),
		});
	}
	return comments;
}

function formatReviewSummary(comments: ReviewComment[]): string {
	if (comments.length === 0) return "";

	const bySeverity: Record<string, number> = {};
	for (const c of comments) {
		bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
	}

	const severityOrder = ["critical", "high", "medium", "low"];
	const parts = severityOrder
		.filter((s) => bySeverity[s])
		.map((s) => `${bySeverity[s]} ${s}`);

	return `${comments.length} comment${comments.length !== 1 ? "s" : ""}: ${parts.join(", ")}`;
}

// --- tool ---

export function createCodeReviewTool(): ToolDefinition {
	return {
		name: "code_review",
		label: "Code Review",
		description:
			"Review code changes, diffs, outstanding changes, or modified files. " +
			"Use when asked to review changes, check code quality, analyze uncommitted work, " +
			"or perform a code review.\n\n" +
			"It takes in a description of the diff or code change that can be used to generate " +
			"the full diff, which is then reviewed. When using this tool, do not invoke `git diff` " +
			"or any other tool to generate the diff but just pass a natural language description " +
			"of how to compute the diff in the diff_description argument.",

		parameters: Type.Object({
			diff_description: Type.String({
				description:
					"A description of the diff or code change that can be used to generate the full diff. " +
					"This can include a git or bash command to generate the diff or a description of the diff " +
					"which can then be used to generate the git or bash command to generate the full diff.",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Specific files to focus the review on. If empty, all changed files covered " +
						"by the diff description are reviewed.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					description: "Additional instructions to guide the review agent.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch {}

			// compose task prompt
			const parts: string[] = [];
			parts.push(`Review the following diff:\n${params.diff_description}`);

			if (params.files && params.files.length > 0) {
				parts.push(`\nFocus the review on these files:\n${params.files.join("\n")}`);
			}
			if (params.instructions) {
				parts.push(`\nAdditional review instructions:\n${params.instructions}`);
			}

			const fullTask = parts.join("\n");

			const singleResult: SingleResult = {
				agent: "code_review",
				task: params.diff_description,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const systemPrompt = readAgentPrompt(SYSTEM_PROMPT_FILE) || DEFAULT_SYSTEM_PROMPT;
			const reportFormat = readAgentPrompt(REPORT_FORMAT_FILE) || DEFAULT_REPORT_FORMAT;

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: fullTask,
				model: MODEL,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				systemPromptBody: systemPrompt,
				followUp: reportFormat,
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
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(reviewing...)" }],
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
			const desc = args.diff_description || "...";
			const preview = desc.length > 70 ? `${desc.slice(0, 70)}...` : desc;
			let text = theme.fg("toolTitle", theme.bold("code_review ")) + theme.fg("dim", preview);
			if (args.files?.length) {
				text += theme.fg("muted", ` (${args.files.length} file${args.files.length > 1 ? "s" : ""})`);
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

			// parse XML comments from output for summary line
			const output = getFinalOutput(details.messages);
			const comments = parseReviewXml(output);
			if (comments.length > 0) {
				const summary = formatReviewSummary(comments);
				container.addChild(
					new Text(theme.fg("accent", summary), 0, 0),
				);
			}

			renderAgentTree(details, container, expanded, theme, "code_review");
			return container;
		},
	};
}
