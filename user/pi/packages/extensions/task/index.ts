/**
 * Task tool — delegate complex multi-step work to a sub-agent.
 *
 * replaces the generic subagent(agent: "Task", task: ...) pattern
 * with a dedicated tool. the model calls
 * Task(prompt: "...", description: "...") directly.
 *
 * the Task sub-agent inherits the parent's default model (no --model
 * flag). it gets most tools: read/write, edit, grep, bash, finder,
 * skill, format_file. the description is shown to the user in the
 * TUI; the prompt is the full instruction for the sub-agent.
 *
 * no custom system prompt — the sub-agent uses pi's default prompt.
 * the task prompt itself contains all necessary context and instructions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { piSpawn, zeroUsage } from "@bds_pi/pi-spawn";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";

type TaskExtConfig = {
  builtinTools: string[];
  extensionTools: string[];
};

type TaskExtensionDeps = {
  createTaskTool: typeof createTaskTool;
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: TaskExtConfig = {
  builtinTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  extensionTools: [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "format_file",
    "skill",
    "finder",
  ],
};

const DEFAULT_DEPS: TaskExtensionDeps = {
  createTaskTool,
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isTaskConfig(value: Record<string, unknown>): value is TaskExtConfig {
  return (
    isStringArray(value.builtinTools) && isStringArray(value.extensionTools)
  );
}

const TASK_CONFIG_SCHEMA: ExtensionConfigSchema<TaskExtConfig> = {
  validate: isTaskConfig,
};

interface TaskParams {
  prompt: string;
  description: string;
}

export interface TaskConfig {
  builtinTools?: string[];
  extensionTools?: string[];
}

export function createTaskTool(config: TaskConfig = {}): ToolDefinition {
  return {
    name: "Task",
    label: "Task",
    description:
      "Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to " +
      "the following tools: Read, Grep, Find, ls, Bash, Edit, Write, format_file, skill, finder.\n\n" +
      "When to use the Task tool:\n" +
      "- When you need to perform complex multi-step tasks\n" +
      "- When you need to run an operation that will produce a lot of output (tokens) " +
      "that is not needed after the sub-agent's task completes\n" +
      "- When you are making changes across many layers of an application, after you have " +
      "first planned and spec'd out the changes so they can be implemented independently\n" +
      '- When the user asks you to launch an "agent" or "subagent"\n\n' +
      "When NOT to use the Task tool:\n" +
      "- When you are performing a single logical task\n" +
      "- When you're reading a single file (use Read), performing a text search (use Grep), " +
      "editing a single file (use Edit)\n" +
      "- When you're not sure what changes you want to make\n\n" +
      "How to use the Task tool:\n" +
      "- Run multiple sub-agents concurrently if tasks are independent, by including " +
      "multiple tool uses in a single assistant message.\n" +
      "- Include all necessary context and a detailed plan in the task description.\n" +
      "- Tell the sub-agent how to verify its work if possible.\n" +
      "- When the agent is done, it will return a single message back to you.",

    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The task for the agent to perform. Be specific and include any relevant context.",
      }),
      description: Type.String({
        description:
          "A very short description of the task that can be displayed to the user.",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as TaskParams;
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const singleResult: SingleResult = {
        agent: "Task",
        task: p.description,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: p.prompt,
        builtinTools: config.builtinTools ?? CONFIG_DEFAULTS.builtinTools,
        extensionTools: config.extensionTools ?? CONFIG_DEFAULTS.extensionTools,
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
                  text: getFinalOutput(partial.messages) || "(working...)",
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
      const desc = args.description || "...";
      const preview = desc.length > 80 ? `${desc.slice(0, 80)}...` : desc;
      return new Text(
        theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("dim", preview),
        0,
        0,
      );
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
        label: "Task",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createTaskExtension(
  deps: TaskExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function taskExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/task",
      CONFIG_DEFAULTS,
      { schema: TASK_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        deps.createTaskTool({
          builtinTools: cfg.builtinTools,
          extensionTools: cfg.extensionTools,
        }),
      ),
    );
  };
}

const taskExtension: (pi: ExtensionAPI) => void = createTaskExtension();

export default taskExtension;

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

  describe("task extension", () => {
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
      const tool = { name: "Task" } as ToolDefinition;
      const createTaskToolSpy = vi.fn(() => tool);
      const withPromptPatchSpy = vi.fn((nextTool: ToolDefinition) => nextTool);
      const extension = createTaskExtension({
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/task",
        CONFIG_DEFAULTS,
        { schema: TASK_CONFIG_SCHEMA },
      );
      expect(createTaskToolSpy).toHaveBeenCalledWith({
        builtinTools: CONFIG_DEFAULTS.builtinTools,
        extensionTools: CONFIG_DEFAULTS.extensionTools,
      });
      expect(withPromptPatchSpy).toHaveBeenCalledWith(tool);
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
      const createTaskToolSpy = vi.fn(
        () => ({ name: "Task" }) as ToolDefinition,
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createTaskExtension({
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(createTaskToolSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-task-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/task": {
          builtinTools: ["read", 123],
          extensionTools: "finder",
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const tool = { name: "Task" } as ToolDefinition;
      const createTaskToolSpy = vi.fn(() => tool);
      const withPromptPatchSpy = vi.fn((nextTool: ToolDefinition) => nextTool);
      const extension = createTaskExtension({
        ...DEFAULT_DEPS,
        createTaskTool: createTaskToolSpy as typeof DEFAULT_DEPS.createTaskTool,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/task; falling back to defaults.",
      );
      expect(createTaskToolSpy).toHaveBeenCalledWith({
        builtinTools: CONFIG_DEFAULTS.builtinTools,
        extensionTools: CONFIG_DEFAULTS.extensionTools,
      });
      expect(withPromptPatchSpy).toHaveBeenCalledWith(tool);
      expect(harness.tools).toHaveLength(1);
    });
  });
}
