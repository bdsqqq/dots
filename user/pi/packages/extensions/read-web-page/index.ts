/**
 * v3: defuddle HTML→markdown + LLM Q&A + pagination + raw mode.
 *
 * defuddle strips page chrome, extracts main content, and converts to
 * markdown. tiny/sparse HTML falls back to defuddle's markdown converter.
 *
 * `prompt` spawns a gemini flash sub-agent that receives page content
 * and returns AI-generated prose (36/1202 calls use this pattern).
 * `start_index`/`max_length` provide character-level pagination (~16 calls).
 * `raw` skips conversion entirely (1 call).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { htmlToMarkdown } from "@bds_pi/html-to-md";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
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
import { OutputBuffer, headTailChars } from "@bds_pi/output-buffer";
import { osc8Link } from "@bds_pi/box-format";
const HEAD_LINES = 500;
const TAIL_LINES = 500;
const MAX_CHARS = 64_000;
const CURL_TIMEOUT_SECS = 30;
const MAX_REDIRECTS = 5;

const READ_WEB_PAGE_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:low";

type ReadWebPageExtConfig = {
  model: typeof READ_WEB_PAGE_DEFAULT_MODEL | string;
  promptFile: string;
  promptString: string;
};

type ReadWebPageExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: ReadWebPageExtConfig = {
  model: READ_WEB_PAGE_DEFAULT_MODEL,
  promptFile: "",
  promptString: "",
};

const DEFAULT_DEPS: ReadWebPageExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
  withPromptPatch,
};

function isReadWebPageConfig(
  value: Record<string, unknown>,
): value is ReadWebPageExtConfig {
  return (
    isPiSpawnModelValue(value.model) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const READ_WEB_PAGE_CONFIG_SCHEMA: ExtensionConfigSchema<ReadWebPageExtConfig> =
  {
    validate: isReadWebPageConfig,
  };

const DEFAULT_PROMPT_SYSTEM = String.raw`You analyze web page content and answer questions about it.
Be concise and direct. Answer based only on the provided page content.
No preamble, disclaimers, or filler. When uncertain, say so.
Use GitHub-flavored Markdown. No emojis.
`;

function fetchUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ html: string; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      "-sL",
      "-H",
      "Accept: text/markdown, text/html;q=0.9",
      "-m",
      String(CURL_TIMEOUT_SECS),
      "--max-redirs",
      String(MAX_REDIRECTS),
      "-A",
      "Mozilla/5.0 (compatible; pi-agent/1.0)",
      url,
    ];

    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      output.add(data.toString("utf-8"));
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ html: "", error: `curl error: ${err.message}` });
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        resolve({ html: "", error: "fetch aborted" });
        return;
      }
      if (code !== 0) {
        resolve({
          html: "",
          error: `fetch failed: ${stderr.trim() || `curl exited with code ${code}`}`,
        });
        return;
      }
      const { text } = output.format();
      resolve({ html: text });
    });
  });
}

// --- typed params interfaces ---

export interface ReadWebPageParams {
  url: string;
  objective?: string;
  prompt?: string;
  start_index?: number;
  max_length?: number;
  raw?: boolean;
  forceRefetch?: boolean;
}

export interface ReadWebPageConfig {
  systemPrompt?: string;
  model?: typeof READ_WEB_PAGE_DEFAULT_MODEL | string;
}

export function createReadWebPageTool(
  config: ReadWebPageConfig = {},
): ToolDefinition<any> {
  return {
    name: "read_web_page",
    label: "Read Web Page",
    description:
      "Read the contents of a web page at a given URL.\n\n" +
      "Returns the page content converted to Markdown.\n\n" +
      "When an objective is provided, it returns excerpts relevant to that objective.\n\n" +
      "Do NOT use for localhost or local URLs — use `curl` via Bash instead.",

    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the web page to read.",
      }),
      objective: Type.Optional(
        Type.String({
          description:
            "A natural-language description of the research goal. " +
            "If set, only relevant excerpts will be returned. If not set, the full content is returned.",
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "A question to answer about the page content. " +
            "Spawns an AI sub-agent that reads the page and returns a prose answer.",
        }),
      ),
      start_index: Type.Optional(
        Type.Number({
          description:
            "Character offset to start from in the converted content (for pagination).",
        }),
      ),
      max_length: Type.Optional(
        Type.Number({
          description:
            "Maximum number of characters to return (for pagination).",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description: "Return raw HTML instead of converting to Markdown.",
        }),
      ),
      forceRefetch: Type.Optional(
        Type.Boolean({
          description:
            "Force a live fetch (no caching). Currently always fetches live.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as ReadWebPageParams;
      const url = p.url;

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error(
          `invalid URL: "${url}" — must start with http:// or https://`,
        );
      }

      const { html, error } = await fetchUrl(url, signal);

      if (error) throw new Error(error);

      if (!html.trim()) {
        return {
          content: [{ type: "text" as const, text: "(empty response)" }],
        } as any;
      }

      // raw mode: skip conversion entirely
      if (p.raw) {
        const content = headTailChars(
          `Raw HTML content as requested:\n${html}`,
          MAX_CHARS,
        ).text;
        return { content: [{ type: "text" as const, text: content }] } as any;
      }

      const md = await htmlToMarkdown(html);
      let content = md ?? html;

      // pagination: slice before truncation so offsets are stable
      if (p.start_index !== undefined || p.max_length !== undefined) {
        const total = content.length;
        const start = p.start_index ?? 0;
        const end = p.max_length !== undefined ? start + p.max_length : total;
        content = content.slice(start, end);
        content += `\n\n[${start}–${Math.min(end, total)} of ${total} characters]`;
      }

      content = headTailChars(content, MAX_CHARS).text;

      if (p.objective) {
        content = `Objective: ${p.objective}\n\n---\n\n${content}`;
      }

      // prompt mode: spawn sub-agent to answer a question about the page
      if (p.prompt) {
        let parentSession: string | undefined;
        try {
          parentSession = ctx.sessionManager?.getSessionFile?.() ?? undefined;
        } catch {}

        const task = `Here is the content of ${url}:\n\n${content}\n\n---\n\nAnswer this question: ${p.prompt}`;

        const singleResult: SingleResult = {
          agent: "read_web_page",
          task: p.prompt,
          exitCode: -1,
          messages: [],
          usage: zeroUsage(),
        };

        const promptSystem = config.systemPrompt || DEFAULT_PROMPT_SYSTEM;

        const result = await piSpawn({
          cwd: ctx.cwd,
          task,
          model: config.model ?? CONFIG_DEFAULTS.model,
          builtinTools: [],
          extensionTools: [],
          systemPromptBody: promptSystem,
          signal,
          session: { persist: false, parentSession },
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
                    text: getFinalOutput(partial.messages) || "(analyzing...)",
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
      }

      return { content: [{ type: "text" as const, text: content }] } as any;
    },

    renderCall(args: any, theme: any) {
      const url = args.url || "...";
      const displayUrl = url.length > 60 ? `${url.slice(0, 60)}...` : url;
      const linkedUrl = url.startsWith("http")
        ? osc8Link(url, displayUrl)
        : displayUrl;
      let text =
        theme.fg("toolTitle", theme.bold("read_web_page ")) +
        theme.fg("dim", linkedUrl);
      const label = args.prompt || args.objective;
      if (label) {
        const short = label.length > 40 ? `${label.slice(0, 40)}...` : label;
        text += theme.fg("muted", ` — ${short}`);
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
      renderAgentTree(details, container, expanded, theme, {
        label: "read_web_page",
        header: "statusOnly",
      });
      return container;
    },
  };
}

export function resolveReadWebPageConfig(
  deps: Pick<
    ReadWebPageExtensionDeps,
    "getEnabledExtensionConfig" | "resolvePrompt"
  > = DEFAULT_DEPS,
): { enabled: boolean; config: ReadWebPageConfig } {
  const { enabled, config } = deps.getEnabledExtensionConfig(
    "@bds_pi/read-web-page",
    CONFIG_DEFAULTS,
    { schema: READ_WEB_PAGE_CONFIG_SCHEMA },
  );

  return {
    enabled,
    config: {
      systemPrompt: enabled
        ? deps.resolvePrompt(config.promptString, config.promptFile) ||
          DEFAULT_PROMPT_SYSTEM
        : undefined,
      model: config.model,
    },
  };
}

function createReadWebPageExtension(
  deps: ReadWebPageExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function readWebPageExtension(pi: ExtensionAPI): void {
    const { enabled, config } = resolveReadWebPageConfig(deps);
    if (!enabled) return;

    pi.registerTool(deps.withPromptPatch(createReadWebPageTool(config)));
  };
}

const readWebPageExtension: (pi: ExtensionAPI) => void =
  createReadWebPageExtension();

export default readWebPageExtension;

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

  describe("read-web-page extension", () => {
    it("resolves the effective model and custom system prompt", () => {
      const extensionConfig = {
        ...CONFIG_DEFAULTS,
        model: "custom/model",
        promptFile: "custom.md",
        promptString: "inline",
      };
      const getEnabledExtensionConfigSpy = vi.fn(() => ({
        enabled: true,
        config: extensionConfig,
      }));
      const resolvePromptSpy = vi.fn(() => "resolved prompt");

      expect(
        resolveReadWebPageConfig({
          getEnabledExtensionConfig:
            getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
          resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        }),
      ).toEqual({
        enabled: true,
        config: {
          systemPrompt: "resolved prompt",
          model: extensionConfig.model,
        },
      });
      expect(resolvePromptSpy).toHaveBeenCalledWith("inline", "custom.md");
    });

    it("uses the built-in system prompt when no configured prompt resolves", () => {
      const getEnabledExtensionConfigSpy = vi.fn(() => ({
        enabled: true,
        config: CONFIG_DEFAULTS,
      }));

      expect(
        resolveReadWebPageConfig({
          getEnabledExtensionConfig:
            getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
          resolvePrompt: vi.fn(() => "") as typeof DEFAULT_DEPS.resolvePrompt,
        }),
      ).toEqual({
        enabled: true,
        config: {
          systemPrompt: DEFAULT_PROMPT_SYSTEM,
          model: CONFIG_DEFAULTS.model,
        },
      });
    });

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
      const resolvePromptSpy = vi.fn(() => DEFAULT_PROMPT_SYSTEM);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadWebPageExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/read-web-page",
        CONFIG_DEFAULTS,
        { schema: READ_WEB_PAGE_CONFIG_SCHEMA },
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
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
      const resolvePromptSpy = vi.fn(() => DEFAULT_PROMPT_SYSTEM);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadWebPageExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(resolvePromptSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-read-web-page-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/read-web-page": {
          model: "",
          promptFile: 123,
          promptString: false,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const resolvePromptSpy = vi.fn(() => DEFAULT_PROMPT_SYSTEM);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createReadWebPageExtension({
        ...DEFAULT_DEPS,
        resolvePrompt: resolvePromptSpy as typeof DEFAULT_DEPS.resolvePrompt,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/read-web-page; falling back to defaults.",
      );
      expect(resolvePromptSpy).toHaveBeenCalledWith(
        CONFIG_DEFAULTS.promptString,
        CONFIG_DEFAULTS.promptFile,
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
    });
  });
}
