import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockExtensionApiHarness } from "../test-utils/mock-extension-api";

vi.mock("@bds_pi/config", () => ({
  getExtensionConfig: <T extends Record<string, unknown>>(
    _namespace: string,
    defaults: T,
  ) => defaults,
}));

vi.mock("@bds_pi/prompt-patch", () => ({
  withPromptPatch: <T>(tool: T) => tool,
}));

vi.mock("@bds_pi/mentions", async () =>
  import("../../core/mentions/index"),
);

vi.mock("@bds_pi/box-format", () => ({
  boxRendererWindowed: () => null,
}));

const SESSION_FIXTURE = {
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

describe("search-sessions extension", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers the local session mention source when loaded", async () => {
    const { getMentionSource } = await import("../../core/mentions/sources");
    expect(getMentionSource("session")).toBeNull();

    const { default: searchSessionsExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    searchSessionsExtension(harness.pi);

    const source = getMentionSource("session");
    expect(source?.kind).toBe("session");
    expect(
      source?.getSuggestions("alpha", {
        cwd: "/repo/app",
        sessions: [SESSION_FIXTURE],
      }),
    ).toEqual([
      {
        value: "@session/alpha1234",
        label: "@session/alpha1234",
        description: "alpha work",
      },
    ]);
    expect(harness.tools).toHaveLength(1);
  });

  it("preserves session resolution and graceful degradation", async () => {
    const { createSessionMentionSource } = await import("./session-mention-source");
    const source = createSessionMentionSource();

    expect(
      source.getSuggestions("", {
        cwd: "/repo/app",
        sessionsDir: "/definitely/missing",
      }),
    ).toEqual([]);

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/alpha",
          value: "alpha",
          start: 0,
          end: 14,
        },
        {
          cwd: "/repo/app",
          sessions: [SESSION_FIXTURE],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/alpha",
        value: "alpha",
        start: 0,
        end: 14,
      },
      status: "resolved",
      kind: "session",
      session: {
        sessionId: "alpha1234",
        sessionName: "alpha work",
        workspace: "/repo/app",
        startedAt: "2026-03-06T17:00:00.000Z",
        updatedAt: "2026-03-06T17:10:00.000Z",
        firstUserMessage: "alpha task",
        parentSessionPath: undefined,
      },
    });

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/alpha",
          value: "alpha",
          start: 0,
          end: 14,
        },
        {
          cwd: "/repo/app",
          sessions: [
            SESSION_FIXTURE,
            {
              ...SESSION_FIXTURE,
              sessionId: "alpha5678",
              filePath: "/sessions/alpha-2.jsonl",
              updatedAt: "2026-03-06T17:20:00.000Z",
            },
          ],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/alpha",
        value: "alpha",
        start: 0,
        end: 14,
      },
      status: "unresolved",
      reason: "session_prefix_ambiguous",
    });

    expect(
      source.resolve(
        {
          kind: "session",
          raw: "@session/missing",
          value: "missing",
          start: 0,
          end: 16,
        },
        {
          cwd: "/repo/app",
          sessions: [SESSION_FIXTURE],
        },
      ),
    ).toEqual({
      token: {
        kind: "session",
        raw: "@session/missing",
        value: "missing",
        start: 0,
        end: 16,
      },
      status: "unresolved",
      reason: "session_not_found",
    });
  });
});
