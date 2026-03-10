import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@mariozechner/pi-tui";
import { resolveGitRoot } from "./commit-index";
import { detectMentionPrefix } from "./parse";
import {
  getMentionKindDescription,
  getMentionSource,
  listEnabledMentionKinds,
  type MentionSourceContext,
} from "./sources";
import type { MentionKind } from "./types";

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
      items: dedupeAutocompleteItems([...special, ...base.items]).slice(
        0,
        this.maxItems,
      ),
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
      return this.baseProvider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
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
      .map((kind) =>
        this.trackItem({
          value: `@${kind}/`,
          label: `@${kind}/`,
          description: getMentionKindDescription(kind),
        }),
      )
      .slice(0, this.maxItems);
  }

  private getValueSuggestions(
    kind: MentionKind,
    query: string,
  ): AutocompleteItem[] {
    const source = getMentionSource(kind);
    if (!source) return [];
    if (!(source.isEnabled?.(this.getSourceContext()) ?? true)) return [];

    return source
      .getSuggestions(query, this.getSourceContext())
      .slice(0, this.maxItems)
      .map((item) => this.trackItem(item));
  }

  private getEnabledKinds(): MentionKind[] {
    return listEnabledMentionKinds(this.getSourceContext());
  }

  private getSourceContext(): MentionSourceContext {
    return {
      cwd: this.cwd,
      sessionsDir: this.sessionsDir,
      gitEnabled: this.gitEnabled,
    };
  }

  private trackItem(item: AutocompleteItem): AutocompleteItem {
    this.specialItems.add(item);
    return item;
  }
}

function dedupeAutocompleteItems(
  items: AutocompleteItem[],
): AutocompleteItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.value}\u0000${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
