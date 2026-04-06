/**
 * SDK-backed integration tests for mentions extension.
 *
 * Tests event handler behavior: input resolution, context injection,
 * and state management across agent/session lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import mentionsExtension, {
  createMentionsExtension,
  type MentionAdapterDeps,
} from "../index";

const CUSTOM_TYPE = "mentions:resolved";

function createTestDeps() {
  const mentionProvider = {
    getSuggestions: vi.fn(),
    applyCompletion: vi.fn(),
    kind: "mention-provider",
  };
  const registerAutocompleteContributor = vi.fn();
  const createMentionProvider = vi.fn(() => mentionProvider);
  const resolveMentionsMock = vi.fn();
  const renderResolvedMentionsTextMock = vi.fn();
  const clearSessionMentionCacheMock = vi.fn();
  const clearCommitIndexCacheMock = vi.fn();

  return {
    deps: {
      registerAutocompleteContributor,
      createMentionProvider,
      resolveMentions: resolveMentionsMock as any,
      renderResolvedMentionsText: renderResolvedMentionsTextMock as any,
      clearSessionMentionCache: clearSessionMentionCacheMock as any,
      clearCommitIndexCache: clearCommitIndexCacheMock as any,
    } satisfies MentionAdapterDeps,
    mentionProvider,
    registerAutocompleteContributor,
    createMentionProvider,
    resolveMentionsMock,
    renderResolvedMentionsTextMock,
    clearSessionMentionCacheMock,
    clearCommitIndexCacheMock,
  };
}

function createMockPi() {
  const handlers: Array<{ event: string; handler: (...args: any[]) => any }> =
    [];

  return {
    pi: {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: any) => handlers.push({ event, handler }),
      events: { emit: vi.fn() },
    } as any,
    handlers,
    getHandler: (event: string) => {
      const entry = handlers.find((h) => h.event === event);
      if (!entry) throw new Error(`missing ${event} handler`);
      return entry.handler;
    },
  };
}

describe("mentions extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("autocomplete registration", () => {
    it("registers an editor autocomplete contributor", () => {
      const { deps, registerAutocompleteContributor, createMentionProvider } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi } = createMockPi();

      ext(pi);

      expect(registerAutocompleteContributor).toHaveBeenCalledTimes(1);
      const contributor = registerAutocompleteContributor.mock.calls[0]?.[0];
      expect(contributor?.id).toBe("mentions");

      const baseProvider = { getSuggestions: vi.fn(), applyCompletion: vi.fn() };
      contributor?.enhance(baseProvider, { cwd: "/repo/app" });

      expect(createMentionProvider).toHaveBeenCalledWith(baseProvider, {
        cwd: "/repo/app",
      });
    });
  });

  describe("input handler", () => {
    it("skips extension-sourced inputs", async () => {
      const { deps, resolveMentionsMock } = createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      ext(pi);

      const result = await getHandler("input")(
        { source: "extension", text: "ignored" },
        { cwd: "/repo" },
      );

      expect(result).toEqual({ action: "continue" });
      expect(resolveMentionsMock).not.toHaveBeenCalled();
    });

    it("resolves mentions and stores context", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      const resolvedMention = {
        token: {
          kind: "session" as const,
          raw: "@session/alpha1234",
          value: "alpha1234",
          start: 6,
          end: 24,
        },
        status: "resolved" as const,
        kind: "session" as const,
        session: {
          sessionId: "alpha1234",
          sessionName: "alpha work",
          workspace: "/repo/app",
          startedAt: "2026-03-06T17:00:00.000Z",
          updatedAt: "2026-03-06T17:10:00.000Z",
          firstUserMessage: "alpha task",
        },
      };

      resolveMentionsMock.mockResolvedValue([resolvedMention]);
      renderResolvedMentionsTextMock.mockReturnValue("resolved context");

      ext(pi);

      await getHandler("input")(
        { source: "user", text: "open @session/alpha1234" },
        { cwd: "/repo/app" },
      );

      expect(resolveMentionsMock).toHaveBeenCalledWith(
        "open @session/alpha1234",
        { cwd: "/repo/app" },
      );
      expect(renderResolvedMentionsTextMock).toHaveBeenCalledWith([
        resolvedMention,
      ]);
    });

    it("filters to resolved mentions only", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      const resolvedMention = {
        token: { kind: "session" as const, raw: "@session/a", value: "a", start: 0, end: 10 },
        status: "resolved" as const,
        kind: "session" as const,
        session: { sessionId: "a", sessionName: "a", workspace: "/", startedAt: "", updatedAt: "", firstUserMessage: "" },
      };
      const unresolvedMention = {
        token: { kind: "session" as const, raw: "@session/missing", value: "missing", start: 11, end: 27 },
        status: "unresolved" as const,
        reason: "session_not_found",
      };

      resolveMentionsMock.mockResolvedValue([resolvedMention, unresolvedMention]);
      renderResolvedMentionsTextMock.mockReturnValue("context");

      ext(pi);
      await getHandler("input")({ source: "user", text: "test" }, { cwd: "/" });

      expect(renderResolvedMentionsTextMock).toHaveBeenCalledWith([
        resolvedMention,
      ]);
    });
  });

  describe("context handler", () => {
    it("injects hidden message when context is active", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([
        { status: "resolved", kind: "session", token: { kind: "session", raw: "@s", value: "s", start: 0, end: 2 }, session: { sessionId: "s" } },
      ]);
      renderResolvedMentionsTextMock.mockReturnValue("resolved context");

      ext(pi);
      await getHandler("input")({ source: "user", text: "test" }, { cwd: "/" });

      const result = await getHandler("context")({
        messages: [{ role: "user", content: "hi" }],
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]).toMatchObject({
        role: "custom",
        customType: CUSTOM_TYPE,
        content: "resolved context",
        display: false,
      });
    });

    it("filters out existing mention messages", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      ext(pi);

      const result = await getHandler("context")({
        messages: [
          { role: "user", content: "hi" },
          { role: "custom", customType: CUSTOM_TYPE, content: "old", display: false },
        ],
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("returns unchanged messages when no active context", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      ext(pi);
      await getHandler("input")({ source: "user", text: "no mentions" }, { cwd: "/" });

      const messages = [{ role: "user", content: "hi" }];
      const result = await getHandler("context")({ messages });

      expect(result.messages).toEqual(messages);
    });
  });

  describe("lifecycle handlers", () => {
    it("clears state on agent_end", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([
        { status: "resolved", kind: "session", token: { kind: "session", raw: "@s", value: "s", start: 0, end: 2 }, session: { sessionId: "s" } },
      ]);
      renderResolvedMentionsTextMock.mockReturnValue("context");

      ext(pi);
      await getHandler("input")({ source: "user", text: "@s" }, { cwd: "/" });

      // Verify context is injected
      let result = await getHandler("context")({ messages: [] });
      expect(result.messages).toHaveLength(1);

      await getHandler("agent_end")();

      result = await getHandler("context")({ messages: [] });
      expect(result.messages).toHaveLength(0);
    });

    it("clears state and caches on session_start", async () => {
      const {
        deps,
        resolveMentionsMock,
        renderResolvedMentionsTextMock,
        clearSessionMentionCacheMock,
        clearCommitIndexCacheMock,
      } = createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([
        { status: "resolved", kind: "session", token: { kind: "session", raw: "@s", value: "s", start: 0, end: 2 }, session: { sessionId: "s" } },
      ]);
      renderResolvedMentionsTextMock.mockReturnValue("context");

      ext(pi);
      await getHandler("input")({ source: "user", text: "@s" }, { cwd: "/" });

      await getHandler("session_start")({ reason: "startup" });

      expect(clearSessionMentionCacheMock).toHaveBeenCalledTimes(1);
      expect(clearCommitIndexCacheMock).toHaveBeenCalledTimes(1);

      const result = await getHandler("context")({ messages: [] });
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty mention resolution", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      ext(pi);
      await getHandler("input")({ source: "user", text: "no mentions" }, { cwd: "/" });

      const result = await getHandler("context")({ messages: [] });
      expect(result.messages).toHaveLength(0);
    });

    it("handles all unresolved mentions", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const ext = createMentionsExtension(deps);
      const { pi, getHandler } = createMockPi();

      resolveMentionsMock.mockResolvedValue([
        {
          token: { kind: "session", raw: "@session/missing", value: "missing", start: 0, end: 16 },
          status: "unresolved",
          reason: "session_not_found",
        },
      ]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      ext(pi);
      await getHandler("input")({ source: "user", text: "@session/missing" }, { cwd: "/" });

      expect(renderResolvedMentionsTextMock).toHaveBeenCalledWith([]);
    });
  });
});
