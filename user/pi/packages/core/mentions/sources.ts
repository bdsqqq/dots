import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  getCommitIndex,
  lookupCommitByPrefix,
  resolveGitRoot,
  type CommitIndex,
} from "./commit-index";
import type { MentionableSession } from "./session-index";
import {
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
  getSuggestions(
    query: string,
    context: MentionSourceContext,
  ): AutocompleteItem[];
  resolve(
    token: MentionToken,
    context: MentionSourceContext,
  ): ResolvedMention | Promise<ResolvedMention>;
}

const sources = new Map<MentionKind, MentionSource>();

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
  return (
    getMentionSource(kind)?.description ??
    mentionKindDescriptions.get(kind) ??
    kind
  );
}
