import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
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
import { boxBottom, boxRow, boxTop } from "../tools/lib/box-chrome";
import type { PaletteActionContext, PaletteItem, PaletteView } from "./types";

const MAX_VISIBLE = 12;

/**
 * Stack-based generic list overlay.
 * Renders whichever PaletteView sits on top of the stack.
 * Items control navigation via the PaletteActionContext passed to onSelect.
 */
export class StackPalette implements Component, Focusable {
  private stack: PaletteView[];
  private searchText = "";
  private filtered: PaletteItem[];
  private highlightedIndex = 0;
  private scrollOffset = 0;
  private cachedLines?: string[];
  private cachedWidth?: number;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private initialView: PaletteView,
    private theme: Theme,
    private pi: ExtensionAPI,
    private extensionCtx: ExtensionContext,
    private done: () => void,
  ) {
    this.stack = [initialView];
    this.filtered = [...initialView.items];
  }

  // ── input ──────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.stack.length > 1) {
        this.stack.pop();
        this.resetView();
        this.invalidate();
      } else {
        this.done();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const item = this.filtered[this.highlightedIndex];
      if (item) {
        const actionCtx: PaletteActionContext = {
          pi: this.pi,
          ctx: this.extensionCtx,
          push: (view: PaletteView) => {
            this.stack.push(view);
            this.resetView();
            this.invalidate();
          },
          close: () => this.done(),
        };
        void item.onSelect(actionCtx);
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
      this.highlightedIndex = Math.min(this.filtered.length - 1, this.highlightedIndex + 1);
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
    const view = this.currentView();
    const maxW = Math.min(width, 72);
    const innerW = maxW - 2;
    const lines: string[] = [];
    const dim = (s: string) => th.fg("dim", s);

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const chrome = { dim };
    const row = (content: string) =>
      boxRow({ variant: "closed", style: chrome, inner: pad(content, innerW) });

    // ── top border, title only for sub-views ──
    const showTitle = this.stack.length > 1;
    const headerText = showTitle ? dim(`[${view.title}]`) : undefined;
    const headerWidth = showTitle ? visibleWidth(`[${view.title}]`) : 0;
    lines.push(boxTop({
      variant: "closed",
      style: chrome,
      innerWidth: innerW,
      header: showTitle ? { text: headerText!, width: headerWidth } : undefined,
    }));

    // ── search ──
    const searchable = view.searchable !== false;
    if (searchable) {
      const prompt = dim(" > ");
      const searchDisplay = th.fg("text", this.searchText);
      const cursor = this._focused ? CURSOR_MARKER + th.fg("accent", "▏") : dim("▏");
      const placeholder = this.searchText.length === 0 ? dim("type to search…") : "";
      lines.push(row(prompt + searchDisplay + cursor + placeholder));
      lines.push(row(""));
    }

    // ── items ──
    if (this.filtered.length === 0) {
      lines.push(row(dim("  no matches")));
    } else {
      const visibleEnd = Math.min(this.scrollOffset + MAX_VISIBLE, this.filtered.length);

      // compute max category badge width for right-aligned badges
      const maxBadgeW = this.filtered.reduce((max, item) => {
        return Math.max(max, item.category ? visibleWidth(item.category) : 0);
      }, 0);

      if (this.scrollOffset > 0) {
        lines.push(row(dim(`  ↑ ${this.scrollOffset} more`)));
      }

      for (let i = this.scrollOffset; i < visibleEnd; i++) {
        const item = this.filtered[i];
        const isHl = i === this.highlightedIndex;

        // right-aligned category badge
        let badge = "";
        if (maxBadgeW > 0) {
          const cat = item.category ?? "";
          const padLen = maxBadgeW - visibleWidth(cat);
          badge = " ".repeat(padLen) + dim(cat) + "  ";
        }

        const label = isHl ? th.bold(item.label) : th.fg("text", item.label);
        const delegateMarker = item.delegate ? dim(" *") : "";
        let desc = "";
        if (item.description) {
          desc = "  " + dim(item.description);
        }
        let shortcut = "";
        if (item.shortcut) {
          shortcut = "  " + th.fg("muted", item.shortcut);
        }

        let line = ` ${badge}${label}${delegateMarker}${desc}${shortcut}`;
        line = truncateToWidth(line, innerW);
        if (isHl) {
          line = th.bg("selectedBg", pad(line, innerW));
        }

        lines.push(boxRow({ variant: "closed", style: chrome, inner: isHl ? line : pad(line, innerW) }));
      }

      const remaining = this.filtered.length - visibleEnd;
      if (remaining > 0) {
        lines.push(row(dim(`  ↓ ${remaining} more`)));
      }
    }

    // ── bottom border with footer hints ──
    const escHint = this.stack.length > 1 ? "esc back" : "esc close";
    const hasDelegates = this.filtered.some((item) => item.delegate);
    const footerParts = [`↑↓ navigate`, `enter select`, escHint];
    if (hasDelegates) footerParts.push("* opens native ui");
    const footerStr = dim(footerParts.join(" • "));
    const footerWidth = visibleWidth(footerStr);

    lines.push(boxBottom({
      variant: "closed",
      style: chrome,
      innerWidth: innerW,
      footer: { text: footerStr, width: footerWidth },
    }));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private currentView(): PaletteView {
    return this.stack[this.stack.length - 1];
  }

  private resetView(): void {
    this.searchText = "";
    this.highlightedIndex = 0;
    this.scrollOffset = 0;
    this.filtered = [...this.currentView().items];
  }

  private applyFilter(): void {
    const view = this.currentView();
    if (this.searchText === "" || view.searchable === false) {
      this.filtered = [...view.items];
    } else {
      this.filtered = fuzzyFilter(
        view.items,
        this.searchText,
        (item) => `${item.label} ${item.description ?? ""} ${item.category ?? ""}`,
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
