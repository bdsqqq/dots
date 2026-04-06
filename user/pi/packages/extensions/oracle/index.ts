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
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getEnabledExtensionConfig,
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

type OracleExtConfig = {
  model: string;
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
  model: "openrouter/google/gemini-3.1-pro-preview",
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
    isNonEmptyString(value.model) &&
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
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

export function createOracleTool(config: OracleConfig = {}): ToolDefinition {
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
