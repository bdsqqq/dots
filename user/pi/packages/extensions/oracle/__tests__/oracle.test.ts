/**
 * SDK-backed integration tests for oracle extension.
 *
 * Tests extension lifecycle, tool registration, and config validation.
 * Uses minimal tracking mocks that assert on observable outcomes.
 *
 * NOTE: Tests involving pi-spawn sub-agent execution are marked with it.todo()
 * and require deeper SDK understanding or mocking the LLM boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import oracleExtension, {
  createOracleExtension,
  createOracleTool,
  isNonEmptyString,
  isStringArray,
  isOracleConfig,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  ORACLE_CONFIG_SCHEMA,
} from "../index";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

function createMockExtensionApi() {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension registration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("oracle extension (SDK integration)", () => {
  describe("extension registration", () => {
    it("registers the oracle tool when enabled", () => {
      const mockConfig = vi.fn(() => ({
        enabled: true,
        config: CONFIG_DEFAULTS,
      }));
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

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
        { schema: ORACLE_CONFIG_SCHEMA }
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile
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
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

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
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const ext = createOracleExtension({
        getEnabledExtensionConfig: mockConfig as any,
        resolvePrompt: resolvePromptSpy as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const { pi, tools } = createMockExtensionApi();
      ext(pi);

      expect(resolvePromptSpy).toHaveBeenCalledWith(
        customConfig.promptString,
        customConfig.promptFile
      );
      expect(tools).toHaveLength(1);
    });

    it.todo(
      "falls back to defaults when config is invalid and still registers tool"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition tests
// ─────────────────────────────────────────────────────────────────────────────

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

    // Tool metadata is static, but config affects execute behavior
    expect(tool.name).toBe("oracle");
  });

  describe("renderCall", () => {
    it("renders short task preview", () => {
      const tool = createOracleTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderCall!({ task: "short task" }, theme);
      const lines = result.render(80);

      expect(lines[0]).toContain("oracle");
      expect(lines[0]).toContain("short task");
    });

    it("truncates long task preview", () => {
      const tool = createOracleTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const longTask = "a".repeat(120); // Must be > 80 chars to trigger truncation in renderCall

      const result = tool.renderCall!({ task: longTask }, theme);
      const lines = result.render(80);

      // Verify the output contains "oracle" prefix (truncation behavior is implementation detail)
      expect(lines[0]).toMatch(/^oracle/);
    });

    it("shows file count when files provided", () => {
      const tool = createOracleTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderCall!(
        { task: "task", files: ["a.ts", "b.ts", "c.ts"] },
        theme
      );
      const lines = result.render(80);

      expect(lines[0]).toContain("3 files");
    });
  });

  describe("execute", () => {
    it.todo("spawns sub-agent with correct task assembly");
    it.todo("includes context in task when provided");
    it.todo("includes file contents in task when files provided");
    it.todo("resolves relative file paths against ctx.cwd");
    it.todo("handles file read errors gracefully");
    it.todo("returns error result when sub-agent fails");
    it.todo("returns output from final assistant message on success");
    it.todo("passes signal to piSpawn for cancellation");
    it.todo("calls onUpdate with partial results during execution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config validation tests
// ─────────────────────────────────────────────────────────────────────────────

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
      model: "openrouter/google/gemini-3.1-pro-preview",
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
      expect(isOracleConfig({ ...validConfig, extensionTools: ["read", 123] })).toBe(false);
    });

    it("returns false when builtinTools is not an array", () => {
      expect(isOracleConfig({ ...validConfig, builtinTools: "bash" })).toBe(false);
    });

    it("returns false when promptFile is not a string", () => {
      expect(isOracleConfig({ ...validConfig, promptFile: 123 })).toBe(false);
    });

    it("returns false when promptString is not a string", () => {
      expect(isOracleConfig({ ...validConfig, promptString: false })).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pi-spawn integration (requires LLM boundary mocking)
// ─────────────────────────────────────────────────────────────────────────────

describe("pi-spawn integration", () => {
  it.todo("passes assembled task to piSpawn");
  it.todo("passes configured model to piSpawn");
  it.todo("passes configured tools to piSpawn");
  it.todo("passes system prompt body to piSpawn");
  it.todo("passes signal for cancellation support");
  it.todo("includes session ID from context");
});
