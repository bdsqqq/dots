import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { CommitIndex } from "./commit-index";
import type { MentionableSession } from "./session-index";
import type { MentionKind, MentionToken, ResolvedMention } from "./types";

const mentionKinds = ["commit", "session", "handoff"] as const satisfies readonly MentionKind[];

export function listMentionKinds(): MentionKind[] {
  return [...mentionKinds];
}

export function isMentionKind(kind: string): kind is MentionKind {
  return (mentionKinds as readonly string[]).includes(kind);
}

export interface MentionSourceContext {
  cwd: string;
  commitIndex?: CommitIndex | null;
  sessionsDir?: string;
  sessions?: MentionableSession[] | null;
  gitEnabled?: boolean;
}

export interface MentionSource {
  kind: MentionKind;
  description: string;
  isEnabled?(context: MentionSourceContext): boolean;
  getSuggestions(
    query: string,
    context: MentionSourceContext,
  ): AutocompleteItem[];
  resolve(
    token: MentionToken,
    context: MentionSourceContext,
  ): ResolvedMention | Promise<ResolvedMention>;
}
