import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  registerEditorAutocompleteContributor,
  type EditorAutocompleteContributor,
} from "@bds_pi/editor-capabilities";
import {
  MentionAwareProvider,
  renderResolvedMentionsText,
  resolveMentions,
  clearSessionMentionCache,
  clearCommitIndexCache,
  type ResolvedMention,
} from "@bds_pi/mentions";

const CUSTOM_TYPE = "mentions:resolved";

type MentionProviderFactory = EditorAutocompleteContributor["enhance"];

interface MentionAdapterDeps {
  registerAutocompleteContributor(
    contributor: EditorAutocompleteContributor,
  ): void;
  createMentionProvider: MentionProviderFactory;
  resolveMentions: typeof resolveMentions;
  renderResolvedMentionsText: typeof renderResolvedMentionsText;
  clearSessionMentionCache: typeof clearSessionMentionCache;
  clearCommitIndexCache: typeof clearCommitIndexCache;
}

const DEFAULT_DEPS: MentionAdapterDeps = {
  registerAutocompleteContributor: registerEditorAutocompleteContributor,
  createMentionProvider(baseProvider, context) {
    return new MentionAwareProvider({
      baseProvider,
      cwd: context.cwd,
    });
  },
  resolveMentions,
  renderResolvedMentionsText,
  clearSessionMentionCache,
  clearCommitIndexCache,
};

/**
 * resolves special @mentions into hidden turn-local context.
 * also registers mention autocomplete as an optional editor contributor.
 * context is injected per turn, not persisted, so old references dont accumulate.
 */
function createMentionsExtension(deps: MentionAdapterDeps) {
  return function mentionsExtension(pi: ExtensionAPI): void {
    let activeMentionContext = "";

    deps.registerAutocompleteContributor({
      id: "mentions",
      enhance(baseProvider, context) {
        return deps.createMentionProvider(baseProvider, context);
      },
    });

    const clearActive = () => {
      activeMentionContext = "";
    };

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" as const };

      const mentions = await deps.resolveMentions(event.text, { cwd: ctx.cwd });
      const resolved = mentions.filter(
        (
          mention,
        ): mention is Extract<ResolvedMention, { status: "resolved" }> =>
          mention.status === "resolved",
      );

      activeMentionContext = deps.renderResolvedMentionsText(resolved);
      return { action: "continue" as const };
    });

    pi.on("context", async (event) => {
      const messages = event.messages.filter(
        (message: any) => message.customType !== CUSTOM_TYPE,
      );

      if (!activeMentionContext) return { messages };

      return {
        messages: [
          ...messages,
          {
            role: "custom",
            customType: CUSTOM_TYPE,
            content: activeMentionContext,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("agent_end", async () => {
      clearActive();
    });

    pi.on("session_start", async () => {
      clearActive();
      deps.clearSessionMentionCache();
      deps.clearCommitIndexCache();
    });

    pi.on("session_switch", async () => {
      clearActive();
      deps.clearSessionMentionCache();
      deps.clearCommitIndexCache();
    });
  };
}

const mentionsExtension: (pi: ExtensionAPI) => void =
  createMentionsExtension(DEFAULT_DEPS);

export default mentionsExtension;

if (import.meta.vitest) {
  const { beforeEach, describe, expect, it, vi } = import.meta.vitest;

  type RegisteredHandler = (...args: any[]) => any;

  function createMockExtensionApiHarness() {
    const tools: unknown[] = [];
    const commands: Array<{ name: string; command: unknown }> = [];
    const handlers: Array<{ event: string; handler: unknown }> = [];
    const emittedEvents: Array<{ event: string; payload: unknown }> = [];
    const sentUserMessages: string[] = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      registerCommand(name: string, command: unknown) {
        commands.push({ name, command });
      },
      on(event: string, handler: unknown) {
        handlers.push({ event, handler });
      },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      events: {
        emit(event: string, payload: unknown) {
          emittedEvents.push({ event, payload });
        },
      },
    } as unknown as ExtensionAPI;

    return {
      pi,
      tools,
      commands,
      handlers,
      emittedEvents,
      sentUserMessages,
    };
  }

  function getHandler(
    handlers: Array<{ event: string; handler: unknown }>,
    event: string,
  ): RegisteredHandler {
    const entry = handlers.find((handler) => handler.event === event);
    if (!entry) throw new Error(`missing ${event} handler`);
    return entry.handler as RegisteredHandler;
  }

  function createTestDeps() {
    const mentionProvider = {
      getSuggestions: vi.fn(),
      applyCompletion: vi.fn(),
      kind: "mention-provider",
    };
    const registerAutocompleteContributor = vi.fn();
    const createMentionProvider = vi.fn(
      (_baseProvider, _context) => mentionProvider,
    );
    const resolveMentionsMock = vi.fn();
    const renderResolvedMentionsTextMock = vi.fn();
    const clearSessionMentionCacheMock = vi.fn();
    const clearCommitIndexCacheMock = vi.fn();

    return {
      deps: {
        registerAutocompleteContributor,
        createMentionProvider,
        resolveMentions: resolveMentionsMock as typeof resolveMentions,
        renderResolvedMentionsText:
          renderResolvedMentionsTextMock as typeof renderResolvedMentionsText,
        clearSessionMentionCache:
          clearSessionMentionCacheMock as typeof clearSessionMentionCache,
        clearCommitIndexCache:
          clearCommitIndexCacheMock as typeof clearCommitIndexCache,
      } satisfies MentionAdapterDeps,
      registerAutocompleteContributor,
      createMentionProvider,
      resolveMentionsMock,
      renderResolvedMentionsTextMock,
      clearSessionMentionCacheMock,
      clearCommitIndexCacheMock,
    };
  }

  describe("mentions extension", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("registers an editor autocomplete contributor", () => {
      const { deps, registerAutocompleteContributor, createMentionProvider } =
        createTestDeps();
      const mentionsExtension = createMentionsExtension(deps);
      const harness = createMockExtensionApiHarness();

      mentionsExtension(harness.pi);

      expect(registerAutocompleteContributor).toHaveBeenCalledTimes(1);
      const contributor = registerAutocompleteContributor.mock.calls[0]?.[0];
      expect(contributor?.id).toBe("mentions");

      const baseProvider = {
        getSuggestions: vi.fn(),
        applyCompletion: vi.fn(),
      };

      expect(
        contributor?.enhance(baseProvider, { cwd: "/repo/app" }),
      ).toMatchObject({
        kind: "mention-provider",
      });
      expect(createMentionProvider).toHaveBeenCalledWith(baseProvider, {
        cwd: "/repo/app",
      });
    });

    it("resolves mentions on input and injects hidden context only when text is non-empty", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const mentionsExtension = createMentionsExtension(deps);
      const harness = createMockExtensionApiHarness();
      const resolvedSessionMention = {
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
      const unresolvedMention = {
        token: {
          kind: "session" as const,
          raw: "@session/missing",
          value: "missing",
          start: 26,
          end: 42,
        },
        status: "unresolved" as const,
        reason: "session_not_found",
      };

      resolveMentionsMock.mockResolvedValue([
        resolvedSessionMention,
        unresolvedMention,
      ]);
      renderResolvedMentionsTextMock.mockReturnValue(
        "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
      );

      mentionsExtension(harness.pi);

      const inputHandler = getHandler(harness.handlers, "input");
      const contextHandler = getHandler(harness.handlers, "context");
      const baseMessages = [{ role: "user", content: "hi" }];

      await expect(
        inputHandler(
          {
            source: "user",
            text: "open @session/alpha1234 then @session/missing",
          },
          { cwd: "/repo/app" },
        ),
      ).resolves.toEqual({ action: "continue" });

      expect(resolveMentionsMock).toHaveBeenCalledWith(
        "open @session/alpha1234 then @session/missing",
        { cwd: "/repo/app" },
      );
      expect(renderResolvedMentionsTextMock).toHaveBeenCalledWith([
        resolvedSessionMention,
      ]);

      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: [
            ...baseMessages,
            expect.objectContaining({
              role: "custom",
              customType: CUSTOM_TYPE,
              content:
                "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
              display: false,
            }),
          ],
        },
      );

      resolveMentionsMock.mockResolvedValue([resolvedSessionMention]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      await expect(
        inputHandler(
          { source: "user", text: "open @session/alpha1234" },
          { cwd: "/repo/app" },
        ),
      ).resolves.toEqual({ action: "continue" });

      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );
    });

    it("clears adapter state on agent_end, session_start, and session_switch", async () => {
      const {
        deps,
        resolveMentionsMock,
        renderResolvedMentionsTextMock,
        clearSessionMentionCacheMock,
        clearCommitIndexCacheMock,
      } = createTestDeps();
      const mentionsExtension = createMentionsExtension(deps);
      const harness = createMockExtensionApiHarness();
      const resolvedMention = {
        token: {
          kind: "session" as const,
          raw: "@session/alpha1234",
          value: "alpha1234",
          start: 0,
          end: 18,
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
      const baseMessages = [{ role: "user", content: "hi" }];

      resolveMentionsMock.mockResolvedValue([resolvedMention]);
      renderResolvedMentionsTextMock.mockReturnValue(
        "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
      );

      mentionsExtension(harness.pi);

      const inputHandler = getHandler(harness.handlers, "input");
      const contextHandler = getHandler(harness.handlers, "context");
      const agentEndHandler = getHandler(harness.handlers, "agent_end");
      const sessionStartHandler = getHandler(harness.handlers, "session_start");
      const sessionSwitchHandler = getHandler(
        harness.handlers,
        "session_switch",
      );

      const primeState = async () => {
        await inputHandler(
          { source: "user", text: "@session/alpha1234" },
          { cwd: "/repo/app" },
        );
        await expect(
          contextHandler({ messages: baseMessages }),
        ).resolves.toEqual({
          messages: [
            ...baseMessages,
            expect.objectContaining({ customType: CUSTOM_TYPE }),
          ],
        });
      };

      await primeState();
      await agentEndHandler();
      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );
      expect(clearSessionMentionCacheMock).not.toHaveBeenCalled();
      expect(clearCommitIndexCacheMock).not.toHaveBeenCalled();

      await primeState();
      await sessionStartHandler();
      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );
      expect(clearSessionMentionCacheMock).toHaveBeenCalledTimes(1);
      expect(clearCommitIndexCacheMock).toHaveBeenCalledTimes(1);

      await primeState();
      await sessionSwitchHandler();
      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );
      expect(clearSessionMentionCacheMock).toHaveBeenCalledTimes(2);
      expect(clearCommitIndexCacheMock).toHaveBeenCalledTimes(2);
    });

    it("degrades gracefully when mentions resolve to nothing or stay unresolved", async () => {
      const { deps, resolveMentionsMock, renderResolvedMentionsTextMock } =
        createTestDeps();
      const mentionsExtension = createMentionsExtension(deps);
      const harness = createMockExtensionApiHarness();
      const baseMessages = [{ role: "user", content: "hi" }];

      mentionsExtension(harness.pi);

      const inputHandler = getHandler(harness.handlers, "input");
      const contextHandler = getHandler(harness.handlers, "context");

      resolveMentionsMock.mockResolvedValue([]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      await expect(
        inputHandler(
          { source: "user", text: "no mentions here" },
          { cwd: "/repo/app" },
        ),
      ).resolves.toEqual({ action: "continue" });
      expect(renderResolvedMentionsTextMock).toHaveBeenLastCalledWith([]);
      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );

      resolveMentionsMock.mockResolvedValue([
        {
          token: {
            kind: "session" as const,
            raw: "@session/missing",
            value: "missing",
            start: 0,
            end: 16,
          },
          status: "unresolved" as const,
          reason: "session_not_found",
        },
      ]);
      renderResolvedMentionsTextMock.mockReturnValue("");

      await expect(
        inputHandler(
          { source: "user", text: "@session/missing" },
          { cwd: "/repo/app" },
        ),
      ).resolves.toEqual({ action: "continue" });
      expect(renderResolvedMentionsTextMock).toHaveBeenLastCalledWith([]);
      await expect(contextHandler({ messages: baseMessages })).resolves.toEqual(
        {
          messages: baseMessages,
        },
      );
    });
  });
}
