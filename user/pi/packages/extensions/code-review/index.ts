/**
 * code_review tool — structured diff review via gpt-5.6-sol high sub-agent.
 *
 * spawns a gpt-5.6-sol high sub-agent that:
 * 1. runs git diff (or other bash command) based on diff_description
 * 2. reads changed files for context
 * 3. produces a Markdown report with per-comment severity/type
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
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import {
  isPiSpawnModelValue,
  piSpawn,
  resolvePrompt,
  zeroUsage,
} from "@bds_pi/pi-spawn";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  applySessionMeta,
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";
const CODE_REVIEW_DEFAULT_MODEL = "openai-codex/gpt-5.6-sol:high";

type CodeReviewExtConfig = {
  model: typeof CODE_REVIEW_DEFAULT_MODEL | string;
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
  model: CODE_REVIEW_DEFAULT_MODEL,
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

const DEFAULT_REPORT_FORMAT = String.raw`Emit your final report as Markdown using this structure:

# Code review

## Summary

A concise summary of the changes and overall assessment.

## Comments

### Comment

- **Filename:** the absolute file path (starting with the working directory)
- **Start line:** the starting line number (see line number rules below)
- **End line:** the ending line number (see line number rules below)
- **Severity:** one of: critical, high, medium, low
- **Comment type:** one of: bug, suggested_edit, compliment, non_actionable
- **Text:** text describing the issue and/or the proposed change to code
- **Why:** brief explanation of why this matters
- **Fix:** brief suggestion for how to fix it (optional for compliments)

Repeat the \`### Comment\` section for each comment. If there are no comments, write \`No comments.\` under \`## Comments\`.
Keep every labeled value on the same line as its label.

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
    isPiSpawnModelValue(value.model) &&
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
  model?: typeof CODE_REVIEW_DEFAULT_MODEL | string;
  builtinTools?: string[];
  extensionTools?: string[];
}

// --- Markdown parsing ---

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

function parseReviewMarkdown(output: string): ReviewComment[] {
  const comments: ReviewComment[] = [];
  const commentRegex =
    /^### comment\s*$([\s\S]*?)(?=^### comment\s*$|$(?![\s\S]))/gim;
  let match: RegExpExecArray | null;

  while ((match = commentRegex.exec(output)) !== null) {
    const block = match[1]!;
    const get = (label: string): string => {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const value = block.match(
        new RegExp(`^- \\*\\*${escapedLabel}:\\*\\*[ \\t]*(.*)$`, "im"),
      );
      return value?.[1]?.trim() ?? "";
    };
    comments.push({
      filename: get("filename"),
      startLine: parseInt(get("start line"), 10) || 0,
      endLine: parseInt(get("end line"), 10) || 0,
      severity: get("severity"),
      commentType: get("comment type"),
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

export interface CodeReviewParams {
  diff_description: string;
  files?: string[];
  instructions?: string;
}

export function createCodeReviewTool(
  config: CodeReviewConfig = {},
): ToolDefinition<any> {
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
      let parentSession: string | undefined;
      try {
        parentSession = ctx.sessionManager?.getSessionFile?.() ?? undefined;
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
        session: { persist: true, parentSession },
        onUpdate: (partial) => {
          singleResult.messages = partial.messages;
          singleResult.usage = partial.usage;
          singleResult.model = partial.model;
          singleResult.stopReason = partial.stopReason;
          singleResult.errorMessage = partial.errorMessage;
          applySessionMeta(singleResult, partial.session);
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
      applySessionMeta(singleResult, result.session);

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";
      const output = getFinalOutput(result.messages) || "(no output)";

      if (isError)
        throw new Error(result.errorMessage || result.stderr || output);

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

      // parse Markdown comments from output for summary line
      const output = getFinalOutput(details.messages);
      const comments = parseReviewMarkdown(output);
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

export function resolveCodeReviewConfig(
  deps: Pick<
    CodeReviewExtensionDeps,
    "getEnabledExtensionConfig" | "resolvePrompt"
  > = DEFAULT_DEPS,
): { enabled: boolean; config: CodeReviewConfig } {
  const { enabled, config } = deps.getEnabledExtensionConfig(
    "@bds_pi/code-review",
    CONFIG_DEFAULTS,
    { schema: CODE_REVIEW_CONFIG_SCHEMA },
  );

  return {
    enabled,
    config: {
      systemPrompt: enabled
        ? deps.resolvePrompt(config.promptString, config.promptFile)
        : undefined,
      reportFormat: enabled
        ? deps.resolvePrompt(config.reportPromptString, config.reportPromptFile)
        : undefined,
      model: config.model,
      builtinTools: config.builtinTools,
      extensionTools: config.extensionTools,
    },
  };
}

function createCodeReviewExtension(
  deps: CodeReviewExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function codeReviewExtension(pi: ExtensionAPI): void {
    const { enabled, config } = resolveCodeReviewConfig(deps);
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createCodeReviewTool(config)));
  };
}

const codeReviewExtension: (pi: ExtensionAPI) => void =
  createCodeReviewExtension();

export default codeReviewExtension;

// Export for testing
export {
  parseReviewMarkdown,
  formatReviewSummary,
  isCodeReviewConfig,
  isNonEmptyString,
  isStringArray,
  createCodeReviewExtension,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  CODE_REVIEW_CONFIG_SCHEMA,
};

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  // ============================================================================
  // PURE FUNCTION TESTS
  // ============================================================================

  describe("parseReviewMarkdown", () => {
    it("extracts a single comment from Markdown output", () => {
      const markdown = `# Code review

## Comments

### Comment

- **Filename:** /src/index.ts
- **Start line:** 42
- **End line:** 45
- **Severity:** high
- **Comment type:** bug
- **Text:** Potential null pointer
- **Why:** Could cause runtime error
- **Fix:** Add null check`;

      const result = parseReviewMarkdown(markdown);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filename: "/src/index.ts",
        startLine: 42,
        endLine: 45,
        severity: "high",
        commentType: "bug",
        text: "Potential null pointer",
        why: "Could cause runtime error",
        fix: "Add null check",
      });
    });

    it("extracts multiple comments from Markdown output", () => {
      const markdown = `### Comment

- **Filename:** /src/a.ts
- **Start line:** 1
- **End line:** 5
- **Severity:** low
- **Comment type:** compliment
- **Text:** Good code
- **Why:** Nice pattern
- **Fix:**

### Comment

- **Filename:** /src/b.ts
- **Start line:** 10
- **End line:** 15
- **Severity:** critical
- **Comment type:** bug
- **Text:** Security issue
- **Why:** SQL injection
- **Fix:** Use parameterized query`;

      const result = parseReviewMarkdown(markdown);

      expect(result).toHaveLength(2);
      expect(result[0]?.filename).toBe("/src/a.ts");
      expect(result[1]?.filename).toBe("/src/b.ts");
    });

    it("returns an empty array when there are no comments", () => {
      expect(parseReviewMarkdown("## Comments\n\nNo comments.")).toEqual([]);
      expect(parseReviewMarkdown("")).toEqual([]);
      expect(parseReviewMarkdown("plain text")).toEqual([]);
    });

    it("handles missing optional fields gracefully", () => {
      const markdown = `### Comment

- **Filename:** /src/test.ts
- **Start line:** 1
- **End line:** 2
- **Severity:** medium
- **Comment type:** suggested_edit
- **Text:** Minor tweak
- **Why:**
- **Fix:**`;

      const result = parseReviewMarkdown(markdown);

      expect(result).toHaveLength(1);
      expect(result[0]?.why).toBe("");
      expect(result[0]?.fix).toBe("");
    });

    it("handles malformed line numbers (defaults to 0)", () => {
      const markdown = `### Comment

- **Filename:** /src/test.ts
- **Start line:** invalid
- **End line:** also-invalid
- **Severity:** low
- **Comment type:** non_actionable
- **Text:** Test
- **Why:** Reason
- **Fix:**`;

      const result = parseReviewMarkdown(markdown);

      expect(result[0]?.startLine).toBe(0);
      expect(result[0]?.endLine).toBe(0);
    });
  });

  describe("formatReviewSummary", () => {
    it("formats single comment count", () => {
      const comments = [
        {
          filename: "/a.ts",
          startLine: 1,
          endLine: 2,
          severity: "high",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
      ];
      expect(formatReviewSummary(comments)).toBe("1 comment: 1 high");
    });

    it("formats multiple comments with severity grouping", () => {
      const comments = [
        {
          filename: "/a.ts",
          startLine: 1,
          endLine: 2,
          severity: "critical",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
        {
          filename: "/b.ts",
          startLine: 1,
          endLine: 2,
          severity: "high",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
        {
          filename: "/c.ts",
          startLine: 1,
          endLine: 2,
          severity: "high",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
        {
          filename: "/d.ts",
          startLine: 1,
          endLine: 2,
          severity: "low",
          commentType: "compliment",
          text: "",
          why: "",
          fix: "",
        },
      ];
      expect(formatReviewSummary(comments)).toBe(
        "4 comments: 1 critical, 2 high, 1 low",
      );
    });

    it("returns empty string for empty comments", () => {
      expect(formatReviewSummary([])).toBe("");
    });

    it("orders severities correctly (critical > high > medium > low)", () => {
      const comments = [
        {
          filename: "/a.ts",
          startLine: 1,
          endLine: 2,
          severity: "low",
          commentType: "compliment",
          text: "",
          why: "",
          fix: "",
        },
        {
          filename: "/b.ts",
          startLine: 1,
          endLine: 2,
          severity: "critical",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
        {
          filename: "/c.ts",
          startLine: 1,
          endLine: 2,
          severity: "medium",
          commentType: "bug",
          text: "",
          why: "",
          fix: "",
        },
      ];
      expect(formatReviewSummary(comments)).toBe(
        "3 comments: 1 critical, 1 medium, 1 low",
      );
    });
  });

  describe("config validators", () => {
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
        expect(isStringArray(["read", "grep", "bash"])).toBe(true);
        expect(isStringArray([])).toBe(true);
      });

      it("returns false for arrays with non-strings", () => {
        expect(isStringArray(["read", 123])).toBe(false);
        expect(isStringArray([null])).toBe(false);
        expect(isStringArray([{}])).toBe(false);
      });

      it("returns false for non-arrays", () => {
        expect(isStringArray("read")).toBe(false);
        expect(isStringArray(null)).toBe(false);
        expect(isStringArray({})).toBe(false);
      });
    });

    describe("isCodeReviewConfig", () => {
      it("validates complete config", () => {
        const valid = {
          model: CODE_REVIEW_DEFAULT_MODEL,
          builtinTools: ["read", "bash"],
          extensionTools: ["read", "web_search"],
          promptFile: "",
          promptString: "",
          reportPromptFile: "",
          reportPromptString: "",
        };
        expect(isCodeReviewConfig(valid)).toBe(true);
      });

      it("rejects empty model", () => {
        const invalid = {
          model: "",
          builtinTools: ["read"],
          extensionTools: ["read"],
          promptFile: "",
          promptString: "",
          reportPromptFile: "",
          reportPromptString: "",
        };
        expect(isCodeReviewConfig(invalid)).toBe(false);
      });

      it("rejects non-array tools", () => {
        const invalid = {
          model: "some-model",
          builtinTools: "read",
          extensionTools: ["read"],
          promptFile: "",
          promptString: "",
          reportPromptFile: "",
          reportPromptString: "",
        };
        expect(isCodeReviewConfig(invalid)).toBe(false);
      });
    });
  });

  // ============================================================================
  // EXTENSION REGISTRATION TESTS
  // ============================================================================

  describe("code-review extension (SDK integration)", () => {
    describe("resolveCodeReviewConfig", () => {
      it("resolves the effective tool config", () => {
        const config = {
          ...CONFIG_DEFAULTS,
          model: "provider/model",
          builtinTools: ["read"],
          extensionTools: ["grep"],
          promptString: "system source",
          promptFile: "system.md",
          reportPromptString: "report source",
          reportPromptFile: "report.md",
        };
        const resolvePrompt = vi.fn(
          (promptString: string, promptFile: string) =>
            `${promptString}:${promptFile}`,
        );

        const resolved = resolveCodeReviewConfig({
          getEnabledExtensionConfig: vi.fn(() => ({
            enabled: true,
            config,
          })) as any,
          resolvePrompt,
        });

        expect(resolved).toEqual({
          enabled: true,
          config: {
            systemPrompt: "system source:system.md",
            reportFormat: "report source:report.md",
            model: "provider/model",
            builtinTools: ["read"],
            extensionTools: ["grep"],
          },
        });
        expect(resolvePrompt).toHaveBeenCalledTimes(2);
      });

      it("does not resolve prompts when disabled", () => {
        const resolvePrompt = vi.fn();

        const resolved = resolveCodeReviewConfig({
          getEnabledExtensionConfig: vi.fn(() => ({
            enabled: false,
            config: CONFIG_DEFAULTS,
          })) as any,
          resolvePrompt,
        });

        expect(resolved.enabled).toBe(false);
        expect(resolved.config.systemPrompt).toBeUndefined();
        expect(resolved.config.reportFormat).toBeUndefined();
        expect(resolvePrompt).not.toHaveBeenCalled();
      });
    });

    describe("extension registration", () => {
      it("does not register anything when disabled", () => {
        const mockConfig = vi.fn(() => ({
          enabled: false,
          config: CONFIG_DEFAULTS,
        }));

        const ext = createCodeReviewExtension({
          ...DEFAULT_DEPS,
          getEnabledExtensionConfig: mockConfig as any,
        });

        const calls: string[] = [];
        const mockPi = {
          registerTool: () => calls.push("tool"),
        } as any;

        ext(mockPi);

        expect(calls).toHaveLength(0);
      });

      it("registers tool when enabled", () => {
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: CONFIG_DEFAULTS,
        }));

        const ext = createCodeReviewExtension({
          ...DEFAULT_DEPS,
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: () => "resolved prompt",
          withPromptPatch: (tool) => tool,
        });

        const tools: any[] = [];
        const mockPi = {
          registerTool: (tool: any) => tools.push(tool),
        } as any;

        ext(mockPi);

        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("code_review");
      });

      it("calls resolvePrompt for system and report prompts", () => {
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: CONFIG_DEFAULTS,
        }));
        const resolvePromptCalls: {
          promptString: string;
          promptFile: string;
        }[] = [];
        const mockResolvePrompt = (
          promptString: string,
          promptFile: string,
        ) => {
          resolvePromptCalls.push({ promptString, promptFile });
          return "resolved";
        };

        const ext = createCodeReviewExtension({
          ...DEFAULT_DEPS,
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: mockResolvePrompt,
          withPromptPatch: (tool) => tool,
        });

        const mockPi = {
          registerTool: () => {},
        } as any;

        ext(mockPi);

        expect(resolvePromptCalls).toHaveLength(2);
        expect(resolvePromptCalls[0]).toEqual({
          promptString: CONFIG_DEFAULTS.promptString,
          promptFile: CONFIG_DEFAULTS.promptFile,
        });
        expect(resolvePromptCalls[1]).toEqual({
          promptString: CONFIG_DEFAULTS.reportPromptString,
          promptFile: CONFIG_DEFAULTS.reportPromptFile,
        });
      });

      it("applies prompt patch to tool via withPromptPatch", () => {
        const mockConfig = vi.fn(() => ({
          enabled: true,
          config: CONFIG_DEFAULTS,
        }));
        let patchedTool: any = null;
        const mockWithPromptPatch = (tool: any) => {
          patchedTool = tool;
          return tool;
        };

        const ext = createCodeReviewExtension({
          ...DEFAULT_DEPS,
          getEnabledExtensionConfig: mockConfig as any,
          resolvePrompt: () => "prompt",
          withPromptPatch: mockWithPromptPatch,
        });

        const mockPi = {
          registerTool: () => {},
        } as any;

        ext(mockPi);

        expect(patchedTool).not.toBeNull();
        expect(patchedTool.name).toBe("code_review");
      });
    });

    describe("tool definition", () => {
      it("has correct name and description", () => {
        const tool = createCodeReviewTool();
        expect(tool.name).toBe("code_review");
        expect(tool.label).toBe("Code Review");
        expect(tool.description).toContain("Review code changes");
      });

      it("has required parameters in schema", () => {
        const tool = createCodeReviewTool();
        expect(tool.parameters.properties.diff_description).toBeDefined();
        expect(tool.parameters.properties.files).toBeDefined();
        expect(tool.parameters.properties.instructions).toBeDefined();
      });
    });

    describe("renderCall", () => {
      it("renders diff_description preview", () => {
        const tool = createCodeReviewTool();
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };

        const result = tool.renderCall!(
          { diff_description: "compare main to feature" },
          mockTheme as any,
          {} as any,
        );
        const lines = result.render(80);

        expect(lines.join("\n")).toContain("code_review");
        expect(lines.join("\n")).toContain("compare main to feature");
      });

      it("truncates long diff_description", () => {
        const tool = createCodeReviewTool();
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const longDesc = "a".repeat(100);

        const result = tool.renderCall!(
          { diff_description: longDesc },
          mockTheme as any,
          {} as any,
        );
        const lines = result.render(80);

        expect(lines.join("\n")).toContain("...");
      });

      it("shows file count when files provided", () => {
        const tool = createCodeReviewTool();
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };

        const result = tool.renderCall!(
          { diff_description: "test", files: ["/a.ts", "/b.ts", "/c.ts"] },
          mockTheme as any,
          {} as any,
        );
        const lines = result.render(80);

        expect(lines.join("\n")).toContain("3 files");
      });
    });

    describe("renderResult", () => {
      it("renders review summary from Markdown", () => {
        const tool = createCodeReviewTool();
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };

        const markdownOutput = `### Comment

- **Filename:** /src/a.ts
- **Start line:** 1
- **End line:** 5
- **Severity:** high
- **Comment type:** bug
- **Text:** Issue
- **Why:** Reason
- **Fix:** Fix`;

        const result = tool.renderResult!(
          {
            content: [{ type: "text", text: markdownOutput }],
            details: {
              agent: "code_review",
              task: "test",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: markdownOutput }],
                },
              ],
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          },
          { expanded: false, isPartial: false },
          mockTheme as any,
          {} as any,
        );

        const lines = (result as any).children[0].render(80);
        expect(lines.join("\n")).toContain("1 comment");
      });

      it("handles result without details", () => {
        const tool = createCodeReviewTool();
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };

        const result = tool.renderResult!(
          {
            content: [{ type: "text", text: "plain text output" }],
            details: undefined,
          },
          { expanded: false, isPartial: false },
          mockTheme as any,
          {} as any,
        );

        const lines = result.render(80);
        expect(lines[0]).toContain("plain text output");
      });
    });
  });
}
