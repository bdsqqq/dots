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

type LibrarianExtConfig = {
  model: string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
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

export default function(pi: ExtensionAPI): void {
  const cfg = getExtensionConfig("@bds_pi/librarian", CONFIG_DEFAULTS);
  pi.registerTool(withPromptPatch(createLibrarianTool({
    systemPrompt: resolvePrompt(cfg.promptString, cfg.promptFile),
    model: cfg.model,
    extensionTools: cfg.extensionTools,
    builtinTools: cfg.builtinTools,
  })));
}
