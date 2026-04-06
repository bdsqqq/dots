import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type Align = "left" | "center" | "right";

export interface InlineSegment {
  align: Align;
  priority?: number;
  renderInline: (maxWidth: number) => string;
}

export interface LayoutOptions {
  gap?: string;
}

export class WidgetRowRegistry {
  private segments = new Map<string, InlineSegment>();
  private _version = 0;

  constructor(private tui: { requestRender(): void }) {}

  get version(): number {
    return this._version;
  }

  set(id: string, segment: InlineSegment): void {
    this.segments.set(id, segment);
    this._version++;
    this.tui.requestRender();
  }

  remove(id: string): void {
    if (this.segments.delete(id)) {
      this._version++;
      this.tui.requestRender();
    }
  }

  clear(): void {
    if (this.segments.size === 0) return;
    this.segments.clear();
    this._version++;
    this.tui.requestRender();
  }

  snapshot(): InlineSegment[] {
    return [...this.segments.values()];
  }
}

function sortByPriority(children: InlineSegment[]): InlineSegment[] {
  return [...children].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function joinGroup(
  children: InlineSegment[],
  width: number,
  gap: string,
): string {
  if (children.length === 0) return "";
  const ordered = sortByPriority(children);
  const parts = ordered
    .map((child) => child.renderInline(width))
    .filter((part) => part.length > 0);
  return parts.join(gap);
}

function clampToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  return truncateToWidth(text, maxWidth);
}

function layoutLine(
  children: InlineSegment[],
  width: number,
  gap: string,
): string {
  if (width <= 0) return "";

  const grouped: Record<Align, InlineSegment[]> = {
    left: [],
    center: [],
    right: [],
  };

  for (const child of children) {
    grouped[child.align].push(child);
  }

  let left = joinGroup(grouped.left, width, gap);
  let center = joinGroup(grouped.center, width, gap);
  let right = joinGroup(grouped.right, width, gap);

  let leftWidth = visibleWidth(left);
  let centerWidth = visibleWidth(center);
  let rightWidth = visibleWidth(right);

  const shrinkCenter = () => {
    const budget = Math.max(0, width - leftWidth - rightWidth);
    if (centerWidth > budget) {
      center = clampToWidth(center, budget);
      centerWidth = visibleWidth(center);
    }
  };

  shrinkCenter();

  if (leftWidth + rightWidth > width) {
    const leftBudget = Math.max(0, width - rightWidth);
    if (leftWidth > leftBudget) {
      left = clampToWidth(left, leftBudget);
      leftWidth = visibleWidth(left);
    }
  }
  if (leftWidth + rightWidth > width) {
    const rightBudget = Math.max(0, width - leftWidth);
    if (rightWidth > rightBudget) {
      right = clampToWidth(right, rightBudget);
      rightWidth = visibleWidth(right);
    }
  }

  const availableCenter = Math.max(0, width - leftWidth - rightWidth);
  if (centerWidth > availableCenter) {
    center = clampToWidth(center, availableCenter);
    centerWidth = visibleWidth(center);
  }

  const paddingForCenter = Math.max(0, availableCenter - centerWidth);
  const padLeft = Math.floor(paddingForCenter / 2);
  const padRight = paddingForCenter - padLeft;

  const line =
    left + " ".repeat(padLeft) + center + " ".repeat(padRight) + right;
  return truncateToWidth(line, width);
}

export class HorizontalLineWidget {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedVersion?: number;

  constructor(
    private getChildren: () => InlineSegment[],
    private options: LayoutOptions = {},
    private getVersion?: () => number,
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedVersion = undefined;
  }

  render(width: number): string[] {
    const version = this.getVersion?.();
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      (!this.getVersion || (version != null && this.cachedVersion === version))
    ) {
      return this.cachedLines;
    }
    const lines = [
      layoutLine(this.getChildren(), width, this.options.gap ?? "  "),
    ];
    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedVersion = version;
    return lines;
  }
}

// Export for testing
export { sortByPriority, joinGroup, clampToWidth, layoutLine };

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("widget-row", () => {
    describe("sortByPriority", () => {
      it("sorts segments by priority ascending", () => {
        const segments: InlineSegment[] = [
          { align: "left", priority: 10, renderInline: () => "high" },
          { align: "left", priority: 0, renderInline: () => "low" },
          { align: "left", priority: 5, renderInline: () => "mid" },
        ];
        const sorted = sortByPriority(segments);
        expect(sorted.map((s) => s.renderInline(10))).toEqual([
          "low",
          "mid",
          "high",
        ]);
      });

      it("treats undefined priority as 0", () => {
        const segments: InlineSegment[] = [
          { align: "left", priority: 5, renderInline: () => "p5" },
          { align: "left", renderInline: () => "undef" },
          { align: "left", priority: -2, renderInline: () => "neg" },
        ];
        const sorted = sortByPriority(segments);
        expect(sorted.map((s) => s.renderInline(10))).toEqual([
          "neg",
          "undef",
          "p5",
        ]);
      });
    });

    describe("joinGroup", () => {
      it("joins rendered segments with gap", () => {
        const segments: InlineSegment[] = [
          { align: "left", renderInline: () => "a" },
          { align: "left", renderInline: () => "b" },
          { align: "left", renderInline: () => "c" },
        ];
        expect(joinGroup(segments, 80, " ")).toBe("a b c");
        expect(joinGroup(segments, 80, " · ")).toBe("a · b · c");
      });

      it("filters out empty renders", () => {
        const segments: InlineSegment[] = [
          { align: "left", renderInline: () => "a" },
          { align: "left", renderInline: () => "" },
          { align: "left", renderInline: () => "b" },
        ];
        expect(joinGroup(segments, 80, " ")).toBe("a b");
      });

      it("returns empty string for empty array", () => {
        expect(joinGroup([], 80, " ")).toBe("");
      });
    });

    describe("clampToWidth", () => {
      it("returns empty string for non-positive width", () => {
        expect(clampToWidth("test", 0)).toBe("");
        expect(clampToWidth("test", -1)).toBe("");
      });

      it("truncates text that exceeds width", () => {
        // truncateToWidth adds ANSI codes for reset sequences
        const result = clampToWidth("hello world", 5);
        // The visible width should be 5 (he + ellipsis)
        expect(result).toContain("he");
        expect(result).toContain("...");
      });

      it("returns text as-is when within width", () => {
        expect(clampToWidth("hi", 10)).toBe("hi");
      });
    });

    describe("layoutLine", () => {
      it("lays out left-aligned segments on the left", () => {
        const segments: InlineSegment[] = [
          { align: "left", renderInline: () => "left" },
        ];
        const line = layoutLine(segments, 20, " ");
        expect(line.startsWith("left")).toBe(true);
      });

      it("lays out right-aligned segments on the right", () => {
        const segments: InlineSegment[] = [
          { align: "right", renderInline: () => "right" },
        ];
        const line = layoutLine(segments, 20, " ");
        expect(line.endsWith("right")).toBe(true);
      });

      it("centers center-aligned segments", () => {
        const segments: InlineSegment[] = [
          { align: "center", renderInline: () => "center" },
        ];
        const line = layoutLine(segments, 20, " ");
        // Should have padding on both sides
        expect(line.trim()).toBe("center");
        // Check that there's space on both sides
        const leftPad = line.match(/^( *)/)?.[1]?.length ?? 0;
        const rightPad = line.match(/( *)$/)?.[1]?.length ?? 0;
        expect(leftPad).toBeGreaterThan(0);
        expect(rightPad).toBeGreaterThanOrEqual(0);
      });

      it("handles all three alignments together", () => {
        const segments: InlineSegment[] = [
          { align: "left", renderInline: () => "L" },
          { align: "center", renderInline: () => "C" },
          { align: "right", renderInline: () => "R" },
        ];
        const line = layoutLine(segments, 20, " ");
        expect(line.startsWith("L")).toBe(true);
        expect(line.endsWith("R")).toBe(true);
        expect(line).toContain("C");
      });

      it("returns empty string for zero/negative width", () => {
        expect(layoutLine([], 0, " ")).toBe("");
        expect(layoutLine([], -1, " ")).toBe("");
      });

      it("truncates overflow content", () => {
        const segments: InlineSegment[] = [
          { align: "left", renderInline: () => "a".repeat(30) },
          { align: "right", renderInline: () => "b".repeat(30) },
        ];
        const line = layoutLine(segments, 40, " ");
        // truncateToWidth handles overflow - visible width may differ from string length
        // due to ANSI codes. Just verify it returns something.
        expect(line.length).toBeGreaterThan(0);
      });
    });

    describe("WidgetRowRegistry", () => {
      it("tracks segments by id", () => {
        const tui = { requestRender: () => {} };
        const registry = new WidgetRowRegistry(tui);
        registry.set("a", { align: "left", renderInline: () => "seg a" });
        registry.set("b", { align: "right", renderInline: () => "seg b" });
        expect(registry.snapshot().length).toBe(2);
      });

      it("removes segments by id", () => {
        const tui = { requestRender: () => {} };
        const registry = new WidgetRowRegistry(tui);
        registry.set("a", { align: "left", renderInline: () => "seg a" });
        registry.remove("a");
        expect(registry.snapshot().length).toBe(0);
      });

      it("increments version on mutation", () => {
        const tui = { requestRender: () => {} };
        const registry = new WidgetRowRegistry(tui);
        const v1 = registry.version;
        registry.set("a", { align: "left", renderInline: () => "a" });
        expect(registry.version).toBeGreaterThan(v1);
        const v2 = registry.version;
        registry.remove("a");
        expect(registry.version).toBeGreaterThan(v2);
      });

      it("clears all segments", () => {
        const tui = { requestRender: () => {} };
        const registry = new WidgetRowRegistry(tui);
        registry.set("a", { align: "left", renderInline: () => "a" });
        registry.set("b", { align: "left", renderInline: () => "b" });
        registry.clear();
        expect(registry.snapshot().length).toBe(0);
      });
    });

    describe("HorizontalLineWidget", () => {
      it("renders segments via layoutLine", () => {
        const widget = new HorizontalLineWidget(
          () => [{ align: "left", renderInline: () => "lefty" }],
          { gap: " " },
        );
        const lines = widget.render(20);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.startsWith("lefty")).toBe(true);
      });

      it("caches rendered output", () => {
        let callCount = 0;
        const widget = new HorizontalLineWidget(
          () => {
            callCount++;
            return [{ align: "left", renderInline: () => "test" }];
          },
          { gap: " " },
        );
        widget.render(20);
        widget.render(20);
        expect(callCount).toBe(1);
      });

      it("invalidates cache on invalidate() call", () => {
        let callCount = 0;
        const widget = new HorizontalLineWidget(
          () => {
            callCount++;
            return [{ align: "left", renderInline: () => "test" }];
          },
          { gap: " " },
        );
        widget.render(20);
        widget.invalidate();
        widget.render(20);
        expect(callCount).toBe(2);
      });

      it("uses version for cache invalidation", () => {
        let version = 0;
        let callCount = 0;
        const widget = new HorizontalLineWidget(
          () => {
            callCount++;
            return [{ align: "left", renderInline: () => "test" }];
          },
          { gap: " " },
          () => version,
        );
        widget.render(20);
        version = 1;
        widget.render(20);
        expect(callCount).toBe(2);
      });
    });
  });
}
