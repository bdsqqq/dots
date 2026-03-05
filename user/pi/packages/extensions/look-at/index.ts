/**
 * look_at tool — multimodal file analysis via gemini flash sub-agent.
 *
 * hooks into pi's existing read tool pipeline: the sub-agent calls
 * read(path) which returns images as base64 content parts. gemini
 * sees the image and analyzes it per the user's objective.
 *
 * for text files, the sub-agent reads and summarizes/extracts per
 * objective — useful when you need analyzed data, not raw contents.
 *
 * supports reference files for comparison (e.g., before/after
 * screenshots, two versions of a diagram).
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, resolvePrompt, zeroUsage } from "@bds_pi/pi-spawn";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";
import { getExtensionConfig } from "@bds_pi/config";

type LookAtExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

const CONFIG_DEFAULTS: LookAtExtConfig = {
  model: "openrouter/google/gemini-3-flash-preview",
  extensionTools: ["read", "ls"],
  builtinTools: ["read", "ls"],
  promptFile: "prompt.amp.look-at.md",
  promptString: "",
};

const DEFAULT_SYSTEM_PROMPT = `Analyze the provided file and answer the user's question about it. Be concise and direct, reference specific locations. When comparing files, systematically identify differences.`;

export interface LookAtConfig {
  systemPrompt?: string;
  model?: string;
  extensionTools?: string[];
  builtinTools?: string[];
}

interface LookAtParams {
  path: string;
  objective: string;
  context: string;
  referenceFiles?: string[];
}

export function createLookAtTool(config: LookAtConfig = {}): ToolDefinition {
  return {
    name: "look_at",
    label: "Look At",
    description:
      "Extract specific information from a local file (including images and other media).\n\n" +
      "Use this tool when you need to extract or summarize information from a file " +
      "without getting the literal contents. Always provide a clear objective.\n\n" +
      "Pass reference files when you need to compare two or more things.\n\n" +
      "## When to use this tool\n\n" +
      "- Analyzing images that the Read tool cannot interpret\n" +
      "- Extracting specific information or summaries from documents\n" +
      "- Describing visual content in images or diagrams\n" +
      "- When you only need analyzed/extracted data, not raw file contents\n\n" +
      "## When NOT to use this tool\n\n" +
      "- For source code or plain text files where you need exact contents — use Read instead\n" +
      "- When you need to edit the file afterward (you need literal content from Read)\n" +
      "- For simple file reading where no interpretation is needed",

    parameters: Type.Object({
      path: Type.String({
        description:
          "Workspace-relative or absolute path to the file to analyze.",
      }),
      objective: Type.String({
        description:
          "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).",
      }),
      context: Type.String({
        description: "The broader goal and context for the analysis.",
      }),
      referenceFiles: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of paths to reference files for comparison.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as LookAtParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {}

      // build the task prompt: read file(s), then analyze
      const parts: string[] = [];

      parts.push(`Read the file at "${p.path}" using the read tool.`);

      if (p.referenceFiles && p.referenceFiles.length > 0) {
        for (const ref of p.referenceFiles) {
          parts.push(`Also read the reference file at "${ref}".`);
        }
      }

      parts.push("");
      parts.push(`Context: ${p.context}`);
      parts.push("");
      parts.push(`Analyze with this objective: ${p.objective}`);

      if (p.referenceFiles && p.referenceFiles.length > 0) {
        parts.push("");
        parts.push(
          "Compare the main file against the reference file(s). Identify all differences and similarities.",
        );
      }

      const fullTask = parts.join("\n");

      const singleResult: SingleResult = {
        agent: "look_at",
        task: p.objective,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: fullTask,
        model: config.model ?? CONFIG_DEFAULTS.model,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
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
                  text: getFinalOutput(partial.messages) || "(analyzing...)",
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
      const path = args.path || "...";
      const objective = args.objective
        ? args.objective.length > 60
          ? `${args.objective.slice(0, 60)}...`
          : args.objective
        : "";
      let text =
        theme.fg("toolTitle", theme.bold("look_at ")) + theme.fg("dim", path);
      if (objective) text += theme.fg("muted", ` — ${objective}`);
      if (args.referenceFiles?.length) {
        text += theme.fg(
          "muted",
          ` (+${args.referenceFiles.length} ref${args.referenceFiles.length > 1 ? "s" : ""})`,
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
        label: "look_at",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export default function (pi: ExtensionAPI) {
  const cfg = getExtensionConfig("@bds_pi/look-at", CONFIG_DEFAULTS);
  pi.registerTool(withPromptPatch(createLookAtTool({
    systemPrompt: resolvePrompt(cfg.promptString, cfg.promptFile),
    model: cfg.model,
    extensionTools: cfg.extensionTools,
    builtinTools: cfg.builtinTools,
  })));
}
