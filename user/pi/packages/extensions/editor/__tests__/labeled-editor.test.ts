/**
 * Headless TUI rendering tests for LabeledEditor.
 *
 * Tests the editor's border rendering with labels by mocking
 * the parent CustomEditor class and asserting on render() output.
 *
 * Key insight: Mock the theme to strip ANSI codes, then assert on plain text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LabeledEditor } from "../index";

// Mock theme that strips ANSI codes
const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

// Mock TUI
const mockTui = {
  requestRender: vi.fn(),
} as any;

// Mock EditorTheme
const mockEditorTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as any;

// Mock KeybindingsManager
const mockKeybindings = {} as any;

/**
 * Create a LabeledEditor instance with a mocked parent render.
 * The parentRenderMock controls what the base editor returns.
 */
function createEditor(parentRenderMock: (width: number) => string[]) {
  const editor = new LabeledEditor(
    mockTui,
    mockEditorTheme,
    mockKeybindings,
    mockTheme,
    "/test/cwd",
  );

  // Override the parent's render method
  (editor as any).render = function (width: number) {
    // Simulate the parent's render output
    const innerWidth = width - 2;
    if (innerWidth < 4) return parentRenderMock(width);

    const lines = parentRenderMock(innerWidth);
    if (lines.length < 2) return lines;

    // Now apply LabeledEditor's border wrapping logic
    // This is a simplified version of the actual render logic
    const bottomIdx = (this as any).findBottomBorderIndex(lines);
    const result: string[] = [];

    const chrome = { dim: (s: string) => this.dim(s) };

    // Import box functions - we'll inline the logic for testing
    const topLine = (this as any).buildBorderLine(
      width,
      { left: "╭", right: "╮" },
      "top",
      lines[0],
    );
    result.push(topLine);

    // Content lines with side rails
    for (let i = 1; i < bottomIdx; i++) {
      const dimmed = this.dim("│");
      result.push(dimmed + lines[i] + dimmed);
    }

    // Bottom border
    const bottomLine = (this as any).buildBorderLine(
      width,
      { left: "╰", right: "╯" },
      "bottom",
      lines[bottomIdx],
    );
    result.push(bottomLine);

    // Autocomplete lines
    for (let i = bottomIdx + 1; i < lines.length; i++) {
      result.push(" " + lines[i] + " ");
    }

    return result;
  };

  return editor;
}

describe("LabeledEditor (headless TUI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("label management", () => {
    it("setLabel adds a label that can be retrieved", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("test", "hello world", "top", "left");

      // Internal check - labels are stored correctly
      const labels = (editor as any).labels;
      expect(labels.get("test")).toEqual({
        key: "test",
        text: "hello world",
        position: "top",
        align: "left",
      });
    });

    it("removeLabel deletes a label", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("test", "hello", "top", "left");
      editor.removeLabel("test");

      const labels = (editor as any).labels;
      expect(labels.has("test")).toBe(false);
    });

    it("multiple labels on same position/align are joined with separator", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("a", "first", "top", "left");
      editor.setLabel("b", "second", "top", "left");

      const labels = (editor as any).labels;
      expect(labels.size).toBe(2);

      // getLabelsFor should join them
      const leftText = (editor as any).getLabelsFor("top", "left");
      expect(leftText).toBe("first · second");
    });

    it("labels on different positions are independent", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("top-left", "TL", "top", "left");
      editor.setLabel("top-right", "TR", "top", "right");
      editor.setLabel("bottom-left", "BL", "bottom", "left");
      editor.setLabel("bottom-right", "BR", "bottom", "right");

      expect((editor as any).getLabelsFor("top", "left")).toBe("TL");
      expect((editor as any).getLabelsFor("top", "right")).toBe("TR");
      expect((editor as any).getLabelsFor("bottom", "left")).toBe("BL");
      expect((editor as any).getLabelsFor("bottom", "right")).toBe("BR");
    });
  });

  describe("border building", () => {
    it("buildBorderLine creates correct top border with corners", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("stats", "50%", "top", "left");

      const line = (editor as any).buildBorderLine(
        80,
        { left: "╭", right: "╮" },
        "top",
        "─".repeat(78),
      );

      expect(line).toContain("╭");
      expect(line).toContain("╮");
      expect(line).toContain("50%");
      expect(line).toContain("─");
    });

    it("buildBorderLine creates correct bottom border with corners", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("cwd", "~/project", "bottom", "right");

      const line = (editor as any).buildBorderLine(
        80,
        { left: "╰", right: "╯" },
        "bottom",
        "─".repeat(78),
      );

      expect(line).toContain("╰");
      expect(line).toContain("╯");
      expect(line).toContain("~/project");
    });

    it("caches border lines for unchanged content", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("stats", "50%", "top", "left");

      const line1 = (editor as any).buildBorderLine(
        80,
        { left: "╭", right: "╮" },
        "top",
        "─".repeat(78),
      );

      // Second call with same params should return cached version
      const line2 = (editor as any).buildBorderLine(
        80,
        { left: "╭", right: "╮" },
        "top",
        "─".repeat(78),
      );

      expect(line1).toBe(line2);

      // Check cache was used (borderCache should have entry)
      const cache = (editor as any).borderCache;
      expect(cache.top).not.toBeNull();
    });

    it("invalidates cache when labels change", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      editor.setLabel("stats", "50%", "top", "left");

      const line1 = (editor as any).buildBorderLine(
        80,
        { left: "╭", right: "╮" },
        "top",
        "─".repeat(78),
      );

      // Change label
      editor.setLabel("stats", "75%", "top", "left");

      const line2 = (editor as any).buildBorderLine(
        80,
        { left: "╭", right: "╮" },
        "top",
        "─".repeat(78),
      );

      expect(line1).not.toBe(line2);
      expect(line2).toContain("75%");
      expect(line2).not.toContain("50%");
    });
  });

  describe("scroll indicator extraction", () => {
    it("extracts scroll indicator from border line", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      const indicator = (editor as any).extractScrollIndicator(
        "────────────── ↑ 5 more ──────",
      );
      expect(indicator).toBe("↑ 5 more");
    });

    it("extracts down scroll indicator", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      const indicator = (editor as any).extractScrollIndicator(
        "────────────── ↓ 10 more ──────",
      );
      expect(indicator).toBe("↓ 10 more");
    });

    it("returns empty string when no scroll indicator", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      const indicator = (editor as any).extractScrollIndicator(
        "────────────────────────────",
      );
      expect(indicator).toBe("");
    });
  });

  describe("findBottomBorderIndex", () => {
    it("finds bottom border in simple content", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      const lines = ["──────────", "content line", "──────────"];
      const idx = (editor as any).findBottomBorderIndex(lines);
      expect(idx).toBe(2);
    });

    it("finds bottom border with autocomplete lines after", () => {
      const parentRender = (w: number) => ["─".repeat(w), "content", "─".repeat(w)];
      const editor = createEditor(parentRender);

      const lines = [
        "──────────",
        "content",
        "──────────",
        "autocomplete option 1",
        "autocomplete option 2",
      ];
      const idx = (editor as any).findBottomBorderIndex(lines);
      expect(idx).toBe(2);
    });

    it("handles single line", () => {
      const parentRender = (w: number) => ["─".repeat(w)];
      const editor = createEditor(parentRender);

      const lines = ["──────────"];
      const idx = (editor as any).findBottomBorderIndex(lines);
      expect(idx).toBe(0);
    });
  });

  describe("render integration", () => {
    it.todo(
      "renders full editor with top/bottom borders and side rails (needs CustomEditor mock)",
    );

    it.todo(
      "preserves autocomplete lines below bottom border (needs CustomEditor mock)",
    );

    it.todo(
      "adapts to different terminal widths (needs CustomEditor mock)",
    );
  });
});
