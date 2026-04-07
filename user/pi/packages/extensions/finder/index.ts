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
 * default prompt loaded from the shared repo prompt file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { piSpawn, resolvePrompt, zeroUsage } from "@bds_pi/pi-spawn";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";

type FinderExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type FinderExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: FinderExtConfig = {
  model: "openrouter/google/gemini-3-flash-preview",
  extensionTools: ["read", "grep", "find", "ls"],
  builtinTools: ["read", "grep", "find", "ls"],
  promptFile: "agent.amp.finder.md",
  promptString: "",
};

const DEFAULT_DEPS: FinderExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isFinderConfig(
  value: Record<string, unknown>,
): value is FinderExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const FINDER_CONFIG_SCHEMA: ExtensionConfigSchema<FinderExtConfig> = {
  validate: isFinderConfig,
};

export interface FinderConfig {
  systemPrompt?: string;
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

interface FinderParams {
  query: string;
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
      '- You need answers to questions like "Where do we validate JWT headers?"\n\n' +
      "WHEN NOT TO USE THIS TOOL:\n" +
      "- When you know the exact file path - use Read directly\n" +
      "- When looking for specific symbols or exact strings - use Find or Grep\n" +
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
      const p = params as FinderParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const singleResult: SingleResult = {
        agent: "finder",
        task: p.query,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: p.query,
        model: config.model ?? CONFIG_DEFAULTS.model,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
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
              content: [
                {
                  type: "text",
                  text: getFinalOutput(partial.messages) || "(searching...)",
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
      const preview = args.query
        ? args.query.length > 80
          ? `${args.query.slice(0, 80)}...`
          : args.query
        : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("finder ")) + theme.fg("dim", preview),
        0,
        0,
      );
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
        label: "finder",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createFinderExtension(
  deps: FinderExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function finderExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/finder",
      CONFIG_DEFAULTS,
      { schema: FINDER_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createFinderTool({
          systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
          model: cfg.model,
          extensionTools: cfg.extensionTools,
          builtinTools: cfg.builtinTools,
        }),
      ),
    );
  };
}

const finderExtension: (pi: ExtensionAPI) => void = createFinderExtension();

export default finderExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

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
  });

  describe("finder extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFinderExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/finder",
        CONFIG_DEFAULTS,
        { schema: FINDER_CONFIG_SCHEMA },
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });

    it("registers no tools when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFinderExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(resolvePromptSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-finder-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/finder": {
          model: "",
          extensionTools: ["read", 123],
          builtinTools: "grep",
          promptFile: 123,
          promptString: false,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFinderExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/finder; falling back to defaults.",
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });
  });

  describe("renderAgentTree rendering", () => {
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
    };

    it("renders tree with connectors, icons, label, summary, and usage stats", () => {
      const singleResult: SingleResult = {
        agent: "finder",
        task: "search for createGrepTool definition",
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "grep",
                arguments: { pattern: "createGrepTool", path: "." },
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "gemini-3-flash",
            usage: {
              input: 50,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 100,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "grep",
            content: [{ type: "text", text: "found in src/tools/grep.ts" }],
            isError: false,
            timestamp: 0,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Found it in src/tools/grep.ts" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "gemini-3-flash",
            usage: {
              input: 75,
              output: 75,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
        ],
        usage: {
          input: 500,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.0012,
          contextTokens: 300,
          turns: 2,
        },
        model: "gemini-3-flash",
        stopReason: "stop",
      };

      const container = new Container();
      renderAgentTree(singleResult, container, false, mockTheme, {
        label: "finder",
        header: "statusOnly",
      });

      const lines = container.render(80);
      const output = lines.join("\n");

      // tree connectors
      expect(output).toContain("├──");
      expect(output).toContain("╰──");

      // success icon
      expect(output).toContain("✓");

      // summary section
      expect(output).toContain("Summary:");

      // usage stats
      expect(output).toContain("2 turns");
      expect(output).toContain("gemini");
    });

    it("renders error state with error icon and message", () => {
      const singleResult: SingleResult = {
        agent: "finder",
        task: "search for nonexistent",
        exitCode: 1,
        messages: [],
        usage: {
          input: 100,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        stopReason: "error",
        errorMessage: "connection timeout",
      };

      const container = new Container();
      renderAgentTree(singleResult, container, false, mockTheme, {
        label: "finder",
        header: "statusOnly",
      });

      const lines = container.render(80);
      const output = lines.join("\n");

      expect(output).toContain("✕");
      expect(output).toContain("connection timeout");
    });

    it("renders pending state with warning icon", () => {
      const singleResult: SingleResult = {
        agent: "finder",
        task: "search in progress",
        exitCode: -1,
        messages: [],
        usage: {
          input: 50,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      };

      const container = new Container();
      renderAgentTree(singleResult, container, false, mockTheme, {
        label: "finder",
        header: "statusOnly",
      });

      const lines = container.render(80);
      const output = lines.join("\n");

      expect(output).toContain("⋯");
    });
  });

  // Layer 2: E2E eval tests (gated by PI_E2E env var)
  // Uses piSpawn which spawns CLI and loads extensions from user's settings
  describe.skipIf(!process.env.PI_E2E)("eval: finder tool", () => {
    const E2E_MODEL =
      process.env.PI_E2E_MODEL ?? "openrouter/moonshotai/kimi-k2.5";

    it("eval: searches codebase and returns results", async () => {
      const { piSpawn } = await import("@bds_pi/pi-spawn");

      const result = await piSpawn({
        cwd: process.cwd(),
        task: "Use the finder tool to search for where SessionManager class is defined in this codebase. Tell me the file path.",
        model: E2E_MODEL,
        extensionTools: ["read", "grep", "find", "ls"],
        builtinTools: ["read", "grep", "find", "ls"],
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();

      // Check that finder was called by looking at messages
      const messages = result.messages;
      const toolCalls = messages
        .filter((m) => m.role === "assistant")
        .flatMap(
          (m) =>
            m.content?.filter(
              (
                c,
              ): c is {
                type: "toolCall";
                id: string;
                name: string;
                arguments: Record<string, unknown>;
              } => c.type === "toolCall",
            ) ?? [],
        );
      const finderCall = toolCalls.find((c) => c.name === "finder");

      expect(finderCall).toBeDefined();

      // Check the final output mentions session-manager
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const textContent =
        lastAssistant?.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text)
          .join(" ") ?? "";

      expect(textContent.toLowerCase()).toContain("session-manager");
    }, 120_000);
  });
}
