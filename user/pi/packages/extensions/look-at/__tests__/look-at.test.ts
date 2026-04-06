/**
 * SDK-backed integration tests for look-at extension.
 *
 * Tests extension lifecycle, tool registration, and config handling.
 * Uses minimal tracking mocks instead of homemade harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  createLookAtExtension,
  createLookAtTool,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  LOOK_AT_CONFIG_SCHEMA,
} from "../index";
import {
  clearConfigCache,
  setGlobalSettingsPath,
} from "@bds_pi/config";

const tmpdir = os.tmpdir();

function writeTmpJson(dir: string, filename: string, data: unknown): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

describe("look-at extension (SDK integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("extension registration", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const resolvePromptSpy = vi.fn(() => "system prompt");
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);

      const extension = createLookAtExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });

      const tools: ToolDefinition[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      } as unknown as ExtensionAPI;

      extension(mockPi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/look-at",
        CONFIG_DEFAULTS,
        { schema: LOOK_AT_CONFIG_SCHEMA },
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("look_at");
    });

    it("registers no tools when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );

      const extension = createLookAtExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: vi.fn(),
        withPromptPatch: vi.fn((tool) => tool),
      });

      const tools: ToolDefinition[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      } as unknown as ExtensionAPI;

      extension(mockPi);

      expect(tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-look-at-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/look-at": {
          model: "",
          extensionTools: ["read", 123],
          builtinTools: "ls",
          promptFile: 123,
          promptString: false,
        },
      });
      setGlobalSettingsPath(settingsPath);

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const extension = createLookAtExtension({
        ...DEFAULT_DEPS,
      });

      const tools: ToolDefinition[] = [];
      const mockPi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      } as unknown as ExtensionAPI;

      extension(mockPi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/look-at; falling back to defaults.",
      );
      expect(tools).toHaveLength(1);
    });
  });

  describe("createLookAtTool", () => {
    it("creates tool with expected metadata", () => {
      const tool = createLookAtTool();

      expect(tool.name).toBe("look_at");
      expect(tool.label).toBe("Look At");
      expect(tool.description).toContain("Extract specific information");
      expect(tool.parameters).toBeDefined();
    });

    it("accepts custom config", () => {
      const tool = createLookAtTool({
        model: "custom-model",
        systemPrompt: "custom prompt",
        extensionTools: ["custom-tool"],
        builtinTools: ["bash"],
      });

      expect(tool.name).toBe("look_at");
    });
  });

  describe("config validation", () => {
    it("validates LOOK_AT_CONFIG_SCHEMA accepts valid config", () => {
      expect(
        LOOK_AT_CONFIG_SCHEMA.validate!({
          model: "gpt-4",
          extensionTools: ["read"],
          builtinTools: ["ls"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);
    });

    it("rejects empty model", () => {
      expect(
        LOOK_AT_CONFIG_SCHEMA.validate!({
          model: "",
          extensionTools: ["read"],
          builtinTools: ["ls"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("rejects non-array tools", () => {
      expect(
        LOOK_AT_CONFIG_SCHEMA.validate!({
          model: "gpt-4",
          extensionTools: "read",
          builtinTools: ["ls"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });
  });

});
