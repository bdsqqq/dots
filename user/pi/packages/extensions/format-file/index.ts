/**
 * format_file tool — runs a code formatter on a file.
 *
 * tries formatters in order: prettier, biome. uses whichever is
 * available on PATH (nix provides these). captures before/after
 * diff and tracks the change for undo_edit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { Type } from "@sinclair/typebox";
import { saveChange, simpleDiff } from "@bds_pi/file-tracker";
import { withFileLock } from "@bds_pi/mutex";
import { resolveToAbsolute, resolveWithVariants } from "@bds_pi/fs";
import * as toolPolicy from "@bds_pi/tool-policy";
import {
  boxRendererWindowed,
  textSection,
  osc8Link,
  type Excerpt,
} from "@bds_pi/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

type Formatter = { name: string; args: (file: string) => string[] };

type FormatFileExtConfig = {
  preferredFormatter: string;
  formatterLookupTimeoutMs: number;
};

type FormatFileExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: FormatFileExtConfig = {
  preferredFormatter: "auto",
  formatterLookupTimeoutMs: 3000,
};

const DEFAULT_DEPS: FormatFileExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

const FORMATTERS: Formatter[] = [
  {
    name: "prettier",
    args: (file) => ["--write", "--log-level", "silent", file],
  },
  {
    name: "biome",
    args: (file) => ["format", "--write", file],
  },
];

function isFormatterName(value: unknown): value is string {
  return (
    value === "auto" || FORMATTERS.some((formatter) => formatter.name === value)
  );
}

function isFormatFileConfig(
  value: Record<string, unknown>,
): value is FormatFileExtConfig {
  return (
    isFormatterName(value.preferredFormatter) &&
    typeof value.formatterLookupTimeoutMs === "number" &&
    Number.isInteger(value.formatterLookupTimeoutMs) &&
    value.formatterLookupTimeoutMs >= 1
  );
}

const FORMAT_FILE_CONFIG_SCHEMA: ExtensionConfigSchema<FormatFileExtConfig> = {
  validate: isFormatFileConfig,
};

function findFormatter(preferred: string, timeoutMs: number): Formatter | null {
  const ordered =
    preferred !== "auto"
      ? [...FORMATTERS].sort((a, b) =>
          a.name === preferred ? -1 : b.name === preferred ? 1 : 0,
        )
      : FORMATTERS;
  for (const fmt of ordered) {
    const result = spawnSync("which", [fmt.name], {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    if (result.status === 0) return fmt;
  }
  return null;
}

export function createFormatFileTool(
  config: FormatFileExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<any> {
  return {
    name: "format_file",
    label: "Format File",
    description: "Run a code formatter (prettier or biome) on a file.",

    parameters: Type.Object({
      path: Type.String({
        description: "The absolute path to the file to format.",
      }),
    }),

    renderCall(args: any, theme: any) {
      const filePath = args.path || "...";
      const home = os.homedir();
      const shortened = filePath.startsWith(home)
        ? `~${filePath.slice(home.length)}`
        : filePath;
      const linked = filePath.startsWith("/")
        ? osc8Link(`file://${filePath}`, shortened)
        : shortened;
      return new Text(
        theme.fg("toolTitle", theme.bold("Format ")) + theme.fg("dim", linked),
        0,
        0,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text("(no output)", 0, 0);
      return boxRendererWindowed(
        () => [textSection(undefined, content.text)],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { path: string };
      const requestedPath = resolveToAbsolute(p.path, ctx.cwd);
      const verdict = toolPolicy.evaluateToolPolicy(
        "format_file",
        {
          path: requestedPath,
          sessionCwd: ctx.cwd,
        },
        toolPolicy.loadToolPolicy(),
      );
      if (verdict.action === "reject") {
        return {
          content: [
            {
              type: "text" as const,
              text: verdict.message
                ? `path rejected: ${verdict.message}`
                : "path rejected by tool policy.",
            },
          ],
          isError: true,
        } as any;
      }

      const resolved = resolveWithVariants(p.path, ctx.cwd);

      if (!fs.existsSync(resolved)) {
        return {
          content: [
            { type: "text" as const, text: `file not found: ${resolved}` },
          ],
          isError: true,
        } as any;
      }

      const formatter = findFormatter(
        config.preferredFormatter,
        config.formatterLookupTimeoutMs,
      );
      if (!formatter) {
        return {
          content: [
            {
              type: "text" as const,
              text: "no formatter found. install prettier or biome.",
            },
          ],
          isError: true,
        } as any;
      }

      return withFileLock(resolved, async () => {
        const before = fs.readFileSync(resolved, "utf-8");

        const result = spawnSync(formatter.name, formatter.args(resolved), {
          encoding: "utf-8",
          timeout: 30_000,
          cwd: ctx.cwd,
        });

        if (result.status !== 0) {
          const err =
            result.stderr?.trim() ||
            result.stdout?.trim() ||
            `exit code ${result.status}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `${formatter.name} failed: ${err}`,
              },
            ],
            isError: true,
          } as any;
        }

        const after = fs.readFileSync(resolved, "utf-8");

        if (before === after) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${path.basename(resolved)} is already formatted.`,
              },
            ],
            details: { header: resolved },
          } as any;
        }

        // track for undo_edit
        const sessionId = ctx.sessionManager.getSessionId();
        const diff = simpleDiff(resolved, before, after);
        saveChange(sessionId, toolCallId, {
          uri: `file://${resolved}`,
          before,
          after,
          diff,
          isNewFile: false,
          timestamp: Date.now(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `formatted ${path.basename(resolved)} with ${formatter.name}.\n\n${diff}`,
            },
          ],
          details: { header: resolved },
        } as any;
      });
    },
  };
}

function createFormatFileExtension(
  deps: FormatFileExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function formatFileExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/format-file",
      CONFIG_DEFAULTS,
      { schema: FORMAT_FILE_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createFormatFileTool(cfg)));
  };
}

const formatFileExtension: (pi: ExtensionAPI) => void =
  createFormatFileExtension();

export default formatFileExtension;

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
    const tools: unknown[] = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;

    return { pi, tools };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("format-file extension", () => {
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
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFormatFileExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/format-file",
        CONFIG_DEFAULTS,
        { schema: FORMAT_FILE_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "format_file" });
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
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFormatFileExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-format-file-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/format-file": {
          preferredFormatter: "nope",
          formatterLookupTimeoutMs: 0,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createFormatFileExtension({
        ...DEFAULT_DEPS,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/format-file; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "format_file" });
    });
  });

  describe("format-file tool policy", () => {
    it("rejects disallowed paths before filesystem checks", async () => {
      const tool = createFormatFileTool();
      const evaluateToolPolicySpy = vi
        .spyOn(toolPolicy, "evaluateToolPolicy")
        .mockReturnValue({ action: "reject", message: "workspace only" });
      vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([]);

      const result = (await tool.execute!(
        "test-id",
        { path: "../sibling/file.ts" },
        undefined,
        undefined,
        { cwd: "/repo/project" } as any,
      )) as any;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("path rejected: workspace only");
      expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
        "format_file",
        { path: "/repo/sibling/file.ts", sessionCwd: "/repo/project" },
        [],
      );
    });
  });
}
