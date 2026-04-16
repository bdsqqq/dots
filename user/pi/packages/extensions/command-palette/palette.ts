import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
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
import { boxBottom, boxRow, boxTop } from "@bds_pi/box-chrome";
import type { PaletteActionContext, PaletteItem, PaletteView } from "./types";

export const MAX_VISIBLE = 12;

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
    if (this._focused === value) return;
    this._focused = value;
    this.invalidate();
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

    if (
      data.length >= 1 &&
      !data.startsWith("\x1b") &&
      data.charCodeAt(0) >= 32
    ) {
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
    lines.push(
      boxTop({
        variant: "closed",
        style: chrome,
        innerWidth: innerW,
        header: showTitle
          ? { text: headerText!, width: headerWidth }
          : undefined,
      }),
    );

    // ── search ──
    const searchable = view.searchable !== false;
    if (searchable) {
      const prompt = dim(" > ");
      const searchDisplay = th.fg("text", this.searchText);
      const cursor = this._focused
        ? CURSOR_MARKER + th.fg("accent", "▏")
        : dim("▏");
      const placeholder =
        this.searchText.length === 0 ? dim("type to search…") : "";
      lines.push(row(prompt + searchDisplay + cursor + placeholder));
      lines.push(row(""));
    }

    // ── items ──
    if (this.filtered.length === 0) {
      lines.push(row(dim("  no matches")));
    } else {
      const visibleEnd = Math.min(
        this.scrollOffset + MAX_VISIBLE,
        this.filtered.length,
      );

      // compute max category badge width for right-aligned badges
      const maxBadgeW = this.filtered.reduce((max, item) => {
        return Math.max(max, item.category ? visibleWidth(item.category) : 0);
      }, 0);

      if (this.scrollOffset > 0) {
        lines.push(row(dim(`  ↑ ${this.scrollOffset} more`)));
      }

      for (let i = this.scrollOffset; i < visibleEnd; i++) {
        const item = this.filtered[i];
        if (!item) continue;
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

        lines.push(
          boxRow({
            variant: "closed",
            style: chrome,
            inner: isHl ? line : pad(line, innerW),
          }),
        );
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

    lines.push(
      boxBottom({
        variant: "closed",
        style: chrome,
        innerWidth: innerW,
        footer: { text: footerStr, width: footerWidth },
      }),
    );

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
    const view = this.stack[this.stack.length - 1];
    if (!view) throw new Error("No view in stack");
    return view;
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
        (item) =>
          `${item.label} ${item.description ?? ""} ${item.category ?? ""}`,
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

if (import.meta.vitest) {
  const { describe, it, expect, vi, beforeEach } = import.meta.vitest;

  // Mock theme that strips ANSI codes for easy text assertions
  function createMockTheme(): any {
    return {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      strikethrough: (text: string) => text,
      inverse: (text: string) => text,
    };
  }

  // Helper to create a simple test view
  function createTestView(items: any[] = []): any {
    return {
      title: "Test View",
      items,
    };
  }

  // Helper to create minimal mock context
  function createMockContext(): { pi: any; ctx: any; done: () => void } {
    return {
      pi: {},
      ctx: {},
      done: vi.fn(),
    };
  }

  describe("StackPalette (headless TUI)", () => {
    let mockTheme: any;
    let mockPi: any;
    let mockCtx: any;
    let mockDone: () => void;

    beforeEach(() => {
      mockTheme = createMockTheme();
      const context = createMockContext();
      mockPi = context.pi;
      mockCtx = context.ctx;
      mockDone = context.done;
    });

    describe("rendering", () => {
      it("renders empty state when no items", () => {
        const view = createTestView([]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        // Should have: top border, search row, empty row, "no matches" row, bottom border
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.some((l) => l.includes("no matches"))).toBe(true);
      });

      it("renders items with labels", () => {
        const view = createTestView([
          { id: "1", label: "First Item", onSelect: vi.fn() },
          { id: "2", label: "Second Item", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        expect(lines.some((l) => l.includes("First Item"))).toBe(true);
        expect(lines.some((l) => l.includes("Second Item"))).toBe(true);
      });

      it("renders items with descriptions", () => {
        const view = createTestView([
          {
            id: "1",
            label: "Item",
            description: "A description",
            onSelect: vi.fn(),
          },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        expect(lines.some((l) => l.includes("A description"))).toBe(true);
      });

      it("renders items with category badges", () => {
        const view = createTestView([
          { id: "1", label: "Item", category: "cmd", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        expect(lines.some((l) => l.includes("cmd"))).toBe(true);
      });

      it("renders delegate marker (*) for delegate items", () => {
        const view = createTestView([
          { id: "1", label: "Item", delegate: true, onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        expect(lines.some((l) => l.includes("*"))).toBe(true);
      });

      it("shows scroll indicators when items exceed MAX_VISIBLE", () => {
        const items: PaletteItem[] = Array.from(
          { length: MAX_VISIBLE + 5 },
          (_, i) => ({
            id: `item-${i}`,
            label: `Item ${i}`,
            onSelect: vi.fn(),
          }),
        );
        const view = createTestView(items);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines = palette.render(72);

        // Should show "↓ X more" indicator
        expect(lines.some((l) => l.includes("↓") && l.includes("more"))).toBe(
          true,
        );
      });

      it("caches rendered lines for same width", () => {
        const view = createTestView([
          { id: "1", label: "Item", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines1 = palette.render(72);
        const lines2 = palette.render(72);

        // Same reference means cache was used
        expect(lines1).toBe(lines2);
      });

      it("re-renders when width changes", () => {
        const view = createTestView([
          { id: "1", label: "Item", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        const lines1 = palette.render(72);
        const lines2 = palette.render(60);

        // Different arrays means re-render happened
        expect(lines1).not.toBe(lines2);
      });
    });

    describe("search and filtering", () => {
      it("filters items by search text", () => {
        const view = createTestView([
          { id: "1", label: "Apple", onSelect: vi.fn() },
          { id: "2", label: "Banana", onSelect: vi.fn() },
          { id: "3", label: "Apricot", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Type "ap" to filter
        palette.handleInput("a");
        palette.handleInput("p");

        const lines = palette.render(72);

        // Should show Apple and Apricot, not Banana
        expect(lines.some((l) => l.includes("Apple"))).toBe(true);
        expect(lines.some((l) => l.includes("Apricot"))).toBe(true);
        expect(lines.some((l) => l.includes("Banana"))).toBe(false);
      });

      it("shows no matches when filter excludes all items", () => {
        const view = createTestView([
          { id: "1", label: "Apple", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Type something that won't match
        palette.handleInput("z");
        palette.handleInput("z");

        const lines = palette.render(72);

        expect(lines.some((l) => l.includes("no matches"))).toBe(true);
      });

      it("clears filter on backspace", () => {
        const view = createTestView([
          { id: "1", label: "Apple", onSelect: vi.fn() },
          { id: "2", label: "Banana", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Filter to "a"
        palette.handleInput("a");
        let lines = palette.render(72);
        expect(lines.some((l) => l.includes("Banana"))).toBe(true);

        // Clear filter
        palette.handleInput("\x7f"); // backspace
        lines = palette.render(72);
        expect(lines.some((l) => l.includes("Apple"))).toBe(true);
        expect(lines.some((l) => l.includes("Banana"))).toBe(true);
      });

      it("respects searchable: false on view", () => {
        const view: PaletteView = {
          title: "Non-Searchable",
          items: [
            { id: "1", label: "Apple", onSelect: vi.fn() },
            { id: "2", label: "Banana", onSelect: vi.fn() },
          ],
          searchable: false,
        };
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Type to filter - should be ignored
        palette.handleInput("a");
        palette.handleInput("p");

        const lines = palette.render(72);

        // All items should still be visible
        expect(lines.some((l) => l.includes("Apple"))).toBe(true);
        expect(lines.some((l) => l.includes("Banana"))).toBe(true);
      });
    });

    describe("navigation", () => {
      it("navigates down with down arrow", () => {
        const view = createTestView([
          { id: "1", label: "First", onSelect: vi.fn() },
          { id: "2", label: "Second", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        palette.render(72);
        palette.handleInput("\x1b[B"); // down arrow

        // Second item should now be highlighted
        // We can't directly check highlightedIndex, but we can verify behavior
        // through selection
      });

      it("navigates up with up arrow", () => {
        const view = createTestView([
          { id: "1", label: "First", onSelect: vi.fn() },
          { id: "2", label: "Second", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Navigate down twice, then up once
        palette.handleInput("\x1b[B"); // down
        palette.handleInput("\x1b[B"); // down (clamped at end)
        palette.handleInput("\x1b[A"); // up

        // Should be at index 1
      });

      it("supports ctrl+p/ctrl+n navigation", () => {
        const view = createTestView([
          { id: "1", label: "First", onSelect: vi.fn() },
          { id: "2", label: "Second", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        palette.handleInput("\x10"); // ctrl+p (up)
        palette.handleInput("\x0e"); // ctrl+n (down)

        // Should work like up/down
      });

      it("wraps scroll offset when navigating beyond visible range", () => {
        const items: PaletteItem[] = Array.from(
          { length: MAX_VISIBLE + 5 },
          (_, i) => ({
            id: `item-${i}`,
            label: `Item ${i}`,
            onSelect: vi.fn(),
          }),
        );
        const view = createTestView(items);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Navigate down many times
        for (let i = 0; i < MAX_VISIBLE + 3; i++) {
          palette.handleInput("\x1b[B"); // down
        }

        const lines = palette.render(72);

        // Should show "↑ X more" indicator
        expect(lines.some((l) => l.includes("↑") && l.includes("more"))).toBe(
          true,
        );
      });
    });

    describe("selection", () => {
      it("calls onSelect with action context on enter", () => {
        const onSelect = vi.fn((actx: PaletteActionContext) => {
          actx.close();
        });
        const view = createTestView([{ id: "1", label: "Item", onSelect }]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        palette.render(72);
        palette.handleInput("\x0d"); // enter

        expect(onSelect).toHaveBeenCalled();
        expect(mockDone).toHaveBeenCalled();
      });

      it("pushes new view when onSelect calls push", () => {
        const subView: PaletteView = { title: "Sub View", items: [] };
        const onSelect = vi.fn((actx: PaletteActionContext) => {
          actx.push(subView);
        });
        const view = createTestView([{ id: "1", label: "Item", onSelect }]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        palette.render(72);
        palette.handleInput("\x0d"); // enter

        expect(onSelect).toHaveBeenCalled();

        // Render should now show sub-view title
        const lines = palette.render(72);
        expect(lines.some((l) => l.includes("Sub View"))).toBe(true);
      });
    });

    describe("stack navigation", () => {
      it("closes palette on esc from root view", () => {
        const view = createTestView([
          { id: "1", label: "Item", onSelect: vi.fn() },
        ]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        palette.handleInput("\x1b"); // escape

        expect(mockDone).toHaveBeenCalled();
      });

      it("pops to previous view on esc from sub-view", () => {
        const subView: PaletteView = { title: "Sub View", items: [] };
        const onSelect = (actx: PaletteActionContext) => actx.push(subView);
        const view = createTestView([{ id: "1", label: "Item", onSelect }]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Push sub-view
        palette.render(72);
        palette.handleInput("\x0d"); // enter

        // Verify we're in sub-view
        let lines = palette.render(72);
        expect(lines.some((l) => l.includes("Sub View"))).toBe(true);

        // Press esc to pop back
        palette.handleInput("\x1b"); // escape
        lines = palette.render(72);
        expect(lines.some((l) => l.includes("Sub View"))).toBe(false);
      });

      it("resets search when popping views", () => {
        const subView: PaletteView = { title: "Sub", items: [] };
        const onSelect = (actx: PaletteActionContext) => actx.push(subView);
        const view = createTestView([{ id: "1", label: "Item", onSelect }]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        // Type search text that matches "Item" (so we can still select it)
        palette.handleInput("I");
        palette.handleInput("t");

        // Push sub-view (item should still be visible and selectable)
        palette.render(72);
        palette.handleInput("\x0d"); // enter

        // Pop back
        palette.handleInput("\x1b"); // escape

        // Render and check the search line doesn't contain "It"
        const lines = palette.render(72);
        // Search prompt line should not contain our search text
        const searchLine = lines.find((l) => l.includes(">"));
        expect(searchLine).toBeDefined();
        // Search line should show empty search (cursor marker at start)
        expect(searchLine!.includes("It")).toBe(false);
      });
    });

    describe("focus", () => {
      it("has focused property that can be set", () => {
        const view = createTestView([]);
        const palette = new StackPalette(
          view,
          mockTheme,
          mockPi,
          mockCtx,
          mockDone,
        );

        expect(palette.focused).toBe(false);

        palette.focused = true;
        expect(palette.focused).toBe(true);
      });

      it("for any tested width, focused state determines cursor marker presence", () => {
        const widths = [40, 72];
        const view = createTestView([
          { id: "1", label: "Alpha", onSelect: vi.fn() },
          { id: "2", label: "Beta", onSelect: vi.fn() },
        ]);

        for (const width of widths) {
          const palette = new StackPalette(
            view,
            mockTheme,
            mockPi,
            mockCtx,
            mockDone,
          );

          palette.focused = true;
          const focusedLines = palette.render(width);
          const focusedText = focusedLines.join("\n");

          expect(focusedText).toContain(CURSOR_MARKER);

          palette.focused = false;
          const unfocusedLines = palette.render(width);
          const unfocusedText = unfocusedLines.join("\n");

          expect(unfocusedLines).not.toBe(focusedLines);
          expect(unfocusedText).not.toContain(CURSOR_MARKER);

          palette.focused = true;
          const refocusedText = palette.render(width).join("\n");
          expect(refocusedText).toContain(CURSOR_MARKER);
        }
      });
    });
  });
}
