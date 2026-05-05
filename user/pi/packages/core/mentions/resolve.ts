import { parseMentions } from "./parse";
import type { MentionSource, MentionSourceContext } from "./sources";
import type { MentionToken, ResolvedMention } from "./types";

export interface ResolveMentionsOptions extends MentionSourceContext {
  sources: MentionSource[];
}

export async function resolveMention(
  token: MentionToken,
  options: ResolveMentionsOptions,
): Promise<ResolvedMention> {
  const source = options.sources.find((candidate) => candidate.kind === token.kind);
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
