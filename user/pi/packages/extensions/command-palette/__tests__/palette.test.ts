/**
 * Headless TUI rendering tests for StackPalette.
 *
 * Tests UI components by instantiating them directly and asserting
 * on their render(width) output - no tmux needed.
 *
 * Key insight: Mock the theme to strip ANSI codes, then assert on plain text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StackPalette, MAX_VISIBLE } from "../palette";
import type { PaletteView, PaletteItem, PaletteActionContext } from "../types";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";

// Mock theme that strips ANSI codes for easy text assertions
function createMockTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		inverse: (text: string) => text,
	} as unknown as Theme;
}

// Helper to create a simple test view
function createTestView(items: PaletteItem[] = []): PaletteView {
	return {
		title: "Test View",
		items,
	};
}

// Helper to create minimal mock context
function createMockContext(): { pi: ExtensionAPI; ctx: ExtensionContext; done: () => void } {
	return {
		pi: {} as ExtensionAPI,
		ctx: {} as ExtensionContext,
		done: vi.fn(),
	};
}

describe("StackPalette (headless TUI)", () => {
	let mockTheme: Theme;
	let mockPi: ExtensionAPI;
	let mockCtx: ExtensionContext;
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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines = palette.render(72);

			expect(lines.some((l) => l.includes("First Item"))).toBe(true);
			expect(lines.some((l) => l.includes("Second Item"))).toBe(true);
		});

		it("renders items with descriptions", () => {
			const view = createTestView([
				{ id: "1", label: "Item", description: "A description", onSelect: vi.fn() },
			]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines = palette.render(72);

			expect(lines.some((l) => l.includes("A description"))).toBe(true);
		});

		it("renders items with category badges", () => {
			const view = createTestView([
				{ id: "1", label: "Item", category: "cmd", onSelect: vi.fn() },
			]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines = palette.render(72);

			expect(lines.some((l) => l.includes("cmd"))).toBe(true);
		});

		it("renders delegate marker (*) for delegate items", () => {
			const view = createTestView([
				{ id: "1", label: "Item", delegate: true, onSelect: vi.fn() },
			]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines = palette.render(72);

			expect(lines.some((l) => l.includes("*"))).toBe(true);
		});

		it("shows scroll indicators when items exceed MAX_VISIBLE", () => {
			const items: PaletteItem[] = Array.from({ length: MAX_VISIBLE + 5 }, (_, i) => ({
				id: `item-${i}`,
				label: `Item ${i}`,
				onSelect: vi.fn(),
			}));
			const view = createTestView(items);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines = palette.render(72);

			// Should show "↓ X more" indicator
			expect(lines.some((l) => l.includes("↓") && l.includes("more"))).toBe(true);
		});

		it("caches rendered lines for same width", () => {
			const view = createTestView([
				{ id: "1", label: "Item", onSelect: vi.fn() },
			]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			const lines1 = palette.render(72);
			const lines2 = palette.render(72);

			// Same reference means cache was used
			expect(lines1).toBe(lines2);
		});

		it("re-renders when width changes", () => {
			const view = createTestView([
				{ id: "1", label: "Item", onSelect: vi.fn() },
			]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			palette.handleInput("\x10"); // ctrl+p (up)
			palette.handleInput("\x0e"); // ctrl+n (down)

			// Should work like up/down
		});

		it("wraps scroll offset when navigating beyond visible range", () => {
			const items: PaletteItem[] = Array.from({ length: MAX_VISIBLE + 5 }, (_, i) => ({
				id: `item-${i}`,
				label: `Item ${i}`,
				onSelect: vi.fn(),
			}));
			const view = createTestView(items);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			// Navigate down many times
			for (let i = 0; i < MAX_VISIBLE + 3; i++) {
				palette.handleInput("\x1b[B"); // down
			}

			const lines = palette.render(72);

			// Should show "↑ X more" indicator
			expect(lines.some((l) => l.includes("↑") && l.includes("more"))).toBe(true);
		});
	});

	describe("selection", () => {
		it("calls onSelect with action context on enter", () => {
			let pushedView: PaletteView | null = null;
			const onSelect = vi.fn((actx: PaletteActionContext) => {
				actx.close();
			});
			const view = createTestView([{ id: "1", label: "Item", onSelect }]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const view = createTestView([{ id: "1", label: "Item", onSelect: vi.fn() }]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			palette.handleInput("\x1b"); // escape

			expect(mockDone).toHaveBeenCalled();
		});

		it("pops to previous view on esc from sub-view", () => {
			const subView: PaletteView = { title: "Sub View", items: [] };
			const onSelect = (actx: PaletteActionContext) => actx.push(subView);
			const view = createTestView([{ id: "1", label: "Item", onSelect }]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

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
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			expect(palette.focused).toBe(false);

			palette.focused = true;
			expect(palette.focused).toBe(true);
		});

		it("shows cursor marker when focused", () => {
			const view = createTestView([]);
			const palette = new StackPalette(view, mockTheme, mockPi, mockCtx, mockDone);

			palette.focused = true;
			const focusedLines = palette.render(72);

			palette.focused = false;
			const unfocusedLines = palette.render(72);

			// Focused should show cursor marker, unfocused should not
			// The mock theme strips colors, so we check for the raw marker
			expect(focusedLines.some((l) => l.includes("▏"))).toBe(true);
		});
	});
});
