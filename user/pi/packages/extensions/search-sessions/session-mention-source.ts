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
            session.sessionName || session.firstUserMessage || session.workspace,
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
