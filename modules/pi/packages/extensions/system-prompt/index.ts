/**
 * system-prompt — injects an extended system prompt body into pi's agent prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * a configurable body with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses before_agent_start return value { systemPrompt } to modify the
 * system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} comes from inline defaults unless
 * config overrides provide prompt content explicitly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const DEFAULT_SYSTEM_PROMPT_BODY = String.raw`You are {identity}.

# Environment

Today's date: {date}

Working directory: {cwd}

Workspace root folder: {wsroot}

Operating system: {os}

Repository: {repo}

Session ID: {sessionId}

## Directory listing
List of files (top-level only) in the user's workspace:
{ls}`;

const CONFIG_DEFAULTS: SystemPromptExtConfig = {
  identity: "Pi",
  harness: "pi",
  promptFile: "",
  promptString: DEFAULT_SYSTEM_PROMPT_BODY,
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

function isSystemPromptConfig(
  value: Record<string, unknown>,
): value is SystemPromptExtConfig {
  return (
    isNonEmptyString(value.identity) &&
    isNonEmptyString(value.harness) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string" &&
    typeof value.harnessDocsPromptFile === "string" &&
    typeof value.harnessDocsPromptString === "string"
  );
}

const SYSTEM_PROMPT_CONFIG_SCHEMA: ExtensionConfigSchema<SystemPromptExtConfig> =
  {
    validate: isSystemPromptConfig,
  };

function createSystemPromptExtension(
  deps: SystemPromptExtensionDeps = DEFAULT_DEPS,
) {
  return function systemPromptExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/system-prompt",
      CONFIG_DEFAULTS,
      { schema: SYSTEM_PROMPT_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const body = deps.resolvePrompt(cfg.promptString, cfg.promptFile);
    if (!body) return;

    const harnessDocs =
      cfg.harnessDocsPromptString || cfg.harnessDocsPromptFile
        ? deps.resolvePrompt(
            cfg.harnessDocsPromptString,
            cfg.harnessDocsPromptFile,
          )
        : "";

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

const systemPromptExtension: (pi: ExtensionAPI) => void =
  createSystemPromptExtension();

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
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();

    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers };
  }

  function createMockContext(cwd = tmpdir) {
    return {
      cwd,
      sessionManager: {
        getSessionId: () => "session-123",
      },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("system-prompt extension", () => {
    it("registers before_agent_start with default config when enabled", () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      const harness = createMockExtensionApiHarness();
      const resolvePromptSpy = vi.fn(
        (promptString: string, promptFile: string) =>
          promptString ||
          (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
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

    it("adds identity and runtime context without duplicating harness guidance", async () => {
      setGlobalSettingsPath(
        path.join(tmpdir, `nonexistent-${Date.now()}.json`),
      );
      const harness = createMockExtensionApiHarness();
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: ((promptString: string) =>
          promptString) as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);
      const handler = harness.handlers.get("before_agent_start");
      const result = (await handler?.(
        { systemPrompt: "upstream prompt" },
        createMockContext(),
      )) as { systemPrompt: string };

      expect(result.systemPrompt).toContain("upstream prompt\n\nYou are Pi.");
      expect(result.systemPrompt).toContain("Session ID: session-123");
      expect(result.systemPrompt).not.toContain("# Tool usage");
      expect(result.systemPrompt).not.toContain("<available_skills>");
      expect(result.systemPrompt).not.toContain("What pi does NOT have");
    });

    it("preserves explicit prompt and harness documentation overrides", async () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-system-prompt-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/system-prompt": {
          enabled: true,
          identity: "Axi",
          harness: "custom",
          promptFile: "",
          promptString: "{identity}\n{harness_docs_section}",
          harnessDocsPromptFile: "",
          harnessDocsPromptString: "custom harness docs",
        },
      });
      setGlobalSettingsPath(settingsPath);
      const harness = createMockExtensionApiHarness();
      const extension = createSystemPromptExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: ((promptString: string) =>
          promptString) as typeof DEFAULT_DEPS.resolvePrompt,
      });

      extension(harness.pi);
      const handler = harness.handlers.get("before_agent_start");
      const result = (await handler?.(
        { systemPrompt: "upstream prompt" },
        createMockContext(),
      )) as { systemPrompt: string };

      expect(result.systemPrompt).toBe(
        "upstream prompt\n\nAxi\ncustom harness docs",
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
      const resolvePromptSpy = vi.fn(
        (promptString: string, promptFile: string) =>
          promptString ||
          (promptFile === CONFIG_DEFAULTS.promptFile ? "body" : ""),
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
