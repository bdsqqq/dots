import { getCommitIndex, lookupCommitByPrefix, type CommitIndex } from "./commit-index";
import { parseMentions } from "./parse";
import type { MentionToken, ResolvedMention } from "./types";

export interface ResolveMentionsOptions {
  cwd: string;
  commitIndex?: CommitIndex | null;
}

export async function resolveMention(
  token: MentionToken,
  options: ResolveMentionsOptions,
): Promise<ResolvedMention> {
  if (token.kind !== "commit") {
    return {
      token,
      status: "unresolved",
      reason: `${token.kind}_mentions_not_supported_yet`,
    };
  }

  const index = options.commitIndex ?? getCommitIndex(options.cwd);
  if (!index) {
    return { token, status: "unresolved", reason: "git_repository_not_found" };
  }

  const result = lookupCommitByPrefix(token.value, index);
  if (result.status === "resolved") {
    return { token, status: "resolved", commit: result.commit };
  }

  return {
    token,
    status: "unresolved",
    reason: result.status === "ambiguous" ? "commit_prefix_ambiguous" : "commit_not_found",
  };
}

export async function resolveMentions(
  input: string | MentionToken[],
  options: ResolveMentionsOptions,
): Promise<ResolvedMention[]> {
  const tokens = typeof input === "string" ? parseMentions(input) : input;
  return Promise.all(tokens.map((token) => resolveMention(token, options)));
}
