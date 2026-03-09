/**
 * read_session tool — extract relevant context from a pi session via sub-agent.
 *
 * loads a full session tree (all branches), renders it as structured markdown,
 * then spawns a gemini flash sub-agent to extract only the information
 * relevant to the stated goal. the agent sees the complete tree — including
 * abandoned branches — so it can understand decision points and context.
 *
 * branch awareness: if a leaf_id is provided, the target branch is annotated
 * in the rendered output so the agent knows which path to focus on.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { walkDirSync } from "@bds_pi/fs";
import { Container, Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "@bds_pi/pi-spawn";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";
import { headTailChars } from "@bds_pi/output-buffer";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";

type ReadSessionExtConfig = {
  model: string;
  sessionsDir: string;
  maxChars: number;
};

const CONFIG_DEFAULTS: ReadSessionExtConfig = {
  model: "openrouter/google/gemini-3-flash-preview",
  sessionsDir: path.join(os.homedir(), ".pi", "agent", "sessions"),
  maxChars: 120_000,
};

export type ReadSessionExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const DEFAULT_DEPS: ReadSessionExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReadSessionConfig(value: Record<string, unknown>): value is ReadSessionExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isNonEmptyString(value.sessionsDir) &&
    typeof value.maxChars === "number" &&
    Number.isInteger(value.maxChars) &&
    value.maxChars >= 1
  );
}

const READ_SESSION_CONFIG_SCHEMA: ExtensionConfigSchema<ReadSessionExtConfig> = {
  validate: isReadSessionConfig,
};

const DEFAULT_SYSTEM_PROMPT = `You are analyzing a pi coding agent session transcript. Extract information relevant to the user's goal. Be specific — cite file paths, decisions made, code patterns discussed. If a specific branch is marked as the target, focus on that branch but use other branches for context about what was tried and abandoned.`;

export interface ReadSessionConfig {
  systemPrompt?: string;
  model?: string;
  sessionsDir: string;
  maxChars: number;
}

// --- session parsing (shared types with search-sessions) ---

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

interface MessageContent {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

// --- session rendering ---

interface ReadSessionParams {
  session_id: string;
  goal: string;
  leaf_id?: string;
}

function findSessionFile(sessionId: string, sessionsDir: string): string | null {
  if (!fs.existsSync(sessionsDir)) return null;

  // fast path: check filename contains session id
  const byFilename = walkDirSync(sessionsDir, {
    stopWhen: (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      entry.name.includes(sessionId),
  })[0];
  if (byFilename) return byFilename;

  // slow path: parse headers
  return (
    walkDirSync(sessionsDir, {
      stopWhen: (entry, absolutePath) => {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return false;
        try {
          const firstLine = fs.readFileSync(absolutePath, "utf-8").split("\n")[0];
          if (!firstLine) return false;
          const header = JSON.parse(firstLine);
          return header.type === "session" && header.id === sessionId;
        } catch {
          return false;
        }
      },
    })[0] ?? null
  );
}

function renderSessionTree(
  filePath: string,
  targetLeafId: string | undefined,
  maxChars: number,
): { markdown: string; sessionName: string; sessionId: string } {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const entries: SessionEntry[] = [];
  let sessionId = "";
  let sessionName = "";
  let cwd = "";
  let timestamp = "";

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        sessionId = entry.id;
        cwd = entry.cwd || "";
        timestamp = entry.timestamp || "";
      }
      if (entry.type === "session_info" && entry.name) {
        sessionName = entry.name;
      }
      if (entry.id) entries.push(entry);
    } catch {
      /* skip */
    }
  }

  // build tree
  const byId = new Map<string, SessionEntry>();
  const children = new Map<string, string[]>();
  for (const e of entries) {
    byId.set(e.id, e);
    const parent = e.parentId ?? "__root__";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(e.id);
  }

  // find target branch path (leaf → root) for annotation
  const targetPath = new Set<string>();
  if (targetLeafId) {
    let current = targetLeafId;
    while (current) {
      targetPath.add(current);
      const entry = byId.get(current);
      if (!entry?.parentId) break;
      current = entry.parentId;
    }
  }

  // detect branch points (entries with >1 child)
  const branchPoints = new Set<string>();
  for (const [parentId, kids] of children.entries()) {
    if (kids.length > 1) branchPoints.add(parentId);
  }

  // render as markdown via DFS
  const parts: string[] = [];
  parts.push(`# session: ${sessionName || sessionId}`);
  parts.push(`id: ${sessionId}`);
  parts.push(`workspace: ${cwd}`);
  parts.push(`started: ${timestamp}`);
  if (targetLeafId) parts.push(`target branch leaf: ${targetLeafId}`);
  parts.push("");

  const renderEntry = (entryId: string, depth: number) => {
    const entry = byId.get(entryId);
    if (!entry) return;

    const isTarget = targetPath.has(entryId);
    const marker = isTarget ? " [TARGET BRANCH]" : "";

    // check if this is a branch point
    const kids = children.get(entryId) || [];
    if (kids.length > 1) {
      parts.push(`\n--- branch point (${kids.length} paths) ---\n`);
    }

    if (entry.type === "message") {
      const msg = (entry as any).message as MessageContent | undefined;
      if (!msg) return;

      if (msg.role === "user") {
        const textParts =
          msg.content
            ?.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") || "";
        if (textParts) {
          parts.push(`## user${marker}`);
          parts.push(textParts);
          parts.push("");
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];

        for (const part of msg.content || []) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text);
          } else if (part.type === "toolCall") {
            const args = part.arguments
              ? JSON.stringify(part.arguments).slice(0, 200)
              : "";
            toolCalls.push(`${part.name}(${args})`);
          }
          // skip thinking blocks — they're internal
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          parts.push(`## assistant${marker}`);
          if (textParts.length > 0) parts.push(textParts.join("\n"));
          if (toolCalls.length > 0) {
            parts.push(`\ntool calls: ${toolCalls.join(", ")}`);
          }
          parts.push("");
        }
      } else if (msg.role === "toolResult") {
        const toolName = msg.toolName || "?";
        const textContent =
          msg.content
            ?.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") || "";
        // truncate tool results to avoid overwhelming the context
        const truncated =
          textContent.length > 500
            ? `${textContent.slice(0, 500)}... (truncated)`
            : textContent;
        if (truncated) {
          parts.push(
            `### ${toolName} result${msg.isError ? " (ERROR)" : ""}${marker}`,
          );
          parts.push(truncated);
          parts.push("");
        }
      }
    } else if (entry.type === "model_change") {
      parts.push(`*model changed to ${String(entry.modelId)}*\n`);
    }

    // render children
    for (const childId of kids) {
      renderEntry(childId, depth + 1);
    }
  };

  // start from root entries (parentId is null or points to non-existent)
  const rootIds = children.get("__root__") || [];
  // also find entries whose parentId doesn't exist in byId (orphan roots)
  for (const e of entries) {
    if (e.parentId && !byId.has(e.parentId) && !rootIds.includes(e.id)) {
      rootIds.push(e.id);
    }
  }

  for (const rootId of rootIds) {
    renderEntry(rootId, 0);
  }

  let markdown = parts.join("\n");
  const truncated = headTailChars(markdown, maxChars);
  if (truncated.truncated) {
    markdown = truncated.text;
  }

  return { markdown, sessionName, sessionId };
}

// --- tool ---

export function createReadSessionTool(
  config: ReadSessionConfig,
): ToolDefinition {
  return {
    name: "read_session",
    label: "Read Session",
    description:
      "Read and extract relevant content from a past pi session.\n\n" +
      "Loads the full session tree (all branches, including abandoned paths), " +
      "then uses AI to extract only the information relevant to your stated goal. " +
      "The AI sees the complete tree to understand decision points and context.\n\n" +
      "Use `search_sessions` first to find session IDs and branch leaf IDs.\n\n" +
      "WHEN TO USE:\n" +
      "- Extracting context from a previous session\n" +
      "- Understanding what was tried and decided in a past session\n" +
      "- Continuing work from a prior session\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Current session context (already available)\n" +
      "- Finding sessions (use search_sessions first)",

    parameters: Type.Object({
      session_id: Type.String({
        description: "The session ID to read (from search_sessions results).",
      }),
      goal: Type.String({
        description:
          "What information you're looking for. Be specific about what to extract.",
      }),
      leaf_id: Type.Optional(
        Type.String({
          description:
            "Optional branch leaf ID to focus on. The AI will see all branches " +
            "but prioritize the target branch.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as ReadSessionParams;
      // find the session file
      const sessionFile = findSessionFile(p.session_id, config.sessionsDir);
      if (!sessionFile) {
        return {
          content: [
            {
              type: "text" as const,
              text: `session not found: ${p.session_id}`,
            },
          ],
          isError: true,
        } as any;
      }

      // render session tree
      const { markdown } = renderSessionTree(sessionFile, p.leaf_id, config.maxChars);

      if (!markdown.trim()) {
        return {
          content: [{ type: "text" as const, text: "(session is empty)" }],
        } as any;
      }

      // spawn sub-agent to extract relevant content
      let sessionId = "";
      try {
        sessionId = (ctx as any).sessionManager?.getSessionId?.() ?? "";
      } catch {}

      const task = `Here is a pi coding agent session transcript:\n\n${markdown}\n\n---\n\nExtract the information relevant to this goal: ${p.goal}`;

      const singleResult: SingleResult = {
        agent: "read_session",
        task: p.goal,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const result = await piSpawn({
        cwd: ctx.cwd,
        task,
        model: config.model ?? CONFIG_DEFAULTS.model,
        builtinTools: [],
        extensionTools: [],
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
              content: [
                {
                  type: "text",
                  text:
                    getFinalOutput(partial.messages) || "(reading session...)",
                },
              ],
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

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";
      const output = getFinalOutput(result.messages) || "(no output)";

      if (isError) {
        return subAgentResult(
          result.errorMessage || result.stderr || output,
          singleResult,
          true,
        );
      }

      return subAgentResult(output, singleResult);
    },

    renderCall(args: any, theme: any) {
      const goal = args.goal
        ? args.goal.length > 60
          ? `${args.goal.slice(0, 60)}...`
          : args.goal
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("read_session ")) +
        theme.fg("dim", goal);
      if (args.session_id) {
        const shortId =
          args.session_id.length > 8
            ? args.session_id.slice(0, 8)
            : args.session_id;
        text += theme.fg("muted", ` (${shortId}...)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as SingleResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }
      const container = new Container();
      renderAgentTree(details, container, expanded, theme, {
        label: "read_session",
        header: "statusOnly",
      });
      return container;
    },
  };
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();
  const tmpRoots: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-session-"));
    tmpRoots.push(dir);
    return dir;
  }

  function writeSessionJsonl(filePath: string, lines: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const tools: unknown[] = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;

    return { pi, tools };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("findSessionFile", () => {
    it("finds sessions by filename first", () => {
      const sessionsDir = makeTmpDir();
      const filePath = path.join(
        sessionsDir,
        "2026",
        "2026-03-06T17-00-00-000Z_alpha-session.jsonl",
      );
      writeSessionJsonl(filePath, [
        {
          type: "session",
          id: "alpha-session",
          timestamp: "2026-03-06T17:00:00.000Z",
          cwd: "/repo/app",
        },
      ]);

      expect(findSessionFile("alpha-session", sessionsDir)).toBe(filePath);
    });

    it("falls back to parsing headers when filenames do not include the session id", () => {
      const sessionsDir = makeTmpDir();
      const filePath = path.join(sessionsDir, "nested", "session-log.jsonl");
      writeSessionJsonl(filePath, [
        {
          type: "session",
          id: "beta-session",
          timestamp: "2026-03-06T17:10:00.000Z",
          cwd: "/repo/app",
        },
      ]);

      expect(findSessionFile("beta-session", sessionsDir)).toBe(filePath);
    });
  });

  describe("read-session extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadSessionExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/read-session",
        CONFIG_DEFAULTS,
        { schema: READ_SESSION_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });

    it("registers no tools when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadSessionExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = makeTmpDir();
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/read-session": {
          model: "",
          sessionsDir: "",
          maxChars: 0,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadSessionExtension({
        ...DEFAULT_DEPS,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/read-session; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });
  });
}

export function createReadSessionExtension(
  deps: ReadSessionExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function readSessionExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/read-session",
      CONFIG_DEFAULTS,
      { schema: READ_SESSION_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createReadSessionTool({
          model: cfg.model,
          sessionsDir: cfg.sessionsDir,
          maxChars: cfg.maxChars,
        }),
      ),
    );
  };
}

const readSessionExtension: (pi: ExtensionAPI) => void = createReadSessionExtension();

export default readSessionExtension;
