import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockExtensionApiHarness } from "../test-utils/mock-extension-api";

const mocks = vi.hoisted(() => {
  const registerEditorAutocompleteContributor = vi.fn();
  const resolveMentions = vi.fn();
  const renderResolvedMentionsText = vi.fn();
  const clearSessionMentionCache = vi.fn();
  const clearCommitIndexCache = vi.fn();

  class MentionAwareProvider {
    static instances: MentionAwareProvider[] = [];
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
      MentionAwareProvider.instances.push(this);
    }
  }

  return {
    registerEditorAutocompleteContributor,
    resolveMentions,
    renderResolvedMentionsText,
    clearSessionMentionCache,
    clearCommitIndexCache,
    MentionAwareProvider,
  };
});

vi.mock("@bds_pi/editor-capabilities", () => ({
  registerEditorAutocompleteContributor: mocks.registerEditorAutocompleteContributor,
}));

vi.mock("@bds_pi/mentions", () => ({
  MentionAwareProvider: mocks.MentionAwareProvider,
  resolveMentions: mocks.resolveMentions,
  renderResolvedMentionsText: mocks.renderResolvedMentionsText,
  clearSessionMentionCache: mocks.clearSessionMentionCache,
  clearCommitIndexCache: mocks.clearCommitIndexCache,
}));

type RegisteredHandler = (...args: any[]) => any;

function getHandler(
  handlers: Array<{ event: string; handler: unknown }>,
  event: string,
): RegisteredHandler {
  const entry = handlers.find((handler) => handler.event === event);
  if (!entry) throw new Error(`missing ${event} handler`);
  return entry.handler as RegisteredHandler;
}

describe("mentions extension", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.MentionAwareProvider.instances = [];
  });

  it("registers an editor autocomplete contributor", async () => {
    const { default: mentionsExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    mentionsExtension(harness.pi);

    expect(mocks.registerEditorAutocompleteContributor).toHaveBeenCalledTimes(1);
    const contributor = mocks.registerEditorAutocompleteContributor.mock.calls[0]?.[0];
    expect(contributor?.id).toBe("mentions");

    const baseProvider = {
      getSuggestions: vi.fn(),
      applyCompletion: vi.fn(),
    };

    const provider = contributor?.enhance(baseProvider, { cwd: "/repo/app" });

    expect(provider).toBeInstanceOf(mocks.MentionAwareProvider);
    expect(mocks.MentionAwareProvider.instances[0]?.options).toEqual({
      baseProvider,
      cwd: "/repo/app",
    });
  });

  it("resolves mentions on input and injects hidden context only when text is non-empty", async () => {
    const resolvedSessionMention = {
      token: {
        kind: "session",
        raw: "@session/alpha1234",
        value: "alpha1234",
        start: 6,
        end: 24,
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
      },
    };
    const unresolvedMention = {
      token: {
        kind: "session",
        raw: "@session/missing",
        value: "missing",
        start: 26,
        end: 42,
      },
      status: "unresolved",
      reason: "session_not_found",
    };

    mocks.resolveMentions.mockResolvedValue([
      resolvedSessionMention,
      unresolvedMention,
    ]);
    mocks.renderResolvedMentionsText.mockReturnValue(
      "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
    );

    const { default: mentionsExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    mentionsExtension(harness.pi);

    const inputHandler = getHandler(harness.handlers, "input");
    const contextHandler = getHandler(harness.handlers, "context");
    const baseMessages = [{ role: "user", content: "hi" }];

    await expect(
      inputHandler(
        { source: "user", text: "open @session/alpha1234 then @session/missing" },
        { cwd: "/repo/app" },
      ),
    ).resolves.toEqual({ action: "continue" });

    expect(mocks.resolveMentions).toHaveBeenCalledWith(
      "open @session/alpha1234 then @session/missing",
      { cwd: "/repo/app" },
    );
    expect(mocks.renderResolvedMentionsText).toHaveBeenCalledWith([
      resolvedSessionMention,
    ]);

    await expect(
      contextHandler({ messages: baseMessages }),
    ).resolves.toEqual({
      messages: [
        ...baseMessages,
        expect.objectContaining({
          role: "custom",
          customType: "mentions:resolved",
          content:
            "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
          display: false,
        }),
      ],
    });

    mocks.resolveMentions.mockResolvedValue([resolvedSessionMention]);
    mocks.renderResolvedMentionsText.mockReturnValue("");

    await expect(
      inputHandler(
        { source: "user", text: "open @session/alpha1234" },
        { cwd: "/repo/app" },
      ),
    ).resolves.toEqual({ action: "continue" });

    await expect(
      contextHandler({ messages: baseMessages }),
    ).resolves.toEqual({ messages: baseMessages });
  });

  it("clears adapter state on agent_end, session_start, and session_switch", async () => {
    const resolvedMention = {
      token: {
        kind: "session",
        raw: "@session/alpha1234",
        value: "alpha1234",
        start: 0,
        end: 18,
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
      },
    };

    mocks.resolveMentions.mockResolvedValue([resolvedMention]);
    mocks.renderResolvedMentionsText.mockReturnValue(
      "resolved mention context:\n@session/alpha1234\tsession\talpha1234",
    );

    const { default: mentionsExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    mentionsExtension(harness.pi);

    const inputHandler = getHandler(harness.handlers, "input");
    const contextHandler = getHandler(harness.handlers, "context");
    const agentEndHandler = getHandler(harness.handlers, "agent_end");
    const sessionStartHandler = getHandler(harness.handlers, "session_start");
    const sessionSwitchHandler = getHandler(harness.handlers, "session_switch");
    const baseMessages = [{ role: "user", content: "hi" }];

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
          expect.objectContaining({ customType: "mentions:resolved" }),
        ],
      });
    };

    await primeState();
    await agentEndHandler();
    await expect(contextHandler({ messages: baseMessages })).resolves.toEqual({
      messages: baseMessages,
    });
    expect(mocks.clearSessionMentionCache).not.toHaveBeenCalled();
    expect(mocks.clearCommitIndexCache).not.toHaveBeenCalled();

    await primeState();
    await sessionStartHandler();
    await expect(contextHandler({ messages: baseMessages })).resolves.toEqual({
      messages: baseMessages,
    });
    expect(mocks.clearSessionMentionCache).toHaveBeenCalledTimes(1);
    expect(mocks.clearCommitIndexCache).toHaveBeenCalledTimes(1);

    await primeState();
    await sessionSwitchHandler();
    await expect(contextHandler({ messages: baseMessages })).resolves.toEqual({
      messages: baseMessages,
    });
    expect(mocks.clearSessionMentionCache).toHaveBeenCalledTimes(2);
    expect(mocks.clearCommitIndexCache).toHaveBeenCalledTimes(2);
  });

  it("degrades gracefully when mentions resolve to nothing or stay unresolved", async () => {
    const { default: mentionsExtension } = await import("./index");
    const harness = createMockExtensionApiHarness();

    mentionsExtension(harness.pi);

    const inputHandler = getHandler(harness.handlers, "input");
    const contextHandler = getHandler(harness.handlers, "context");
    const baseMessages = [{ role: "user", content: "hi" }];

    mocks.resolveMentions.mockResolvedValue([]);
    mocks.renderResolvedMentionsText.mockReturnValue("");

    await expect(
      inputHandler({ source: "user", text: "no mentions here" }, { cwd: "/repo/app" }),
    ).resolves.toEqual({ action: "continue" });
    expect(mocks.renderResolvedMentionsText).toHaveBeenLastCalledWith([]);
    await expect(contextHandler({ messages: baseMessages })).resolves.toEqual({
      messages: baseMessages,
    });

    mocks.resolveMentions.mockResolvedValue([
      {
        token: {
          kind: "session",
          raw: "@session/missing",
          value: "missing",
          start: 0,
          end: 16,
        },
        status: "unresolved",
        reason: "session_not_found",
      },
    ]);
    mocks.renderResolvedMentionsText.mockReturnValue("");

    await expect(
      inputHandler({ source: "user", text: "@session/missing" }, { cwd: "/repo/app" }),
    ).resolves.toEqual({ action: "continue" });
    expect(mocks.renderResolvedMentionsText).toHaveBeenLastCalledWith([]);
    await expect(contextHandler({ messages: baseMessages })).resolves.toEqual({
      messages: baseMessages,
    });
  });
});
