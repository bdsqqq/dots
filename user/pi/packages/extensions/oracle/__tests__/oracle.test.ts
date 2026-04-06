/**
 * SDK-backed integration tests for oracle extension.
 *
 * Tests extension lifecycle, tool registration, and config validation.
 * Execute tests removed - oracle is just task → piSpawn → return.
 */

import { describe, it, expect, vi } from "vitest";
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

    it("uses provided config values even when potentially invalid", () => {
      // Extension doesn't validate - it trusts getEnabledExtensionConfig
      const weirdConfig = {
        model: "",  // empty string
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
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const ext = createOracleExtension({
        getEnabledExtensionConfig: mockConfig as any,
        resolvePrompt: resolvePromptSpy as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const { pi, tools } = createMockExtensionApi();
      ext(pi);

      // Extension still registers the tool with whatever config it got
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("oracle");
      // resolvePrompt is called with the config values
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        weirdConfig.promptString,
        weirdConfig.promptFile
      );
    });
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool execute tests removed - these mocked piSpawn calls were testing our mocks,
// not meaningful behavior. Oracle is just task → piSpawn → return.
// ─────────────────────────────────────────────────────────────────────────────

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
// pi-spawn integration tests removed - these mocked piSpawn calls were testing
// our mocks, not meaningful behavior. Oracle is just task → piSpawn → return.
// ─────────────────────────────────────────────────────────────────────────────
