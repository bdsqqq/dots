import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@mariozechner/pi-tui";
import { getCommitIndex, resolveGitRoot } from "./commit-index";
import { detectMentionPrefix } from "./parse";
import { getSessionMentionsIndex } from "./resolve";
import { MENTION_KINDS, type MentionKind } from "./types";

const KIND_DESCRIPTIONS: Record<MentionKind, string> = {
  commit: "git commit",
  session: "previous pi session",
  handoff: "forked session with resumable context",
};

export interface MentionAwareProviderOptions {
  baseProvider: AutocompleteProvider;
  cwd: string;
  sessionsDir?: string;
  maxItems?: number;
}

export class MentionAwareProvider implements AutocompleteProvider {
  private readonly baseProvider: AutocompleteProvider;
  private readonly cwd: string;
  private readonly sessionsDir?: string;
  private readonly maxItems: number;
  private readonly specialItems = new WeakSet<AutocompleteItem>();
  private readonly gitEnabled: boolean;

  constructor(options: MentionAwareProviderOptions) {
    this.baseProvider = options.baseProvider;
    this.cwd = options.cwd;
    this.sessionsDir = options.sessionsDir;
    this.maxItems = options.maxItems ?? 8;
    this.gitEnabled = resolveGitRoot(this.cwd) !== null;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null {
    const line = lines[cursorLine] ?? "";
    const prefix = detectMentionPrefix(line, cursorCol);
    const base = this.baseProvider.getSuggestions(lines, cursorLine, cursorCol);

    if (!prefix) return base;

    if (prefix.kind) {
      return {
        items: this.getValueSuggestions(prefix.kind, prefix.valueQuery),
        prefix: prefix.raw,
      };
    }

    if (prefix.hasSlash) return base;

    const special = this.getKindSuggestions(prefix.familyQuery);
    if (special.length === 0) return base;
    if (!base || base.prefix !== prefix.raw) {
      return { items: special, prefix: prefix.raw };
    }

    return {
      items: dedupeAutocompleteItems([...special, ...base.items]).slice(0, this.maxItems),
      prefix: prefix.raw,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  } {
    if (!this.specialItems.has(item)) {
      return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    const line = lines[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    const nextLine = line.slice(0, start) + item.value + line.slice(cursorCol);
    const nextLines = [...lines];
    nextLines[cursorLine] = nextLine;

    return {
      lines: nextLines,
      cursorLine,
      cursorCol: start + item.value.length,
    };
  }

  private getKindSuggestions(query: string): AutocompleteItem[] {
    return this.getEnabledKinds()
      .filter((kind) => kind.startsWith(query.toLowerCase()))
      .map((kind) => this.trackItem({
        value: `@${kind}/`,
        label: `@${kind}/`,
        description: KIND_DESCRIPTIONS[kind],
      }))
      .slice(0, this.maxItems);
  }

  private getValueSuggestions(kind: MentionKind, query: string): AutocompleteItem[] {
    if (kind === "commit") {
      if (!this.gitEnabled) return [];
      const index = getCommitIndex(this.cwd);
      if (!index) return [];

      return index.commits
        .filter((commit) => query.length === 0 || commit.sha.startsWith(query.toLowerCase()))
        .slice(0, this.maxItems)
        .map((commit) => this.trackItem({
          value: `@commit/${commit.shortSha}`,
          label: `@commit/${commit.shortSha}`,
          description: commit.subject,
        }));
    }

    return getSessionMentionsIndex(this.sessionsDir)
      .filter((session) => kind !== "handoff" || session.isHandoffCandidate)
      .filter((session) =>
        query.length === 0 || session.sessionId.toLowerCase().startsWith(query.toLowerCase()),
      )
      .slice(0, this.maxItems)
      .map((session) =>
        this.trackItem({
          value: `@${kind}/${session.sessionId}`,
          label: `@${kind}/${session.sessionId}`,
          description: session.sessionName || session.firstUserMessage || session.workspace,
        }),
      );
  }

  private getEnabledKinds(): MentionKind[] {
    return MENTION_KINDS.filter((kind) => this.gitEnabled || kind !== "commit");
  }

  private trackItem(item: AutocompleteItem): AutocompleteItem {
    this.specialItems.add(item);
    return item;
  }
}

function dedupeAutocompleteItems(items: AutocompleteItem[]): AutocompleteItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.value}\u0000${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
