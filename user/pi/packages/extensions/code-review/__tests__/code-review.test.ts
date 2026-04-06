/**
 * SDK-backed integration tests for code-review extension.
 *
 * Tests tool registration, config validation, and diff description parsing.
 * Uses minimal tracking mocks to verify observable outcomes.
 *
 * For pi-spawn/sub-agent execution tests, see it.todo() entries below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import codeReviewExtension, {
  createCodeReviewExtension,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  CODE_REVIEW_CONFIG_SCHEMA,
  parseReviewXml,
  formatReviewSummary,
  isCodeReviewConfig,
  isNonEmptyString,
  isStringArray,
  createCodeReviewTool,
} from "../index";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

// ============================================================================
// PURE FUNCTION TESTS
// ============================================================================

describe("parseReviewXml", () => {
  it("extracts single comment from XML output", () => {
    const xml = `<codeReview>
<comment>
  <filename>/src/index.ts</filename>
  <startLine>42</startLine>
  <endLine>45</endLine>
  <severity>high</severity>
  <commentType>bug</commentType>
  <text>Potential null pointer</text>
  <why>Could cause runtime error</why>
  <fix>Add null check</fix>
</comment>
</codeReview>`;

    const result = parseReviewXml(xml);

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

  it("extracts multiple comments from XML output", () => {
    const xml = `<codeReview>
<comment>
  <filename>/src/a.ts</filename>
  <startLine>1</startLine>
  <endLine>5</endLine>
  <severity>low</severity>
  <commentType>compliment</commentType>
  <text>Good code</text>
  <why>Nice pattern</why>
  <fix></fix>
</comment>
<comment>
  <filename>/src/b.ts</filename>
  <startLine>10</startLine>
  <endLine>15</endLine>
  <severity>critical</severity>
  <commentType>bug</commentType>
  <text>Security issue</text>
  <why>SQL injection</why>
  <fix>Use parameterized query</fix>
</comment>
</codeReview>`;

    const result = parseReviewXml(xml);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe("/src/a.ts");
    expect(result[1].filename).toBe("/src/b.ts");
  });

  it("returns empty array for XML with no comments", () => {
    expect(parseReviewXml("<codeReview></codeReview>")).toEqual([]);
    expect(parseReviewXml("")).toEqual([]);
    expect(parseReviewXml("no xml here")).toEqual([]);
  });

  it("handles missing optional fields gracefully", () => {
    const xml = `<comment>
  <filename>/src/test.ts</filename>
  <startLine>1</startLine>
  <endLine>2</endLine>
  <severity>medium</severity>
  <commentType>suggested_edit</commentType>
  <text>Minor tweak</text>
  <why></why>
  <fix></fix>
</comment>`;

    const result = parseReviewXml(xml);

    expect(result).toHaveLength(1);
    expect(result[0].why).toBe("");
    expect(result[0].fix).toBe("");
  });

  it("handles malformed line numbers (defaults to 0)", () => {
    const xml = `<comment>
  <filename>/src/test.ts</filename>
  <startLine>invalid</startLine>
  <endLine>also-invalid</endLine>
  <severity>low</severity>
  <commentType>non_actionable</commentType>
  <text>Test</text>
  <why>Reason</why>
  <fix></fix>
</comment>`;

    const result = parseReviewXml(xml);

    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(0);
  });
});

describe("formatReviewSummary", () => {
  it("formats single comment count", () => {
    const comments = [
      { filename: "/a.ts", startLine: 1, endLine: 2, severity: "high", commentType: "bug", text: "", why: "", fix: "" },
    ];
    expect(formatReviewSummary(comments)).toBe("1 comment: 1 high");
  });

  it("formats multiple comments with severity grouping", () => {
    const comments = [
      { filename: "/a.ts", startLine: 1, endLine: 2, severity: "critical", commentType: "bug", text: "", why: "", fix: "" },
      { filename: "/b.ts", startLine: 1, endLine: 2, severity: "high", commentType: "bug", text: "", why: "", fix: "" },
      { filename: "/c.ts", startLine: 1, endLine: 2, severity: "high", commentType: "bug", text: "", why: "", fix: "" },
      { filename: "/d.ts", startLine: 1, endLine: 2, severity: "low", commentType: "compliment", text: "", why: "", fix: "" },
    ];
    expect(formatReviewSummary(comments)).toBe("4 comments: 1 critical, 2 high, 1 low");
  });

  it("returns empty string for empty comments", () => {
    expect(formatReviewSummary([])).toBe("");
  });

  it("orders severities correctly (critical > high > medium > low)", () => {
    const comments = [
      { filename: "/a.ts", startLine: 1, endLine: 2, severity: "low", commentType: "compliment", text: "", why: "", fix: "" },
      { filename: "/b.ts", startLine: 1, endLine: 2, severity: "critical", commentType: "bug", text: "", why: "", fix: "" },
      { filename: "/c.ts", startLine: 1, endLine: 2, severity: "medium", commentType: "bug", text: "", why: "", fix: "" },
    ];
    expect(formatReviewSummary(comments)).toBe("3 comments: 1 critical, 1 medium, 1 low");
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
        model: "openrouter/google/gemini-3.1-pro-preview",
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
  describe("extension registration", () => {
    it("does not register anything when disabled", () => {
      const mockConfig = vi.fn(() => ({ enabled: false, config: CONFIG_DEFAULTS }));

      const ext = createCodeReviewExtension({
        ...DEFAULT_DEPS,
        getEnabledExtensionConfig: mockConfig as any,
      });

      const calls: string[] = [];
      const mockPi = {
        registerTool: () => calls.push("tool"),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(calls).toHaveLength(0);
    });

    it("registers tool when enabled", () => {
      const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));

      const ext = createCodeReviewExtension({
        ...DEFAULT_DEPS,
        getEnabledExtensionConfig: mockConfig as any,
        resolvePrompt: () => "resolved prompt",
        withPromptPatch: (tool) => tool,
      });

      const tools: ToolDefinition[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("code_review");
    });

    it("calls resolvePrompt for system and report prompts", () => {
      const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));
      const resolvePromptCalls: { promptString: string; promptFile: string }[] = [];
      const mockResolvePrompt = (promptString: string, promptFile: string) => {
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
      } as unknown as ExtensionAPI;

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
      const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));
      let patchedTool: ToolDefinition | null = null;
      const mockWithPromptPatch = (tool: ToolDefinition) => {
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
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(patchedTool).not.toBeNull();
      expect(patchedTool!.name).toBe("code_review");
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

      const result = tool.renderCall!({ diff_description: "compare main to feature" }, mockTheme);
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

      const result = tool.renderCall!({ diff_description: longDesc }, mockTheme);
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
        mockTheme,
      );
      const lines = result.render(80);

      expect(lines.join("\n")).toContain("3 files");
    });
  });

  describe("renderResult", () => {
    it("renders review summary from XML", () => {
      const tool = createCodeReviewTool();
      const mockTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const xmlOutput = `<codeReview>
<comment>
  <filename>/src/a.ts</filename>
  <startLine>1</startLine>
  <endLine>5</endLine>
  <severity>high</severity>
  <commentType>bug</commentType>
  <text>Issue</text>
  <why>Reason</why>
  <fix>Fix</fix>
</comment>
</codeReview>`;

      const result = tool.renderResult!(
        {
          content: [{ type: "text", text: xmlOutput }],
          details: {
            agent: "code_review",
            task: "test",
            exitCode: 0,
            messages: [{ role: "assistant", content: [{ type: "text", text: xmlOutput }] }],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          },
        },
        { expanded: false },
        mockTheme,
      );

      const lines = result.render(80);
      expect(lines.join("\n")).toContain("1 comment");
    });

    it("handles result without details", () => {
      const tool = createCodeReviewTool();
      const mockTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderResult!(
        { content: [{ type: "text", text: "plain text output" }] },
        { expanded: false },
        mockTheme,
      );

      const lines = result.render(80);
      // Text component pads output to fill width, so check it contains the expected text
      expect(lines[0]).toContain("plain text output");
    });
  });

  // ============================================================================
  // PI-SPAWN / SUB-AGENT TESTS removed
  // ============================================================================
  // Removed it.todo() entries - code-review execute is just params → piSpawn → return.
  // Kept: parseReviewXml, formatReviewSummary (meaningful parsing/formatting logic)
});
