import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enumerateBranches,
  listMentionableSessions,
  parseSessionFile,
  resolveMentionableSession,
  summarizeMentionableSession,
} from "./session-index";

const tempDirs: string[] = [];

function createSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mentions-session-index-"));
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(dir: string, name: string, lines: unknown[]): string {
  const filePath = join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("enumerateBranches", () => {
  it("extracts first user message and touched files from a branch", () => {
    const parsed = parseSessionFile(
      writeSessionFile(
        createSessionsDir(),
        "2026-03-06T17-00-00-000Z_alpha-session.jsonl",
        [
          {
            type: "session",
            version: 1,
            id: "alpha-session",
            timestamp: "2026-03-06T17:00:00.000Z",
            cwd: "/repo/app",
          },
          {
            type: "session_info",
            id: "info-1",
            parentId: null,
            timestamp: "2026-03-06T17:00:01.000Z",
            name: "alpha work",
          },
          {
            type: "message",
            id: "msg-user-1",
            parentId: "info-1",
            timestamp: "2026-03-06T17:00:02.000Z",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "check @user/pi/packages/core/mentions/index.ts and /tmp/demo.ts",
                },
              ],
            },
          },
          {
            type: "message",
            id: "msg-assistant-1",
            parentId: "msg-user-1",
            timestamp: "2026-03-06T17:00:03.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "looking now" },
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: "read",
                  arguments: { path: "/repo/app/src/index.ts" },
                },
              ],
            },
          },
        ],
      ),
    );

    expect(parsed.header).not.toBeNull();
    const branches = enumerateBranches(
      parsed.header!,
      parsed.entries,
      parsed.sessionName,
      parsed.filePath,
    );

    expect(branches).toHaveLength(1);
    expect(branches[0]).toEqual(
      expect.objectContaining({
        sessionId: "alpha-session",
        sessionName: "alpha work",
        firstUserMessage:
          "check @user/pi/packages/core/mentions/index.ts and /tmp/demo.ts",
        filesTouched: expect.arrayContaining([
          "user/pi/packages/core/mentions/index.ts",
          "/tmp/demo.ts",
          "/repo/app/src/index.ts",
        ]),
      }),
    );
  });
});

describe("summarizeMentionableSession", () => {
  it("marks forked sessions with a first user message as handoff candidates", () => {
    const parsed = parseSessionFile(
      writeSessionFile(
        createSessionsDir(),
        "2026-03-06T17-10-00-000Z_handoff-1.jsonl",
        [
          {
            type: "session",
            version: 1,
            id: "handoff-1",
            timestamp: "2026-03-06T17:10:00.000Z",
            cwd: "/repo/app",
            parentSession: "/sessions/2026-03-06T17-00-00-000Z_parent.jsonl",
          },
          {
            type: "session_info",
            id: "info-1",
            parentId: null,
            timestamp: "2026-03-06T17:10:01.000Z",
            name: "follow-up",
          },
          {
            type: "message",
            id: "msg-user-1",
            parentId: "info-1",
            timestamp: "2026-03-06T17:10:02.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "continue from the handoff" }],
            },
          },
        ],
      ),
    );

    expect(summarizeMentionableSession(parsed)).toEqual(
      expect.objectContaining({
        sessionId: "handoff-1",
        sessionName: "follow-up",
        firstUserMessage: "continue from the handoff",
        isHandoffCandidate: true,
      }),
    );
  });

  it("keeps forked sessions without a user message out of handoff results", () => {
    const parsed = parseSessionFile(
      writeSessionFile(
        createSessionsDir(),
        "2026-03-06T17-20-00-000Z_handoff-2.jsonl",
        [
          {
            type: "session",
            version: 1,
            id: "handoff-2",
            timestamp: "2026-03-06T17:20:00.000Z",
            cwd: "/repo/app",
            parentSession: "/sessions/2026-03-06T17-00-00-000Z_parent.jsonl",
          },
          {
            type: "session_info",
            id: "info-1",
            parentId: null,
            timestamp: "2026-03-06T17:20:01.000Z",
            name: "empty follow-up",
          },
        ],
      ),
    );

    expect(summarizeMentionableSession(parsed)).toEqual(
      expect.objectContaining({
        sessionId: "handoff-2",
        firstUserMessage: "",
        isHandoffCandidate: false,
      }),
    );
  });
});

describe("listMentionableSessions + resolveMentionableSession", () => {
  it("filters handoff sessions and resolves unique prefixes", () => {
    const dir = createSessionsDir();

    writeSessionFile(dir, "2026-03-06T17-30-00-000Z_alpha1234.jsonl", [
      {
        type: "session",
        version: 1,
        id: "alpha1234",
        timestamp: "2026-03-06T17:30:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-06T17:30:01.000Z",
        name: "alpha",
      },
      {
        type: "message",
        id: "msg-user-1",
        parentId: "info-1",
        timestamp: "2026-03-06T17:30:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "alpha task" }],
        },
      },
    ]);

    writeSessionFile(dir, "2026-03-06T17-31-00-000Z_handoffabcd.jsonl", [
      {
        type: "session",
        version: 1,
        id: "handoffabcd",
        timestamp: "2026-03-06T17:31:00.000Z",
        cwd: "/repo/app",
        parentSession: "/sessions/parent.jsonl",
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-06T17:31:01.000Z",
        name: "handoff alpha",
      },
      {
        type: "message",
        id: "msg-user-1",
        parentId: "info-1",
        timestamp: "2026-03-06T17:31:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "resume alpha" }],
        },
      },
    ]);

    const sessions = listMentionableSessions(dir);
    expect(sessions.map((session) => session.sessionId)).toEqual([
      "handoffabcd",
      "alpha1234",
    ]);

    const handoffs = listMentionableSessions(dir, { kind: "handoff" });
    expect(handoffs.map((session) => session.sessionId)).toEqual([
      "handoffabcd",
    ]);

    expect(resolveMentionableSession(sessions, "handoffa", "handoff")).toEqual({
      status: "resolved",
      session: expect.objectContaining({ sessionId: "handoffabcd" }),
    });
  });
});
