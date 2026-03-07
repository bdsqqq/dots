import type { MentionableSession } from "./session-index";

export type MentionKind = "commit" | "session" | "handoff";

export interface MentionToken {
  kind: MentionKind;
  raw: string;
  value: string;
  start: number;
  end: number;
}

export interface MentionPrefix {
  raw: string;
  start: number;
  end: number;
  familyQuery: string;
  kind: MentionKind | null;
  valueQuery: string;
  hasSlash: boolean;
}

export interface ResolvedCommitMention {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

export interface ResolvedSessionMention {
  sessionId: string;
  sessionName: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  firstUserMessage: string;
  parentSessionPath?: string;
}

export interface ResolvedCommitMentionResult {
  token: MentionToken;
  status: "resolved";
  kind: "commit";
  commit: ResolvedCommitMention;
}

export interface ResolvedSessionMentionResult {
  token: MentionToken;
  status: "resolved";
  kind: "session" | "handoff";
  session: ResolvedSessionMention;
}

export interface UnresolvedMentionResult {
  token: MentionToken;
  status: "unresolved";
  reason: string;
}

export type ResolvedMention =
  | ResolvedCommitMentionResult
  | ResolvedSessionMentionResult
  | UnresolvedMentionResult;

export function toResolvedSessionMention(
  session: MentionableSession,
): ResolvedSessionMention {
  return {
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    workspace: session.workspace,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    firstUserMessage: session.firstUserMessage,
    parentSessionPath: session.parentSessionPath,
  };
}
