import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { detectMentionPrefix } from "./parse";
import type { MentionSource, MentionSourceContext } from "./sources";

export interface MentionAutocompleteProviderOptions {
  baseProvider: AutocompleteProvider;
  source: MentionSource;
  context: MentionSourceContext;
  maxItems?: number;
}

export class MentionAutocompleteProvider implements AutocompleteProvider {
  private readonly baseProvider: AutocompleteProvider;
  private readonly source: MentionSource;
  private readonly context: MentionSourceContext;
  private readonly maxItems: number;
  private readonly specialItems = new WeakSet<AutocompleteItem>();

  constructor(options: MentionAutocompleteProviderOptions) {
    this.baseProvider = options.baseProvider;
    this.source = options.source;
    this.context = options.context;
    this.maxItems = options.maxItems ?? 8;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? "";
    const prefix = detectMentionPrefix(line, cursorCol);
    const base = await this.baseProvider.getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    );

    if (!prefix) return base;

    if (prefix.kind) {
      if (prefix.kind !== this.source.kind) return base;
      return {
        items: this.getValueSuggestions(prefix.valueQuery),
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
    if (!(this.source.isEnabled?.(this.context) ?? true)) return [];
    if (!this.source.kind.startsWith(query.toLowerCase())) return [];

    return [
      this.trackItem({
        value: `@${this.source.kind}/`,
        label: `@${this.source.kind}/`,
        description: this.source.description,
      }),
    ];
  }

  private getValueSuggestions(query: string): AutocompleteItem[] {
    if (!(this.source.isEnabled?.(this.context) ?? true)) return [];

    return this.source
      .getSuggestions(query, this.context)
      .slice(0, this.maxItems)
      .map((item) => this.trackItem(item));
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
