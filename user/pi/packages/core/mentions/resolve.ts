import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCache, getOrSet } from "./cache";
import { getCommitIndex, lookupCommitByPrefix, type CommitIndex } from "./commit-index";
import { parseMentions } from "./parse";
import {
  listMentionableSessions,
  resolveMentionableSession,
  type MentionableSession,
} from "./session-index";
import {
  toResolvedSessionMention,
  type MentionToken,
  type ResolvedMention,
} from "./types";

export const DEFAULT_MENTION_SESSIONS_DIR: string = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "sessions",
);

const sessionMentionCache = createCache<string, MentionableSession[]>();

export interface ResolveMentionsOptions {
  cwd: string;
  commitIndex?: CommitIndex | null;
  sessionsDir?: string;
  sessions?: MentionableSession[] | null;
}

export function clearSessionMentionCache(): void {
  sessionMentionCache.clear();
}

export function getSessionMentionsIndex(
  sessionsDir: string = DEFAULT_MENTION_SESSIONS_DIR,
): MentionableSession[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return getOrSet(sessionMentionCache, sessionsDir, () =>
    listMentionableSessions(sessionsDir),
  );
}

export async function resolveMention(
  token: MentionToken,
  options: ResolveMentionsOptions,
): Promise<ResolvedMention> {
  if (token.kind === "commit") {
    const index = options.commitIndex ?? getCommitIndex(options.cwd);
    if (!index) {
      return { token, status: "unresolved", reason: "git_repository_not_found" };
    }

    const result = lookupCommitByPrefix(token.value, index);
    if (result.status === "resolved") {
      return { token, status: "resolved", kind: "commit", commit: result.commit };
    }

    return {
      token,
      status: "unresolved",
      reason:
        result.status === "ambiguous"
          ? "commit_prefix_ambiguous"
          : "commit_not_found",
    };
  }

  const sessions = options.sessions ?? getSessionMentionsIndex(options.sessionsDir);
  const result = resolveMentionableSession(sessions ?? [], token.value, token.kind);

  if (result.status === "resolved") {
    return {
      token,
      status: "resolved",
      kind: token.kind,
      session: toResolvedSessionMention(result.session),
    };
  }

  return {
    token,
    status: "unresolved",
    reason:
      result.status === "ambiguous"
        ? `${token.kind}_prefix_ambiguous`
        : `${token.kind}_not_found`,
  };
}

export async function resolveMentions(
  input: string | MentionToken[],
  options: ResolveMentionsOptions,
): Promise<ResolvedMention[]> {
  const tokens = typeof input === "string" ? parseMentions(input) : input;
  return Promise.all(tokens.map((token) => resolveMention(token, options)));
}
