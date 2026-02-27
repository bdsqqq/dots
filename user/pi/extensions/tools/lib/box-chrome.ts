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
    return style.dim(corner.left + "─".repeat(Math.max(0, innerWidth)) + corner.right);
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
  return style.dim("╰" + "─".repeat(left)) + footer.text + style.dim("─".repeat(right) + "╯");
}
