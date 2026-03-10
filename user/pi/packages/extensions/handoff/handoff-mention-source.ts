import {
  DEFAULT_MENTION_SESSIONS_DIR,
  getSessionMentionsIndex,
  resolveMentionableSession,
  toResolvedSessionMention,
  type MentionSource,
  type MentionSourceContext,
} from "@bds_pi/mentions";

function getSessions(context: MentionSourceContext) {
  return (
    context.sessions ??
    getSessionMentionsIndex(context.sessionsDir ?? DEFAULT_MENTION_SESSIONS_DIR)
  );
}

export function createHandoffMentionSource(): MentionSource {
  return {
    kind: "handoff",
    description: "forked session with resumable context",
    getSuggestions(query, context) {
      return getSessions(context)
        .filter((session) => session.isHandoffCandidate)
        .filter(
          (session) =>
            query.length === 0 ||
            session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((session) => ({
          value: `@handoff/${session.sessionId}`,
          label: `@handoff/${session.sessionId}`,
          description:
            session.sessionName ||
            session.firstUserMessage ||
            session.workspace,
        }));
    },
    resolve(token, context) {
      const result = resolveMentionableSession(
        getSessions(context),
        token.value,
        "handoff",
      );

      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind: "handoff",
          session: toResolvedSessionMention(result.session),
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? "handoff_prefix_ambiguous"
            : "handoff_not_found",
      };
    },
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

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

  describe("createHandoffMentionSource", () => {
    it("preserves handoff-only resolution and graceful degradation", () => {
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

      const handoffToken = {
        kind: "handoff" as const,
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
}
