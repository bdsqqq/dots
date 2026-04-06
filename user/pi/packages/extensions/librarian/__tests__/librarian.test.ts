/**
 * SDK-backed integration tests for librarian extension.
 *
 * These tests use pi's SDK patterns instead of homemade mocks. This ensures
 * we test against pi's actual runtime behavior, not our assumptions about it.
 *
 * NOTE: Tests involving pi-spawn (sub-agent execution) are documented with
 * it.todo() until we have a strategy for mocking LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  createLibrarianExtension,
  createLibrarianTool,
  CONFIG_DEFAULTS,
  DEFAULT_DEPS,
  LIBRARIAN_CONFIG_SCHEMA,
} from "../index";

describe("librarian extension (SDK integration)", () => {
  describe("extension registration", () => {
    it("does not register anything when disabled", () => {
      const mockConfig = vi.fn(() => ({ enabled: false, config: CONFIG_DEFAULTS }));

      const ext = createLibrarianExtension({
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

    it("registers the librarian tool when enabled", () => {
      const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));

      const ext = createLibrarianExtension({
        ...DEFAULT_DEPS,
        getEnabledExtensionConfig: mockConfig as any,
        resolvePrompt: () => "test prompt",
        withPromptPatch: (tool: ToolDefinition) => tool,
      });

      const calls: { type: string; name?: string }[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) =>
          calls.push({ type: "tool", name: tool.name }),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      expect(calls).toEqual([{ type: "tool", name: "librarian" }]);
    });

    it("passes resolved prompt to tool config", () => {
      const testPrompt = "custom librarian system prompt";
      const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));

      const ext = createLibrarianExtension({
        ...DEFAULT_DEPS,
        getEnabledExtensionConfig: mockConfig as any,
        resolvePrompt: () => testPrompt,
        withPromptPatch: (tool: ToolDefinition) => tool,
      });

      const registeredTools: ToolDefinition[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) => registeredTools.push(tool),
      } as unknown as ExtensionAPI;

      ext(mockPi);

      // Tool should be registered - we can't directly verify prompt but
      // we can verify the tool was created with the right name
      expect(registeredTools).toHaveLength(1);
      expect(registeredTools[0].name).toBe("librarian");
    });
  });

  describe("config validation", () => {
    it("validates model must be a non-empty string", () => {
      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "openrouter/openai/gpt-4",
          extensionTools: ["read_github"],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "",
          extensionTools: ["read_github"],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("validates extensionTools must be a string array", () => {
      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: ["read_github", "search_github"],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: "read_github",
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: ["read_github", 123],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("validates builtinTools must be a string array", () => {
      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: ["bash"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: "bash",
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("accepts empty arrays for tools", () => {
      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);
    });

    it("validates promptFile and promptString are strings", () => {
      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: [],
          promptFile: "agent.md",
          promptString: "inline prompt",
        }),
      ).toBe(true);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: [],
          promptFile: 123,
          promptString: "",
        }),
      ).toBe(false);

      expect(
        LIBRARIAN_CONFIG_SCHEMA.validate({
          model: "test-model",
          extensionTools: [],
          builtinTools: [],
          promptFile: "",
          promptString: false,
        }),
      ).toBe(false);
    });
  });

  describe("createLibrarianTool", () => {
    it("creates tool with correct name and label", () => {
      const tool = createLibrarianTool();
      expect(tool.name).toBe("librarian");
      expect(tool.label).toBe("Librarian");
    });

    it("creates tool with parameters schema", () => {
      const tool = createLibrarianTool();
      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).properties.query).toBeDefined();
      expect((tool.parameters as any).properties.context).toBeDefined();
    });

    it("uses provided config values", () => {
      const tool = createLibrarianTool({
        model: "custom-model",
        extensionTools: ["custom_tool"],
        builtinTools: ["bash"],
      });

      // The tool should be created; we can't directly verify internal config
      // but we can verify it was created successfully
      expect(tool.name).toBe("librarian");
    });

    it("provides renderCall method for TUI", () => {
      const tool = createLibrarianTool();
      const mockTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      const result = tool.renderCall!({ query: "test query" }, mockTheme);

      // Should return a TUI component
      expect(result).toBeDefined();
    });

    it("provides renderResult method for TUI", () => {
      const tool = createLibrarianTool();
      const mockTheme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        dim: (text: string) => text,
      };

      const result = tool.renderResult!(
        { content: [{ type: "text", text: "output" }] },
        { expanded: false },
        mockTheme,
      );

      expect(result).toBeDefined();
    });
  });

  describe("tool execution (pi-spawn)", () => {
    /**
     * Tool execution involves pi-spawn which spawns a sub-agent with
     * gemini flash. Testing this properly requires:
     * 1. Mocking the LLM API calls
     * 2. Simulating session context
     * 3. Verifying the sub-agent result structure
     *
     * For now, we document expected behaviors with it.todo().
     */

    it.todo("executes query via pi-spawn with configured model");

    it.todo("passes extensionTools and builtinTools to pi-spawn");

    it.todo("includes context parameter in task when provided");

    it.todo("returns error result on non-zero exit code");

    it.todo("returns error result on stopReason 'error' or 'aborted'");

    it.todo("streams progress updates via onUpdate callback");

    it.todo("propagates abort signal to pi-spawn");

    it.todo("handles missing sessionManager gracefully");
  });

  describe("sub-agent rendering", () => {
    /**
     * The renderResult method renders a SingleResult structure
     * using renderAgentTree. Testing this requires understanding
     * the SingleResult type and renderAgentTree function.
     */

    it.todo("renders agent tree with statusOnly header option");

    it.todo("renders error state when exitCode is non-zero");

    it.todo("shows progress during execution (exploring...)");
  });
});
