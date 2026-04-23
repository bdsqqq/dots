/**
 * look_at tool — multimodal file analysis via gemini flash sub-agent.
 *
 * hooks into pi's existing read tool pipeline: the sub-agent calls
 * read(path) which returns images as base64 content parts. gemini
 * sees the image and analyzes it per the user's objective.
 *
 * for text files, the sub-agent reads and summarizes/extracts per
 * objective — useful when you need analyzed data, not raw contents.
 *
 * supports reference files for comparison (e.g., before/after
 * screenshots, two versions of a diagram).
 */

import { getModel } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getEnabledExtensionConfig,
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
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";

const LOOK_AT_DEFAULT_MODEL = getModel(
  "openrouter",
  "google/gemini-3-flash-preview",
);

type LookAtExtConfig = {
  model: typeof LOOK_AT_DEFAULT_MODEL | string;
  extensionTools: string[];
  builtinTools: string[];
  promptFile: string;
  promptString: string;
};

type LookAtExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  resolvePrompt: typeof resolvePrompt;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: LookAtExtConfig = {
  model: LOOK_AT_DEFAULT_MODEL,
  extensionTools: ["read", "ls"],
  builtinTools: ["read", "ls"],
  promptFile: "",
  promptString: "",
};

const DEFAULT_DEPS: LookAtExtensionDeps = {
  getEnabledExtensionConfig,
  resolvePrompt,
  withPromptPatch,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isLookAtExtConfig(
  value: Record<string, unknown>,
): value is LookAtExtConfig {
  return (
    isPiSpawnModelValue(value.model) &&
    isStringArray(value.extensionTools) &&
    isStringArray(value.builtinTools) &&
    typeof value.promptFile === "string" &&
    typeof value.promptString === "string"
  );
}

const LOOK_AT_CONFIG_SCHEMA: ExtensionConfigSchema<LookAtExtConfig> = {
  validate: isLookAtExtConfig,
};

const DEFAULT_SYSTEM_PROMPT: string = String.raw`You are an AI assistant that analyzes files for a software engineer.

# Core Principles

- Be concise and direct. Minimize output while maintaining accuracy.
- Focus only on the user's objective. Do not add tangential information.
- No preamble, disclaimers, or summaries unless specifically relevant.
- Never start with flattery ("great question", "interesting file", etc.).
- A wrong answer is worse than no answer. When uncertain, say so.

# Precision Guidelines

- When analyzing images: describe exactly what you see, do not guess or infer.
- When analyzing code: reference specific line numbers and symbols.
- When analyzing documents: extract the specific information requested.

# Comparing Files

When reference files are provided alongside the main file, you are being asked to compare them.
- Systematically identify differences and similarities.
- Be specific: mention exact locations, values, or visual elements that differ.
- Structure the comparison clearly (e.g., "File A has X, File B has Y").

# Output Format

- Use GitHub-flavored Markdown.
- Use code fences with language tags for code snippets.
- No emojis or decorative symbols.
- Keep responses focused and brief.
`;

export interface LookAtConfig extends Partial<
  Pick<LookAtExtConfig, "model" | "extensionTools" | "builtinTools">
> {
  systemPrompt?: string;
}

interface LookAtParams {
  path: string;
  objective: string;
  context: string;
  referenceFiles?: string[];
}

export function createLookAtTool(config: LookAtConfig = {}): ToolDefinition {
  return {
    name: "look_at",
    label: "Look At",
    description:
      "Extract specific information from a local file (including images and other media).\n\n" +
      "Use this tool when you need to extract or summarize information from a file " +
      "without getting the literal contents. Always provide a clear objective.\n\n" +
      "Pass reference files when you need to compare two or more things.\n\n" +
      "## When to use this tool\n\n" +
      "- Analyzing images that the Read tool cannot interpret\n" +
      "- Extracting specific information or summaries from documents\n" +
      "- Describing visual content in images or diagrams\n" +
      "- When you only need analyzed/extracted data, not raw file contents\n\n" +
      "## When NOT to use this tool\n\n" +
      "- For source code or plain text files where you need exact contents — use Read instead\n" +
      "- When you need to edit the file afterward (you need literal content from Read)\n" +
      "- For simple file reading where no interpretation is needed",

    parameters: Type.Object({
      path: Type.String({
        description:
          "Workspace-relative or absolute path to the file to analyze.",
      }),
      objective: Type.String({
        description:
          "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).",
      }),
      context: Type.String({
        description: "The broader goal and context for the analysis.",
      }),
      referenceFiles: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of paths to reference files for comparison.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as LookAtParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {}

      // build the task prompt: read file(s), then analyze
      const parts: string[] = [];

      parts.push(`Read the file at "${p.path}" using the read tool.`);

      if (p.referenceFiles && p.referenceFiles.length > 0) {
        for (const ref of p.referenceFiles) {
          parts.push(`Also read the reference file at "${ref}".`);
        }
      }

      parts.push("");
      parts.push(`Context: ${p.context}`);
      parts.push("");
      parts.push(`Analyze with this objective: ${p.objective}`);

      if (p.referenceFiles && p.referenceFiles.length > 0) {
        parts.push("");
        parts.push(
          "Compare the main file against the reference file(s). Identify all differences and similarities.",
        );
      }

      const fullTask = parts.join("\n");

      const singleResult: SingleResult = {
        agent: "look_at",
        task: p.objective,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: fullTask,
        model: config.model ?? CONFIG_DEFAULTS.model,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
        systemPromptBody: systemPrompt,
        signal,
        sessionId,
        onUpdate: (partial) => {
          singleResult.messages = partial.messages;
          singleResult.usage = partial.usage;
          singleResult.model = partial.model;
          singleResult.stopReason = partial.stopReason;
          singleResult.errorMessage = partial.errorMessage;
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

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";
      const output = getFinalOutput(result.messages) || "(no output)";

      if (isError) {
        return subAgentResult(
          result.errorMessage || result.stderr || output,
          singleResult,
          true,
        );
      }

      return subAgentResult(output, singleResult);
    },

    renderCall(args: any, theme: any) {
      const path = args.path || "...";
      const objective = args.objective
        ? args.objective.length > 60
          ? `${args.objective.slice(0, 60)}...`
          : args.objective
        : "";
      let text =
        theme.fg("toolTitle", theme.bold("look_at ")) + theme.fg("dim", path);
      if (objective) text += theme.fg("muted", ` — ${objective}`);
      if (args.referenceFiles?.length) {
        text += theme.fg(
          "muted",
          ` (+${args.referenceFiles.length} ref${args.referenceFiles.length > 1 ? "s" : ""})`,
        );
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
        label: "look_at",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createLookAtExtension(
  deps: LookAtExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function lookAtExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/look-at",
      CONFIG_DEFAULTS,
      { schema: LOOK_AT_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        createLookAtTool({
          systemPrompt: deps.resolvePrompt(cfg.promptString, cfg.promptFile),
          model: cfg.model,
          extensionTools: cfg.extensionTools,
          builtinTools: cfg.builtinTools,
        }),
      ),
    );
  };
}

const lookAtExtension: (pi: ExtensionAPI) => void = createLookAtExtension();

export default lookAtExtension;

// Export for testing
export {
  createLookAtExtension,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  LOOK_AT_CONFIG_SCHEMA,
  DEFAULT_SYSTEM_PROMPT,
  isNonEmptyString,
  isStringArray,
  isLookAtExtConfig,
};

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  // Layer 2: E2E eval tests (gated by PI_E2E env var)
  describe.skipIf(!process.env.PI_E2E)("eval: look-at tool", () => {
    const E2E_MODEL =
      process.env.PI_E2E_MODEL ?? "openrouter/moonshotai/kimi-k2.5";

    it("eval: analyzes a file with real AI", async () => {
      const {
        createAgentSession,
        ModelRegistry,
        AuthStorage,
        DefaultResourceLoader,
        SettingsManager,
      } = await import("@mariozechner/pi-coding-agent");
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");

      // Parse model string: "provider/model-id"
      const [provider, ...modelIdParts] = E2E_MODEL.split("/");
      const modelId = modelIdParts.join("/");
      if (!provider || !modelId) {
        throw new Error(
          `Invalid E2E_MODEL format: ${E2E_MODEL}. Expected: provider/model-id`,
        );
      }

      const cwd = process.cwd();

      // Create auth storage and model registry
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = modelRegistry.find(provider, modelId);
      if (!model) {
        throw new Error(
          `Model not found: ${provider}/${modelId}. Available providers: ${[...new Set(modelRegistry.getAll().map((m) => m.provider))].join(", ")}`,
        );
      }

      // Create settings manager with the pi package enabled
      const settingsManager = SettingsManager.create(cwd);

      // Create resource loader to load extensions including look-at
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        settingsManager,
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd,
        model,
        sessionManager: SessionManager.inMemory(cwd),
        modelRegistry,
        authStorage,
        settingsManager,
        resourceLoader,
      });

      // Track tool executions and messages
      let lookAtCalled = false;
      let lookAtPath: string | undefined;
      const allToolCalls: string[] = [];
      const unsubscribe = session.agent.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          allToolCalls.push(event.toolName);
          if (event.toolName === "look_at") {
            lookAtCalled = true;
            lookAtPath = event.args?.path;
          }
        }
      });

      // Log available tools
      const toolNames = session.agent.state.tools.map((t) => t.name);
      console.log("Available tools:", toolNames.slice(0, 20).join(", "));

      try {
        // Ask agent to analyze this file using look_at
        await session.prompt(
          `Use the look_at tool to analyze the file at "user/pi/packages/extensions/look-at/index.ts" and tell me what the DEFAULT_SYSTEM_PROMPT constant contains. Be specific about its contents.`,
        );
        await session.agent.waitForIdle();

        // Get the final response
        const messages = session.agent.state.messages;
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const responseText =
          lastAssistant?.content
            ?.filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join(" ") ?? "";

        // Verify look_at was called with the correct path
        console.log("Tool calls made:", allToolCalls);
        console.log("Final response:", responseText.slice(0, 500));
        expect(lookAtCalled).toBe(true);
        expect(lookAtPath).toContain("look-at/index.ts");

        // Verify the response mentions the system prompt contents
        expect(responseText.toLowerCase()).toContain("concise");
        expect(responseText.toLowerCase()).toContain("ai assistant");
      } finally {
        unsubscribe();
        session.dispose();
      }
    }, 120_000);
  });

  // Layer 1: Pure function tests (collocated for fast feedback)
  describe("isNonEmptyString", () => {
    it("returns true for non-empty strings", () => {
      expect(isNonEmptyString("hello")).toBe(true);
      expect(isNonEmptyString("  a  ")).toBe(true);
    });

    it("returns false for empty or whitespace-only strings", () => {
      expect(isNonEmptyString("")).toBe(false);
      expect(isNonEmptyString("   ")).toBe(false);
      expect(isNonEmptyString("\t\n")).toBe(false);
    });

    it("returns false for non-strings", () => {
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
      expect(isNonEmptyString(123)).toBe(false);
      expect(isNonEmptyString([])).toBe(false);
    });
  });

  describe("isStringArray", () => {
    it("returns true for arrays of strings", () => {
      expect(isStringArray(["a", "b", "c"])).toBe(true);
      expect(isStringArray([""])).toBe(true);
      expect(isStringArray([])).toBe(true);
    });

    it("returns false for arrays with non-strings", () => {
      expect(isStringArray(["a", 1])).toBe(false);
      expect(isStringArray([null])).toBe(false);
      expect(isStringArray([{}])).toBe(false);
    });

    it("returns false for non-arrays", () => {
      expect(isStringArray("not an array")).toBe(false);
      expect(isStringArray(null)).toBe(false);
      expect(isStringArray(undefined)).toBe(false);
    });
  });

  describe("isLookAtExtConfig", () => {
    it("validates correct config", () => {
      expect(
        isLookAtExtConfig({
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
        isLookAtExtConfig({
          model: "",
          extensionTools: ["read"],
          builtinTools: ["ls"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("rejects invalid tool arrays", () => {
      expect(
        isLookAtExtConfig({
          model: "gpt-4",
          extensionTools: "not-an-array",
          builtinTools: ["ls"],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);

      expect(
        isLookAtExtConfig({
          model: "gpt-4",
          extensionTools: ["read"],
          builtinTools: [123],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(false);
    });

    it("accepts any string for promptFile/promptString", () => {
      expect(
        isLookAtExtConfig({
          model: "gpt-4",
          extensionTools: [],
          builtinTools: [],
          promptFile: "/some/path.md",
          promptString: "custom prompt",
        }),
      ).toBe(true);

      // Empty strings are valid (use defaults)
      expect(
        isLookAtExtConfig({
          model: "gpt-4",
          extensionTools: [],
          builtinTools: [],
          promptFile: "",
          promptString: "",
        }),
      ).toBe(true);
    });
  });
}
