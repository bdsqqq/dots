/**
 * oracle tool — expert technical advisor via gpt-5.2 sub-agent.
 *
 * replaces the generic subagent(agent: "oracle", task: ...) pattern
 * with a dedicated tool. the model calls
 * oracle(task: "...", context?: "...", files?: [...]) directly.
 *
 * the oracle operates zero-shot: no follow-up questions, makes its
 * final message comprehensive. only the last assistant message is
 * returned to the parent agent.
 *
 * default prompt loaded from the shared repo prompt file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import {
  getModelFromCliString,
  isPiSpawnModelValue,
  piSpawn,
  resolvePrompt,
  zeroUsage,
} from "@bds_pi/pi-spawn";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";

const ORACLE_DEFAULT_MODEL: any = getModel(
  "openrouter",
  "google/gemini-3.1-pro-preview",
);

type OracleExtConfig = {
  model: typeof ORACLE_DEFAULT_MODEL | string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type OracleExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: OracleExtConfig = {
  model: ORACLE_DEFAULT_MODEL,
  extensionTools: ["read", "grep", "find", "ls", "bash"],
  builtinTools: ["read", "grep", "find", "ls", "bash"],
  promptFile: "agent.amp.oracle.md",
  promptString: "",
};

const DEFAULT_DEPS: OracleExtensionDeps = {
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

function isOracleConfig(
  value: Record<string, unknown>,
): value is OracleExtConfig {
  return (
    isPiSpawnModelValue(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const ORACLE_CONFIG_SCHEMA: ExtensionConfigSchema<OracleExtConfig> = {
  validate: isOracleConfig,
};

interface OracleParams {
  task: string;
  context?: string;
  files?: string[];
}

export interface OracleConfig {
  systemPrompt?: string;
  model?: typeof ORACLE_DEFAULT_MODEL | string;
  extensionTools?: string[];
  builtinTools?: string[];
}

export function createOracleTool(
  config: OracleConfig = {},
): ToolDefinition<any> {
  return {
    name: "oracle",
    label: "Oracle",
    description:
      "Consult the oracle - an AI advisor powered by a reasoning model " +
      "that can plan, review, and provide expert guidance.\n\n" +
      "The oracle has access to tools: Read, Grep, Find, ls, Bash.\n\n" +
      "You should consult the oracle for:\n" +
      "- Code reviews and architecture feedback\n" +
      "- Finding difficult bugs across many files\n" +
      "- Planning complex implementations or refactors\n" +
      "- Answering complex technical questions requiring deep reasoning\n" +
      "- Providing an alternative point of view\n\n" +
      "You should NOT consult the oracle for:\n" +
      "- File reads or simple keyword searches (use Read or Grep directly)\n" +
      "- Codebase searches (use finder)\n" +
      "- Basic code modifications (do it yourself or use Task)\n\n" +
      "Usage guidelines:\n" +
      "- Be specific about what you want reviewed, planned, or debugged\n" +
      "- Provide relevant context. If you know which files are involved, list them.",

    parameters: Type.Object({
      task: Type.String({
        description:
          "The task or question for the oracle. Be specific about what guidance you need.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional context about the current situation or background information.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional file paths the oracle should examine.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as OracleParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      // compose task with context and inline file contents
      const parts: string[] = [p.task];
      if (p.context) parts.push(`\nContext: ${p.context}`);
      if (p.files && p.files.length > 0) {
        for (const filePath of p.files) {
          const resolved = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(ctx.cwd, filePath);
          try {
            const content = fs.readFileSync(resolved, "utf-8");
            parts.push(`\nFile: ${filePath}\n\`\`\`\n${content}\n\`\`\``);
          } catch {
            parts.push(`\nFile: ${filePath} (could not read)`);
          }
        }
      }
      const fullTask = parts.join("\n");

      const singleResult: SingleResult = {
        agent: "oracle",
        task: p.task,
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
                  text: getFinalOutput(partial.messages) || "(thinking...)",
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
      const preview = args.task
        ? args.task.length > 80
          ? `${args.task.slice(0, 80)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("oracle ")) + theme.fg("dim", preview);
      if (args.files?.length) {
        text += theme.fg(
          "muted",
          ` (${args.files.length} file${args.files.length > 1 ? "s" : ""})`,
        );
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
        label: "oracle",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createOracleExtension(
  deps: OracleExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function oracleExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/oracle",
      CONFIG_DEFAULTS,
      { schema: ORACLE_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createOracleTool({
          systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
          model: cfg.model,
          extensionTools: cfg.extensionTools,
          builtinTools: cfg.builtinTools,
        }),
      ),
    );
  };
}

const oracleExtension: (pi: ExtensionAPI) => void = createOracleExtension();

export default oracleExtension;

// Export for testing
export {
  createOracleExtension,
  isNonEmptyString,
  isStringArray,
  isOracleConfig,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  ORACLE_CONFIG_SCHEMA,
};

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  function createMockExtensionApi() {
    const tools: any[] = [];
    const pi = {
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any;
    return { pi, tools };
  }

  describe("oracle extension (SDK integration)", () => {
    describe("extension registration", () => {
      it("registers the oracle tool when enabled", () => {
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: CONFIG_DEFAULTS,
        }));
        const resolvePromptSpy = vi.fn(() => "system prompt");
        const withPromptPatchSpy = vi.fn((tool: any) => tool);

        const ext = createOracleExtension({
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: resolvePromptSpy as any,
          withPromptPatch: withPromptPatchSpy as any,
        });

        const { pi, tools } = createMockExtensionApi();
        ext(pi);

        expect(mockConfig).toHaveBeenCalledWith(
          "@bds_pi/oracle",
          CONFIG_DEFAULTS,
          { schema: ORACLE_CONFIG_SCHEMA },
        );
        expect(resolvePromptSpy).toHaveBeenCalledWith(
          CONFIG_DEFAULTS.promptString,
          CONFIG_DEFAULTS.promptFile,
        );
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("oracle");
      });

      it("does not register any tools when disabled", () => {
        const mockConfig = vi.fn(() => ({
          enabled: false,
          config: CONFIG_DEFAULTS,
        }));
        const resolvePromptSpy = vi.fn(() => "system prompt");
        const withPromptPatchSpy = vi.fn((tool: any) => tool);

        const ext = createOracleExtension({
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: resolvePromptSpy as any,
          withPromptPatch: withPromptPatchSpy as any,
        });

        const { pi, tools } = createMockExtensionApi();
        ext(pi);

        expect(resolvePromptSpy).not.toHaveBeenCalled();
        expect(withPromptPatchSpy).not.toHaveBeenCalled();
        expect(tools).toHaveLength(0);
      });

      it("passes config values to createOracleTool", () => {
        const customConfig = {
          model: "custom/model",
          extensionTools: ["read", "grep"],
          builtinTools: ["bash"],
          promptFile: "custom-prompt.md",
          promptString: "",
        };
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: customConfig,
        }));
        const resolvePromptSpy = vi.fn(() => "custom system prompt");
        const withPromptPatchSpy = vi.fn((tool: any) => tool);

        const ext = createOracleExtension({
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: resolvePromptSpy as any,
          withPromptPatch: withPromptPatchSpy as any,
        });

        const { pi, tools } = createMockExtensionApi();
        ext(pi);

        expect(resolvePromptSpy).toHaveBeenCalledWith(
          customConfig.promptString,
          customConfig.promptFile,
        );
        expect(tools).toHaveLength(1);
      });

      it("uses provided config values even when potentially invalid", () => {
        const weirdConfig = {
          model: "",
          extensionTools: ["read"],
          builtinTools: ["bash"],
          promptFile: "custom.md",
          promptString: "",
        };
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: weirdConfig as any,
        }));
        const resolvePromptSpy = vi.fn(() => "system prompt");
        const withPromptPatchSpy = vi.fn((tool: any) => tool);

        const ext = createOracleExtension({
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: resolvePromptSpy as any,
          withPromptPatch: withPromptPatchSpy as any,
        });

        const { pi, tools } = createMockExtensionApi();
        ext(pi);

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("oracle");
        expect(resolvePromptSpy).toHaveBeenCalledWith(
          weirdConfig.promptString,
          weirdConfig.promptFile,
        );
      });
    });
  });

  describe("createOracleTool", () => {
    it("creates a tool with correct metadata", () => {
      const tool = createOracleTool();

      expect(tool.name).toBe("oracle");
      expect(tool.label).toBe("Oracle");
      expect(tool.description).toContain("expert guidance");
      expect(tool.description).toContain("Read, Grep, Find, ls, Bash");
    });

    it("has correct parameter schema", () => {
      const tool = createOracleTool();
      const params = tool.parameters as any;

      expect(params.type).toBe("object");
      expect(params.properties.task).toBeDefined();
      expect(params.properties.task.type).toBe("string");
      expect(params.properties.context).toBeDefined();
      expect(params.properties.files).toBeDefined();
      expect(params.properties.files.type).toBe("array");
    });

    it("applies custom config to tool", () => {
      const tool = createOracleTool({
        model: "custom/model",
        extensionTools: ["read"],
        builtinTools: ["grep"],
        systemPrompt: "custom prompt",
      });

      expect(tool.name).toBe("oracle");
    });

    describe("renderCall", () => {
      it("renders short task preview", () => {
        const tool = createOracleTool();
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as any;

        const result = tool.renderCall!({ task: "short task" }, theme, {
          lastComponent: undefined,
        } as any);
        const lines = result.render(80);

        expect(lines[0]).toContain("oracle");
        expect(lines[0]).toContain("short task");
      });

      it("truncates long task preview", () => {
        const tool = createOracleTool();
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as any;
        const longTask = "a".repeat(120);

        const result = tool.renderCall!({ task: longTask }, theme, {
          lastComponent: undefined,
        } as any);
        const lines = result.render(80);

        expect(lines[0]).toMatch(/^oracle/);
      });

      it("shows file count when files provided", () => {
        const tool = createOracleTool();
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as any;

        const result = tool.renderCall!(
          { task: "task", files: ["a.ts", "b.ts", "c.ts"] },
          theme,
          { lastComponent: undefined } as any,
        );
        const lines = result.render(80);

        expect(lines[0]).toContain("3 files");
      });
    });
  });

  describe("config validation", () => {
    describe("isNonEmptyString", () => {
      it("returns true for non-empty strings", () => {
        expect(isNonEmptyString("hello")).toBe(true);
        expect(isNonEmptyString("  trimmed  ")).toBe(true);
      });

      it("returns false for empty or whitespace-only strings", () => {
        expect(isNonEmptyString("")).toBe(false);
        expect(isNonEmptyString("   ")).toBe(false);
        expect(isNonEmptyString("\n\t")).toBe(false);
      });

      it("returns false for non-strings", () => {
        expect(isNonEmptyString(123)).toBe(false);
        expect(isNonEmptyString(null)).toBe(false);
        expect(isNonEmptyString(undefined)).toBe(false);
        expect(isNonEmptyString({})).toBe(false);
      });
    });

    describe("isStringArray", () => {
      it("returns true for arrays of strings", () => {
        expect(isStringArray(["read", "grep"])).toBe(true);
        expect(isStringArray([])).toBe(true);
      });

      it("returns false for arrays with non-strings", () => {
        expect(isStringArray(["read", 123])).toBe(false);
        expect(isStringArray([null, "grep"])).toBe(false);
      });

      it("returns false for non-arrays", () => {
        expect(isStringArray("read")).toBe(false);
        expect(isStringArray({})).toBe(false);
        expect(isStringArray(null)).toBe(false);
      });
    });

    describe("isOracleConfig", () => {
      const validConfig = {
        model: ORACLE_DEFAULT_MODEL,
        extensionTools: ["read", "grep"],
        builtinTools: ["read", "grep"],
        promptFile: "prompt.md",
        promptString: "",
      };

      it("returns true for valid config", () => {
        expect(isOracleConfig(validConfig)).toBe(true);
      });

      it("returns false when model is empty", () => {
        expect(isOracleConfig({ ...validConfig, model: "" })).toBe(false);
      });

      it("returns false when extensionTools contains non-strings", () => {
        expect(
          isOracleConfig({ ...validConfig, extensionTools: ["read", 123] }),
        ).toBe(false);
      });

      it("returns false when builtinTools is not an array", () => {
        expect(isOracleConfig({ ...validConfig, builtinTools: "bash" })).toBe(
          false,
        );
      });

      it("returns false when promptFile is not a string", () => {
        expect(isOracleConfig({ ...validConfig, promptFile: 123 })).toBe(false);
      });

      it("returns false when promptString is not a string", () => {
        expect(isOracleConfig({ ...validConfig, promptString: false })).toBe(
          false,
        );
      });
    });
  });

  // E2E eval test - requires PI_E2E=1 and real API keys
  describe.skipIf(!process.env.PI_E2E)("eval: oracle", () => {
    const E2E_MODEL =
      process.env.PI_E2E_MODEL ?? "openrouter/moonshotai/kimi-k2.5";

    it("eval: consults oracle and gets a response", async () => {
      const model = getModelFromCliString(E2E_MODEL);

      // Create oracle tool with default config
      const oracleTool = createOracleTool();

      const { session } = await createAgentSession({
        cwd: process.cwd(),
        sessionManager: SessionManager.inMemory(),
        model,
        customTools: [oracleTool],
      });

      // Subscribe to events to collect tool calls
      const toolCalls: Array<{ name: string; args: any }> = [];
      session.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          for (const part of event.message.content ?? []) {
            if (part.type === "toolCall") {
              toolCalls.push({ name: part.name, args: part.arguments });
            }
          }
        }
      });

      await session.prompt(
        'Use the oracle tool with task "What is 2+2? Answer with just the number."',
      );

      // Verify oracle was called
      const oracleCall = toolCalls.find((c) => c.name === "oracle");
      expect(oracleCall).toBeDefined();

      // Verify we got a response with content
      const messages = session.messages;
      const lastAssistant = messages
        .filter((m) => m.role === "assistant")
        .pop();
      expect(lastAssistant).toBeDefined();

      const textContent = lastAssistant?.content
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(textContent?.length).toBeGreaterThan(0);
    }, 120_000);
  });
}
