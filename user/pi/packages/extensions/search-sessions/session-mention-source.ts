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

export function createSessionMentionSource(): MentionSource {
  return {
    kind: "session",
    description: "previous pi session",
    getSuggestions(query, context) {
      return getSessions(context)
        .filter(
          (session) =>
            query.length === 0 ||
            session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((session) => ({
          value: `@session/${session.sessionId}`,
          label: `@session/${session.sessionId}`,
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
        "session",
      );

      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind: "session",
          session: toResolvedSessionMention(result.session),
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? "session_prefix_ambiguous"
            : "session_not_found",
      };
    },
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

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

  describe("createSessionMentionSource", () => {
    it("preserves session resolution and graceful degradation", () => {
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
}
