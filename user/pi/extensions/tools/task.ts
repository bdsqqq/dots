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

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "./lib/pi-spawn";
import {
  getFinalOutput,
  renderAgentTree,
  subAgentResult,
  type SingleResult,
} from "./lib/sub-agent-render";

const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const EXTENSION_TOOLS = [
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
];

export function createTaskTool(): ToolDefinition {
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let sessionId = "";
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        /* graceful */
      }

      const singleResult: SingleResult = {
        agent: "Task",
        task: params.description,
        exitCode: -1,
        messages: [],
        usage: zeroUsage(),
      };

      const result = await piSpawn({
        cwd: ctx.cwd,
        task: params.prompt,
        builtinTools: BUILTIN_TOOLS,
        extensionTools: EXTENSION_TOOLS,
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
