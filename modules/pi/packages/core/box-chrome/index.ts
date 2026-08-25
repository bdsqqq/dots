/**
 * box-chrome — shared box-drawing primitives for open and closed frames.
 *
 * "open" (tool output style):   ╭─[header] / │ content / ╰────
 * "closed" (overlay style):     ╭─[header]──╮ / │content│ / ╰──footer──╯
 *
 * only concern is layout chrome. callers own content rendering,
 * truncation, and interactivity. styling is injected via BoxChromeStyle
 * so both raw ANSI (box-format) and theme functions (palette) work.
 */

export type BoxChromeVariant = "open" | "closed";

export type BoxChromeStyle = { dim: (s: string) => string };

export type MeasuredText = { text: string; width: number };

export function boxTop(args: {
  variant: BoxChromeVariant;
  style: BoxChromeStyle;
  innerWidth?: number;
  header?: MeasuredText;
}): string {
  const { variant, style, innerWidth = 0, header } = args;
  if (variant === "open") {
    return header
      ? style.dim("╭─[") + header.text + style.dim("]")
      : style.dim("╭─");
  }
  if (!header) return style.dim("╭" + "─".repeat(innerWidth) + "╮");
  const right = Math.max(0, innerWidth - 1 - header.width);
  return style.dim("╭─") + header.text + style.dim("─".repeat(right) + "╮");
}

export function boxRow(args: {
  variant: BoxChromeVariant;
  style: BoxChromeStyle;
  inner: string;
}): string {
  const { variant, style, inner } = args;
  return variant === "closed"
    ? style.dim("│") + inner + style.dim("│")
    : style.dim("│ ") + inner;
}

/**
 * Border line with left AND right labels, separated by ─ fill.
 * Used by the editor for: ╭─ left ──── right ─╮ / ╰─ left ──── right ─╯
 *
 * Always renders a ─ after the left corner and before the right corner
 * (the "edge dashes"), so labels never touch the corners directly.
 * innerWidth is the space between the two corner characters.
 */
export function boxBorderLR(args: {
  corner: { left: string; right: string };
  style: BoxChromeStyle;
  innerWidth: number;
  left?: MeasuredText;
  right?: MeasuredText;
}): string {
  const { corner, style, innerWidth, left, right } = args;
  const leftW = left?.width ?? 0;
  const rightW = right?.width ?? 0;

  // budget: innerWidth minus 2 edge dashes minus label widths
  const fill = innerWidth - 2 - leftW - rightW;
  if (fill < 0) {
    // overflow — plain dashed line
    return style.dim(
      corner.left + "─".repeat(Math.max(0, innerWidth)) + corner.right,
    );
  }

  return (
    style.dim(corner.left + "─") +
    (left ? left.text : "") +
    style.dim("─".repeat(fill)) +
    (right ? right.text : "") +
    style.dim("─" + corner.right)
  );
}

export function boxBottom(args: {
  variant: BoxChromeVariant;
  style: BoxChromeStyle;
  innerWidth?: number;
  footer?: MeasuredText;
}): string {
  const { variant, style, innerWidth = 0, footer } = args;
  if (variant === "open") return style.dim("╰────");
  if (!footer) return style.dim("╰" + "─".repeat(innerWidth) + "╯");
  const left = Math.max(0, Math.floor((innerWidth - footer.width) / 2));
  const right = Math.max(0, innerWidth - left - footer.width);
  return (
    style.dim("╰" + "─".repeat(left)) +
    footer.text +
    style.dim("─".repeat(right) + "╯")
  );
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // identity style for testing raw output
  const identity = { dim: (s: string) => s };

  describe("boxTop", () => {
    it("open variant without header", () => {
      expect(boxTop({ variant: "open", style: identity })).toBe("╭─");
    });

    it("open variant with header", () => {
      expect(
        boxTop({
          variant: "open",
          style: identity,
          header: { text: "title", width: 5 },
        }),
      ).toBe("╭─[title]");
    });

    it("closed variant without header", () => {
      expect(
        boxTop({ variant: "closed", style: identity, innerWidth: 5 }),
      ).toBe("╭─────╮");
    });

    it("closed variant with header", () => {
      expect(
        boxTop({
          variant: "closed",
          style: identity,
          innerWidth: 10,
          header: { text: "hi", width: 2 },
        }),
      ).toBe("╭─hi───────╮");
    });
  });

  describe("boxRow", () => {
    it("open variant", () => {
      expect(boxRow({ variant: "open", style: identity, inner: "text" })).toBe(
        "│ text",
      );
    });

    it("closed variant", () => {
      expect(
        boxRow({ variant: "closed", style: identity, inner: "text" }),
      ).toBe("│text│");
    });
  });

  describe("boxBorderLR", () => {
    it("no labels", () => {
      expect(
        boxBorderLR({
          corner: { left: "╭", right: "╮" },
          style: identity,
          innerWidth: 6,
        }),
      ).toBe("╭──────╮");
    });

    it("left label only", () => {
      expect(
        boxBorderLR({
          corner: { left: "╭", right: "╮" },
          style: identity,
          innerWidth: 10,
          left: { text: "L", width: 1 },
        }),
      ).toBe("╭─L────────╮");
    });

    it("right label only", () => {
      expect(
        boxBorderLR({
          corner: { left: "╭", right: "╮" },
          style: identity,
          innerWidth: 10,
          right: { text: "R", width: 1 },
        }),
      ).toBe("╭────────R─╮");
    });

    it("both labels", () => {
      expect(
        boxBorderLR({
          corner: { left: "╭", right: "╮" },
          style: identity,
          innerWidth: 12,
          left: { text: "L", width: 1 },
          right: { text: "R", width: 1 },
        }),
      ).toBe("╭─L────────R─╮");
    });

    it("overflow falls back to plain dashed line", () => {
      expect(
        boxBorderLR({
          corner: { left: "╭", right: "╮" },
          style: identity,
          innerWidth: 4,
          left: { text: "LONG", width: 4 },
          right: { text: "X", width: 1 },
        }),
      ).toBe("╭────╮");
    });
  });

  describe("boxBottom", () => {
    it("open variant", () => {
      expect(boxBottom({ variant: "open", style: identity })).toBe("╰────");
    });

    it("closed variant without footer", () => {
      expect(
        boxBottom({ variant: "closed", style: identity, innerWidth: 5 }),
      ).toBe("╰─────╯");
    });

    it("closed variant with centered footer", () => {
      expect(
        boxBottom({
          variant: "closed",
          style: identity,
          innerWidth: 10,
          footer: { text: "ok", width: 2 },
        }),
      ).toBe("╰────ok────╯");
    });

    it("footer centering handles odd widths", () => {
      expect(
        boxBottom({
          variant: "closed",
          style: identity,
          innerWidth: 9,
          footer: { text: "ok", width: 2 },
        }),
      ).toBe("╰───ok────╯");
    });
  });
}
