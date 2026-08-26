/**
 * box-format — shared diagnostic-style box renderer for tool output.
 *
 * produces miette/ariadne-style box-drawing output:
 *   ╭─[header text]
 *    42 │ highlighted line (base-color gutter)
 *    43 │ dim context line
 *       ·
 *   100 │ another block
 *   ╰────
 *
 * chrome (╭│╰─·) renders DIM. highlighted lines get base-color
 * gutter + content; non-highlighted lines are fully dim.
 * tools without line numbers omit the gutter column.
 *
 * pipeline: callers produce BoxSection[], optionally pass Excerpt[] for
 * per-block visual-line windowing. box-format computes chrome width,
 * expands content to visual lines at (width - chrome), applies
 * windowItems() from show.ts, then wraps the result in box chrome.
 *
 * IMPORTANT: all output lines are truncated to the provided `width`
 * via truncateToWidth() as a safety net. the TUI will crash if any
 * rendered line exceeds terminal width.
 */

import { MarkerColumn, Text, type Component } from "@earendil-works/pi-tui";
import { boxBottom, boxTop } from "@bds_pi/box-chrome";
import { windowItems, type Excerpt } from "@bds_pi/show";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

/**
 * ANSI-aware visible width + truncation.
 * pi-tui exports these too (with better wide-char support), but we
 * keep local versions so box-format works in test environments where
 * pi-tui isn't available.
 */
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

/** tab stop width — terminals default to 8 but most code uses 4 */
const TAB_WIDTH = 4;

function visibleWidth(text: string): number {
  const stripped = text.replace(ANSI_RE, "");
  let w = 0;
  for (const ch of stripped) {
    w += ch === "\t" ? TAB_WIDTH : 1;
  }
  return w;
}

function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis = "…",
): string {
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisLen = ellipsis.length;
  const target = maxWidth - ellipsisLen;
  if (target <= 0) return ellipsis.slice(0, maxWidth);

  let visible = 0;
  let i = 0;
  while (i < text.length && visible < target) {
    // skip SGR escape sequences (\x1b[...m)
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    // skip OSC 8 hyperlink sequences (\x1b]8;;...\x07)
    if (text[i] === "\x1b" && text[i + 1] === "]") {
      const end = text.indexOf("\x07", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible += text[i] === "\t" ? TAB_WIDTH : 1;
    i++;
  }

  return text.slice(0, i) + RST + ellipsis;
}

/**
 * defensive padding subtracted from width before truncating.
 * the pi TUI passes the content-area width to render(), but
 * border/padding chars can still cause off-by-one wrapping
 * that eats subsequent lines. 2 chars is conservative enough
 * to prevent wrapping without wasting visible space.
 */
const WIDTH_SAFETY_MARGIN = 2;

export interface BoxLine {
  /** optional gutter text (e.g., line number). right-aligned to gutter width. */
  gutter?: string;
  /** line content */
  text: string;
  /** when true, gutter + content render at base color instead of dim */
  highlight?: boolean;
}

export interface BoxBlock {
  lines: BoxLine[];
}

export interface BoxSection {
  /** text inside ╭─[...]. omit for headless boxes (no opening line). */
  header?: string;
  /** contiguous blocks. gaps between blocks show · elision marker. */
  blocks: BoxBlock[];
}

// --- visual-line-aware rendering (show + box-format pipeline) ---

/** re-export Excerpt so consumers import from box-format only */
export type { Excerpt };

/** intermediate visual line produced by expanding BoxLine text */
interface VisualBoxLine {
  text: string;
  gutter: string;
  highlight: boolean;
  isElision: boolean;
  isGap: boolean;
}

/**
 * expand a block's logical BoxLine[] to visual lines at contentWidth.
 * wrapping is done by pi-tui's Text.render(). first visual line of
 * a wrapped logical line gets the gutter; continuation lines get "".
 */
function expandBlock(block: BoxBlock, contentWidth: number): VisualBoxLine[] {
  const result: VisualBoxLine[] = [];
  for (const line of block.lines) {
    const visualLines =
      contentWidth > 0
        ? new Text(line.text, 0, 0).render(contentWidth)
        : [line.text];

    for (let i = 0; i < visualLines.length; i++) {
      const visualLine = visualLines[i];
      if (visualLine === undefined) continue;
      result.push({
        text: visualLine,
        gutter: i === 0 ? (line.gutter ?? "") : "",
        highlight: line.highlight ?? false,
        isElision: false,
        isGap: false,
      });
    }
  }
  return result;
}

/**
 * compute the chrome prefix width for a given gutter width.
 * with gutter:  "  42 │ " = gutterWidth + 3
 * without:      "│ "      = 2
 */
function chromeWidth(gutterWidth: number): number {
  return gutterWidth > 0 ? gutterWidth + 3 : 2;
}

export interface BoxWindowedOpts {
  /** max sections to show (rest get "… N more" footer) */
  maxSections?: number;
  /**
   * excerpts applied independently to each block's visual lines.
   * e.g., [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }]
   * caps each block at 25 visual lines (head 12 + tail 13).
   */
  excerpts?: Excerpt[];
}

/**
 * visual-line-aware box renderer.
 *
 * pipeline: compute chrome width → expand to visual lines at content width
 * → window per-block via excerpts → render chrome around the result.
 *
 * wraps content to fit width
 * via pi-tui Text.render(). truncateToWidth is kept as a safety net.
 *
 * usage:
 *   formatBoxesWindowed(
 *     sections,
 *     { excerpts: [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }] },
 *     ["some notice"],
 *     90,
 *   )
 */
export function formatBoxesWindowed(
  sections: BoxSection[],
  opts: BoxWindowedOpts = {},
  notices?: string[],
  width?: number,
): string {
  const maxSections = opts.maxSections ?? sections.length;
  const excerpts = opts.excerpts ?? [];
  const shown = sections.slice(0, maxSections);
  const out: string[] = [];

  const safeWidth =
    width != null ? Math.max(1, width - WIDTH_SAFETY_MARGIN) : undefined;
  const clamp = (line: string): string =>
    safeWidth != null ? truncateToWidth(line, safeWidth, "…") : line;

  const chrome = { dim: (s: string) => `${DIM}${s}${RST}` };

  for (let si = 0; si < shown.length; si++) {
    const section = shown[si];
    if (!section) continue;

    // compute gutter width from all lines (before any windowing)
    const allGutters = section.blocks.flatMap((b) =>
      b.lines.map((l) => l.gutter ?? ""),
    );
    const gw = Math.max(0, ...allGutters.map((g) => g.length));
    const pad = " ".repeat(gw);

    // compute content width for visual-line expansion
    const cw = chromeWidth(gw);
    const contentWidth = safeWidth != null ? Math.max(1, safeWidth - cw) : 80;

    if (si > 0) out.push("");

    // header (omitted for headless sections)
    if (section.header != null) {
      out.push(
        clamp(
          boxTop({
            variant: "open",
            style: chrome,
            header: {
              text: section.header,
              width: section.header.replace(/\x1b\[[0-9;]*m/g, "").length,
            },
          }),
        ),
      );
    }

    let _anyBlockTruncated = false;

    for (let bi = 0; bi < section.blocks.length; bi++) {
      const block = section.blocks[bi];
      if (!block) continue;
      // gap marker between blocks
      if (bi > 0) {
        out.push(gw > 0 ? `${DIM}${pad} ·${RST}` : `${DIM}·${RST}`);
      }

      // expand to visual lines at content width
      const expanded = expandBlock(block, contentWidth);

      // apply per-block excerpts
      const windowed =
        excerpts.length > 0
          ? windowItems(
              expanded,
              excerpts,
              (count): VisualBoxLine => ({
                text: `· ··· ${count} more lines`,
                gutter: "",
                highlight: false,
                isElision: true,
                isGap: false,
              }),
            )
          : { items: expanded, skippedRanges: [] as Array<[number, number]> };

      if (windowed.skippedRanges.length > 0) _anyBlockTruncated = true;

      // render each visual line with chrome
      for (const vl of windowed.items) {
        if (vl.isElision) {
          const prefix = gw > 0 ? `${pad} ` : "";
          out.push(`${DIM}${prefix}${vl.text}${RST}`);
        } else if (gw > 0) {
          const gutter = vl.gutter.padStart(gw);
          if (vl.highlight) {
            out.push(clamp(`${gutter} ${DIM}│${RST} ${vl.text}`));
          } else {
            out.push(clamp(`${DIM}${gutter} │ ${vl.text}${RST}`));
          }
        } else {
          if (vl.highlight) {
            out.push(clamp(`${DIM}│${RST} ${vl.text}`));
          } else {
            out.push(clamp(`${DIM}│ ${vl.text}${RST}`));
          }
        }
      }
    }

    // footer
    out.push(
      safeWidth == null
        ? boxBottom({ variant: "open", style: chrome })
        : truncateToWidth(
            boxBottom({ variant: "open", style: chrome }),
            safeWidth,
            "",
          ),
    );
  }

  // section elision
  if (sections.length > maxSections) {
    const rem = sections.length - maxSections;
    out.push(`${DIM}… ${rem} more${RST}`);
  }

  if (notices?.length) {
    out.push("");
    out.push(clamp(`${DIM}[${notices.join(". ")}]${RST}`));
  }

  return out.join("\n");
}

/**
 * convenience: wrap a single text block in a box section with no gutter.
 * all lines get highlight=true (base color) by default.
 */
export function textSection(
  header: string | undefined,
  text: string,
  dim = false,
): BoxSection {
  return {
    ...(header != null && { header }),
    blocks: [
      {
        lines: text.split("\n").map((line) => ({
          text: line,
          highlight: !dim,
        })),
      },
    ],
  };
}

/** Frames short fallback text with the same open chrome as structured output. */
export function framedTextRenderer(
  text: string,
  expanded = false,
  dim = false,
): Component & { invalidate(): void } {
  return boxRendererWindowed(
    () => [textSection(undefined, text, dim)],
    { collapsed: {}, expanded: {} },
    undefined,
    expanded,
  );
}

/**
 * visual-line-aware boxRenderer. uses formatBoxesWindowed under the hood.
 * caches by (width, expanded).
 */
export function boxRendererWindowed(
  buildSections: () => BoxSection[],
  opts: { collapsed: BoxWindowedOpts; expanded: BoxWindowedOpts },
  notices?: string[],
  expanded: boolean = false,
): Component & { invalidate(): void } {
  let cachedWidth: number | undefined;
  let cachedExpanded: boolean | undefined;
  let cachedLines: string[] | undefined;

  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      if (
        cachedLines !== undefined &&
        cachedExpanded === expanded &&
        cachedWidth === width
      ) {
        return cachedLines;
      }
      const sections = buildSections();
      const visual = formatBoxesWindowed(
        sections,
        expanded ? opts.expanded : opts.collapsed,
        notices,
        width,
      );
      cachedLines = visual.split("\n");
      cachedExpanded = expanded;
      cachedWidth = width;
      return cachedLines;
    },
    invalidate() {
      cachedLines = undefined;
      cachedExpanded = undefined;
      cachedWidth = undefined;
    },
  };
}

/**
 * wrap visible text in an OSC 8 terminal hyperlink.
 * terminals that support OSC 8 render this as a clickable link;
 * others silently ignore the sequences and show plain text.
 */
export function osc8Link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

const LIFECYCLE_CALL_INTERVAL_MS = 320;

export interface LifecycleCallContext {
  isError: boolean;
  isPartial: boolean;
  invalidate?: () => void;
  lastComponent?: Component;
}

class LifecycleCallComponent implements Component {
  private rows: Component[];
  private marker = "";
  private middleMarker = "";
  private endMarker = "";
  private continuationMarker = "";
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private renderVersion = 0;
  private requestRender?: () => void;

  constructor(content: Component | readonly Component[]) {
    this.rows = Array.isArray(content) ? [...content] : [content as Component];
  }

  update(
    content: Component | readonly Component[],
    theme: any,
    context: LifecycleCallContext,
  ): void {
    this.renderVersion++;
    this.requestRender = context.invalidate;
    const active = context.isPartial && !context.isError;

    if (active && this.requestRender && !this.interval) {
      this.interval = setInterval(() => {
        this.frame = (this.frame + 1) % 2;
        const renderedVersion = this.renderVersion;
        try {
          this.requestRender?.();
        } finally {
          // a component removed from the transcript cannot settle through another
          // renderCall. Stop after one unanswered invalidation instead of leaking.
          if (this.renderVersion === renderedVersion) this.stop();
        }
      }, LIFECYCLE_CALL_INTERVAL_MS);
      this.interval.unref?.();
    } else if (!active) {
      this.stop();
    }

    this.marker = context.isError
      ? theme.fg("error", "✕")
      : active
        ? theme.fg(this.frame % 2 === 0 ? "muted" : "accent", "●")
        : theme.fg("success", "✓");
    this.middleMarker = theme.fg("muted", "├");
    this.endMarker = theme.fg("muted", "╰");
    this.continuationMarker = theme.fg("muted", "│");
    this.rows = Array.isArray(content) ? [...content] : [content as Component];
  }

  render(width: number): string[] {
    if (this.rows.length === 1) {
      return new MarkerColumn(this.marker, this.rows[0]!).render(width);
    }
    return this.rows.flatMap((row, index) => {
      const first = index === 0;
      const last = index === this.rows.length - 1;
      return new MarkerColumn(
        first ? this.marker : last ? this.endMarker : this.middleMarker,
        row,
        {
          continuationMarker: last ? "" : this.continuationMarker,
        },
      ).render(width);
    });
  }

  invalidate(): void {
    for (const row of this.rows) row.invalidate();
  }

  private stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}

/**
 * adds a stable lifecycle column without taking over the tool's own call UI.
 * reuse keeps one pulse timer attached to a row while MarkerColumn delegates
 * wrapping to the original component at the remaining width.
 */
export function renderLifecycleCall(
  content: Component | readonly Component[],
  theme: any,
  context: LifecycleCallContext,
): Component {
  const component =
    context.lastComponent instanceof LifecycleCallComponent
      ? context.lastComponent
      : new LifecycleCallComponent(content);
  component.update(content, theme, context);
  return component;
}

/**
 * standardized call-line component for renderCall.
 * renders: bold(label) dim(context)
 *
 * usage: renderCallLine("Edit", "~/path/to/file.ts", theme)
 */
export function renderCallLine(
  label: string,
  context: string,
  theme: any,
): { render(width: number): string[]; invalidate(): void } {
  const line =
    theme.fg("toolTitle", theme.bold(label)) +
    (context ? " " + theme.fg("dim", context) : "");
  return {
    render(_width: number): string[] {
      return [line];
    },
    invalidate() {},
  };
}

// --- inline tests ---

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  describe("visibleWidth", () => {
    it("counts plain text characters", () => {
      expect(visibleWidth("hello")).toBe(5);
      expect(visibleWidth("")).toBe(0);
    });

    it("expands tabs to TAB_WIDTH", () => {
      expect(visibleWidth("\t")).toBe(4);
      expect(visibleWidth("a\tb")).toBe(6); // a + 4 (tab) + b
    });

    it("ignores ANSI SGR sequences", () => {
      expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
      expect(visibleWidth("\x1b[1;32mgreen\x1b[0m")).toBe(5);
    });

    it("ignores OSC 8 hyperlink sequences", () => {
      expect(
        visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
      ).toBe(4);
    });
  });

  describe("truncateToWidth", () => {
    it("returns text unchanged if within width", () => {
      expect(truncateToWidth("hello", 10)).toBe("hello");
    });

    it("truncates and adds ellipsis", () => {
      // "hello world" at width 8: "hello w" (7 visible) + RST + ellipsis
      const result = truncateToWidth("hello world", 8);
      expect(result).toContain("…");
      expect(visibleWidth(result.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(8);
    });

    it("preserves ANSI codes in truncated output", () => {
      const input = "\x1b[31mhello world\x1b[0m";
      const result = truncateToWidth(input, 8);
      expect(result).toContain("\x1b[31m");
      expect(result).toContain("\x1b[0m");
      expect(result).toContain("…");
    });

    it("handles text shorter than ellipsis", () => {
      expect(truncateToWidth("hi", 1)).toBe("…");
    });
  });

  describe("chromeWidth", () => {
    it("returns 2 for no gutter", () => {
      expect(chromeWidth(0)).toBe(2);
    });

    it("returns gutterWidth + 3 for gutter", () => {
      expect(chromeWidth(3)).toBe(6); // "  42 │ " = 3 + 3
      expect(chromeWidth(5)).toBe(8);
    });
  });

  describe("osc8Link", () => {
    it("wraps text in OSC 8 hyperlink", () => {
      const result = osc8Link("https://example.com", "click me");
      expect(result).toBe(
        "\x1b]8;;https://example.com\x07click me\x1b]8;;\x07",
      );
    });

    it("handles empty text", () => {
      const result = osc8Link("https://example.com", "");
      expect(result).toBe("\x1b]8;;https://example.com\x07\x1b]8;;\x07");
    });
  });

  describe("textSection", () => {
    it("creates section with header and text", () => {
      const section = textSection("Title", "line1\nline2");
      expect(section.header).toBe("Title");
      expect(section.blocks).toHaveLength(1);
      expect(section.blocks[0]?.lines).toHaveLength(2);
    });

    it("creates headless section when header is undefined", () => {
      const section = textSection(undefined, "content");
      expect(section.header).toBeUndefined();
    });

    it("sets highlight=true by default", () => {
      const section = textSection("Title", "text");
      expect(section.blocks[0]?.lines[0]?.highlight).toBe(true);
    });

    it("sets highlight=false when dim=true", () => {
      const section = textSection("Title", "text", true);
      expect(section.blocks[0]?.lines[0]?.highlight).toBe(false);
    });
  });

  describe("framedTextRenderer", () => {
    it("frames fallback rows and closes exactly once", () => {
      const lines = framedTextRenderer("first\nsecond")
        .render(80)
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

      expect(lines.slice(0, -1).every((line) => line.startsWith("│"))).toBe(
        true,
      );
      expect(lines.filter((line) => line === "╰────")).toHaveLength(1);
      expect(lines.at(-1)).toBe("╰────");
    });

    it("keeps footer chrome within narrow render widths", () => {
      const component = framedTextRenderer("output");

      for (const width of [0, 1, 2, 3, 4]) {
        expect(
          component.render(width).every((line) => visibleWidth(line) <= width),
        ).toBe(true);
      }
    });
  });

  describe("renderLifecycleCall", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    };

    it("pulses active calls between muted and accent", () => {
      vi.useFakeTimers();
      try {
        const colors: string[] = [];
        const pulseTheme = {
          fg: (color: string, text: string) => {
            if (text === "●") colors.push(color);
            return text;
          },
        };
        let component: Component | undefined;
        const renderActive = (): void => {
          component = renderLifecycleCall(
            new Text("Bash echo ok", 0, 0),
            pulseTheme,
            {
              isError: false,
              isPartial: true,
              invalidate,
              lastComponent: component,
            },
          );
        };
        const invalidate = vi.fn(renderActive);

        renderActive();
        expect(colors.at(-1)).toBe("muted");
        vi.advanceTimersByTime(LIFECYCLE_CALL_INTERVAL_MS);
        expect(colors.at(-1)).toBe("accent");
        expect(invalidate).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders terminal success and error outcomes", () => {
      const success = renderLifecycleCall(new Text("Read file", 0, 0), theme, {
        isError: false,
        isPartial: false,
      });
      const error = renderLifecycleCall(new Text("Read file", 0, 0), theme, {
        isError: true,
        isPartial: true,
      });

      expect(success.render(80)[0]?.trimEnd()).toBe("✓ Read file");
      expect(error.render(80)[0]?.trimEnd()).toBe("✕ Read file");
    });

    it("reuses the last wrapper while replacing its content", () => {
      const first = renderLifecycleCall(new Text("Read old", 0, 0), theme, {
        isError: false,
        isPartial: false,
      });
      const next = renderLifecycleCall(new Text("Read new", 0, 0), theme, {
        isError: false,
        isPartial: false,
        lastComponent: first,
      });

      expect(next).toBe(first);
      expect(next.render(80)[0]?.trimEnd()).toBe("✓ Read new");
    });

    it("hangs wrapped content after one marker cell and one gap", () => {
      const component = renderLifecycleCall(
        new Text("Delegate verify settlement and abort findings", 0, 0),
        theme,
        { isError: false, isPartial: false },
      );

      expect(component.render(24).map((line) => line.trimEnd())).toEqual([
        "✓ Delegate verify",
        "  settlement and abort",
        "  findings",
      ]);
    });

    it("uses compact tree connectors for multi-row calls", () => {
      const component = renderLifecycleCall(
        [
          new Text("$ git diff --stat", 0, 0),
          new Text("$ git diff --name-status", 0, 0),
          new Text("$ git status --short", 0, 0),
        ],
        theme,
        { isError: false, isPartial: false },
      );

      expect(component.render(40).map((line) => line.trimEnd())).toEqual([
        "✓ $ git diff --stat",
        "├ $ git diff --name-status",
        "╰ $ git status --short",
      ]);
    });

    it("stays within narrow widths", () => {
      const component = renderLifecycleCall(
        new Text("Read file", 0, 0),
        theme,
        {
          isError: false,
          isPartial: false,
        },
      );

      expect(component.render(0)).toEqual([]);
      expect(component.render(1)).toEqual(["✓"]);
      expect(component.render(2)).toEqual(["✓ "]);
      for (const width of [1, 2, 3, 8]) {
        expect(
          component.render(width).every((line) => visibleWidth(line) <= width),
        ).toBe(true);
      }
    });

    it("cleans up on settlement and after a detached render", () => {
      vi.useFakeTimers();
      try {
        let component: Component | undefined;
        const rerender = (): void => {
          component = renderLifecycleCall(new Text("Bash test", 0, 0), theme, {
            isError: false,
            isPartial: true,
            invalidate: rerender,
            lastComponent: component,
          });
        };
        rerender();
        expect(vi.getTimerCount()).toBe(1);

        component = renderLifecycleCall(new Text("Bash test", 0, 0), theme, {
          isError: false,
          isPartial: false,
          invalidate: rerender,
          lastComponent: component,
        });
        expect(vi.getTimerCount()).toBe(0);

        renderLifecycleCall(new Text("Grep query", 0, 0), theme, {
          isError: false,
          isPartial: true,
          invalidate: () => {},
        });
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(LIFECYCLE_CALL_INTERVAL_MS);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("formatBoxesWindowed", () => {
    it("renders single section with header", () => {
      const sections: BoxSection[] = [
        {
          header: "Test",
          blocks: [{ lines: [{ text: "hello" }] }],
        },
      ];
      const result = formatBoxesWindowed(sections, {}, undefined, 80);
      expect(result).toContain("Test");
      expect(result).toContain("hello");
    });

    it("renders gutter with line numbers", () => {
      const sections: BoxSection[] = [
        {
          header: "File",
          blocks: [
            {
              lines: [
                { gutter: "1", text: "first", highlight: true },
                { gutter: "2", text: "second", highlight: false },
              ],
            },
          ],
        },
      ];
      const result = formatBoxesWindowed(sections, {}, undefined, 80);
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    it("respects maxSections option", () => {
      const sections: BoxSection[] = [
        { header: "A", blocks: [{ lines: [{ text: "a" }] }] },
        { header: "B", blocks: [{ lines: [{ text: "b" }] }] },
        { header: "C", blocks: [{ lines: [{ text: "c" }] }] },
      ];
      const result = formatBoxesWindowed(
        sections,
        { maxSections: 2 },
        undefined,
        80,
      );
      expect(result).toContain("A");
      expect(result).toContain("B");
      expect(result).not.toContain("C");
      expect(result).toContain("… 1 more");
    });

    it("appends notices", () => {
      const sections: BoxSection[] = [
        { header: "Test", blocks: [{ lines: [{ text: "content" }] }] },
      ];
      const result = formatBoxesWindowed(
        sections,
        {},
        ["Notice 1", "Notice 2"],
        80,
      );
      expect(result).toContain("[Notice 1. Notice 2]");
    });
  });
}
