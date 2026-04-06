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

import {
  complete,
  type Api,
  type Model,
  type Message,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { registerMentionSource } from "@bds_pi/mentions";
import { resolvePrompt } from "@bds_pi/pi-spawn";
import { createHandoffMentionSource } from "./handoff-mention-source";

type HandoffExtConfig = {
  threshold: number;
  model: { provider: string; id: string };
  promptFile: string;
  promptString: string;
};

const DEFAULT_HANDOFF_PROMPT = String.raw`
# extraction-prompt

Extract relevant context from the conversation above for continuing this work. Write from my perspective (first person: "I did...", "I told you...").

Consider what would be useful to know based on my request below. Questions that might be relevant:
- What did I just do or implement?
- What instructions did I already give you which are still relevant (e.g. follow patterns in the codebase)?
- What files did I already tell you that's important or that I am working on (and should continue working on)?
- Did I provide a plan or spec that should be included?
- What did I already tell you that's important (certain libraries, patterns, constraints, preferences)?
- What important technical details did I discover (APIs, methods, patterns)?
- What caveats, limitations, or open questions did I find?

Extract what matters for the specific request below. Don't answer questions that aren't relevant. Pick an appropriate length based on the complexity of the request.

Focus on capabilities and behavior, not file-by-file changes. Avoid excessive implementation details (variable names, storage keys, constants) unless critical.

Format: Plain text with bullets. No markdown headers, no bold/italic, no code fences. Use workspace-relative paths for files.

My request:

# tool-description

Extract relevant information from the conversation and select relevant files for another agent to continue the work. Use this tool to identify the most important context and files needed.

# field-relevant-information

Extract relevant context from the conversation. Write from first person perspective ("I did...", "I told you...").

Consider what's useful based on the user's request. Questions that might be relevant: What did I just do or implement? What instructions did I already give you which are still relevant (e.g. follow patterns in the codebase)? Did I provide a plan or spec that should be included? What did I already tell you that's important (certain libraries, patterns, constraints, preferences)? What important technical details did I discover (APIs, methods, patterns)? What caveats, limitations, or open questions did I find? What files did I tell you to edit that I should continue working on?

Extract what matters for the specific request. Don't answer questions that aren't relevant. Pick an appropriate length based on the complexity of the request.

Focus on capabilities and behavior, not file-by-file changes. Avoid excessive implementation details (variable names, storage keys, constants) unless critical.

Format: Plain text with bullets. No markdown headers, no bold/italic, no code fences. Use workspace-relative paths.

# field-relevant-files

An array of file or directory paths (workspace-relative) that are relevant to accomplishing the goal.

Rules:
- Maximum 10 files. Only include the most critical files needed for the task.
- You can include directories if multiple files from that directory are needed.
- Prioritize by importance and relevance. Put the most important files first.
- Return workspace-relative paths (e.g., "user/pi/extensions/handoff.ts").
- Do not use absolute paths or invent files.
`;

const CONFIG_DEFAULTS: HandoffExtConfig = {
  threshold: 0.85,
  model: {
    provider: "openrouter",
    id: "google/gemini-3-flash-preview",
  },
  promptFile: "",
  promptString: DEFAULT_HANDOFF_PROMPT,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandoffConfig(
  value: Record<string, unknown>,
): value is HandoffExtConfig {
  const threshold = value.threshold;
  if (typeof threshold !== "number" || threshold <= 0 || threshold > 1) {
    return false;
  }

  if (!isPlainObject(value.model)) {
    return false;
  }

  return (
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0 &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const HANDOFF_CONFIG_SCHEMA: ExtensionConfigSchema<HandoffExtConfig> = {
  validate: isHandoffConfig,
};

const MAX_RELEVANT_FILES = 10;

function parsePromptSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = content.split("\n# ");
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl === -1) continue;
    const name = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    if (name) sections[name] = body;
  }
  return sections;
}

interface HandoffExtraction {
  relevantInformation: string;
  relevantFiles: string[];
}

function extractToolCallArgs(response: {
  content: ({ type: string } | ToolCall)[];
}): HandoffExtraction | null {
  const toolCall = response.content.find(
    (c): c is ToolCall =>
      c.type === "toolCall" &&
      "name" in c &&
      c.name === "create_handoff_context",
  );
  if (!toolCall) return null;
  const args = toolCall.arguments as Record<string, unknown>;
  return {
    relevantInformation: (args.relevantInformation as string) ?? "",
    relevantFiles: (Array.isArray(args.relevantFiles)
      ? args.relevantFiles
      : []
    ).slice(0, MAX_RELEVANT_FILES) as string[],
  };
}

function assembleHandoffPrompt(
  sessionId: string,
  extraction: HandoffExtraction,
  goal: string,
): string {
  const parts: string[] = [];

  parts.push(
    `Continuing work from session ${sessionId}. Use read_session to retrieve details if needed.`,
  );

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

interface HandoffExtensionDeps {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  registerMentionSource: typeof registerMentionSource;
  resolvePrompt: typeof resolvePrompt;
}

const DEFAULT_DEPS: HandoffExtensionDeps = {
  getEnabledExtensionConfig,
  registerMentionSource,
  resolvePrompt,
};

function getParentDescription(parentPath: string, maxWidth: number): string {
  const budget =
    maxWidth - PROVENANCE_PREFIX.length - PROVENANCE_ELLIPSIS.length;
  try {
    const session = SessionManager.open(parentPath);

    const name = session.getSessionName();
    if (name)
      return name.length > budget
        ? name.slice(0, Math.max(0, budget)) + PROVENANCE_ELLIPSIS
        : name;

    const branch = session.getBranch();
    const firstUser = branch.find(
      (e): e is SessionEntry & { type: "message" } =>
        e.type === "message" &&
        "content" in e.message &&
        e.message.role === "user",
    );
    if (firstUser) {
      const content = (firstUser.message as { content: unknown }).content;
      const text = (Array.isArray(content) ? content : [])
        .filter(
          (c): c is { type: "text"; text: string } =>
            typeof c === "object" && c !== null && c.type === "text",
        )
        .map((c) => c.text)
        .join(" ")
        .trim();
      if (text)
        return text.length > budget
          ? text.slice(0, Math.max(0, budget)) + PROVENANCE_ELLIPSIS
          : text;
    }
    const header = session.getHeader();
    return header?.id?.slice(0, 8) ?? parentPath.split("/").pop() ?? "unknown";
  } catch {
    return parentPath.split("/").pop() ?? "unknown";
  }
}

function showProvenance(ctx: ExtensionContext, parentPath: string): void {
  ctx.ui.setWidget("handoff-provenance", (_tui, theme) => ({
    render(width: number): string[] {
      const desc = getParentDescription(parentPath, width);
      const arrow = theme.fg("dim", "↳ ");
      const text = truncateToWidth(
        `${PROVENANCE_PREFIX.slice(2)}${desc}`,
        width,
      );
      const content = arrow + text;
      const contentWidth = visibleWidth(content);
      const pad = Math.max(0, width - contentWidth);
      return [" ".repeat(pad) + content];
    },
    invalidate() {},
  }));
}

function createHandoffExtension(deps: HandoffExtensionDeps = DEFAULT_DEPS) {
  return function handoffExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/handoff",
      CONFIG_DEFAULTS,
      { schema: HANDOFF_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    deps.registerMentionSource(createHandoffMentionSource());

    const handoffSections = parsePromptSections(
      deps.resolvePrompt(cfg.promptString, cfg.promptFile),
    );

    const HANDOFF_TOOL: Tool = {
      name: "create_handoff_context",
      description:
        handoffSections["tool-description"] || "Extract context for handoff",
      parameters: Type.Object({
        relevantInformation: Type.String({
          description:
            handoffSections["field-relevant-information"] ||
            "Extract relevant context",
        }),
        relevantFiles: Type.Array(Type.String(), {
          description:
            handoffSections["field-relevant-files"] || "Relevant file paths",
        }),
      }),
    };

    function buildExtractionPrompt(
      conversationText: string,
      goal: string,
    ): string {
      const body = handoffSections["extraction-prompt"] ?? "";
      return `${conversationText}\n\n${body}\n${goal}\n\nUse the create_handoff_context tool to extract relevant information and files.`;
    }

    let storedHandoffPrompt: string | null = null;
    let handoffPending = false;
    let parentSessionFile: string | undefined;
    let generating = false;

    /** resolve the dedicated handoff model, fall back to ctx.model */
    function getHandoffModel(ctx: {
      modelRegistry: { find(p: string, id: string): Model<Api> | undefined };
      model: Model<Api> | undefined;
    }): Model<Api> | undefined {
      return (
        ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model
      );
    }

    async function generateHandoffPrompt(
      ctx: { sessionManager: any; modelRegistry: any },
      handoffModel: Model<Api>,
      goal: string,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e: any): e is SessionEntry & { type: "message" } =>
            e.type === "message",
        )
        .map((e: any) => e.message);

      if (messages.length === 0) return null;

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const sessionId = ctx.sessionManager.getSessionId();

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(handoffModel);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      if (!auth.apiKey && !auth.headers) {
        throw new Error("missing auth for handoff model");
      }
      const userMessage: Message = {
        role: "user",
        content: [
          { type: "text", text: buildExtractionPrompt(conversationText, goal) },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(
        handoffModel,
        { messages: [userMessage], tools: [HANDOFF_TOOL] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
          toolChoice: "any",
        },
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
    async function executeHandoff(
      prompt: string,
      parent: string | undefined,
      ctx: any,
    ): Promise<boolean> {
      storedHandoffPrompt = null;
      handoffPending = false;
      generating = false;
      ctx.ui?.setStatus?.("handoff", "");
      pi.events.emit("editor:remove-label", { key: "handoff" });

      const switchResult = await ctx.newSession({ parentSession: parent });
      if (switchResult.cancelled) return false;

      if (parent) showProvenance(ctx, parent);

      // pi.sendUserMessage() doesn't work after ctx.newSession() because pi creates
      // a new runtime for each session but the extension still references the old one.
      // Stage the prompt in the editor for manual submission instead (like pi's handoff example).
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Handoff ready. Review the prompt and press Enter to submit.", "info");
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
      if (usage.percent < cfg.threshold * 100) return;
      const handoffModel = getHandoffModel(ctx);
      if (!handoffModel) return;

      generating = true;
      parentSessionFile = ctx.sessionManager.getSessionFile();

      try {
        const prompt = await generateHandoffPrompt(
          ctx,
          handoffModel,
          "continue the most specific pending task from the conversation",
          ctx.signal,
        );

        if (!prompt) {
          generating = false;
          ctx.ui.notify(
            "handoff generation failed: no extraction result",
            "error",
          );
          return;
        }

        storedHandoffPrompt = prompt;
        handoffPending = true;
        generating = false;

        ctx.ui.setEditorText("/handoff");
        ctx.ui.setStatus(
          "handoff",
          `handoff ready (${Math.round(usage.percent)}%)`,
        );
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
        ctx.ui.notify(`handoff generation failed: ${String(err)}`, "error");
      }
    });

    // --- /handoff command: create new session + send prompt ---
    pi.registerCommand("handoff", {
      description:
        "Transfer context to a new focused session (replaces compaction)",
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

          const result = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
              const loader = new BorderedLoader(
                tui,
                theme,
                `generating handoff prompt (${handoffModel.name})...`,
              );
              loader.onAbort = () => done(null);

              generateHandoffPrompt(ctx, handoffModel, goal, loader.signal)
                .then(done)
                .catch((err) => {
                  console.error("handoff generation failed:", err);
                  done(null);
                });

              return loader;
            },
          );

          if (!result) {
            ctx.ui.notify("cancelled", "info");
            return;
          }

          storedHandoffPrompt = result;
        }

        if (!storedHandoffPrompt) {
          ctx.ui.notify(
            "no handoff prompt available. usage: /handoff <goal>",
            "error",
          );
          return;
        }

        // let user review/edit the handoff prompt before sending
        const edited = await ctx.ui.editor(
          "handoff prompt — ⏎ to handoff ␛ to cancel",
          storedHandoffPrompt,
        );

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
    pi.on("session_start", async (event, ctx) => {
      if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
        storedHandoffPrompt = null;
        handoffPending = false;
        generating = false;
        pi.events.emit("editor:remove-label", { key: "handoff" });
        ctx.ui.setWidget("handoff-provenance", undefined);
      }
    });

    // --- handoff tool: agent-invokable session transfer ---
    const handoffTool: ToolDefinition = {
      name: "handoff",
      label: "Handoff",
      description:
        "Hand off to a new session. Generates a handoff prompt from the current conversation and stages /handoff in the editor. The user presses Enter to review the prompt, then confirms to switch sessions.",
      promptSnippet:
        "Hand off to a new session with a generated context transfer prompt",
      promptGuidelines: [
        "Use this when context is getting crowded or the user asks to continue in a fresh session.",
        "Set goal to a specific next task, not a vague continuation.",
      ],
      parameters: Type.Object({
        goal: Type.String({
          description:
            "What should be accomplished in the new session. Be specific about the next task.",
        }),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const p = params as { goal: string };
        const handoffModel = getHandoffModel(_ctx);
        if (!handoffModel) {
          throw new Error("no model available for handoff extraction");
        }

        parentSessionFile = _ctx.sessionManager.getSessionFile();

        const prompt = await generateHandoffPrompt(
          _ctx,
          handoffModel,
          p.goal,
          _signal ?? undefined,
        );
        if (!prompt) {
          throw new Error(
            "handoff generation failed: could not extract context",
          );
        }

        storedHandoffPrompt = prompt;
        handoffPending = true;

        _ctx.ui.setEditorText("/handoff");
        _ctx.ui.setStatus("handoff", "handoff ready");
        pi.events.emit("editor:set-label", {
          key: "handoff",
          text: "handoff ready",
          position: "top",
          align: "right",
        });

        return {
          content: [
            {
              type: "text",
              text: `handoff prompt generated for: "${p.goal}". staged /handoff — press Enter to continue in a new session.`,
            },
          ],
          details: undefined,
        };
      },
    };

    pi.registerTool(handoffTool);
  };
}

const handoffExtension: (pi: ExtensionAPI) => void = createHandoffExtension();

export default handoffExtension;

// Export for testing
export {
  parsePromptSections,
  extractToolCallArgs,
  assembleHandoffPrompt,
  isHandoffConfig,
  isPlainObject,
  getParentDescription,
  showProvenance,
  createHandoffExtension,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  HANDOFF_CONFIG_SCHEMA,
  PROVENANCE_PREFIX,
  PROVENANCE_ELLIPSIS,
};

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  // ============================================================================
  // PURE FUNCTION TESTS
  // ============================================================================
  // These tests verify pure, stateless functions. They run inline via
  // import.meta.vitest for fast feedback during development.
  //
  // For integration tests (extension lifecycle, SDK interactions), see
  // __tests__/handoff.test.ts
  // For headless TUI rendering tests, see __tests__/provenance-widget.test.ts
  // ============================================================================

  describe("parsePromptSections", () => {
    it("extracts named sections from prompt text", () => {
      const result = parsePromptSections("# foo\nbar content\n# baz\nqux content");
      // The first section keeps the # prefix (split doesn't remove it from first part)
      expect(result).toEqual({ "# foo": "bar content", baz: "qux content" });
    });

    it("handles sections with empty bodies", () => {
      const result = parsePromptSections("# empty\n\n# filled\nhas content");
      // The function splits by \n# , so # empty\n becomes one part
      // The name includes the # prefix because split doesn't remove it from the first part
      expect(result).toEqual({ "# empty": "", filled: "has content" });
    });

    it("returns empty object for text without sections", () => {
      const result = parsePromptSections("just some text without headers");
      expect(result).toEqual({});
    });

    it("trims section names and bodies", () => {
      const result = parsePromptSections("#  spaced name  \n  body text  ");
      // The # prefix is kept because split doesn't remove it from the first part
      expect(result).toEqual({ "#  spaced name": "body text" });
    });

    it("handles DEFAULT_HANDOFF_PROMPT structure", () => {
      const result = parsePromptSections(DEFAULT_HANDOFF_PROMPT);
      expect(result).toHaveProperty("extraction-prompt");
      expect(result).toHaveProperty("tool-description");
      expect(result).toHaveProperty("field-relevant-information");
      expect(result).toHaveProperty("field-relevant-files");
    });
  });

  describe("extractToolCallArgs", () => {
    it("extracts arguments from create_handoff_context tool call", () => {
      const response = {
        content: [
          {
            type: "toolCall",
            name: "create_handoff_context",
            arguments: {
              relevantInformation: "We built a feature",
              relevantFiles: ["src/index.ts", "src/utils.ts"],
            },
          },
        ],
      };
      const result = extractToolCallArgs(response);
      expect(result).toEqual({
        relevantInformation: "We built a feature",
        relevantFiles: ["src/index.ts", "src/utils.ts"],
      });
    });

    it("returns null when tool call is missing", () => {
      const response = { content: [{ type: "text", text: "hello" }] };
      expect(extractToolCallArgs(response)).toBeNull();
    });

    it("returns null when tool call has wrong name", () => {
      const response = {
        content: [
          { type: "toolCall", name: "other_tool", arguments: {} },
        ],
      };
      expect(extractToolCallArgs(response)).toBeNull();
    });

    it("limits relevantFiles to MAX_RELEVANT_FILES", () => {
      const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
      const response = {
        content: [
          {
            type: "toolCall",
            name: "create_handoff_context",
            arguments: {
              relevantInformation: "info",
              relevantFiles: manyFiles,
            },
          },
        ],
      };
      const result = extractToolCallArgs(response);
      expect(result?.relevantFiles).toHaveLength(10);
    });

    it("handles missing arguments gracefully", () => {
      const response = {
        content: [
          {
            type: "toolCall",
            name: "create_handoff_context",
            arguments: {},
          },
        ],
      };
      const result = extractToolCallArgs(response);
      expect(result).toEqual({ relevantInformation: "", relevantFiles: [] });
    });

    it("handles non-array relevantFiles", () => {
      const response = {
        content: [
          {
            type: "toolCall",
            name: "create_handoff_context",
            arguments: {
              relevantInformation: "info",
              relevantFiles: "not-an-array",
            },
          },
        ],
      };
      const result = extractToolCallArgs(response);
      expect(result?.relevantFiles).toEqual([]);
    });
  });

  describe("assembleHandoffPrompt", () => {
    it("assembles prompt with all components", () => {
      const extraction = {
        relevantInformation: "We discussed X",
        relevantFiles: ["src/a.ts", "src/b.ts"],
      };
      const result = assembleHandoffPrompt("session-123", extraction, "continue X");

      expect(result).toContain("session-123");
      expect(result).toContain("@src/a.ts @src/b.ts");
      expect(result).toContain("We discussed X");
      expect(result).toContain("continue X");
    });

    it("handles empty relevantFiles", () => {
      const extraction = { relevantInformation: "info", relevantFiles: [] };
      const result = assembleHandoffPrompt("session-123", extraction, "goal");

      expect(result).not.toContain("@");
    });

    it("handles empty relevantInformation", () => {
      const extraction = { relevantInformation: "", relevantFiles: ["a.ts"] };
      const result = assembleHandoffPrompt("session-123", extraction, "goal");

      expect(result).toContain("@a.ts");
      expect(result).toContain("goal");
    });

    it("always includes session reference", () => {
      const extraction = { relevantInformation: "", relevantFiles: [] };
      const result = assembleHandoffPrompt("abc123", extraction, "goal");

      expect(result).toContain("abc123");
      expect(result).toContain("read_session");
    });
  });

  describe("isPlainObject", () => {
    it("returns true for plain objects", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it("returns false for non-objects", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject("string")).toBe(false);
      expect(isPlainObject(123)).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
    });
  });

  describe("isHandoffConfig", () => {
    it("validates correct config", () => {
      const config = {
        threshold: 0.85,
        model: { provider: "openrouter", id: "gemini-flash" },
        promptFile: "",
        promptString: "test",
      };
      expect(isHandoffConfig(config)).toBe(true);
    });

    it("rejects threshold outside 0-1 range", () => {
      const config = {
        threshold: 1.5,
        model: { provider: "x", id: "y" },
        promptFile: "",
        promptString: "",
      };
      expect(isHandoffConfig(config)).toBe(false);

      config.threshold = 0;
      expect(isHandoffConfig(config)).toBe(false);

      config.threshold = -0.5;
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects missing or empty provider", () => {
      const config = {
        threshold: 0.5,
        model: { provider: "", id: "y" },
        promptFile: "",
        promptString: "",
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects missing or empty model id", () => {
      const config = {
        threshold: 0.5,
        model: { provider: "x", id: "" },
        promptFile: "",
        promptString: "",
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects missing model object", () => {
      const config = {
        threshold: 0.5,
        model: null,
        promptFile: "",
        promptString: "",
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects non-string promptFile", () => {
      const config = {
        threshold: 0.5,
        model: { provider: "x", id: "y" },
        promptFile: 123,
        promptString: "",
      };
      expect(isHandoffConfig(config)).toBe(false);
    });
  });
}
