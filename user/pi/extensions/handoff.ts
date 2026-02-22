/**
 * handoff extension — replace compaction with LLM-driven context transfer.
 *
 * at ~85% context usage, generates a focused handoff prompt via LLM,
 * stages `/handoff` in the editor. user presses Enter → new session
 * with curated context, agent starts working immediately.
 *
 * manual usage anytime:
 *   /handoff implement this for teams
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 */

import { complete, type Api, type Model, type Message, type Tool, type ToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation, SessionManager } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const HANDOFF_THRESHOLD = 0.85;
const HANDOFF_MODEL = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" } as const;
const MAX_RELEVANT_FILES = 10;

const HANDOFF_TOOL: Tool = {
	name: "create_handoff_context",
	description: "Extract context and select relevant files for handoff to a new session.",
	parameters: Type.Object({
		relevantInformation: Type.String({
			description: `Extract conversation context in first person.

Consider what context would help continue the work.

Extract what's relevant. Adjust length to complexity.

Focus on behavior over implementation details.

Format: plain text with bullets. Use workspace-relative paths.`,
		}),
		relevantFiles: Type.Array(Type.String(), {
			description: `An array of file or directory paths (workspace-relative) that are relevant to accomplishing the goal.

Rules:
- Maximum ${MAX_RELEVANT_FILES} files. Only include the most critical files needed for the task.
- You can include directories if multiple files from that directory are needed.
- Prioritize by importance and relevance. Put the most important files first.
- Return workspace-relative paths (e.g., "user/pi/extensions/handoff.ts").
- Do not use absolute paths or invent files.`,
		}),
	}),
};

function buildExtractionPrompt(conversationText: string, goal: string): string {
	return `${conversationText}

Summarize the conversation for handoff. Write in first person.

Consider what context is needed:
- What did I just do or implement?
- What instructions did I already give you which are still relevant (e.g. follow patterns in the codebase)?
- What files did I already tell you that's important or that I am working on (and should continue working on)?
- Did I provide a plan or spec that should be included?
- What did I already tell you that's important (certain libraries, patterns, constraints, preferences)?
- What important technical details did I discover (APIs, methods, patterns)?
- What caveats, limitations, or open questions did I find?

Extract what's relevant. Adjust length to complexity.

Focus on behavior over implementation details.

Format: plain text with bullets. Use workspace-relative paths.

My request:
${goal}

Use the create_handoff_context tool to extract relevant information and files.`;
}

interface HandoffExtraction {
	relevantInformation: string;
	relevantFiles: string[];
}

function extractToolCallArgs(response: { content: ({ type: string } | ToolCall)[] }): HandoffExtraction | null {
	const toolCall = response.content.find((c): c is ToolCall => c.type === "toolCall" && c.name === "create_handoff_context");
	if (!toolCall) return null;
	const args = toolCall.arguments as Record<string, unknown>;
	return {
		relevantInformation: (args.relevantInformation as string) ?? "",
		relevantFiles: (Array.isArray(args.relevantFiles) ? args.relevantFiles : []).slice(0, MAX_RELEVANT_FILES) as string[],
	};
}

function assembleHandoffPrompt(sessionId: string, extraction: HandoffExtraction, goal: string): string {
	const parts: string[] = [];

	parts.push(`Continuing work from session ${sessionId}. Use read_session to retrieve details if needed.`);

	if (extraction.relevantFiles.length > 0) {
		parts.push(extraction.relevantFiles.map((f) => `@${f}`).join(" "));
	}

	if (extraction.relevantInformation) {
		parts.push(extraction.relevantInformation);
	}

	parts.push(goal);

	return parts.join("\n\n");
}

const PROVENANCE_PREFIX = "↳ handed off from: ";
const PROVENANCE_ELLIPSIS = "…";

/** get a short description from a parent session file for provenance display */
function getParentDescription(parentPath: string, maxWidth: number): string {
	const budget = maxWidth - PROVENANCE_PREFIX.length - PROVENANCE_ELLIPSIS.length;
	try {
		const session = SessionManager.open(parentPath);
		const branch = session.getBranch();
		const firstUser = branch.find(
			(e): e is SessionEntry & { type: "message" } => e.type === "message" && e.message.role === "user",
		);
		if (firstUser) {
			const text = firstUser.message.content
				?.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ")
				.trim();
			if (text) return text.length > budget ? text.slice(0, Math.max(0, budget)) + PROVENANCE_ELLIPSIS : text;
		}
		// fallback: session id from header
		const header = session.getHeader();
		return header?.id?.slice(0, 8) ?? parentPath.split("/").pop() ?? "unknown";
	} catch {
		return parentPath.split("/").pop() ?? "unknown";
	}
}

function showProvenance(ctx: ExtensionContext, parentPath: string): void {
	ctx.ui.setWidget("handoff-provenance", (_tui, _theme) => ({
		render(width: number): string[] {
			const desc = getParentDescription(parentPath, width - 1); // -1 for leading space
			return [truncateToWidth(` ${PROVENANCE_PREFIX}${desc}`, width)];
		},
		invalidate() {},
	}));
}

export default function (pi: ExtensionAPI) {
	let storedHandoffPrompt: string | null = null;
	let handoffPending = false;
	let parentSessionFile: string | undefined;
	let generating = false;

	/** resolve the dedicated handoff model, fall back to ctx.model */
	function getHandoffModel(ctx: { modelRegistry: { find(p: string, id: string): Model<Api> | undefined }; model: Model<Api> | undefined }): Model<Api> | undefined {
		return ctx.modelRegistry.find(HANDOFF_MODEL.provider, HANDOFF_MODEL.id) ?? ctx.model;
	}

	/** generate a handoff prompt from conversation + goal via haiku extraction */
	async function generateHandoffPrompt(
		ctx: { sessionManager: any; modelRegistry: any },
		handoffModel: Model<Api>,
		goal: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		const branch = ctx.sessionManager.getBranch();
		const messages = branch
			.filter((e: any): e is SessionEntry & { type: "message" } => e.type === "message")
			.map((e: any) => e.message);

		if (messages.length === 0) return null;

		const llmMessages = convertToLlm(messages);
		const conversationText = serializeConversation(llmMessages);
		const sessionId = ctx.sessionManager.getSessionId();

		const apiKey = await ctx.modelRegistry.getApiKey(handoffModel);
		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: buildExtractionPrompt(conversationText, goal) }],
			timestamp: Date.now(),
		};

		const response = await complete(
			handoffModel,
			{ messages: [userMessage], tools: [HANDOFF_TOOL] },
			{ apiKey, signal, toolChoice: "any" },
		);

		if (response.stopReason === "aborted") return null;

		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "API request failed");
		}

		const extraction = extractToolCallArgs(response);
		if (!extraction) return null;

		return assembleHandoffPrompt(sessionId, extraction, goal);
	}

	/** switch to a new session and send the handoff prompt */
	async function executeHandoff(prompt: string, parent: string | undefined, ctx: any): Promise<boolean> {
		storedHandoffPrompt = null;
		handoffPending = false;
		generating = false;
		ctx.ui?.setStatus?.("handoff", "");
		pi.events.emit("editor:remove-label", { key: "handoff" });

		const switchResult = await ctx.newSession({ parentSession: parent });
		if (switchResult.cancelled) return false;

		if (parent) showProvenance(ctx, parent);

		pi.sendUserMessage(prompt);
		return true;
	}

	// --- provenance: show "handed off from" when session has a parent ---
	pi.on("session_start", async (_event, ctx) => {
		const parentPath = ctx.sessionManager.getHeader()?.parentSession;
		if (parentPath) showProvenance(ctx, parentPath);
	});

	// --- always cancel compaction. we handoff instead. ---
	pi.on("session_before_compact", async (_event, _ctx) => {
		return { cancel: true };
	});

	// --- monitor context after each agent turn ---
	pi.on("agent_end", async (_event, ctx) => {
		if (handoffPending || generating) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null) return;
		if (usage.percent < HANDOFF_THRESHOLD * 100) return;
		const handoffModel = getHandoffModel(ctx);
		if (!handoffModel) return;

		generating = true;
		parentSessionFile = ctx.sessionManager.getSessionFile();

		try {
			const prompt = await generateHandoffPrompt(
				ctx,
				handoffModel,
				"continue the most specific pending task from the conversation",
			);

			if (!prompt) {
				generating = false;
				ctx.ui.notify("handoff generation failed: no extraction result", "error");
				return;
			}

			storedHandoffPrompt = prompt;
			handoffPending = true;
			generating = false;

			ctx.ui.setEditorText("/handoff");
			ctx.ui.setStatus("handoff", `handoff ready (${Math.round(usage.percent)}%)`);
			pi.events.emit("editor:set-label", {
				key: "handoff",
				text: `handoff ready (${Math.round(usage.percent)}%)`,
				position: "top",
				align: "right",
			});
			ctx.ui.notify(
				`context at ${Math.round(usage.percent)}% — handoff prompt generated. press enter to continue in a new session.`,
				"warning",
			);
		} catch (err) {
			generating = false;
			ctx.ui.notify(`handoff generation failed: ${err}`, "error");
		}
	});

	// --- /handoff command: create new session + send prompt ---
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session (replaces compaction)",
		handler: async (args, ctx) => {
			const goal = args.trim();

			// manual invocation with a goal — generate fresh handoff
			if (goal && !handoffPending) {
				const handoffModel = getHandoffModel(ctx);
				if (!handoffModel) {
					ctx.ui.notify("no model available for handoff", "error");
					return;
				}

				parentSessionFile = ctx.sessionManager.getSessionFile();

				const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `generating handoff prompt (${handoffModel.name})...`);
					loader.onAbort = () => done(null);

					generateHandoffPrompt(ctx, handoffModel, goal, loader.signal)
						.then(done)
						.catch((err) => {
							console.error("handoff generation failed:", err);
							done(null);
						});

					return loader;
				});

				if (!result) {
					ctx.ui.notify("cancelled", "info");
					return;
				}

				storedHandoffPrompt = result;
			}

			if (!storedHandoffPrompt) {
				ctx.ui.notify("no handoff prompt available. usage: /handoff <goal>", "error");
				return;
			}

			// let user review/edit the handoff prompt before sending
			const edited = await ctx.ui.editor("handoff prompt — ⏎ to handoff ␛ to cancel", storedHandoffPrompt);

			if (!edited) {
				ctx.ui.notify("handoff cancelled", "info");
				return;
			}

			const prompt = edited;
			const parent = parentSessionFile;

			const switched = await executeHandoff(prompt, parent, ctx);
			if (!switched) {
				// restore state if user cancels
				storedHandoffPrompt = prompt;
				handoffPending = true;
				ctx.ui.notify("session switch cancelled", "info");
			}
		},
	});

	// reset state on manual session switch
	pi.on("session_switch", async (_event, ctx) => {
		storedHandoffPrompt = null;
		handoffPending = false;
		generating = false;
		pi.events.emit("editor:remove-label", { key: "handoff" });
		ctx.ui.setWidget("handoff-provenance", undefined);
	});

	// --- handoff tool: agent-invokable session transfer ---
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Hand off to a new session. Generates a handoff prompt from the current conversation and stages /handoff in the editor. The user presses Enter to review the prompt, then confirms to switch sessions.",
		parameters: Type.Object({
			goal: Type.String({
				description: "What should be accomplished in the new session. Be specific about the next task.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const handoffModel = getHandoffModel(ctx);
			if (!handoffModel) {
				return {
					content: [{ type: "text", text: "no model available for handoff extraction" }],
					isError: true,
				};
			}

			parentSessionFile = ctx.sessionManager.getSessionFile();

			const prompt = await generateHandoffPrompt(ctx, handoffModel, params.goal, signal ?? undefined);
			if (!prompt) {
				return {
					content: [{ type: "text", text: "handoff generation failed: could not extract context" }],
					isError: true,
				};
			}

			storedHandoffPrompt = prompt;
			handoffPending = true;

			ctx.ui.setEditorText("/handoff");
			ctx.ui.setStatus("handoff", "handoff ready");
			pi.events.emit("editor:set-label", {
				key: "handoff",
				text: "handoff ready",
				position: "top",
				align: "right",
			});

			return {
				content: [{ type: "text", text: `handoff prompt generated for: "${params.goal}". staged /handoff — press Enter to continue in a new session.` }],
			};
		},
	});

}
