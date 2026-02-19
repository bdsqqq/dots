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
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation, SessionManager } from "@mariozechner/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
	let storedHandoffPrompt: string | null = null;
	let handoffPending = false;
	let parentSessionFile: string | undefined;
	let generating = false;

	/** resolve the dedicated handoff model, fall back to ctx.model */
	function getHandoffModel(ctx: { modelRegistry: { find(p: string, id: string): Model<Api> | undefined }; model: Model<Api> | undefined }): Model<Api> | undefined {
		return ctx.modelRegistry.find(HANDOFF_MODEL.provider, HANDOFF_MODEL.id) ?? ctx.model;
	}

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

		const branch = ctx.sessionManager.getBranch();
		const messages = branch
			.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
			.map((e) => e.message);

		if (messages.length === 0) {
			generating = false;
			return;
		}

		const llmMessages = convertToLlm(messages);
		const conversationText = serializeConversation(llmMessages);
		const sessionId = ctx.sessionManager.getSessionId();

		try {
			const apiKey = await ctx.modelRegistry.getApiKey(handoffModel);
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: buildExtractionPrompt(conversationText, "continue the most specific pending task from the conversation"),
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				handoffModel,
				{ messages: [userMessage], tools: [HANDOFF_TOOL] },
				{ apiKey, toolChoice: "any" },
			);

			if (response.stopReason === "aborted") {
				generating = false;
				return;
			}

			const extraction = extractToolCallArgs(response);
			if (!extraction) {
				generating = false;
				ctx.ui.notify("handoff generation failed: model did not call extraction tool", "error");
				return;
			}

			storedHandoffPrompt = assembleHandoffPrompt(
				sessionId,
				extraction,
				"continue the most specific pending task from the conversation",
			);

			handoffPending = true;
			generating = false;

			ctx.ui.setEditorText("/handoff");
			ctx.ui.setStatus("handoff", `⚡ handoff ready (${Math.round(usage.percent)}%)`);
			pi.events.emit("editor:set-label", {
				key: "handoff",
				text: `⚡ handoff ready (${Math.round(usage.percent)}%)`,
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

				const branch = ctx.sessionManager.getBranch();
				const messages = branch
					.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
					.map((e) => e.message);

				if (messages.length === 0) {
					ctx.ui.notify("no conversation to hand off", "error");
					return;
				}

				const llmMessages = convertToLlm(messages);
				const conversationText = serializeConversation(llmMessages);
				parentSessionFile = ctx.sessionManager.getSessionFile();
				const sessionId = ctx.sessionManager.getSessionId();

				const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `generating handoff prompt (${handoffModel.name})...`);
					loader.onAbort = () => done(null);

					const doGenerate = async () => {
						const apiKey = await ctx.modelRegistry.getApiKey(handoffModel);
						const userMessage: Message = {
							role: "user",
							content: [
								{
									type: "text",
									text: buildExtractionPrompt(conversationText, goal),
								},
							],
							timestamp: Date.now(),
						};

						const response = await complete(
							handoffModel,
							{ messages: [userMessage], tools: [HANDOFF_TOOL] },
							{ apiKey, signal: loader.signal, toolChoice: "any" },
						);

						if (response.stopReason === "aborted") return null;

						const extraction = extractToolCallArgs(response);
						if (!extraction) return null;

						return assembleHandoffPrompt(sessionId, extraction, goal);
					};

					doGenerate()
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
			const edited = await ctx.ui.editor("handoff prompt (edit or save to send)", storedHandoffPrompt);

			if (!edited) {
				ctx.ui.notify("handoff cancelled", "info");
				return;
			}

			const prompt = edited;
			const parent = parentSessionFile;

			// clear state before session switch
			storedHandoffPrompt = null;
			handoffPending = false;
			generating = false;
			ctx.ui.setStatus("handoff", "");
			pi.events.emit("editor:remove-label", { key: "handoff" });

			const switchResult = await ctx.newSession({ parentSession: parent });

			if (switchResult.cancelled) {
				// restore state if user cancels
				storedHandoffPrompt = prompt;
				handoffPending = true;
				ctx.ui.notify("session switch cancelled", "info");
				return;
			}

			// send the handoff prompt as the first message — agent starts immediately
			pi.sendUserMessage(prompt);
		},
	});

	// reset state on manual session switch
	pi.on("session_switch", async (_event, _ctx) => {
		storedHandoffPrompt = null;
		handoffPending = false;
		generating = false;
		pi.events.emit("editor:remove-label", { key: "handoff" });
	});

	// --- read_session tool: read a previous session by ID ---
	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: "Read a previous pi session by ID (partial UUID match). Returns the serialized conversation as markdown.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "Session ID or partial UUID to match against" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const allSessions = await SessionManager.listAll();

			const match = allSessions.find(
				(s) => s.id === params.sessionId || s.id.includes(params.sessionId) || s.path.includes(params.sessionId),
			);

			if (!match) {
				return {
					content: [{ type: "text", text: `no session found matching "${params.sessionId}"` }],
					isError: true,
				};
			}

			const session = SessionManager.open(match.path);
			const branch = session.getBranch();
			const messages = branch
				.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
				.map((e) => e.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: `session ${match.id} exists but has no messages` }],
				};
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const header = `Session: ${match.id}\nCWD: ${match.cwd}\nCreated: ${match.created}\nMessages: ${match.messageCount}\n\n`;

			return {
				content: [{ type: "text", text: header + conversationText }],
			};
		},
	});

	// --- search_sessions tool: search across all sessions ---
	pi.registerTool({
		name: "search_sessions",
		label: "Search Sessions",
		description:
			"Search across all pi sessions by text query. Returns matching session IDs with metadata and preview.",
		parameters: Type.Object({
			query: Type.String({ description: "Text to search for across session conversations" }),
			cwd: Type.Optional(
				Type.String({ description: "Limit search to sessions from this working directory" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default: 10)", default: 10 }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const sessions = params.cwd
				? await SessionManager.list(params.cwd)
				: await SessionManager.listAll();

			const queryLower = params.query.toLowerCase();
			const limit = params.limit ?? 10;

			const matches = sessions
				.filter((s) => s.allMessagesText?.toLowerCase().includes(queryLower))
				.slice(0, limit);

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `no sessions found matching "${params.query}"` }],
				};
			}

			const results = matches.map((s) => {
				const preview = s.firstMessage
					? s.firstMessage.length > 120
						? s.firstMessage.slice(0, 120) + "..."
						: s.firstMessage
					: "(no preview)";

				return [
					`**${s.id}**`,
					`  cwd: ${s.cwd}`,
					`  created: ${s.created}`,
					`  messages: ${s.messageCount}`,
					`  preview: ${preview}`,
				].join("\n");
			});

			const header = `found ${matches.length} session${matches.length > 1 ? "s" : ""} matching "${params.query}":\n\n`;
			return {
				content: [{ type: "text", text: header + results.join("\n\n") }],
			};
		},
	});
}
