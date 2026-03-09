/**
 * librarian tool — cross-repo codebase understanding via gemini flash sub-agent.
 *
 * replaces the generic subagent pattern with a dedicated tool. the model
 * calls librarian(query: "...", context?: "...")
 * directly.
 *
 * spawns `pi --mode json` with gemini flash, constrained to the 7
 * github tools (read_github, search_github, list_directory_github,
 * list_repositories, glob_github, commit_search, diff). the librarian
 * explores repos thoroughly before providing comprehensive answers.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
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

type LibrarianExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type LibrarianExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: LibrarianExtConfig = {
  model: "openrouter/google/gemini-3-flash-preview",
  extensionTools: [
    "read_github",
    "search_github",
    "list_directory_github",
    "list_repositories",
    "glob_github",
    "commit_search",
    "diff",
    "web_search",
  ],
  builtinTools: [],
  promptFile: "",
  promptString: "",
};

const DEFAULT_DEPS: LibrarianExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLibrarianConfig(
  value: Record<string, unknown>,
): value is LibrarianExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const LIBRARIAN_CONFIG_SCHEMA: ExtensionConfigSchema<LibrarianExtConfig> = {
  validate: isLibrarianConfig,
};

export interface LibrarianConfig {
  systemPrompt?: string;
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

interface LibrarianParams {
  query: string;
  context?: string;
}

export function createLibrarianTool(
  config: LibrarianConfig = {},
): ToolDefinition {
  return {
    name: "librarian",
    label: "Librarian",
    description:
      "The Librarian — a specialized codebase understanding agent that helps answer " +
      "questions about large, complex codebases across GitHub repositories.\n\n" +
      "The Librarian reads from GitHub — it can see public repositories and private " +
      "repositories you have access to via `gh` CLI auth.\n\n" +
      "WHEN TO USE THE LIBRARIAN:\n" +
      "- Understanding complex multi-repository codebases\n" +
      "- Exploring relationships between different repositories\n" +
      "- Analyzing architectural patterns across projects\n" +
      "- Finding specific implementations across codebases\n" +
      "- Understanding code evolution and commit history\n" +
      "- Getting comprehensive explanations of how features work\n\n" +
      "WHEN NOT TO USE THE LIBRARIAN:\n" +
      "- Simple local file reading (use Read directly)\n" +
      "- Local codebase searches (use finder)\n" +
      "- Code modifications (use other tools)\n\n" +
      "USAGE GUIDELINES:\n" +
      "- Be specific about what repositories or projects you want to understand\n" +
      "- Provide context about what you're trying to achieve\n" +
      "- The Librarian explores thoroughly before providing comprehensive answers\n" +
      "- When getting an answer from the Librarian, show it to the user in full, do not summarize it.",

    parameters: Type.Object({
      query: Type.String({
        description:
          "Your question about the codebase. Be specific about what you want to understand.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional context about what you're trying to achieve or background information.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const p = params as LibrarianParams;
      const parts: string[] = [p.query];
      if (p.context) parts.push(`\nContext: ${p.context}`);
      const fullTask = parts.join("\n");

      const singleResult: SingleResult = {
        agent: "librarian",
        task: p.query,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: fullTask,
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
                  text: getFinalOutput(partial.messages) || "(exploring...)",
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
        theme.fg("toolTitle", theme.bold("librarian ")) +
          theme.fg("dim", preview),
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
        label: "librarian",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createLibrarianExtension(
  deps: LibrarianExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function librarianExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/librarian",
      CONFIG_DEFAULTS,
      { schema: LIBRARIAN_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createLibrarianTool({
          systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
          model: cfg.model,
          extensionTools: cfg.extensionTools,
          builtinTools: cfg.builtinTools,
        }),
      ),
    );
  };
}

const librarianExtension: (pi: ExtensionAPI) => void = createLibrarianExtension();

export default librarianExtension;

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

  describe("librarian extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createLibrarianExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/librarian",
        CONFIG_DEFAULTS,
        { schema: LIBRARIAN_CONFIG_SCHEMA },
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
        <T extends Record<string, unknown>>(_namespace: string, defaults: T) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createLibrarianExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(resolvePromptSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-librarian-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/librarian": {
          model: "",
          extensionTools: ["read_github", 123],
          builtinTools: "bash",
          promptFile: 123,
          promptString: false,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createLibrarianExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch: withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/librarian; falling back to defaults.",
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });
  });
}
