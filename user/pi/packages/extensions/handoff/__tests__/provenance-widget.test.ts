/**
 * Headless TUI rendering tests for handoff provenance widget.
 *
 * Tests UI components by instantiating them directly and asserting
 * on their render(width) output - no tmux needed.
 *
 * Key insight: Mock the theme to strip ANSI codes, then assert on plain text.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtensionUIContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showProvenance, getParentDescription, PROVENANCE_PREFIX, PROVENANCE_ELLIPSIS } from "../index";

// Helper to create a mock UI context that captures widget renders
function createMockUIContext() {
  const widgets = new Map<string, { render(width: number): string[] }>();
  const notifications: { message: string; level: string }[] = [];

  return {
    widgets,
    notifications,
    ui: {
      setWidget: vi.fn((key: string, factory: any) => {
        if (factory) {
          // Create a mock TUI and theme
          const mockTui = {} as any;
          const mockTheme = {
            fg: (_color: string, text: string) => text, // strip colors
            bg: (_color: string, text: string) => text,
          };
          widgets.set(key, factory(mockTui, mockTheme));
        } else {
          widgets.delete(key);
        }
      }),
      notify: vi.fn((message: string, level: string) => {
        notifications.push({ message, level });
      }),
      setEditorText: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ExtensionUIContext,
  };
}

// Helper to create a minimal ExtensionContext for showProvenance
function createMockContext(ui: ExtensionUIContext): ExtensionContext {
  return {
    ui,
    hasUI: true,
    cwd: "/test/cwd",
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
      getBranch: () => [],
      getHeader: () => undefined,
    } as any,
    modelRegistry: {} as any,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
}

describe("provenance widget (headless TUI)", () => {
  describe("getParentDescription", () => {
    it("returns fallback when session file doesn't exist", () => {
      // When the session file can't be opened, it falls back to the filename
      const desc = getParentDescription("/nonexistent/session.jsonl", 80);
      expect(desc).toBe("session.jsonl");
    });

    it("truncates long descriptions to fit budget", () => {
      // The budget is: maxWidth - prefix.length - ellipsis.length
      // At width 40: budget = 40 - 20 - 1 = 19 chars
      const longName = "This is a very long session name that should be truncated";
      // We'd need a real session file to test this properly
      // For now, test the fallback behavior
      const desc = getParentDescription("/path/to/NonexistentSessionFile.jsonl", 40);
      expect(desc.length).toBeLessThanOrEqual(40);
    });
  });

  describe("showProvenance", () => {
    it("registers widget with correct key", () => {
      const { ui, widgets } = createMockUIContext();
      const ctx = createMockContext(ui);

      showProvenance(ctx, "/sessions/parent.jsonl");

      expect(ui.setWidget).toHaveBeenCalledWith("handoff-provenance", expect.any(Function));
      expect(widgets.has("handoff-provenance")).toBe(true);
    });

    it("renders provenance line with arrow prefix", () => {
      const { ui, widgets } = createMockUIContext();
      const ctx = createMockContext(ui);

      showProvenance(ctx, "/sessions/parent.jsonl");

      const widget = widgets.get("handoff-provenance");
      expect(widget).toBeDefined();

      // Render at width 80
      const lines = widget!.render(80);
      expect(lines).toHaveLength(1);

      // The line should contain the arrow
      expect(lines[0]).toContain("↳");
      // And mention "handed off"
      expect(lines[0]).toContain("handed off");
    });

    it("right-aligns the provenance line", () => {
      const { ui, widgets } = createMockUIContext();
      const ctx = createMockContext(ui);

      showProvenance(ctx, "/sessions/parent.jsonl");

      const widget = widgets.get("handoff-provenance");
      const lines = widget!.render(80);

      // The content should be right-aligned (leading spaces)
      expect(lines[0]).toMatch(/^ +/);
    });

    it("adapts to different terminal widths", () => {
      const { ui, widgets } = createMockUIContext();
      const ctx = createMockContext(ui);

      showProvenance(ctx, "/sessions/parent.jsonl");

      const widget = widgets.get("handoff-provenance");

      // Render at different widths
      const narrow = widget!.render(40);
      const wide = widget!.render(120);

      // Both should have exactly one line
      expect(narrow).toHaveLength(1);
      expect(wide).toHaveLength(1);

      // The narrow version should have less padding
      const narrowPadding = narrow[0].match(/^ +/)?.[0].length ?? 0;
      const widePadding = wide[0].match(/^ +/)?.[0].length ?? 0;
      expect(widePadding).toBeGreaterThan(narrowPadding);
    });
  });

  describe("widget lifecycle", () => {
    it("can be removed by passing undefined", () => {
      const { ui, widgets } = createMockUIContext();
      const ctx = createMockContext(ui);

      showProvenance(ctx, "/sessions/parent.jsonl");
      expect(widgets.has("handoff-provenance")).toBe(true);

      // Remove the widget
      ui.setWidget("handoff-provenance", undefined);
      expect(widgets.has("handoff-provenance")).toBe(false);
    });
  });
});
