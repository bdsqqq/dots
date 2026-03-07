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
            session.sessionName || session.firstUserMessage || session.workspace,
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
