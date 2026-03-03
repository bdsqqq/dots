/**
 * unit tests for sub-agent-render — formatting utilities.
 *
 * tests pure functions: formatUsageStats, getFinalOutput, getDisplayItems.
 * renderAgentTree depends on pi-tui components, not tested here.
 *
 * run: bun test user/pi/extensions/tools/lib/sub-agent-render.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  formatUsageStats,
  getFinalOutput,
  getDisplayItems,
  subAgentResult,
} from "./sub-agent-render";
import type { Message } from "@mariozechner/pi-ai";

describe("formatUsageStats", () => {
  it("formats all fields when present", () => {
    const result = formatUsageStats(
      {
        input: 1500,
        output: 500,
        cacheRead: 2000,
        cacheWrite: 1000,
        cost: 0.0023,
        contextTokens: 5000,
        turns: 2,
      },
      "gpt-4",
    );

    expect(result).toContain("2 turns");
    expect(result).toContain("↑1.5k");
    expect(result).toContain("↓500");
    expect(result).toContain("R2.0k");
    expect(result).toContain("W1.0k");
    expect(result).toContain("$0.0023");
    expect(result).toContain("ctx:5.0k");
    expect(result).toContain("gpt-4");
  });

  it("omits zero/undefined fields", () => {
    const result = formatUsageStats({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });

    expect(result).toContain("↑100");
    expect(result).toContain("↓50");
    expect(result).not.toContain("turn");
    expect(result).not.toContain("R");
    expect(result).not.toContain("W");
    expect(result).not.toContain("$");
    expect(result).not.toContain("ctx");
  });

  it("formats large token counts", () => {
    expect(formatUsageStats({ input: 1500000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toContain("↑1.5M");
    expect(formatUsageStats({ input: 15000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toContain("↑15k");
    expect(formatUsageStats({ input: 1500, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toContain("↑1.5k");
    expect(formatUsageStats({ input: 500, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toContain("↑500");
  });

  it("handles single turn", () => {
    const result = formatUsageStats({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    });
    expect(result).toContain("1 turn");
    expect(result).not.toContain("1 turns");
  });

  it("handles plural turns", () => {
    const result = formatUsageStats({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 3,
    });
    expect(result).toContain("3 turns");
  });
});

describe("getFinalOutput", () => {
  it("returns text from last assistant message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 } as Message,
      { role: "assistant", content: [{ type: "text", text: "first response" }], api: "anthropic-messages", provider: "anthropic", model: "claude", usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as Message,
      { role: "user", content: [{ type: "text", text: "more" }], timestamp: 0 } as Message,
      { role: "assistant", content: [{ type: "text", text: "final response" }], api: "anthropic-messages", provider: "anthropic", model: "claude", usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as Message,
    ];

    expect(getFinalOutput(messages)).toBe("final response");
  });

  it("returns empty string when no assistant messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 } as Message,
    ];

    expect(getFinalOutput(messages)).toBe("");
  });

  it("skips tool calls, returns only text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } },
          { type: "text", text: "here's the output" },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      } as Message,
    ];

    expect(getFinalOutput(messages)).toBe("here's the output");
  });

  it("handles empty message array", () => {
    expect(getFinalOutput([])).toBe("");
  });
});

describe("getDisplayItems", () => {
  it("extracts text and tool calls from messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "response" },
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/file" } } as any,
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "file content" }],
      } as any,
    ];

    const items = getDisplayItems(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "text", text: "response" });
    expect(items[1]).toEqual({
      type: "toolCall",
      id: "tc1",
      name: "read",
      args: { path: "/file" },
      isError: undefined,
    });
  });

  it("marks tool calls as error when toolResult has isError", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "false" } } as any,
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "error" }],
        isError: true,
      } as any,
    ];

    const items = getDisplayItems(messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "toolCall",
      id: "tc1",
      isError: true,
    });
  });

  it("marks tool calls as success when isError is false", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "true" } } as any,
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "done" }],
        isError: false,
      } as any,
    ];

    const items = getDisplayItems(messages);

    expect(items[0]).toMatchObject({
      type: "toolCall",
      id: "tc1",
      isError: false,
    });
  });

  it("handles multiple assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      } as Message,
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      } as Message,
    ];

    const items = getDisplayItems(messages);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: "text", text: "first" });
    expect(items[1]).toEqual({ type: "text", text: "second" });
  });
});

describe("subAgentResult", () => {
  it("builds result with cost from usage", () => {
    const details = {
      agent: "finder",
      task: "search for x",
      exitCode: 0,
      messages: [] as Message[],
      usage: {
        turns: 1,
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.002,
        contextTokens: 0,
      },
      model: "gemini-flash",
    };

    const result = subAgentResult("found it", details);

    expect(result.content).toEqual([{ type: "text", text: "found it" }]);
    expect(result.details.cost).toBe(0.002);
    expect(result.details.model).toBe("gemini-flash");
    expect(result.isError).toBeUndefined();
  });

  it("sets isError when passed true", () => {
    const details = {
      agent: "oracle",
      task: "advise",
      exitCode: 1,
      messages: [] as Message[],
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    };

    const result = subAgentResult("failed", details, true);

    expect(result.isError).toBe(true);
  });
});