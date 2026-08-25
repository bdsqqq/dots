import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptAmpTurn,
  publishAmpMemorySession,
  publishMaintenanceWake,
} from "./pi-memory-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Amp memory adapter", () => {
  it("creates deterministic native checkpoints without reasoning", () => {
    const input = {
      threadId: "T-contract",
      messageId: "turn-1",
      workspace: "/tmp/project",
      status: "done" as const,
      messages: [
        {
          role: "user" as const,
          id: 1,
          content: [{ type: "text" as const, text: "remember this" }],
        },
        {
          role: "assistant" as const,
          id: 2,
          content: [
            { type: "thinking" as const, thinking: "private reasoning" },
            { type: "text" as const, text: "noted" },
          ],
        },
      ],
    };
    const first = adaptAmpTurn(input);
    const second = adaptAmpTurn(input);
    const contract = readFileSync(
      new URL(
        "../../pi/packages/core/agent-memory/test-fixtures/amp-checkpoint-v2.jsonl",
        import.meta.url,
      ),
      "utf8",
    );

    expect(first).toEqual(second);
    expect(first?.jsonl).toBe(contract);
    expect(first?.jsonl).not.toContain("private reasoning");
  });

  it("preserves tool calls and results while dropping info messages", () => {
    const session = adaptAmpTurn({
      threadId: "T-tools",
      messageId: 7,
      workspace: "/tmp/project",
      status: "done",
      messages: [
        {
          role: "user",
          id: 1,
          content: [{ type: "text", text: "inspect it" }],
        },
        {
          role: "assistant",
          id: 2,
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "Read",
              input: { path: "/tmp/a" },
            },
          ],
        },
        {
          role: "user",
          id: 3,
          content: [
            {
              type: "tool_result",
              toolUseID: "call-1",
              output: "failed",
              status: "error",
            },
          ],
        },
        {
          role: "info",
          id: 4,
          content: [{ type: "text", text: "provider metadata" }],
        },
        {
          role: "assistant",
          id: 5,
          content: [{ type: "text", text: "could not read it" }],
        },
      ],
    });

    expect(session?.jsonl).toContain('"type":"toolCall"');
    expect(session?.jsonl).toContain('"role":"toolResult"');
    expect(session?.jsonl).toContain('"isError":true');
    expect(session?.jsonl).not.toContain("provider metadata");
  });

  it("skips incomplete, failed, and cancelled turns", () => {
    const base = {
      threadId: "T-incomplete",
      messageId: 1,
      workspace: "/tmp/project",
      messages: [
        {
          role: "user" as const,
          id: 1,
          content: [{ type: "text" as const, text: "hello" }],
        },
      ],
    };
    expect(adaptAmpTurn({ ...base, status: "done" })).toBeUndefined();
    expect(adaptAmpTurn({ ...base, status: "error" })).toBeUndefined();
    expect(adaptAmpTurn({ ...base, status: "cancelled" })).toBeUndefined();
  });

  it("publishes once and rejects divergent duplicate evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-memory-"));
    temporaryDirectories.push(directory);
    const session = adaptAmpTurn({
      threadId: "T-publish",
      messageId: 1,
      workspace: "/tmp/project",
      status: "done",
      messages: [
        {
          role: "user",
          id: 1,
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          id: 2,
          content: [{ type: "text", text: "hi" }],
        },
      ],
    })!;

    expect(publishAmpMemorySession(directory, session)).toBe("created");
    expect(publishAmpMemorySession(directory, session)).toBe("existing");
    expect(readFileSync(join(directory, `${session.id}.jsonl`), "utf8")).toBe(
      session.jsonl,
    );
    expect(() =>
      publishAmpMemorySession(directory, {
        ...session,
        jsonl: `${session.jsonl}changed\n`,
      }),
    ).toThrow("identity collision");
  });

  it("atomically replaces the durable maintenance wake", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-memory-wake-"));
    temporaryDirectories.push(directory);

    publishMaintenanceWake(directory, "first");
    publishMaintenanceWake(directory, "second");

    expect(readFileSync(join(directory, "wake"), "utf8")).toBe("second\n");
  });
});
