export const MENTION_KINDS = ["commit", "session", "handoff"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

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

export type ResolvedMention =
  | {
      token: MentionToken;
      status: "resolved";
      commit: ResolvedCommitMention;
    }
  | {
      token: MentionToken;
      status: "unresolved";
      reason: string;
    };
