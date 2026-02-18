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

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const HANDOFF_THRESHOLD = 0.85;

const SYSTEM_PROMPT = `You are a context transfer assistant. Analyze a conversation and produce a self-contained prompt for a new session.

The new session agent has ZERO context. Your output is the ONLY thing it will see. Be specific — names, paths, decisions, constraints. Never be generic.

Rules:
- Extract CONCRETE state: what exists, what was built, what was decided, what was rejected and why.
- Include user preferences and conventions observed in the conversation (coding style, voice, tool preferences, verification steps).
- List SPECIFIC files with their roles, not just paths.
- Identify the EXACT next task. If the user provided a goal, use it. If not, infer the most specific pending work from the conversation — never say "continue the work" or "focus on recent tasks."
- Include any commands needed for verification or setup.
- Reference the previous session ID so the new agent can use read_thread if needed.

Output the prompt directly. No preamble, no wrapper.

Format:

Continuing work from session {session_id}. Use read_thread to retrieve details if needed.

@file/references — one per relevant file

- [bullet list of concrete state: what exists, what was decided, key constraints]
- [user preferences observed]
- [what was tried and rejected, with reasons]

Next: [specific, actionable task with enough detail to execute without asking questions]`;

export default function (pi: ExtensionAPI) {
	let storedHandoffPrompt: string | null = null;
	let handoffPending = false;
	let parentSessionFile: string | undefined;
	let generating = false;

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
		if (!ctx.model) return;

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
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## Session ID\n\n${sessionId}\n\n## Instructions\n\nAnalyze this conversation and generate a handoff prompt. Infer the most specific pending task from the conversation — what was the user working toward that isn't finished yet? Be concrete.`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey },
			);

			if (response.stopReason === "aborted") {
				generating = false;
				return;
			}

			storedHandoffPrompt = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			handoffPending = true;
			generating = false;

			ctx.ui.setEditorText("/handoff");
			ctx.ui.setStatus("handoff", `⚡ handoff ready (${Math.round(usage.percent)}%)`);
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
				if (!ctx.model) {
					ctx.ui.notify("no model selected", "error");
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
					const loader = new BorderedLoader(tui, theme, "generating handoff prompt...");
					loader.onAbort = () => done(null);

					const doGenerate = async () => {
						const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);
						const userMessage: Message = {
							role: "user",
							content: [
								{
									type: "text",
									text: `## Conversation History\n\n${conversationText}\n\n## Session ID\n\n${sessionId}\n\n## User's Goal for New Session\n\n${goal}`,
								},
							],
							timestamp: Date.now(),
						};

						const response = await complete(
							ctx.model!,
							{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
							{ apiKey, signal: loader.signal },
						);

						if (response.stopReason === "aborted") return null;

						return response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
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

			const prompt = storedHandoffPrompt;
			const parent = parentSessionFile;

			// clear state before session switch
			storedHandoffPrompt = null;
			handoffPending = false;
			generating = false;
			ctx.ui.setStatus("handoff", "");

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
	});
}
