import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  fuzzyFilter,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { PaletteEntry } from "./types";

const MAX_VISIBLE = 12;

const SOURCE_BADGE: Record<string, string> = {
  builtin: "cmd",
  extension: "ext",
  skill: "skill",
};

/**
 * Flat search command palette rendered as a centered overlay.
 * Implements Focusable so the hardware cursor tracks the search input for IME.
 */
export class CommandPalette implements Component, Focusable {
  private searchText = "";
  private filtered: PaletteEntry[];
  private highlightedIndex = 0;
  private scrollOffset = 0;
  private cachedLines?: string[];
  private cachedWidth?: number;

  // Focusable — TUI sets this when overlay gets focus
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private entries: PaletteEntry[],
    private theme: Theme,
    private done: (result: PaletteEntry | null) => void,
  ) {
    this.filtered = [...entries];
  }

  // ── input ──────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.filtered.length > 0 && this.highlightedIndex < this.filtered.length) {
        this.done(this.filtered[this.highlightedIndex]);
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.highlightedIndex = Math.max(0, this.highlightedIndex - 1);
      this.ensureVisible();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.highlightedIndex = Math.min(
        this.filtered.length - 1,
        this.highlightedIndex + 1,
      );
      this.ensureVisible();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.searchText.length > 0) {
        this.searchText = this.searchText.slice(0, -1);
        this.applyFilter();
        this.invalidate();
      }
      return;
    }

    // printable characters → append to search (handles paste too)
    if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) {
      this.searchText += data;
      this.applyFilter();
      this.invalidate();
    }
  }

  // ── render ─────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const maxW = Math.min(width, 72);
    const innerW = maxW - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const hLine = "─".repeat(innerW);
    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    // ── header ──
    lines.push(th.fg("border", `╭${hLine}╮`));

    // search input line with cursor marker for IME
    const prompt = th.fg("dim", " ❯ ");
    const searchDisplay = th.fg("text", this.searchText);
    const cursor = this._focused ? CURSOR_MARKER + th.fg("accent", "▏") : th.fg("dim", "▏");
    const placeholder =
      this.searchText.length === 0 ? th.fg("dim", "type to search…") : "";
    lines.push(row(prompt + searchDisplay + cursor + placeholder));

    lines.push(th.fg("border", `├${hLine}┤`));

    // ── items ──
    if (this.filtered.length === 0) {
      lines.push(row(th.fg("muted", "  no matches")));
    } else {
      const visibleEnd = Math.min(
        this.scrollOffset + MAX_VISIBLE,
        this.filtered.length,
      );

      if (this.scrollOffset > 0) {
        lines.push(row(th.fg("dim", `  ↑ ${this.scrollOffset} more`)));
      }

      for (let i = this.scrollOffset; i < visibleEnd; i++) {
        const entry = this.filtered[i];
        const isHl = i === this.highlightedIndex;

        const badge = th.fg("dim", `[${SOURCE_BADGE[entry.source] ?? entry.source}]`);
        const label = isHl
          ? th.fg("accent", th.bold(entry.label))
          : th.fg("text", entry.label);
        const pointer = isHl ? th.fg("accent", "❯ ") : "  ";

        let line = `${pointer}${badge} ${label}`;
        if (entry.description) {
          line += "  " + th.fg("dim", entry.description);
        }

        lines.push(row(truncateToWidth(line, innerW)));
      }

      const remaining = this.filtered.length - visibleEnd;
      if (remaining > 0) {
        lines.push(row(th.fg("dim", `  ↓ ${remaining} more`)));
      }
    }

    // ── footer ──
    lines.push(th.fg("border", `├${hLine}┤`));
    lines.push(
      row(th.fg("dim", " ↑↓ navigate • enter select • esc close")),
    );
    lines.push(th.fg("border", `╰${hLine}╯`));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private applyFilter(): void {
    if (this.searchText === "") {
      this.filtered = [...this.entries];
    } else {
      this.filtered = fuzzyFilter(
        this.entries,
        this.searchText,
        (e) => `${e.label} ${e.description ?? ""} ${e.source}`,
      );
    }
    this.highlightedIndex = 0;
    this.scrollOffset = 0;
  }

  private ensureVisible(): void {
    if (this.highlightedIndex < this.scrollOffset) {
      this.scrollOffset = this.highlightedIndex;
    } else if (this.highlightedIndex >= this.scrollOffset + MAX_VISIBLE) {
      this.scrollOffset = this.highlightedIndex - MAX_VISIBLE + 1;
    }
  }
}
