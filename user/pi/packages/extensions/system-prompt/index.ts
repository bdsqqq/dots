/**
 * system-prompt — injects interpolated prompt.amp.system.md into the agent's system prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * the full amp system prompt with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses before_agent_start return value { systemPrompt } to modify the
 * system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} is populated by reading the
 * appropriate harness docs file (prompt.harness-docs.<harness>.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { interpolatePromptVars } from "@bds_pi/interpolate";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { resolvePrompt } from "@bds_pi/pi-spawn";

type SystemPromptExtConfig = {
  identity: string;
  harness: string;
  promptFile: string;
  promptString: string;
  harnessDocsPromptFile: string;
  harnessDocsPromptString: string;
};

type SystemPromptExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
};

const CONFIG_DEFAULTS: SystemPromptExtConfig = {
  identity: "Amp",
  harness: "pi",
  promptFile: "prompt.amp.system.md",
  promptString: "",
  harnessDocsPromptFile: "",
  harnessDocsPromptString: "",
};

const DEFAULT_DEPS: SystemPromptExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSystemPromptConfig(value: Record<string, unknown>): value is SystemPromptExtConfig {
  return (
    isNonEmptyString(value.identity) &&
    isNonEmptyString(value.harness) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.harnessDocsPromptFile === "string" &&
    typeof value.harnessDocsPromptString === "string"
  );
}

const SYSTEM_PROMPT_CONFIG_SCHEMA: ExtensionConfigSchema<SystemPromptExtConfig> = {
  validate: isSystemPromptConfig,
};

function createSystemPromptExtension(deps: SystemPromptExtensionDeps = DEFAULT_DEPS) {
  return function systemPromptExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/system-prompt",
      CONFIG_DEFAULTS,
      { schema: SYSTEM_PROMPT_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const body = deps.resolvePrompt(cfg.promptString, cfg.promptFile);
    if (!body) return;

    const harnessDocsFile = cfg.harnessDocsPromptFile || `prompt.harness-docs.${cfg.harness}.md`;
    const harnessDocs = deps.resolvePrompt(cfg.harnessDocsPromptString, harnessDocsFile);

    pi.on("before_agent_start", async (event, ctx) => {
      const interpolated = interpolatePromptVars(body, ctx.cwd, {
        sessionId: ctx.sessionManager.getSessionId(),
        identity: cfg.identity,
        harness: cfg.harness,
        harnessDocsSection: harnessDocs,
      });

      if (!interpolated.trim()) return;

      return {
        systemPrompt: event.systemPrompt + "\n\n" + interpolated,
      };
    });
  };
}

const systemPromptExtension: (pi: ExtensionAPI) => void = createSystemPromptExtension();

export default systemPromptExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();

    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("system-prompt extension", () => {
    it("registers before_agent_start with default config when enabled", () => {
      setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn((promptString: string, promptFile: string) =>
        promptString || (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
      );
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
      expect(resolvePromptSpy).toHaveBeenNthCalledWith(
        1,
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
    });

    it("registers no handlers when disabled", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/system-prompt": { enabled: false },
      });
      setGlobalSettingsPath(settingsPath);
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn(() => "body");
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect(harness.handlers.size).toBe(0);
      expect(resolvePromptSpy).not.toHaveBeenCalled();
    });

    it("falls back to defaults when config is invalid and still registers before_agent_start", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/system-prompt": {
          identity: "",
          harness: "",
          promptFile: 123,
          promptString: false,
          harnessDocsPromptFile: null,
          harnessDocsPromptString: 42,
        },
      });
      setGlobalSettingsPath(settingsPath);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn((promptString: string, promptFile: string) =>
        promptString || (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
      );
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);

      expect([...harness.handlers.keys()]).toEqual(["before_agent_start"]);
      expect(resolvePromptSpy).toHaveBeenNthCalledWith(
        1,
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
    });
  });
}
