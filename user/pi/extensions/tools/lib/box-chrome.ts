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
