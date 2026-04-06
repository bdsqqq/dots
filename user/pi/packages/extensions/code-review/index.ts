/**
 * code_review tool — structured diff review via gemini sub-agent.
 *
 * spawns a gemini sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files for context
 * 3. produces XML <codeReview> report with per-comment severity/type
 *
 * review system prompt defines the expert reviewer role. report format
 * is injected as a follow-up message after exploration via piSpawn's
 * RPC mode — follow-up injection after exploration completes.
 *
 * v1: main review agent only. checks system (parallel workspace-defined
 * .md checks via haiku) deferred.
 */

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

type CodeReviewExtConfig = {
  model: string;
  builtinTools: string[];
  extensionTools: string[];
  promptFile: string;
  promptString: string;
  reportPromptFile: string;
  reportPromptString: string;
};

type CodeReviewExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: CodeReviewExtConfig = {
  model: "openrouter/google/gemini-3.1-pro-preview",
  builtinTools: ["read", "grep", "find", "ls", "bash"],
  extensionTools: [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "web_search",
    "read_web_page",
  ],
  promptFile: "",
  promptString: "",
  reportPromptFile: "",
  reportPromptString: "",
};

const DEFAULT_SYSTEM_PROMPT = String.raw`You are an expert senior engineer with deep knowledge of software engineering best practices, security, performance, and maintainability.

Your task is to perform a thorough code review of the provided diff description. The diff description might be a git or bash command that generates the diff or a description of the diff which can then be used to generate the git or bash command to generate the full diff.

After reading the diff, do the following:
1. Generate a high-level summary of the changes in the diff.
2. Go file-by-file and review each changed hunk.
3. Comment on what changed in that hunk (including the line range) and how it relates to other changed hunks and code, reading any other relevant files. Also call out bugs, hackiness, unnecessary code, or too much shared mutable state.

Today's date: {date}
Current working directory (cwd): {cwd}
`;

const DEFAULT_REPORT_FORMAT = String.raw`Emit your final report in the following format:

<codeReview>
<comment>
  <filename>the absolute file path (starting with the working directory)</filename>
  <startLine>the starting line number (see line number rules below)</startLine>
  <endLine>the ending line number (see line number rules below)</endLine>
  <severity>one of: critical, high, medium, low</severity>
  <commentType>one of: bug, suggested_edit, compliment, non_actionable</commentType>
  <text>text describing the issue and/or the proposed change to code</text>
  <why>brief explanation of why this matters</why>
  <fix>brief suggestion for how to fix it (optional for compliments)</fix>
</comment>
<comment>...</comment>
</codeReview>

Line number rules:
- For MODIFIED files: use line numbers from the NEW version (the + side in unified diff headers like @@ -old,count +NEW,count @@)
- For ADDED files: use line numbers from the new file content
- For DELETED files: use startLine=0 and endLine=0 (the file no longer exists, so describe the deletion issue in the text)

Severity levels:
- "critical": Security vulnerability, data loss, crash
- "high": Bug or significant performance issue
- "medium": Code smell, maintainability issue, or minor bug
- "low": Style suggestion, minor improvement, or compliment

Comment types:
- "bug": Points out a bug or defect in the code
- "suggested_edit": Suggests a code change or improvement
- "compliment": Positive feedback praising good code patterns or decisions
- "non_actionable": General observation that doesn't require code changes
`;

const DEFAULT_DEPS: CodeReviewExtensionDeps = {
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

function isCodeReviewConfig(
  value: Record<string, unknown>,
): value is CodeReviewExtConfig {
  return (
    isNonEmptyString(value.model) &&
    isStringArray(value.builtinTools) &&
    isStringArray(value.extensionTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.reportPromptFile === "string" &&
    typeof value.reportPromptString === "string"
  );
}

const CODE_REVIEW_CONFIG_SCHEMA: ExtensionConfigSchema<CodeReviewExtConfig> = {
  validate: isCodeReviewConfig,
};

export interface CodeReviewConfig {
  systemPrompt?: string;
  reportFormat?: string;
  model?: string;
  builtinTools?: string[];
  extensionTools?: string[];
}

// --- XML parsing ---

interface ReviewComment {
  filename: string;
  startLine: number;
  endLine: number;
  severity: string;
  commentType: string;
  text: string;
  why: string;
  fix: string;
}

function parseReviewXml(output: string): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const commentRegex = /<comment>([\s\S]*?)<\/comment>/g;
  let match: RegExpExecArray | null;

  while ((match = commentRegex.exec(output)) !== null) {
    const block = match[1]!;
    const get = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m && m[1] ? m[1].trim() : "";
    };
    comments.push({
      filename: get("filename"),
      startLine: parseInt(get("startLine"), 10) || 0,
      endLine: parseInt(get("endLine"), 10) || 0,
      severity: get("severity"),
      commentType: get("commentType"),
      text: get("text"),
      why: get("why"),
      fix: get("fix"),
    });
  }
  return comments;
}

function formatReviewSummary(comments: ReviewComment[]): string {
  if (comments.length === 0) return "";

  const bySeverity: Record<string, number> = {};
  for (const c of comments) {
    bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
  }

  const severityOrder = ["critical", "high", "medium", "low"];
  const parts = severityOrder
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s}`);

  return `${comments.length} comment${comments.length !== 1 ? "s" : ""}: ${parts.join(", ")}`;
}

// --- tool ---

interface CodeReviewParams {
  diff_description: string;
  files?: string[];
  instructions?: string;
}

export function createCodeReviewTool(
  config: CodeReviewConfig = {},
): ToolDefinition {
  return {
    name: "code_review",
    label: "Code Review",
    description:
      "Review code changes, diffs, outstanding changes, or modified files. " +
      "Use when asked to review changes, check code quality, analyze uncommitted work, " +
      "or perform a code review.\n\n" +
      "It takes in a description of the diff or code change that can be used to generate " +
      "the full diff, which is then reviewed. When using this tool, do not invoke `git diff` " +
      "or any other tool to generate the diff but just pass a natural language description " +
      "of how to compute the diff in the diff_description argument.",

    parameters: Type.Object({
      diff_description: Type.String({
        description:
          "A description of the diff or code change that can be used to generate the full diff. " +
          "This can include a git or bash command to generate the diff or a description of the diff " +
          "which can then be used to generate the git or bash command to generate the full diff.",
      }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Specific files to focus the review on. If empty, all changed files covered " +
            "by the diff description are reviewed.",
        }),
      ),
      instructions: Type.Optional(
        Type.String({
          description: "Additional instructions to guide the review agent.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as CodeReviewParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {}

      // compose task prompt
      const parts: string[] = [];
      parts.push(`Review the following diff:\n${p.diff_description}`);

      if (p.files && p.files.length > 0) {
        parts.push(`\nFocus the review on these files:\n${p.files.join("\n")}`);
      }
      if (p.instructions) {
        parts.push(`\nAdditional review instructions:\n${p.instructions}`);
      }

      const fullTask = parts.join("\n");

      const singleResult: SingleResult = {
        agent: "code_review",
        task: p.diff_description,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const reportFormat = config.reportFormat || DEFAULT_REPORT_FORMAT;

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: fullTask,
        model: config.model ?? CONFIG_DEFAULTS.model,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
        systemPromptBody: systemPrompt,
        followUp: reportFormat,
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
                  text: getFinalOutput(partial.messages) || "(reviewing...)",
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
      const desc = args.diff_description || "...";
      const preview = desc.length > 70 ? `${desc.slice(0, 70)}...` : desc;
      let text =
        theme.fg("toolTitle", theme.bold("code_review ")) +
        theme.fg("dim", preview);
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

      // parse XML comments from output for summary line
      const output = getFinalOutput(details.messages);
      const comments = parseReviewXml(output);
      if (comments.length > 0) {
        const summary = formatReviewSummary(comments);
        container.addChild(new Text(theme.fg("accent", summary), 0, 0));
      }

      renderAgentTree(details, container, expanded, theme, {
        label: "code_review",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createCodeReviewExtension(
  deps: CodeReviewExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function codeReviewExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/code-review",
      CONFIG_DEFAULTS,
      { schema: CODE_REVIEW_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createCodeReviewTool({
          systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
          reportFormat: deps.resolvePrompt(
            cfg.reportPromptString,
            cfg.reportPromptFile,
          ),
          model: cfg.model,
          builtinTools: cfg.builtinTools,
          extensionTools: cfg.extensionTools,
        }),
      ),
    );
  };
}

const codeReviewExtension: (pi: ExtensionAPI) => void =
  createCodeReviewExtension();

export default codeReviewExtension;

// Export for testing
export {
  parseReviewXml,
  formatReviewSummary,
  isCodeReviewConfig,
  isNonEmptyString,
  isStringArray,
  createCodeReviewExtension,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  CODE_REVIEW_CONFIG_SCHEMA,
};
