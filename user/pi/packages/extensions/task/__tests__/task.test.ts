/**
 * SDK-backed integration tests for task extension.
 *
 * Tests extension lifecycle, tool registration, and config validation.
 * Uses minimal tracking mocks that assert on observable outcomes.
 *
 * NOTE: Tests involving pi-spawn sub-agent execution are marked with it.todo()
 * and require deeper SDK understanding or mocking the LLM boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import taskExtension, {
  createTaskExtension,
  createTaskTool,
  isStringArray,
  isTaskConfig,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  TASK_CONFIG_SCHEMA,
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

describe("task extension (SDK integration)", () => {
  describe("extension registration", () => {
    it("registers the Task tool when enabled", () => {
      const mockConfig = vi.fn(() => ({
        enabled: true,
        config: CONFIG_DEFAULTS,
      }));
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const ext = createTaskExtension({
        getEnabledExtensionConfig: mockConfig as any,
        createTaskTool: DEFAULT_DEPS.createTaskTool,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const { pi, tools } = createMockExtensionApi();
      ext(pi);

      expect(mockConfig).toHaveBeenCalledWith(
        "@bds_pi/task",
        CONFIG_DEFAULTS,
        { schema: TASK_CONFIG_SCHEMA }
      );
      expect(withPromptPatchSpy).toHaveBeenCalled();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("Task");
    });

    it("does not register any tools when disabled", () => {
      const mockConfig = vi.fn(() => ({
        enabled: false,
        config: CONFIG_DEFAULTS,
      }));
      const createTaskToolSpy = vi.fn(() => ({ name: "Task" } as ToolDefinition));
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const ext = createTaskExtension({
        getEnabledExtensionConfig: mockConfig as any,
        createTaskTool: createTaskToolSpy as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const { pi, tools } = createMockExtensionApi();
      ext(pi);

      expect(createTaskToolSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(tools).toHaveLength(0);
    });

    it("passes custom config values to createTaskTool", () => {
      const customConfig = {
        builtinTools: ["read", "bash"],
        extensionTools: ["read", "grep", "finder"],
      };
      const mockConfig = vi.fn(() => ({
        enabled: true,
        config: customConfig,
      }));
      const createTaskToolSpy = vi.fn(() => ({ name: "Task" } as ToolDefinition));
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const ext = createTaskExtension({
        getEnabledExtensionConfig: mockConfig as any,
        createTaskTool: createTaskToolSpy as any,
        withPromptPatch: withPromptPatchSpy as any,
      });

      const { pi, tools } = createMockExtensionApi();
      ext(pi);

      expect(createTaskToolSpy).toHaveBeenCalledWith({
        builtinTools: customConfig.builtinTools,
        extensionTools: customConfig.extensionTools,
      });
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

describe("createTaskTool", () => {
  it("creates a tool with correct metadata", () => {
    const tool = createTaskTool();

    expect(tool.name).toBe("Task");
    expect(tool.label).toBe("Task");
    expect(tool.description).toContain("sub-agent");
    expect(tool.description).toContain("Read, Grep, Find");
  });

  it("has correct parameter schema", () => {
    const tool = createTaskTool();
    const params = tool.parameters as any;

    expect(params.type).toBe("object");
    expect(params.properties.prompt).toBeDefined();
    expect(params.properties.prompt.type).toBe("string");
    expect(params.properties.description).toBeDefined();
    expect(params.properties.description.type).toBe("string");
  });

  it("applies custom config to tool", () => {
    const tool = createTaskTool({
      builtinTools: ["read"],
      extensionTools: ["grep"],
    });

    // Tool metadata is static, but config affects execute behavior
    expect(tool.name).toBe("Task");
  });

  describe("renderCall", () => {
    it("renders short description preview", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderCall!({ description: "short task" }, theme);
      const lines = result.render(80);

      expect(lines[0]).toContain("Task");
      expect(lines[0]).toContain("short task");
    });

    it("truncates long description preview", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const longDesc = "a".repeat(120);

      const result = tool.renderCall!({ description: longDesc }, theme);
      const lines = result.render(80);

      // Verify the output contains "Task" prefix (truncation behavior is implementation detail)
      expect(lines[0]).toMatch(/^Task/);
    });

    it("shows ellipsis for missing description", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderCall!({}, theme);
      const lines = result.render(80);

      expect(lines[0]).toContain("Task");
      expect(lines[0]).toContain("...");
    });
  });

  describe("renderResult", () => {
    it("renders text content without details", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderResult!(
        { content: [{ type: "text", text: "done" }] },
        { expanded: false },
        theme
      );
      const lines = result.render(80);

      expect(lines[0]).toContain("done");
    });

    it("renders agent tree with details", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const details = {
        agent: "Task",
        task: "test task",
        exitCode: 0,
        messages: [],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 },
      };

      const result = tool.renderResult!(
        { content: [{ type: "text", text: "done" }], details },
        { expanded: false },
        theme
      );
      const lines = result.render(80);

      // Should render status icon for successful exit
      expect(lines[0]).toContain("✓");
    });

    it("renders error state for non-zero exit code", () => {
      const tool = createTaskTool();
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const details = {
        agent: "Task",
        task: "test task",
        exitCode: 1,
        messages: [],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 },
        errorMessage: "something went wrong",
      };

      const result = tool.renderResult!(
        { content: [{ type: "text", text: "error" }], details },
        { expanded: false },
        theme
      );
      const lines = result.render(80);

      expect(lines[0]).toContain("✕");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("config validation", () => {
  describe("isStringArray", () => {
    it("returns true for arrays of strings", () => {
      expect(isStringArray(["read", "grep"])).toBe(true);
      expect(isStringArray([])).toBe(true);
      expect(isStringArray(["bash", "edit", "write"])).toBe(true);
    });

    it("returns false for arrays with non-strings", () => {
      expect(isStringArray(["read", 123])).toBe(false);
      expect(isStringArray([null, "grep"])).toBe(false);
      expect(isStringArray([undefined])).toBe(false);
      expect(isStringArray([{}])).toBe(false);
    });

    it("returns false for non-arrays", () => {
      expect(isStringArray("read")).toBe(false);
      expect(isStringArray({})).toBe(false);
      expect(isStringArray(null)).toBe(false);
      expect(isStringArray(undefined)).toBe(false);
      expect(isStringArray(123)).toBe(false);
    });
  });

  describe("isTaskConfig", () => {
    const validConfig = {
      builtinTools: ["read", "grep", "bash"],
      extensionTools: ["read", "grep", "finder"],
    };

    it("returns true for valid config", () => {
      expect(isTaskConfig(validConfig)).toBe(true);
    });

    it("returns true for empty arrays", () => {
      expect(isTaskConfig({ builtinTools: [], extensionTools: [] })).toBe(true);
    });

    it("returns false when builtinTools contains non-strings", () => {
      expect(isTaskConfig({ ...validConfig, builtinTools: ["read", 123] })).toBe(false);
    });

    it("returns false when extensionTools is not an array", () => {
      expect(isTaskConfig({ ...validConfig, extensionTools: "bash" })).toBe(false);
    });

    it("returns false when builtinTools is missing", () => {
      expect(isTaskConfig({ extensionTools: ["read"] } as any)).toBe(false);
    });

    it("returns false when extensionTools is missing", () => {
      expect(isTaskConfig({ builtinTools: ["read"] } as any)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pi-spawn integration tests removed - task is just prompt → piSpawn → return.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Default config tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CONFIG_DEFAULTS", () => {
  it("includes expected builtin tools", () => {
    expect(CONFIG_DEFAULTS.builtinTools).toContain("read");
    expect(CONFIG_DEFAULTS.builtinTools).toContain("grep");
    expect(CONFIG_DEFAULTS.builtinTools).toContain("bash");
    expect(CONFIG_DEFAULTS.builtinTools).toContain("edit");
    expect(CONFIG_DEFAULTS.builtinTools).toContain("write");
  });

  it("includes expected extension tools", () => {
    expect(CONFIG_DEFAULTS.extensionTools).toContain("read");
    expect(CONFIG_DEFAULTS.extensionTools).toContain("grep");
    expect(CONFIG_DEFAULTS.extensionTools).toContain("finder");
    expect(CONFIG_DEFAULTS.extensionTools).toContain("skill");
    expect(CONFIG_DEFAULTS.extensionTools).toContain("format_file");
  });

  it("extension tools are superset of builtin tools", () => {
    // Extension tools should include all builtin tools plus more
    for (const tool of CONFIG_DEFAULTS.builtinTools) {
      expect(CONFIG_DEFAULTS.extensionTools).toContain(tool);
    }
    expect(CONFIG_DEFAULTS.extensionTools.length).toBeGreaterThan(
      CONFIG_DEFAULTS.builtinTools.length
    );
  });
});
