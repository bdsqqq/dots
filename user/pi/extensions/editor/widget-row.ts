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
