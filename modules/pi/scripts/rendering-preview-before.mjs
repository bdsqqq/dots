// Isolated pre-fix SDK 1.3.0 fixture (39fcf27f); never loaded by production Pi.
/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by tool renderers and bash-execution.ts for consistent behavior.
 */
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
/**
 * Truncate text to a maximum number of visual lines.
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @param keep - Which visual lines to keep: the last ones (default) or the first ones.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
  text,
  maxVisualLines,
  width,
  paddingX = 0,
  keep = "end",
) {
  if (!text) {
    return { visualLines: [], skippedCount: 0 };
  }
  // Create a temporary Text component to render and get visual lines
  const tempText = new Text(text, paddingX, 0);
  const allVisualLines = tempText.render(width);
  if (allVisualLines.length <= maxVisualLines) {
    return { visualLines: allVisualLines, skippedCount: 0 };
  }
  const truncatedLines =
    keep === "start"
      ? allVisualLines.slice(0, maxVisualLines)
      : allVisualLines.slice(-maxVisualLines);
  const skippedCount = allVisualLines.length - maxVisualLines;
  return { visualLines: truncatedLines, skippedCount };
}
/**
 * Collapsed tool output limited to a number of visual lines, like bash output. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen.
 * Caches its lines per width, since it renders on every frame for every result in the transcript.
 */
export class VisualLinePreview {
  options;
  cachedWidth;
  cachedLines;
  constructor(options) {
    this.options = options;
  }
  render(width) {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const { text, maxVisualLines, keep, formatHint } = this.options;
      const preview = truncateToVisualLines(
        text,
        maxVisualLines,
        width,
        0,
        keep,
      );
      const lines = preview.visualLines;
      if (preview.skippedCount > 0) {
        const hint = truncateToWidth(
          formatHint(preview.skippedCount),
          width,
          "...",
        );
        this.cachedLines =
          keep === "start" ? [...lines, hint] : [hint, ...lines];
      } else {
        this.cachedLines = lines;
      }
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }
  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
