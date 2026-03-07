import type { CommitIndex } from "./commit-index";
import { parseMentions } from "./parse";
import { getMentionSource, type MentionSourceContext } from "./sources";
import type { MentionableSession } from "./session-index";
import type { MentionToken, ResolvedMention } from "./types";

export interface ResolveMentionsOptions extends MentionSourceContext {
  cwd: string;
  commitIndex?: CommitIndex | null;
  sessionsDir?: string;
  sessions?: MentionableSession[] | null;
}

export async function resolveMention(
  token: MentionToken,
  options: ResolveMentionsOptions,
): Promise<ResolvedMention> {
  const source = getMentionSource(token.kind);
  if (!source) {
    return {
      token,
      status: "unresolved",
      reason: `${token.kind}_mentions_not_supported_yet`,
    };
  }

  return source.resolve(token, options);
}

export async function resolveMentions(
  input: string | MentionToken[],
  options: ResolveMentionsOptions,
): Promise<ResolvedMention[]> {
  const tokens = typeof input === "string" ? parseMentions(input) : input;
  return Promise.all(tokens.map((token) => resolveMention(token, options)));
}
