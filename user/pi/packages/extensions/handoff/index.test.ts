import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionToken } from "../../core/mentions/types";
import { createMockExtensionApiHarness } from "../test-utils/mock-extension-api";

vi.mock("@bds_pi/config", () => ({
  getExtensionConfig: <T extends Record<string, unknown>>(
    _namespace: string,
    defaults: T,
  ) => defaults,
}));

vi.mock("@bds_pi/mentions", async () =>
  import("../../core/mentions/index"),
);

vi.mock("@bds_pi/pi-spawn", () => ({
  resolvePrompt: () => "",
}));

const REGULAR_SESSION = {
  sessionId: "alpha1234",
  sessionName: "alpha work",
  workspace: "/repo/app",
  filePath: "/sessions/alpha.jsonl",
  startedAt: "2026-03-06T17:00:00.000Z",
  updatedAt: "2026-03-06T17:10:00.000Z",
  firstUserMessage: "alpha task",
  searchableText: "alpha task",
  branchCount: 1,
  isHandoffCandidate: false,
};

const HANDOFF_SESSION = {
  sessionId: "handoffabcd",
  sessionName: "handoff alpha",
  workspace: "/repo/app",
  filePath: "/sessions/handoff.jsonl",
  startedAt: "2026-03-06T17:00:00.000Z",
  updatedAt: "2026-03-06T17:20:00.000Z",
  firstUserMessage: "resume alpha",
  searchableText: "resume alpha",
  branchCount: 1,
  parentSessionPath: "/sessions/parent.jsonl",
  isHandoffCandidate: true,
};

describe("handoff extension", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers the local handoff mention source when loaded", async () => {
    const { getMentionSource } = await import("../../core/mentions/sources");
    expect(getMentionSource("handoff")).toBeNull();

    const { default: handoffExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    handoffExtension(harness.pi);

    const source = getMentionSource("handoff");
    expect(source?.kind).toBe("handoff");
    expect(
      source?.getSuggestions("handoff", {
        cwd: "/repo/app",
        sessions: [REGULAR_SESSION, HANDOFF_SESSION],
      }),
    ).toEqual([
      {
        value: "@handoff/handoffabcd",
        label: "@handoff/handoffabcd",
        description: "handoff alpha",
      },
    ]);
    expect(harness.commands).toEqual([
      {
        name: "handoff",
        command: expect.any(Object),
      },
    ]);
  });

  it("preserves handoff-only resolution and graceful degradation", async () => {
    const { createHandoffMentionSource } = await import("./handoff-mention-source");
    const source = createHandoffMentionSource();

    expect(
      source.getSuggestions("", {
        cwd: "/repo/app",
        sessionsDir: "/definitely/missing",
      }),
    ).toEqual([]);

    expect(
      source.getSuggestions("", {
        cwd: "/repo/app",
        sessions: [REGULAR_SESSION, HANDOFF_SESSION],
      }),
    ).toEqual([
      {
        value: "@handoff/handoffabcd",
        label: "@handoff/handoffabcd",
        description: "handoff alpha",
      },
    ]);

    const handoffToken: MentionToken = {
      kind: "handoff",
      raw: "@handoff/handoff",
      value: "handoff",
      start: 0,
      end: 16,
    };

    expect(
      source.resolve(handoffToken, {
        cwd: "/repo/app",
        sessions: [REGULAR_SESSION, HANDOFF_SESSION],
      }),
    ).toEqual({
      token: handoffToken,
      status: "resolved",
      kind: "handoff",
      session: {
        sessionId: "handoffabcd",
        sessionName: "handoff alpha",
        workspace: "/repo/app",
        startedAt: "2026-03-06T17:00:00.000Z",
        updatedAt: "2026-03-06T17:20:00.000Z",
        firstUserMessage: "resume alpha",
        parentSessionPath: "/sessions/parent.jsonl",
      },
    });

    expect(
      source.resolve(handoffToken, {
        cwd: "/repo/app",
        sessions: [
          HANDOFF_SESSION,
          {
            ...HANDOFF_SESSION,
            sessionId: "handoffwxyz",
            filePath: "/sessions/handoff-2.jsonl",
            updatedAt: "2026-03-06T17:30:00.000Z",
          },
        ],
      }),
    ).toEqual({
      token: handoffToken,
      status: "unresolved",
      reason: "handoff_prefix_ambiguous",
    });

    expect(
      source.resolve(
        {
          kind: "handoff",
          raw: "@handoff/missing",
          value: "missing",
          start: 0,
          end: 16,
        },
        {
          cwd: "/repo/app",
          sessions: [REGULAR_SESSION],
        },
      ),
    ).toEqual({
      token: {
        kind: "handoff",
        raw: "@handoff/missing",
        value: "missing",
        start: 0,
        end: 16,
      },
      status: "unresolved",
      reason: "handoff_not_found",
    });
  });
});
