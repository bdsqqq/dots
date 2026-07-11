/**
 * delegate tool — delegate complex multi-step work to a sub-agent.
 *
 * replaces the generic subagent(agent: "delegate", task: ...) pattern
 * with a dedicated tool. the model calls
 * delegate(prompt: "...", description: "...") directly.
 *
 * the delegate sub-agent inherits the parent's default model (no --model
 * flag). it gets most tools: read/write, edit, grep, bash, finder,
 * skill, format_file. the description is shown to the user in the
 * TUI; the prompt is the full instruction for the sub-agent.
 *
 * no custom system prompt — the sub-agent uses pi's default prompt.
 * the delegate prompt itself contains all necessary context and instructions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { piSpawn, zeroUsage } from "@bds_pi/pi-spawn";
import {
  applySessionMeta,
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "@bds_pi/sub-agent-render";

type DelegateExtConfig = {
  builtinTools: string[];
  extensionTools: string[];
};

type DelegateExtensionDeps = {
  createDelegateTool: typeof createDelegateTool;
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: DelegateExtConfig = {
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

const DEFAULT_DEPS: DelegateExtensionDeps = {
  createDelegateTool,
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isDelegateConfig(value: Record<string, unknown>): value is DelegateExtConfig {
  return (
    isStringArray(value.builtinTools) && isStringArray(value.extensionTools)
  );
}

const DELEGATE_CONFIG_SCHEMA: ExtensionConfigSchema<DelegateExtConfig> = {
  validate: isDelegateConfig,
};

interface DelegateParams {
  prompt: string;
  description: string;
  continueId?: string;
  leafId?: string;
}

export interface DelegateConfig {
  builtinTools?: string[];
  extensionTools?: string[];
}

function withRoutingMetadata(text: string, result: SingleResult): string {
  const lines: string[] = [];
  if (result.continueId) lines.push(`continueId: ${result.continueId}`);
  if (result.sessionId) lines.push(`sessionId: ${result.sessionId}`);
  if (result.sessionFile) lines.push(`sessionFile: ${result.sessionFile}`);
  if (result.leafId) lines.push(`leafId: ${result.leafId}`);
  return lines.length > 0
    ? `${text}\n\n---\nrouting:\n${lines.join("\n")}`
    : text;
}

export function createDelegateTool(config: DelegateConfig = {}): ToolDefinition<any> {
  return {
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate a task (a sub-task of the user's overall task) using a sub-agent that has access to " +
      "the following tools: Read, Grep, Find, ls, Bash, Edit, Write, format_file, skill, finder.\n\n" +
      "When to use the delegate tool:\n" +
      "- When you need to perform complex multi-step tasks\n" +
      "- When you need to run an operation that will produce a lot of output (tokens) " +
      "that is not needed after the sub-agent's task completes\n" +
      "- When you are making changes across many layers of an application, after you have " +
      "first planned and spec'd out the changes so they can be implemented independently\n" +
      '- When the user asks you to launch an "agent" or "subagent"\n\n' +
      "When NOT to use the delegate tool:\n" +
      "- When you are performing a single logical task\n" +
      "- When you're reading a single file (use Read), performing a text search (use Grep), " +
      "editing a single file (use Edit)\n" +
      "- When you're not sure what changes you want to make\n\n" +
      "How to use the delegate tool:\n" +
      "- Run multiple sub-agents concurrently if tasks are independent, by including " +
      "multiple tool uses in a single assistant message.\n" +
      "- Include all necessary context and a detailed plan in the task description.\n" +
      "- Tell the sub-agent how to verify its work if possible.\n" +
      "- Use continueId to continue a previous delegate child session. leafId is accepted but currently unsupported.\n" +
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
      continueId: Type.Optional(
        Type.String({
          description:
            "Continue a previous delegate child session by id. Use the continueId returned by an earlier delegate result.",
        }),
      ),
      leafId: Type.Optional(
        Type.String({
          description:
            "Branch leaf to continue. Currently unsupported and will fail fast.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as DelegateParams;
      let parentSession: string | undefined;
      try {
        parentSession = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      } catch {
        /* graceful */
      }

      const singleResult: SingleResult = {
        agent: "delegate",
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
        session: {
          id: p.continueId,
          leafId: p.leafId,
          persist: true,
          parentSession,
        },
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
      applySessionMeta(singleResult, result.session);

      const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";
      const output = getFinalOutput(result.messages) || "(no output)";
      const text = withRoutingMetadata(output, singleResult);

      if (isError) {
        return subAgentResult(
          withRoutingMetadata(
            result.errorMessage || result.stderr || output,
            singleResult,
          ),
          singleResult,
          true,
        );
      }

      return subAgentResult(text, singleResult);
    },

    renderCall(args: any, theme: any) {
      const desc = args.description || "...";
      const preview = desc.length > 80 ? `${desc.slice(0, 80)}...` : desc;
      return new Text(
        theme.fg("toolTitle", theme.bold("Delegate ")) + theme.fg("dim", preview),
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
        label: "Delegate",
        header: "statusOnly",
      });
      return container;
    },
  };
}

function createDelegateExtension(
  deps: DelegateExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function delegateExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/delegate",
      CONFIG_DEFAULTS,
      { schema: DELEGATE_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    pi.registerTool(
      deps.withPromptPatch(
        deps.createDelegateTool({
          builtinTools: cfg.builtinTools,
          extensionTools: cfg.extensionTools,
        }),
      ),
    );
  };
}

const delegateExtension: (pi: ExtensionAPI) => void = createDelegateExtension();

export default delegateExtension;

// Export for testing
export {
  createDelegateExtension,
  isStringArray,
  isDelegateConfig,
  DEFAULT_DEPS,
  CONFIG_DEFAULTS,
  DELEGATE_CONFIG_SCHEMA,
};

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

  describe("delegate extension", () => {
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
      const tool = { name: "delegate" } as ToolDefinition;
      const createDelegateToolSpy = vi.fn(() => tool);
      const withPromptPatchSpy = vi.fn((nextTool: ToolDefinition) => nextTool);
      const extension = createDelegateExtension({
        createDelegateTool: createDelegateToolSpy as typeof DEFAULT_DEPS.createDelegateTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/delegate",
        CONFIG_DEFAULTS,
        { schema: DELEGATE_CONFIG_SCHEMA },
      );
      expect(createDelegateToolSpy).toHaveBeenCalledWith({
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
      const createDelegateToolSpy = vi.fn(
        () => ({ name: "delegate" }) as ToolDefinition,
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createDelegateExtension({
        createDelegateTool: createDelegateToolSpy as typeof DEFAULT_DEPS.createDelegateTool,
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(createDelegateToolSpy).not.toHaveBeenCalled();
      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-delegate-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/delegate": {
          builtinTools: ["read", 123],
          extensionTools: "finder",
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const tool = { name: "delegate" } as ToolDefinition;
      const createDelegateToolSpy = vi.fn(() => tool);
      const withPromptPatchSpy = vi.fn((nextTool: ToolDefinition) => nextTool);
      const extension = createDelegateExtension({
        ...DEFAULT_DEPS,
        createDelegateTool: createDelegateToolSpy as typeof DEFAULT_DEPS.createDelegateTool,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/delegate; falling back to defaults.",
      );
      expect(createDelegateToolSpy).toHaveBeenCalledWith({
        builtinTools: CONFIG_DEFAULTS.builtinTools,
        extensionTools: CONFIG_DEFAULTS.extensionTools,
      });
      expect(withPromptPatchSpy).toHaveBeenCalledWith(tool);
      expect(harness.tools).toHaveLength(1);
    });
  });

  describe.skipIf(!process.env.PI_E2E)("eval: delegate tool", () => {
    const E2E_MODEL = process.env.PI_E2E_MODEL ?? "openai-codex/gpt-5.6-sol";
    // pi repo root (3 levels up from this file: delegate -> extensions -> packages -> pi)
    const PI_ROOT = path.resolve(__dirname, "..", "..", "..");

    it("eval: spawns sub-agent and completes a simple task", async () => {
      const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } =
        await import("@earendil-works/pi-coding-agent");

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const slashIdx = E2E_MODEL.indexOf("/");
      const provider = E2E_MODEL.slice(0, slashIdx);
      const modelId = E2E_MODEL.slice(slashIdx + 1);
      const model = modelRegistry.find(provider, modelId);
      if (!model) throw new Error(`model not found: ${E2E_MODEL}`);

      const delegateTool = createDelegateTool();

      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        model,
        authStorage,
        modelRegistry,
        customTools: [delegateTool],
      });

      const testFile = path.join(tmpdir, `pi-delegate-eval-${Date.now()}.txt`);
      const testContent = "delegate eval test content";

      const events: { type: string; toolName?: string; content?: string }[] =
        [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          events.push({ type: "tool_start", toolName: event.toolName });
        }
        if (event.type === "tool_execution_end") {
          events.push({
            type: "tool_end",
            toolName: event.toolName,
            content: event.result?.content?.[0]?.text,
          });
        }
      });

      await session.prompt(
        `Use the delegate tool to create a file at ${testFile} with the exact content "${testContent}". Do not use any other tools.`,
      );

      const delegateEvents = events.filter((e) => e.toolName === "delegate");
      expect(delegateEvents.length).toBeGreaterThanOrEqual(2);
      expect(delegateEvents[0]?.type).toBe("tool_start");
      expect(delegateEvents[1]?.type).toBe("tool_end");

      const delegateResult = delegateEvents[1]?.content ?? "";
      expect(delegateResult).not.toContain("error");

      // verify file was created
      expect(fs.existsSync(testFile)).toBe(true);
      expect(fs.readFileSync(testFile, "utf-8").trim()).toBe(testContent);

      fs.unlinkSync(testFile);
      session.dispose();
    }, 120_000);

    it("eval: child sessions respect PI_BDS_CONFIG_PATH gating for builtin-shadowed tools", async () => {
      const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } =
        await import("@earendil-works/pi-coding-agent");

      // set up sandbox with custom config that disables @bds_pi/bash
      const sandboxDir = fs.mkdtempSync(
        path.join(tmpdir, "pi-delegate-config-gating-"),
      );
      const projectConfigDir = path.join(sandboxDir, ".pi");
      fs.mkdirSync(projectConfigDir, { recursive: true });

      // create config that disables the bash extension
      const childConfigPath = path.join(sandboxDir, "bds-pi.json");
      fs.writeFileSync(
        childConfigPath,
        JSON.stringify({ "@bds_pi/bash": { enabled: false } }),
        "utf-8",
      );

      // set global settings path so piSpawn propagates it to child
      setGlobalSettingsPath(childConfigPath);

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const slashIdx = E2E_MODEL.indexOf("/");
      const provider = E2E_MODEL.slice(0, slashIdx);
      const modelId = E2E_MODEL.slice(slashIdx + 1);
      const model = modelRegistry.find(provider, modelId);
      if (!model) throw new Error(`model not found: ${E2E_MODEL}`);

      const delegateTool = createDelegateTool();

      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        model,
        authStorage,
        modelRegistry,
        customTools: [delegateTool],
        cwd: sandboxDir,
      });

      const prompt = [
        'Use the delegate tool. description: "fallback audit".',
        "In the child, inspect the bash tool schema available to you before acting.",
        "If the required field is `command`, report `builtin-bash`. If the required field is `cmd`, report `custom-bash`.",
        "Then do exactly one thing: run bash with `printf fallback-ok`.",
        "Return only two lines: first the schema label, second the command output.",
      ].join(" ");

      const events: {
        type: string;
        toolName?: string;
        content?: string;
        result?: any;
      }[] = [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_end") {
          events.push({
            type: "tool_end",
            toolName: (event as any).toolName,
            content: (event as any).result?.content?.[0]?.text,
            result: (event as any).result,
          });
        }
      });

      await session.prompt(prompt);

      const delegateEvent = events.find((e) => e.toolName === "delegate");
      expect(delegateEvent).toBeDefined();
      // result structure: { content: [{ type, text }], details: { exitCode, messages, ... } }
      expect(delegateEvent!.result?.isError ?? false).toBe(false);

      const delegateContent = delegateEvent!.content ?? "";
      expect(delegateContent).toContain("builtin-bash");
      expect(delegateContent).toContain("fallback-ok");

      // verify child used builtin bash (command param, not cmd)
      const childMessages = delegateEvent!.result?.details?.messages ?? [];
      const childToolCalls = childMessages.flatMap((msg: any) =>
        (msg.content ?? []).filter((part: any) => part.type === "toolCall"),
      );
      const bashCall = childToolCalls.find((part: any) => part.name === "bash");
      // builtin bash uses `command` param, not `cmd`
      expect(bashCall?.arguments).toMatchObject({
        command: "printf fallback-ok",
      });

      const childToolResults = childMessages.filter(
        (msg: any) => msg.role === "toolResult" && msg.toolName === "bash",
      );
      expect(childToolResults.at(-1)?.content?.[0]?.text ?? "").toContain(
        "fallback-ok",
      );

      session.dispose();
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }, 180_000);

    it("eval: child sessions reject bash escapes outside assigned cwd via tool policy", async () => {
      const sandboxDir = fs.mkdtempSync(
        path.join(tmpdir, "pi-e2e-tool-policy-"),
      );
      const projectConfigDir = path.join(sandboxDir, ".pi");
      const agentConfigDir = path.join(sandboxDir, ".pi", "agent");
      const forbiddenPath = path.join(
        tmpdir,
        `pi-e2e-delegate-escape-${Date.now()}.txt`,
      );

      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.mkdirSync(agentConfigDir, { recursive: true });
      try {
        fs.unlinkSync(forbiddenPath);
      } catch {}

      // Write settings.json to load the delegate extension
      fs.writeFileSync(
        path.join(projectConfigDir, "settings.json"),
        JSON.stringify({
          packages: [],
          extensions: [path.join(PI_ROOT, "dist/extensions/delegate.js")],
        }),
        "utf-8",
      );

      // Copy auth.json to sandbox so child process can authenticate
      const realHome = os.homedir();
      const authSrcPath = path.join(realHome, ".pi", "agent", "auth.json");
      const authDestPath = path.join(agentConfigDir, "auth.json");
      if (fs.existsSync(authSrcPath)) {
        fs.copyFileSync(authSrcPath, authDestPath);
      }

      // Write tool-policy.json to restrict bash to cwd
      fs.writeFileSync(
        path.join(agentConfigDir, "tool-policy.json"),
        JSON.stringify(
          [
            {
              tool: "bash",
              matches: { within: "." },
              action: "allow",
            },
            {
              tool: "bash",
              action: "reject",
              message: "stay inside the assigned cwd",
            },
            { tool: "*", action: "allow" },
          ],
          null,
          2,
        ),
        "utf-8",
      );

      const prompt = [
        'Use the delegate tool. description: "tool policy escape audit".',
        "In the child, do exactly one thing: run bash with this command:",
        `\`printf blocked > "${forbiddenPath}"\`.`,
        "Do not retry. Return only the bash tool result text.",
      ].join(" ");

      // Use piSpawn with HOME override to test tool-policy.json
      const result = await piSpawn({
        cwd: sandboxDir,
        task: prompt,
        model: E2E_MODEL,
        env: {
          HOME: sandboxDir,
        },
        session: { persist: false },
      });

      console.log("DEBUG: exitCode:", result.exitCode);
      console.log("DEBUG: stderr:", result.stderr.slice(0, 500));
      console.log("DEBUG: messages count:", result.messages.length);
      console.log(
        "DEBUG: messages roles:",
        result.messages.map((m) => m.role),
      );
      if (result.messages.length > 0) {
        console.log(
          "DEBUG: last message content:",
          JSON.stringify(
            result.messages[result.messages.length - 1]?.content,
            null,
            2,
          )?.slice(0, 1000),
        );
      }

      if (
        result.exitCode !== 0 &&
        /No API key found|Authentication failed/i.test(result.stderr)
      ) {
        console.log("DEBUG: skipping due to auth error");
        return;
      }

      // Find the delegate tool call and result in messages
      const delegateResultMsg = result.messages.find(
        (msg) => msg.role === "toolResult" && (msg as any).toolName === "delegate",
      );
      expect(delegateResultMsg).toBeDefined();

      // Get child messages from delegate result
      const childMessages = (delegateResultMsg as any)?.details?.messages ?? [];
      console.log("DEBUG: childMessages count:", childMessages.length);
      console.log(
        "DEBUG: childMessages roles:",
        childMessages.map((m: any) => m.role),
      );
      if (childMessages.length > 0) {
        childMessages.forEach((m: any, i: number) => {
          console.log(
            `DEBUG: childMessage[${i}] content:`,
            JSON.stringify(m.content)?.slice(0, 500),
          );
        });
      }

      // Find the bash tool call in child messages
      const childToolCalls = childMessages.flatMap((msg: any) =>
        (msg.content ?? [])
          .filter((part: any) => part.type === "toolCall")
          .map((part: any) => part),
      );
      const bashCall = childToolCalls.find((part: any) => part.name === "bash");
      expect(bashCall?.arguments?.cmd ?? "").toContain(forbiddenPath);

      // Find the bash tool result in child messages
      const bashResultMsg = childMessages.find(
        (msg: any) => msg.role === "toolResult" && msg.toolName === "bash",
      );
      const bashText = bashResultMsg?.content?.[0]?.text ?? "";
      expect(bashText).toContain("command rejected");
      expect(bashText).toContain("stay inside the assigned cwd");

      // Verify the file was NOT created
      expect(fs.existsSync(forbiddenPath)).toBe(false);

      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }, 180_000);
  });
}
