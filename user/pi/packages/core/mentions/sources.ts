import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { getCommitIndex, lookupCommitByPrefix, resolveGitRoot, type CommitIndex } from "./commit-index";
import {
  DEFAULT_MENTION_SESSIONS_DIR,
  getSessionMentionsIndex,
  resolveMentionableSession,
  type MentionableSession,
} from "./session-index";
import {
  toResolvedSessionMention,
  type MentionKind,
  type MentionToken,
  type ResolvedMention,
} from "./types";

const mentionKindDescriptions = new Map<MentionKind, string>([
  ["commit", "git commit"],
  ["session", "previous pi session"],
  ["handoff", "forked session with resumable context"],
]);

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
  getSuggestions(query: string, context: MentionSourceContext): AutocompleteItem[];
  resolve(
    token: MentionToken,
    context: MentionSourceContext,
  ): ResolvedMention | Promise<ResolvedMention>;
}

const sources = new Map<MentionKind, MentionSource>();

function getSessions(context: MentionSourceContext): MentionableSession[] {
  return (
    context.sessions ??
    getSessionMentionsIndex(context.sessionsDir ?? DEFAULT_MENTION_SESSIONS_DIR)
  );
}

function isGitEnabled(context: MentionSourceContext): boolean {
  return context.gitEnabled ?? resolveGitRoot(context.cwd) !== null;
}

export function listMentionKinds(): MentionKind[] {
  return [...mentionKindDescriptions.keys()];
}

export function isMentionKind(kind: string): kind is MentionKind {
  return mentionKindDescriptions.has(kind as MentionKind);
}

export function createCommitMentionSource(): MentionSource {
  return {
    kind: "commit",
    description: mentionKindDescriptions.get("commit") ?? "git commit",
    isEnabled: (context) => isGitEnabled(context),
    getSuggestions(query, context) {
      if (!isGitEnabled(context)) return [];
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) return [];

      return index.commits
        .filter(
          (commit) =>
            query.length === 0 || commit.sha.startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((commit) => ({
          value: `@commit/${commit.shortSha}`,
          label: `@commit/${commit.shortSha}`,
          description: commit.subject,
        }));
    },
    resolve(token, context) {
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) {
        return {
          token,
          status: "unresolved",
          reason: "git_repository_not_found",
        };
      }

      const result = lookupCommitByPrefix(token.value, index);
      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind: "commit",
          commit: result.commit,
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? "commit_prefix_ambiguous"
            : "commit_not_found",
      };
    },
  };
}

export function createSessionMentionSource(
  kind: "session" | "handoff",
): MentionSource {
  return {
    kind,
    description: mentionKindDescriptions.get(kind) ?? kind,
    getSuggestions(query, context) {
      return getSessions(context)
        .filter((session) => kind !== "handoff" || session.isHandoffCandidate)
        .filter(
          (session) =>
            query.length === 0 ||
            session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((session) => ({
          value: `@${kind}/${session.sessionId}`,
          label: `@${kind}/${session.sessionId}`,
          description:
            session.sessionName || session.firstUserMessage || session.workspace,
        }));
    },
    resolve(token, context) {
      const result = resolveMentionableSession(getSessions(context), token.value, kind);

      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind,
          session: toResolvedSessionMention(result.session),
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? `${kind}_prefix_ambiguous`
            : `${kind}_not_found`,
      };
    },
  };
}

registerMentionSource(createCommitMentionSource());

export function listMentionSources(): MentionSource[] {
  return listMentionKinds()
    .map((kind) => sources.get(kind))
    .filter((source): source is MentionSource => source !== undefined);
}

export function getMentionSource(kind: MentionKind): MentionSource | null {
  return sources.get(kind) ?? null;
}

export function registerMentionSource(source: MentionSource): () => void {
  mentionKindDescriptions.set(
    source.kind,
    mentionKindDescriptions.get(source.kind) ?? source.description,
  );

  const previous = sources.get(source.kind);
  sources.set(source.kind, source);

  return () => {
    if (sources.get(source.kind) !== source) return;
    if (previous) {
      sources.set(previous.kind, previous);
      return;
    }
    sources.delete(source.kind);
  };
}

export function listEnabledMentionKinds(
  context: MentionSourceContext,
): MentionKind[] {
  return listMentionSources()
    .filter((source) => source.isEnabled?.(context) ?? true)
    .map((source) => source.kind);
}

export function getMentionKindDescription(kind: MentionKind): string {
  return getMentionSource(kind)?.description ?? mentionKindDescriptions.get(kind) ?? kind;
}
