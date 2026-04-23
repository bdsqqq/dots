/**
 * routes three context-shaping flows through one configurable summary model:
 * handoff to a new session, in-place compaction, and /tree branch summaries.
 *
 * keeping them together avoids prompt drift between features that serialize the
 * same session state but need different output shapes.
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
  SessionMessageEntry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { registerMentionSource } from "@bds_pi/mentions";
import { createHandoffMentionSource } from "./handoff-mention-source";

type SummaryPromptSections = {
  [key: string]: string;
};

interface HandoffExtConfig {
  [key: string]: unknown;
  threshold: number;
  model: { provider: string; id: string };
  prompt: SummaryPromptSections;
}

const DEFAULT_SUMMARY_PROMPT_SECTIONS: SummaryPromptSections = {
  "shared-principles": String.raw`you are compressing prior work for later continuation. read the serialized conversation as historical record, not as a live chat to continue.

write from first person perspective ("i did...", "i learned...", "the user asked..."). extract only context that will help later work. prioritize:
- active goals, sub-goals, and success criteria
- instructions, constraints, preferences, and plans that still apply
- files, directories, commands, apis, patterns, and architectural facts that matter
- what i changed, verified, disproved, ruled out, or learned
- decisions, tradeoffs, blockers, caveats, open questions, and likely next moves

prefer durable context over chronology. be concrete. avoid filler and variable-level trivia unless it is required to continue. do not invent files or facts.`,
  "handoff-intent":
    "this summary is for a successor session. assume the next agent will not see this session directly unless they explicitly read it again. capture what they need to resume with minimal archaeology.",
  "handoff-format": String.raw`return context by calling create_handoff_context.
- relevantInformation: plain text bullet list only. no markdown headers, no bold/italic, no code fences. use workspace-relative paths.
- relevantFiles: array of at most 10 workspace-relative file or directory paths, ordered by importance.`,
  "tool-description":
    "extract relevant information from the conversation and select relevant files for another agent to continue the work. use this tool to identify the most important context and files needed.",
  "field-relevant-information":
    'extract relevant context from the conversation for a successor session. write from first person perspective ("i did...", "i told you..."). return plain text bullet items only.',
  "field-relevant-files": String.raw`an array of workspace-relative file or directory paths that are relevant to accomplishing the goal.

rules:
- maximum 10 files. only include the most critical files needed for the task.
- you can include directories if multiple files from that directory are needed.
- prioritize by importance and relevance. put the most important files first.
- return workspace-relative paths (e.g., "user/pi/extensions/handoff.ts").
- do not use absolute paths or invent files.`,
  "compaction-intent":
    "this summary is for in-place compaction inside the same session. preserve the state i will need after older turns are dropped. emphasize active work, still-relevant discoveries, and what should stay top-of-mind.",
  "compaction-format":
    "output plain text bullet list only. no markdown headers, no bold/italic, no code fences. keep it compact but not skeletal.",
  "tree-intent":
    "this summary is for an abandoned branch in /tree. i am returning to another point in the same session. capture what the current branch should remember from this side-quest: what i tried, what worked or failed, and what changed my understanding.",
  "tree-format":
    "output plain text bullet list only. no markdown headers, no bold/italic, no code fences. optimize for quick reorientation after the branch switch.",
};

const CONFIG_DEFAULTS: HandoffExtConfig = {
  threshold: 0.85,
  model: {
    provider: "openrouter",
    id: "google/gemini-3-flash-preview",
  },
  prompt: DEFAULT_SUMMARY_PROMPT_SECTIONS,
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

  if (!isPlainObject(value.prompt)) {
    return false;
  }

  return (
    typeof value.model.provider === "string" &&
    value.model.provider.trim().length > 0 &&
    typeof value.model.id === "string" &&
    value.model.id.trim().length > 0
  );
}

const HANDOFF_CONFIG_SCHEMA: ExtensionConfigSchema<HandoffExtConfig> = {
  validate: isHandoffConfig,
};

const MAX_RELEVANT_FILES = 10;
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "\n</summary>";

type FileOps = {
  read: Set<string>;
  edited: Set<string>;
  written: Set<string>;
};

interface SummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

interface HandoffExtraction {
  relevantInformation: string;
  relevantFiles: string[];
}

function parsePromptSections(content: string): Record<string, string> {
  const trimmed = content.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `handoff prompt config must be a json object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("handoff prompt config must be a json object");
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
}

function createFileOps(): FileOps {
  return { read: new Set(), edited: new Set(), written: new Set() };
}

function addPathValues(target: Set<string>, values: unknown): void {
  if (!values) return;
  if (Array.isArray(values) || values instanceof Set) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) target.add(value);
    }
  }
}

function cloneFileOps(fileOps: Partial<FileOps> | undefined): FileOps {
  const next = createFileOps();
  if (!fileOps) return next;
  addPathValues(next.read, fileOps.read);
  addPathValues(next.edited, fileOps.edited);
  addPathValues(next.written, fileOps.written);
  return next;
}

function addSummaryDetailsToFileOps(fileOps: FileOps, details: unknown): void {
  if (!isPlainObject(details)) return;
  addPathValues(fileOps.read, details.readFiles);
  addPathValues(fileOps.edited, details.modifiedFiles);
  addPathValues(fileOps.written, details.modifiedFiles);
}

function addSummaryEntryDetails(
  fileOps: FileOps,
  entries: SessionEntry[],
): void {
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addSummaryDetailsToFileOps(fileOps, entry.details);
    }
  }
}

function extractMessageFileOps(
  fileOps: FileOps,
  message: SessionMessageEntry["message"],
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (
      typeof block !== "object" ||
      block === null ||
      block.type !== "toolCall"
    ) {
      continue;
    }

    const args = block.arguments as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) continue;

    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
    }
  }
}

function computeFileLists(fileOps: FileOps): SummaryDetails {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileSections({
  readFiles,
  modifiedFiles,
}: SummaryDetails): string {
  const parts: string[] = [];
  if (readFiles.length > 0) {
    parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function appendFileSections(summary: string, details: SummaryDetails): string {
  return `${summary.trim()}${formatFileSections(details)}`.trim();
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

function extractTextContent(response: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return response.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

type SummaryAction = "handoff" | "compaction" | "tree";

function composeActionPrompt(
  sections: Record<string, string>,
  action: SummaryAction,
  conversationText: string,
  options: {
    goal?: string;
    previousSummary?: string;
    customInstructions?: string;
    replaceInstructions?: boolean;
  } = {},
): string {
  const parts: string[] = [];

  if (options.replaceInstructions && options.customInstructions?.trim()) {
    parts.push(options.customInstructions.trim());
  } else {
    const shared = sections["shared-principles"]?.trim();
    const intent = sections[`${action}-intent`]?.trim();
    const format = sections[`${action}-format`]?.trim();

    if (shared) parts.push(shared);
    if (intent) parts.push(intent);
    if (format) parts.push(format);
    if (options.customInstructions?.trim()) {
      parts.push(
        `additional focus instructions:\n${options.customInstructions.trim()}`,
      );
    }
  }

  if (options.goal?.trim()) {
    parts.push(`current goal:\n${options.goal.trim()}`);
  }

  if (options.previousSummary?.trim()) {
    parts.push(
      `previous summary:\n<summary>\n${options.previousSummary.trim()}\n</summary>`,
    );
  }

  parts.push(`<conversation>\n${conversationText}\n</conversation>`);
  return parts.join("\n\n");
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function sessionEntriesToSummaryMessages(entries: SessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const msg = entry.message;
        if (msg.role !== "toolResult") {
          messages.push(msg as Message);
        }
        break;
      }
      case "custom_message":
        messages.push({
          role: "user",
          content:
            typeof entry.content === "string"
              ? [{ type: "text", text: entry.content }]
              : entry.content,
          timestamp: toTimestamp(entry.timestamp),
        });
        break;
      case "branch_summary":
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX,
            },
          ],
          timestamp: toTimestamp(entry.timestamp),
        });
        break;
      case "compaction":
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                COMPACTION_SUMMARY_PREFIX +
                entry.summary +
                COMPACTION_SUMMARY_SUFFIX,
            },
          ],
          timestamp: toTimestamp(entry.timestamp),
        });
        break;
    }
  }

  return messages;
}

function collectTreeSummaryDetails(entries: SessionEntry[]): SummaryDetails {
  const fileOps = createFileOps();
  addSummaryEntryDetails(fileOps, entries);
  for (const entry of entries) {
    if (entry.type === "message") {
      extractMessageFileOps(fileOps, entry.message);
    }
  }
  return computeFileLists(fileOps);
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
}

const DEFAULT_DEPS: HandoffExtensionDeps = {
  getEnabledExtensionConfig,
  registerMentionSource,
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

    const promptSections: SummaryPromptSections = cfg.prompt;

    const HANDOFF_TOOL: Tool = {
      name: "create_handoff_context",
      description:
        promptSections["tool-description"] || "Extract context for handoff",
      parameters: Type.Object({
        relevantInformation: Type.String({
          description:
            promptSections["field-relevant-information"] ||
            "Extract relevant context",
        }),
        relevantFiles: Type.Array(Type.String(), {
          description:
            promptSections["field-relevant-files"] || "Relevant file paths",
        }),
      }),
    };

    function buildExtractionPrompt(
      conversationText: string,
      goal: string,
    ): string {
      return `${composeActionPrompt(
        promptSections,
        "handoff",
        conversationText,
        {
          goal,
        },
      )}\n\nUse the create_handoff_context tool to extract relevant information and files.`;
    }

    let storedHandoffPrompt: string | null = null;
    let handoffPending = false;
    let parentSessionFile: string | undefined;
    let generating = false;

    function getSummaryModel(ctx: {
      modelRegistry: { find(p: string, id: string): Model<Api> | undefined };
      model: Model<Api> | undefined;
    }): Model<Api> | undefined {
      return (
        ctx.modelRegistry.find(cfg.model.provider, cfg.model.id) ?? ctx.model
      );
    }

    async function getSummaryAuth(
      ctx: { modelRegistry: any },
      summaryModel: Model<Api>,
    ): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      if (!auth.apiKey && !auth.headers) {
        throw new Error("missing auth for summary model");
      }
      return { apiKey: auth.apiKey, headers: auth.headers };
    }

    async function generatePlainSummary(
      ctx: { modelRegistry: any },
      summaryModel: Model<Api>,
      prompt: string,
      signal?: AbortSignal,
    ): Promise<string | null> {
      const auth = await getSummaryAuth(ctx, summaryModel);
      const response = await complete(
        summaryModel,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
        },
      );

      if (response.stopReason === "aborted") return null;
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "API request failed");
      }

      const summary = extractTextContent(response);
      return summary || null;
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
      const auth = await getSummaryAuth(ctx, handoffModel);
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

      const stagePrompt = (targetCtx: any): void => {
        if (parent) showProvenance(targetCtx, parent);
        targetCtx.ui.setEditorText(prompt);
        targetCtx.ui.notify(
          "Handoff ready. Review the prompt and press Enter to submit.",
          "info",
        );
      };

      let stagedInReplacementSession = false;
      const switchResult = await ctx.newSession({
        parentSession: parent,
        withSession: async (nextCtx: any) => {
          stagedInReplacementSession = true;
          stagePrompt(nextCtx);
        },
      });
      if (switchResult.cancelled) return false;

      if (!stagedInReplacementSession) {
        // older pi builds ignore `withSession`; stage on the current ctx so
        // the user can still review the generated prompt before switching.
        stagePrompt(ctx);
      }
      return true;
    }

    pi.on("session_start", async (_event, ctx) => {
      const parentPath = ctx.sessionManager.getHeader()?.parentSession;
      if (parentPath) showProvenance(ctx, parentPath);
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const summaryModel = getSummaryModel(ctx);
      if (!summaryModel) return;

      const conversationText = serializeConversation(
        convertToLlm([
          ...event.preparation.messagesToSummarize,
          ...event.preparation.turnPrefixMessages,
        ]),
      );
      const fileOps = cloneFileOps(event.preparation.fileOps);
      addSummaryEntryDetails(fileOps, event.branchEntries);
      const nextDetails = computeFileLists(fileOps);

      try {
        const summary = await generatePlainSummary(
          ctx,
          summaryModel,
          composeActionPrompt(promptSections, "compaction", conversationText, {
            previousSummary: event.preparation.previousSummary,
            customInstructions: event.customInstructions,
          }),
          event.signal,
        );
        if (!summary) return;

        return {
          compaction: {
            summary: appendFileSections(summary, nextDetails),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: nextDetails,
          },
        };
      } catch (error) {
        ctx.ui.notify(
          `custom compaction summary failed, using default: ${String(error)}`,
          "warning",
        );
        return;
      }
    });

    pi.on("session_before_tree", async (event, ctx) => {
      const { preparation } = event;
      if (!preparation.userWantsSummary) return;
      if (preparation.entriesToSummarize.length === 0) return;

      const summaryModel = getSummaryModel(ctx);
      if (!summaryModel) return;

      const conversationText = serializeConversation(
        sessionEntriesToSummaryMessages(preparation.entriesToSummarize),
      );
      const details = collectTreeSummaryDetails(preparation.entriesToSummarize);

      try {
        const summary = await generatePlainSummary(
          ctx,
          summaryModel,
          composeActionPrompt(promptSections, "tree", conversationText, {
            customInstructions: preparation.customInstructions,
            replaceInstructions: preparation.replaceInstructions,
          }),
          event.signal,
        );
        if (!summary) return;

        return {
          summary: {
            summary: appendFileSections(summary, details),
            details,
          },
        };
      } catch (error) {
        ctx.ui.notify(
          `custom tree summary failed, using default: ${String(error)}`,
          "warning",
        );
        return;
      }
    });

    pi.on("agent_end", async (_event, ctx) => {
      if (handoffPending || generating) return;

      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null) return;
      if (usage.percent < cfg.threshold * 100) return;
      const handoffModel = getSummaryModel(ctx);
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

    pi.registerCommand("handoff", {
      description: "Transfer context to a new focused session",
      handler: async (args, ctx) => {
        const goal = args.trim();

        if (goal && !handoffPending) {
          const handoffModel = getSummaryModel(ctx);
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
      if (
        event.reason === "new" ||
        event.reason === "resume" ||
        event.reason === "fork"
      ) {
        storedHandoffPrompt = null;
        handoffPending = false;
        generating = false;
        pi.events.emit("editor:remove-label", { key: "handoff" });
        ctx.ui.setWidget("handoff-provenance", undefined);
      }
    });

    // --- handoff tool: agent-invokable session transfer ---
    const handoffTool: ToolDefinition<any> = {
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
        const handoffModel = getSummaryModel(_ctx);
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
    it("returns empty object for blank input", () => {
      const result = parsePromptSections("   ");
      expect(result).toEqual({});
    });

    it("parses json prompt objects", () => {
      const result = parsePromptSections('{"foo":"bar","baz":"qux"}');
      expect(result).toEqual({ foo: "bar", baz: "qux" });
    });

    it("rejects non-json prompt strings", () => {
      expect(() => parsePromptSections("# foo\nbar")).toThrow(
        /handoff prompt config must be a json object/,
      );
    });

    it("rejects json arrays", () => {
      expect(() => parsePromptSections('["foo"]')).toThrow(
        /handoff prompt config must be a json object/,
      );
    });

    it("round-trips DEFAULT_SUMMARY_PROMPT_SECTIONS through JSON", () => {
      const json = JSON.stringify(DEFAULT_SUMMARY_PROMPT_SECTIONS);
      const parsed = parsePromptSections(json);
      expect(parsed).toEqual(DEFAULT_SUMMARY_PROMPT_SECTIONS);
    });

    it("validates DEFAULT_SUMMARY_PROMPT_SECTIONS has required action keys", () => {
      const sections = DEFAULT_SUMMARY_PROMPT_SECTIONS;
      for (const action of ["handoff", "compaction", "tree"] as const) {
        expect(typeof sections[`${action}-intent`]).toBe("string");
        expect(typeof sections[`${action}-format`]).toBe("string");
      }
      expect(typeof sections["shared-principles"]).toBe("string");
    });
  });

  describe("composeActionPrompt", () => {
    const sections = DEFAULT_SUMMARY_PROMPT_SECTIONS;

    it("combines shared and action-specific sections", () => {
      const result = composeActionPrompt(sections, "compaction", "[User]: hi");
      expect(result).toContain(sections["shared-principles"]);
      expect(result).toContain(sections["compaction-intent"]);
      expect(result).toContain(sections["compaction-format"]);
      expect(result).toContain("<conversation>\n[User]: hi\n</conversation>");
    });

    it("adds goal only for the current action call", () => {
      const result = composeActionPrompt(sections, "handoff", "[User]: hi", {
        goal: "finish the refactor",
      });
      expect(result).toContain("current goal:\nfinish the refactor");
    });

    it("replaces default instructions when requested", () => {
      const result = composeActionPrompt(sections, "tree", "[User]: hi", {
        customInstructions: "focus on tests only",
        replaceInstructions: true,
      });
      expect(result).toContain("focus on tests only");
      expect(result).not.toContain(sections["shared-principles"]);
      expect(result).not.toContain(sections["tree-intent"]);
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
        content: [{ type: "toolCall", name: "other_tool", arguments: {} }],
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
      const result = assembleHandoffPrompt(
        "session-123",
        extraction,
        "continue X",
      );

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
        prompt: { "handoff-intent": "test" },
      };
      expect(isHandoffConfig(config)).toBe(true);
    });

    it("rejects threshold outside 0-1 range", () => {
      const config = {
        threshold: 1.5,
        model: { provider: "x", id: "y" },
        prompt: {},
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
        prompt: {},
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects missing or empty model id", () => {
      const config = {
        threshold: 0.5,
        model: { provider: "x", id: "" },
        prompt: {},
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects missing model object", () => {
      const config = {
        threshold: 0.5,
        model: null,
        prompt: {},
      };
      expect(isHandoffConfig(config)).toBe(false);
    });

    it("rejects non-object prompt", () => {
      const config = {
        threshold: 0.5,
        model: { provider: "x", id: "y" },
        prompt: "not an object",
      };
      expect(isHandoffConfig(config)).toBe(false);
    });
  });
}
