/**
 * Diagnostic content sections: labels, line-number gutters and visual-line
 * excerpts. The transcript shell owns lifecycle markers, padding and framing.
 */

import {
  Text,
  truncateToWidth,
  visibleWidth as nativeVisibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { windowItems, type Excerpt } from "@bds_pi/show";

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

function visibleWidth(text: string): number {
  return nativeVisibleWidth(text.replace(/\t/g, "    "));
}

export interface SectionLine {
  /** optional gutter text (e.g., line number). right-aligned to gutter width. */
  gutter?: string;
  /** line content */
  text: string;
  /** when true, gutter + content render at base color instead of dim */
  highlight?: boolean;
}

export interface SectionBlock {
  lines: SectionLine[];
}

export interface ContentSection {
  /** Optional section label, without an enclosing frame. */
  header?: string;
  /** contiguous blocks. gaps between blocks show · elision marker. */
  blocks: SectionBlock[];
}

// --- visual-line-aware rendering (show + box-format pipeline) ---

/** re-export Excerpt so consumers import from box-format only */
export type { Excerpt };

/** intermediate visual line produced by expanding SectionLine text */
interface VisualSectionLine {
  text: string;
  gutter: string;
  highlight: boolean;
  isElision: boolean;
  isGap: boolean;
}

/**
 * expand a block's logical SectionLine[] to visual lines at contentWidth.
 * wrapping is done by pi-tui's Text.render(). first visual line of
 * a wrapped logical line gets the gutter; continuation lines get "".
 */
function expandBlock(
  block: SectionBlock,
  contentWidth: number,
): VisualSectionLine[] {
  const result: VisualSectionLine[] = [];
  for (const line of block.lines) {
    const visualLines =
      contentWidth > 0 && line.text !== ""
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
 * without:      no prefix
 */
function chromeWidth(gutterWidth: number): number {
  return gutterWidth > 0 ? gutterWidth + 3 : 0;
}

export interface SectionWindowOptions {
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
 * Visual-line-aware content renderer.
 *
 * Compute gutter width, wrap content, then window each block independently.
 *
 * wraps content to fit width
 * via pi-tui Text.render(). truncateToWidth is kept as a safety net.
 *
 * usage:
 *   formatSectionsWindowed(
 *     sections,
 *     { excerpts: [{ focus: "head", context: 12 }, { focus: "tail", context: 13 }] },
 *     ["some notice"],
 *     90,
 *   )
 */
export function formatSectionsWindowed(
  sections: ContentSection[],
  opts: SectionWindowOptions = {},
  notices?: string[],
  width?: number,
): string {
  const maxSections = opts.maxSections ?? sections.length;
  const excerpts = opts.excerpts ?? [];
  const shown = sections.slice(0, maxSections);
  const out: string[] = [];

  const safeWidth = width != null ? Math.max(0, width) : undefined;
  if (safeWidth === 0) return "";
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

    // Section labels are content; the transcript shell owns the outer frame.
    if (section.header != null) out.push(clamp(chrome.dim(section.header)));

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
          ? windowItems(expanded, excerpts, (count): VisualSectionLine => ({
              text: `· ··· ${count} more lines`,
              gutter: "",
              highlight: false,
              isElision: true,
              isGap: false,
            }))
          : { items: expanded, skippedRanges: [] as Array<[number, number]> };

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
            out.push(clamp(vl.text));
          } else {
            out.push(clamp(`${DIM}${vl.text}${RST}`));
          }
        }
      }
    }
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

  return out.map(clamp).join("\n");
}

/**
 * convenience: wrap a single text block in a box section with no gutter.
 * all lines get highlight=true (base color) by default.
 */
export function textSection(
  header: string | undefined,
  text: string,
  dim = false,
): ContentSection {
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

/**
 * Content-only section renderer; the transcript shell owns the outer frame.
 * Caches by (width, expanded).
 */
export function sectionRendererWindowed(
  buildSections: () => ContentSection[],
  opts: { collapsed: SectionWindowOptions; expanded: SectionWindowOptions },
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
      const visual = formatSectionsWindowed(
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

// --- inline tests ---

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;

  describe("patched native transcript frames", () => {
    // Exercise installed SDK components: patch application alone cannot prove
    // their marker, clipping, or padding-refresh contracts survived an upgrade.
    it.each(["user", "assistant", "branch-summary", "compaction-summary"])(
      "preserves %s markers across narrow widths and padding changes",
      async (name) => {
        const { getPackageDir } =
          await import("@earendil-works/pi-coding-agent");
        const { pathToFileURL } = await import("node:url");
        const { visibleWidth: nativeWidth, stripTerminalSequences } =
          await import("@earendil-works/pi-tui");
        const load = (path: string) =>
          import(pathToFileURL(`${getPackageDir()}/dist/${path}`).href);
        const { initTheme } = await load("modes/interactive/theme/theme.js");
        initTheme("dark", false);
        const exports = await load(
          `modes/interactive/components/${name}-message.js`,
        );
        const constructorName = {
          user: "UserMessageComponent",
          assistant: "AssistantMessageComponent",
          "branch-summary": "BranchSummaryMessageComponent",
          "compaction-summary": "CompactionSummaryMessageComponent",
        }[name]!;
        const message =
          name === "user"
            ? "response text"
            : name === "assistant"
              ? {
                  role: "assistant",
                  content: [{ type: "text", text: "response text" }],
                  stopReason: "stop",
                }
              : { summary: "summary text", tokensBefore: 1000 };
        const component = new exports[constructorName](message);
        const rows = () =>
          component
            .render(80)
            .map((line: string) => stripTerminalSequences(line));
        expect(rows().some((line: string) => line.startsWith(" ●"))).toBe(true);
        expect(rows().some((line: string) => line.includes("╰────"))).toBe(
          name !== "user",
        );
        const before = rows();
        component.setOutputPad(3);
        expect(rows()).not.toEqual(before);
        expect(rows().some((line: string) => line.startsWith("   ●"))).toBe(
          true,
        );
        if (name.endsWith("summary")) {
          component.setExpanded(true);
          expect(rows().join("\n")).toContain("summary text");
        }
        for (const width of [0, 1, 2, 3, 8, 20]) {
          expect(
            component
              .render(width)
              .every((line: string) => nativeWidth(line) <= width),
          ).toBe(true);
        }
      },
    );
  });

  describe("installed shared tool shell", () => {
    async function sdk() {
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const { pathToFileURL } = await import("node:url");
      const load = (path: string) =>
        import(pathToFileURL(`${getPackageDir()}/dist/${path}`).href);
      const { initTheme } = await load("modes/interactive/theme/theme.js");
      initTheme("dark", false);
      const { ToolExecutionComponent } = await load(
        "modes/interactive/components/tool-execution.js",
      );
      const { stripTerminalSequences, visibleWidth } =
        await import("@earendil-works/pi-tui");
      const make = (definition?: unknown, name = "fixture", args = {}) =>
        new ToolExecutionComponent(
          name,
          "fixture-call",
          args,
          {},
          definition,
          { requestRender() {} },
          process.cwd(),
        );
      const rows = (component: Component, width = 80): string[] =>
        component.render(width).map(stripTerminalSequences);
      const result = (text = "output", isError = false) => ({
        content: [{ type: "text", text }],
        details: undefined,
        isError,
        durationMs: 1234,
      });
      return { load, make, rows, result, visibleWidth };
    }

    it("owns lifecycle and fallback framing for registered and unknown tools", async () => {
      const { make, rows, result, visibleWidth } = await sdk();
      for (const definition of [undefined, {}]) {
        const component = make(definition);
        expect(rows(component).join("\n")).toContain("● fixture");
        expect(rows(component).join("\n")).not.toContain("╰────");
        component.markExecutionStarted();
        component.updateResult(result());
        expect(rows(component).join("\n")).toContain("✓ fixture");
        expect(rows(component).join("\n")).toContain("│ output");
        expect(
          rows(component).filter((line) => line.includes("╰────")),
        ).toHaveLength(1);
        component.updateResult(result("failed", true));
        expect(rows(component).join("\n")).toContain("✕ fixture");
        expect(rows(component).join("\n")).toContain("│ failed");
        component.updateResult(result(""));
        expect(rows(component).join("\n")).toContain("│ (no output)");
        for (const width of [0, 1, 2, 3, 4, 8, 20]) {
          expect(
            component
              .render(width)
              .every((line: string) => visibleWidth(line) <= width),
          ).toBe(true);
        }
        component.setOutputPad(3);
        expect(rows(component).some((line) => line.startsWith("   ✓"))).toBe(
          true,
        );
      }
    });

    it("keeps failed custom renderers inside the same fallback shell", async () => {
      const { make, rows, result } = await sdk();
      const component = make({
        renderCall() {
          throw new Error("call renderer failed");
        },
        renderResult() {
          throw new Error("result renderer failed");
        },
      });
      component.updateResult(result("fallback output", true));
      const text = rows(component).join("\n");
      expect(text).toContain("✕ fixture");
      expect(text).toContain("│ fallback output");
      expect(
        rows(component).filter((line) => line.includes("╰────")),
      ).toHaveLength(1);
    });

    it("preserves content instances, state, links, click coordinates and expansion", async () => {
      const { make, rows, result } = await sdk();
      const calls: Component[] = [];
      const results: Component[] = [];
      const clicks: Array<{ x: number; y: number }> = [];
      const states: unknown[] = [];
      const expanded: boolean[] = [];
      const call = new Text("call", 0, 0);
      const output = {
        render: () => [osc8Link("https://example.com", "linked output")],
        invalidate() {},
        handleMouse(event: { x: number; y: number; type: string }) {
          if (event.type === "click") {
            clicks.push(event);
            return { handled: true };
          }
          return undefined;
        },
      };
      const component = make({
        renderCall(_args: unknown, _theme: unknown, context: any) {
          states.push(context.state);
          if (context.lastComponent) calls.push(context.lastComponent);
          return call;
        },
        renderResult(
          _result: unknown,
          options: any,
          _theme: unknown,
          context: any,
        ) {
          expanded.push(options.expanded);
          states.push(context.state);
          if (context.lastComponent) results.push(context.lastComponent);
          return output;
        },
      });
      component.updateResult(result());
      component.setExpanded(true);
      component.invalidate();
      expect(calls.every((last) => last === call)).toBe(true);
      expect(results.every((last) => last === output)).toBe(true);
      expect(new Set(states).size).toBe(1);
      expect(expanded).toContain(true);
      expect(component.render(80).join("\n")).toContain(
        "\x1b]8;;https://example.com",
      );
      const y = rows(component).findIndex((line) =>
        line.includes("linked output"),
      );
      const event = {
        type: "click",
        button: "left",
        x: 5,
        y,
        screenX: 5,
        screenY: y,
        width: 80,
        height: rows(component).length,
        shift: false,
        alt: false,
        ctrl: false,
      } as const;
      expect(component.handleMouse(event)).toMatchObject({ handled: true });
      expect(clicks.at(-1)).toMatchObject({ x: 2, y: 0 });
      const callY = rows(component).findIndex((line) => line.includes("call"));
      component.handleMouse({ ...event, y: callY });
      expect(expanded.at(-1)).toBe(false);
      component.render(80);
      component.handleMouse({ ...event, x: 1 });
      expect(expanded.at(-1)).toBe(true);
      // Unhandled drags remain available for transcript selection.
      expect(component.handleMouse({ ...event, type: "drag" })).toBeUndefined();
    });

    it("windows wrapped native previews at the omission point, including tiny and odd budgets", async () => {
      const { load } = await sdk();
      const { VisualLinePreview, truncateToVisualLines } = await load(
        "modes/interactive/components/visual-truncate.js",
      );
      const {
        stripTerminalSequences,
        visibleWidth,
        truncateToWidth: clip,
      } = await import("@earendil-works/pi-tui");
      const text = `\x1b[32m${osc8Link("https://example.com", "日本語 λ é 😀 ".repeat(10))}\x1b[0m\nFINAL_ERROR`;
      for (const width of [0, 1, 8, 20, 80, 140]) {
        const full = new Text(text, 0, 0)
          .render(width)
          .map((line) => clip(line, width, ""));
        for (const budget of [
          0,
          1,
          2,
          3,
          5,
          10,
          full.length,
          full.length + 1,
        ]) {
          const actual = truncateToVisualLines(text, budget, width);
          const hidden = Math.max(0, full.length - budget);
          expect(actual.skippedCount).toBe(hidden);
          const head = Math.floor(budget / 2);
          const tail = budget - head;
          expect(actual.visualLines).toEqual(
            !hidden
              ? full
              : budget === 0
                ? []
                : [...full.slice(0, head), ...full.slice(-tail)],
          );
          const preview = new VisualLinePreview({
            text,
            maxVisualLines: budget,
            formatHint: (n: number) => `HIDDEN ${n}`,
          });
          const lines = preview.render(width);
          expect(
            lines.every((line: string) => visibleWidth(line) <= width),
          ).toBe(true);
          if (hidden && width >= 20)
            expect(stripTerminalSequences(lines[head])).toBe(
              `HIDDEN ${hidden}`,
            );
          expect(preview.render(width)).toBe(lines);
          preview.invalidate();
          expect(preview.render(width)).toEqual(lines);
          for (const keep of ["start", "end"]) {
            expect(
              truncateToVisualLines(text, budget, width, 0, keep).visualLines,
            ).toEqual(
              !hidden
                ? full
                : budget === 0
                  ? []
                  : keep === "start"
                    ? full.slice(0, budget)
                    : full.slice(-budget),
            );
          }
        }
      }
    });

    it("rejects the isolated pre-fix native preview rather than accepting tail-only output", async () => {
      const { load } = await sdk();
      const fixed = await load(
        "modes/interactive/components/visual-truncate.js",
      );
      const before = await import(
        new URL(
          "../../../scripts/rendering-preview-before.mjs",
          import.meta.url,
        ).href
      );
      const text = Array.from({ length: 30 }, (_, n) => `ROW_${n}`).join("\n");
      const accepts = (implementation: any) => {
        const component = new implementation.VisualLinePreview({
          text,
          maxVisualLines: 5,
          formatHint: (n: number) => `HIDDEN ${n}`,
        });
        const lines = component.render(80).join("\n");
        expect(lines).toContain("ROW_0");
        expect(lines).toContain("ROW_29");
        expect(lines).not.toContain("ROW_15");
        expect(lines.indexOf("HIDDEN 25")).toBeGreaterThan(
          lines.indexOf("ROW_0"),
        );
        expect(lines.indexOf("HIDDEN 25")).toBeLessThan(
          lines.indexOf("ROW_29"),
        );
      };
      accepts(fixed);
      expect(() => accepts(before)).toThrow();
    });

    it("keeps both ends of native code, results, fallback, shell, MCP and write with reversible expansion", async () => {
      const { load, make, rows, result } = await sdk();
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const { createShellRenderers } = await load(
        "core/tools/renderers/bash.js",
      );
      const { writeRenderers } = await load("core/tools/renderers/write.js");
      const { createMcpToolDefinition } = await load("extensions/mcp/tools.js");
      const mcp = createMcpToolDefinition({
        server: "fixture",
        tool: { name: "fixture", inputSchema: { type: "object" } },
      });
      const code = Array.from(
        { length: 30 },
        (_, n) => `// CODE_${String(n).padStart(3, "0")}`,
      ).join("\n");
      const output = Array.from(
        { length: 30 },
        (_, n) => `OUT_${String(n).padStart(3, "0")}`,
      ).join("\n");
      for (const definition of [
        undefined,
        {},
        codemodeRenderers,
        createShellRenderers("$"),
        mcp,
      ]) {
        const component = make(definition, "fixture", {
          code,
          command: "fixture",
        });
        component.updateResult({
          ...result(output + "\nFINAL_ERROR", true),
          details: {
            fullOutputPath: "/tmp/full-output",
            calls: Array.from({ length: 12 }, (_, n) => ({
              name: `child_${n}`,
              args: "",
              status: "ok",
            })),
          },
        });
        for (const width of [20, 80, 140]) {
          component.setExpanded(false);
          const collapsed = rows(component, width).join("\n");
          expect(collapsed).toContain("OUT_000");
          expect(collapsed).toContain("FINAL_ERROR");
          expect(collapsed).not.toContain("OUT_015");
          if (width >= 80) {
            const start = collapsed.indexOf("OUT_000");
            const hint = Math.max(
              collapsed.indexOf("more lines", start),
              collapsed.indexOf("hidden lines", start),
            );
            expect(hint).toBeGreaterThan(start);
            expect(hint).toBeLessThan(collapsed.indexOf("FINAL_ERROR"));
          }
          if (definition === codemodeRenderers && width >= 80) {
            expect(collapsed).toContain("CODE_000");
            expect(collapsed).toContain("CODE_029");
            expect(collapsed).not.toContain("CODE_015");
            expect(collapsed).toContain("child_0");
            expect(collapsed).toContain("child_11");
            expect(collapsed).not.toContain("child_6");
            expect(collapsed).toContain("4 more calls");
            expect(collapsed).toContain("26 more lines");
            expect(collapsed).toContain("/tmp/full-output");
            expect(collapsed).toContain("Took 1.2s");
          }
          component.setExpanded(true);
          expect(rows(component, width).join("\n")).toContain(
            definition === codemodeRenderers ? "OUT_006" : "OUT_015",
          );
          component.setExpanded(false);
          expect(rows(component, width).join("\n")).toBe(collapsed);
        }
      }
      const write = make(writeRenderers, "write", {
        path: "fixture.ts",
        content: code,
      });
      write.updateResult(result(""));
      expect(rows(write).join("\n")).toContain("CODE_000");
      expect(rows(write).join("\n")).toContain("CODE_029");
      expect(rows(write).join("\n")).not.toContain("CODE_015");
      write.setExpanded(true);
      expect(rows(write).join("\n")).toContain("CODE_015");
      const { BashExecutionComponent } = await load(
        "modes/interactive/components/bash-execution.js",
      );
      const shell = new BashExecutionComponent("fixture", {
        requestRender() {},
      });
      shell.appendOutput(output + "\nFINAL_ERROR");
      shell.setComplete(23, false);
      expect(rows(shell).join("\n")).toContain("OUT_000");
      expect(rows(shell).join("\n")).toContain("FINAL_ERROR");
      expect(rows(shell).join("\n")).not.toContain("OUT_015");
      shell.setExpanded(true);
      expect(rows(shell).join("\n")).toContain("OUT_015");
    });

    it("offers raw recovery for a lone horizontally clipped nested failure without spurious wide hints", async () => {
      const { load, make, rows, result } = await sdk();
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const component = make(codemodeRenderers, "codemode", {
        code: "text(1)",
      });
      const failure = {
        ...result("caught"),
        details: {
          calls: [
            {
              name: "read",
              args: "fixture",
              status: "error",
              error: "failure " + "detail ".repeat(25) + "RAW_ERROR_SUFFIX",
            },
          ],
        },
      };
      const original = JSON.stringify(failure);
      component.updateResult(failure);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        for (const width of [20, 80]) {
          const text = rows(component, width).join("\n");
          expect(text.match(/\/tool-output/g)).toHaveLength(1);
          expect(text).not.toContain("RAW_ERROR_SUFFIX");
          expect(
            rows(component, width).filter((row: string) =>
              row.includes("✗ read"),
            ),
          ).toHaveLength(1);
        }
        const wide = rows(component, 500).join("\n");
        expect(wide).toContain("RAW_ERROR_SUFFIX");
        expect(wide).not.toContain("/tool-output");
      }
      expect(JSON.stringify(failure)).toBe(original);
    });

    it("retains native codemode scripts, nested statuses, output, timing and reuse", async () => {
      const { load, make, rows, result, visibleWidth } = await sdk();
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const code =
        "const answer = await tools.read({ path: 'fixture' });\nconsole.log(answer);";
      const component = make(codemodeRenderers, "codemode", { code });
      component.markExecutionStarted();
      const partial = {
        ...result(""),
        details: {
          calls: [{ name: "read", args: "fixture", status: "running" }],
        },
      };
      component.updateResult(partial, true);
      expect(rows(component).join("\n")).toContain("… read fixture");
      const call = component.callRendererComponent;
      const output = component.resultRendererComponent;
      component.updateResult({
        ...result("script output"),
        details: {
          calls: [
            { name: "read", args: "fixture", status: "ok", durationMs: 23 },
            {
              name: "probe",
              args: "bad",
              status: "error",
              durationMs: 4,
              error: "nested failure",
            },
            { name: "cancelled", args: "", status: "cancelled" },
          ],
        },
      });
      const text = rows(component).join("\n");
      expect(text).toContain("const answer");
      // Native highlighted content survives composition byte-for-byte at its allotted width.
      const nativeCallRows: string[] =
        component.callRendererComponent.render(76);
      const shellRows: string[] = component.render(80);
      expect(
        nativeCallRows.every((native) =>
          shellRows.some((shell) => shell.includes(native)),
        ),
      ).toBe(true);
      expect(text).toContain("✓ read fixture 23ms");
      expect(text).toContain("✗ probe nested failure bad 4ms");
      expect(text).toContain("⊘ cancelled");
      expect(text).toContain("script output");
      expect(text).toContain("Took 1.2s");
      component.setExpanded(true);
      expect(rows(component).join("\n")).toContain("nested failure");
      expect(component.callRendererComponent).toBe(call);
      expect(component.resultRendererComponent).toBe(output);
      expect(text.match(/╰────/g)).toHaveLength(1);
      for (const width of [0, 1, 2, 3, 8, 20]) {
        expect(
          component
            .render(width)
            .every((line: string) => visibleWidth(line) <= width),
        ).toBe(true);
      }
    });

    it("bounds expanded native codemode visual rows without interpreting opaque output", async () => {
      const { load, make, rows, result, visibleWidth } = await sdk();
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const code = Array.from(
        { length: 80 },
        (_, n) => `// SCRIPT_${n} ${"日本語 😀 ".repeat(40)}`,
      ).join("\n");
      const opaque = JSON.stringify({
        demo: {
          result: {
            allSettled: [{ status: "rejected", reason: "OPAQUE_NOT_A_CALL" }],
          },
        },
        payload: "x".repeat(20000),
        tail: "OPAQUE_JSON_TAIL",
      });
      const calls = Array.from({ length: 40 }, (_, n) => ({
        name: `child_${n}`,
        args: `arg_${n}\n${"input ".repeat(100)}`,
        status: "ok",
        durationMs: 23,
        cost: 0.01,
        error: undefined as string | undefined,
      }));
      calls[17] = {
        ...calls[17]!,
        status: "error",
        error: "FAIL_REASON\nmore detail",
      };
      calls[18] = { ...calls[18]!, status: "running" };
      calls[19] = { ...calls[19]!, status: "cancelled" };
      const value = {
        ...result("unused", true),
        content: [
          {
            type: "text",
            text: "Script failed\nWall time 1.234 seconds\nOutput:\n",
          },
          {
            type: "text",
            text: `OUTPUT_HEAD\n${opaque}\nScript error: FINAL_ERROR`,
          },
        ],
        details: { calls, fullOutputPath: "/tmp/codemode-full-output" },
      };
      const before = structuredClone(value);
      const component = make(codemodeRenderers, "codemode", { code });
      component.markExecutionStarted();
      component.updateResult(value);
      const callComponent = component.callRendererComponent;
      const resultComponent = component.resultRendererComponent;
      for (const width of [20, 40, 80, 140]) {
        component.setExpanded(false);
        const collapsedRows = rows(component, width);
        component.setExpanded(true);
        const expandedRows = rows(component, width);
        const expanded = expandedRows.join("\n");
        expect(expandedRows.length).toBeGreaterThan(collapsedRows.length);
        // 12 script + 12 call + 20 output rows, plus labels, hints, path, timer and shell.
        expect(expandedRows.length).toBeLessThanOrEqual(65);
        expect(expanded).toContain("OUTPUT_HEAD");
        expect(expanded.replace(/[\s│]/g, "")).toContain("OPAQUE_JSON_TAIL");
        expect(expanded).toContain("FINAL_ERROR");
        expect(expanded).toContain("script");
        expect(expanded).toContain("calls");
        expect(expanded).toContain("output");
        expect(expanded).not.toContain("Script failed");
        expect(
          expandedRows.filter((line) => /│ [✓✗…⊘] child_/.test(line)),
        ).toHaveLength(12);
        if (width >= 80) {
          expect(expanded).toContain("✗ child_17 FAIL_REASON more detail");
          expect(expanded).toContain("… child_18");
          expect(expanded).toContain("⊘ child_19");
          expect(expanded).toContain("28 more calls");
          expect(expanded).toContain("Model calls: $0.40");
          expect(expanded).toContain("/tool-output for raw");
          expect(expanded).toContain("/tmp/codemode-full-output");
          expect(expanded).toContain("Took 1.2s");
          expect(expanded).toContain('"demo":{"result":{"allSettled"');
          expect(expanded).not.toContain("✗ OPAQUE_NOT_A_CALL");
        }
        expect(
          component
            .render(width)
            .every((line: string) => visibleWidth(line) <= width),
        ).toBe(true);
        component.setExpanded(false);
        expect(rows(component, width)).toEqual(collapsedRows);
      }
      for (const width of [0, 1, 2, 3, 4, 8]) {
        component.setExpanded(true);
        expect(
          component
            .render(width)
            .every((line: string) => visibleWidth(line) <= width),
        ).toBe(true);
      }
      expect(component.callRendererComponent).toBe(callComponent);
      expect(component.resultRendererComponent).toBe(resultComponent);
      expect(value).toEqual(before);
    });

    it("reports omitted codemode failures honestly and keeps partial calls bounded", async () => {
      const { load, make, rows, result } = await sdk();
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const calls = Array.from({ length: 30 }, (_, n) => ({
        name: `fail_${n}`,
        status: "error",
        error: `REASON_${n}\n${"more ".repeat(100)}`,
        args: "argument ".repeat(200),
      }));
      const partial = {
        ...result("PARTIAL_OUTPUT_MUST_WAIT"),
        details: { calls },
      };
      const before = structuredClone(partial);
      const component = make(codemodeRenderers, "codemode", {
        code: "await tools.read({});",
      });
      component.markExecutionStarted();
      component.updateResult(partial, true);
      component.setExpanded(true);
      const expandedRows = rows(component, 100);
      const expanded = expandedRows.join("\n");
      expect(expanded).toContain("18 more calls (18 failed)");
      expect(expanded).toContain("✗ fail_0 REASON_0");
      expect(expanded).toContain("✗ fail_11 REASON_11");
      expect(expanded).not.toContain("fail_12");
      expect(expanded).not.toContain("PARTIAL_OUTPUT_MUST_WAIT");
      expect(expanded).toContain("Elapsed");
      expect(expandedRows.length).toBeLessThan(30);
      component.setExpanded(false);
      expect(rows(component, 100).join("\n")).toContain(
        "22 more calls (22 failed)",
      );
      expect(partial).toEqual(before);
      component.updateResult(partial); // settle the native redraw timer
    });

    it("keeps genuine self-shell ownership explicit while sharing native edit chrome", async () => {
      const { load, make, rows, result } = await sdk();
      const own = make({
        renderShell: "self",
        renderCall: () => new Text("own shell", 0, 0),
        renderResult: () => new Text("own output", 0, 0),
      });
      own.updateResult(result());
      expect(rows(own).join("\n")).toContain("own output");
      expect(rows(own).join("\n")).not.toMatch(/[✓│╰]/);
      const { createEditToolDefinition } = await load("core/tools/edit.js");
      const native = createEditToolDefinition(process.cwd());
      expect(native.renderShell).toBeUndefined();
      const component = make(native, "edit", {
        path: "fixture.ts",
        edits: [{ oldText: "before", newText: "after" }],
      });
      const call = component.callRendererComponent;
      component.updateResult({
        ...result(),
        details: { diff: "-1 before\n+1 after", firstChangedLine: 1 },
      });
      expect(component.callRendererComponent).toBe(call);
      expect(rows(component).join("\n")).toContain("before");
      expect(rows(component).join("\n")).toContain("after");
      expect(rows(component).join("\n")).toContain("✓ edit");
      expect(
        rows(component).filter((line) => line.includes("╰────")),
      ).toHaveLength(1);
    });

    it("preserves native asynchronous edit previews without writing the fixture", async () => {
      const { load, make, rows, result, visibleWidth } = await sdk();
      const { mkdtemp, writeFile, readFile, rm } =
        await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const directory = await mkdtemp(join(tmpdir(), "pi-edit-preview-"));
      try {
        const path = join(directory, "fixture.ts");
        await writeFile(path, "const before = 1;\n");
        const { createEditToolDefinition } = await load("core/tools/edit.js");
        const component = make(createEditToolDefinition(directory), "edit", {
          path,
          edits: [{ oldText: "before", newText: "after" }],
        });
        component.setArgsComplete();
        await vi.waitFor(() =>
          expect(rows(component).join("\n")).toContain("after"),
        );
        expect(rows(component).join("\n")).toContain("● edit");
        expect(await readFile(path, "utf8")).toBe("const before = 1;\n");
        const call = component.callRendererComponent;
        const diff = call.preview.diff;
        component.updateResult({
          ...result(),
          details: { diff, firstChangedLine: 1 },
        });
        expect(component.callRendererComponent).toBe(call);
        expect(
          rows(component).filter((line) => line.includes("const after")),
        ).toHaveLength(1);
        expect(
          rows(component).filter((line) => line.includes("╰────")),
        ).toHaveLength(1);
        for (const width of [0, 1, 2, 3, 8, 20]) {
          expect(
            component
              .render(width)
              .every((line: string) => visibleWidth(line) <= width),
          ).toBe(true);
        }
        component.updateResult(result("edit failed", true));
        expect(rows(component).join("\n")).toContain("✕ edit");
        expect(rows(component).join("\n")).toContain("edit failed");
      } finally {
        await rm(directory, { recursive: true });
      }
    });

    it("frames native protocol images within the body width and below the same footer", async () => {
      const { load, make, result, visibleWidth } = await sdk();
      const {
        getCapabilities,
        setCapabilities,
        setCellDimensions,
        getCellDimensions,
        stripTerminalSequences,
      } = await import("@earendil-works/pi-tui");
      const { createReadToolDefinition } = await load("core/tools/read.js");
      const previous = getCapabilities();
      const previousCells = getCellDimensions();
      // A PNG header with known 80x80 geometry; no decoder or external terminal needed.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq6kAAAAASUVORK5CYII=",
        "base64",
      );
      png.writeUInt32BE(80, 16);
      png.writeUInt32BE(80, 20);
      const image = {
        type: "image",
        mimeType: "image/png",
        data: png.toString("base64"),
      };
      try {
        setCellDimensions({ widthPx: 8, heightPx: 16 });
        for (const protocol of ["kitty", "iterm2"] as const) {
          setCapabilities({ ...previous, images: protocol });
          for (const mixed of [false, true]) {
            const component = make(
              createReadToolDefinition(process.cwd()),
              "read",
              { path: "fixture.png" },
            );
            expect(component.render(40, false).join("\n")).not.toContain(
              "╰────",
            );
            const content = mixed
              ? [{ type: "text", text: "image caption" }, image, image]
              : [image];
            component.updateResult({ ...result(""), content }, true);
            const pending = component
              .render(40, false)
              .map(stripTerminalSequences);
            expect(pending.join("\n")).toContain("● read");
            expect(pending.at(-1)?.trim()).toBe("╰────");
            component.updateResult({ ...result(""), content });
            for (const expanded of [false, true]) {
              component.setExpanded(expanded);
              for (const pad of [0, 1, 3]) {
                component.setOutputPad(pad);
                component.setImageWidthCells(12);
                for (const width of [20, 40, 12, 40]) {
                  const lines: string[] = component.render(width, false);
                  const plain = lines.map(stripTerminalSequences);
                  const footer = plain.findIndex((line) =>
                    line.includes("╰────"),
                  );
                  expect(footer).toBe(lines.length - 1);
                  const prefix = " ".repeat(pad) + "│ ";
                  const images = lines.flatMap((line, index) =>
                    line.includes(
                      protocol === "kitty" ? "\x1b_G" : "\x1b]1337;File=",
                    )
                      ? [index]
                      : [],
                  );
                  expect(images).toHaveLength(mixed ? 2 : 1);
                  for (const index of images) {
                    expect(plain[index]).toBe(prefix);
                    expect(index).toBeLessThan(footer);
                    const bodyWidth = width - pad * 2 - 2;
                    const nativeLines: string[] =
                      component.imageComponents[images.indexOf(index)].render(
                        bodyWidth,
                      );
                    // Preserve the complete protocol header, payload and native cursor-up sequence.
                    expect(lines[index]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe(
                      prefix +
                        nativeLines[
                          protocol === "kitty" ? 0 : nativeLines.length - 1
                        ],
                    );
                    const start =
                      protocol === "kitty"
                        ? index
                        : index - nativeLines.length + 1;
                    for (
                      let row = start;
                      row < start + nativeLines.length;
                      row++
                    ) {
                      expect(plain[row]!.trimEnd()).toBe(prefix.trimEnd());
                      expect(row).toBeLessThan(footer);
                    }
                    const columns = Number(
                      lines[index]!.match(
                        protocol === "kitty" ? /,c=(\d+)/ : /;width=(\d+)/,
                      )?.[1],
                    );
                    expect(columns).toBeLessThanOrEqual(
                      Math.min(12, Math.max(1, bodyWidth - 2)),
                    );
                    if (protocol === "kitty")
                      expect(lines[index]).toContain("C=1");
                  }
                  expect(
                    lines.every((line) => visibleWidth(line) <= width),
                  ).toBe(true);
                }
              }
            }
            component.updateResult({ ...result("", true), content });
            expect(
              component
                .render(40, false)
                .map(stripTerminalSequences)
                .join("\n"),
            ).toContain("✕ read");
            for (const width of [0, 1, 2, 3, 4, 8]) {
              expect(
                component
                  .render(width, false)
                  .every((line: string) => visibleWidth(line) <= width),
              ).toBe(true);
            }
            component.setShowImages(false);
            expect(
              component
                .render(40, false)
                .some(
                  (line: string) =>
                    line.includes("\x1b_G") || line.includes("\x1b]1337;File="),
                ),
            ).toBe(false);
            for (const width of [0, 1, 2, 3, 4]) {
              expect(
                component
                  .render(width, false)
                  .every((line: string) => visibleWidth(line) <= width),
              ).toBe(true);
            }
          }
        }
      } finally {
        setCapabilities(previous);
        setCellDimensions(previousCells);
      }
    });

    it("keeps cropped native images and their gutter in the actual fullscreen scroller", async () => {
      const { make, result } = await sdk();
      const {
        getCapabilities,
        setCapabilities,
        getCellDimensions,
        setCellDimensions,
        ScrollView,
        Container,
        Text,
        stripTerminalSequences,
      } = await import("@earendil-works/pi-tui");
      const { TuiAltScreen } = await import(
        new URL(
          "./tui-alt-screen.js",
          import.meta.resolve("@earendil-works/pi-tui"),
        ).href
      );
      const { renderLayoutFrame } = await import(
        new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui"))
          .href
      );
      const previous = getCapabilities();
      const cells = getCellDimensions();
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq6kAAAAASUVORK5CYII=",
        "base64",
      );
      png.writeUInt32BE(80, 16);
      png.writeUInt32BE(80, 20);
      try {
        setCapabilities({ ...previous, images: "kitty" });
        setCellDimensions({ widthPx: 8, heightPx: 16 });
        for (const width of [40, 20, 40])
          for (const pad of [1, 3]) {
            const row = make({
              renderResult: () => ({ render: () => [], invalidate() {} }),
            });
            row.setOutputPad(pad);
            row.setImageWidthCells(12);
            row.updateResult({
              ...result(""),
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: png.toString("base64"),
                },
              ],
            });
            const lines: string[] = row.render(width, false);
            const anchor = lines.findIndex((line) => line.includes("\x1b_G"));
            const imageRows = Number(lines[anchor]!.match(/,r=(\d+)/)?.[1]);
            expect(imageRows).toBeGreaterThan(3);
            const transcript = new Container();
            transcript.addChild(row);
            transcript.addChild(new Text("tail\ntail\ntail\ntail", 0, 0));
            const scroll = new ScrollView(transcript, {
              follow: "none",
              scrollbar: "hidden",
              primary: true,
            });
            let raw = "";
            const terminal = {
              columns: width,
              rows: 4,
              write(data: string) {
                raw += data;
              },
              hideCursor() {},
              showCursor() {},
            };
            const tui = new TuiAltScreen(terminal, false);
            tui.stopped = false;
            tui.altScreenActive = true;
            tui.imageProtocol = "kitty";
            tui.layoutRoot = scroll;
            tui.doRender();
            for (const hidden of [0, 1, 2, 3]) {
              scroll.scrollTo(anchor + hidden);
              tui.doRender();
              const screen: string[] = tui.currentLayout.lines;
              const command = screen.find((line) => line.includes("\x1b_G"));
              expect(command, `anchor hidden by ${hidden} rows`).toBeDefined();
              const visible = Math.min(4, imageRows - hidden);
              expect(command).toContain(`r=${visible}`);
              if (hidden > 0)
                expect(command).toContain(
                  `y=${Math.floor((80 * hidden) / imageRows)}`,
                );
              expect(stripTerminalSequences(screen[0]!).trim()).toBe("│");
              expect(
                screen
                  .slice(0, visible)
                  .every((line) => stripTerminalSequences(line).trim() === "│"),
              ).toBe(true);
              if (visible < 4)
                expect(stripTerminalSequences(screen[visible]!).trim()).toBe(
                  "╰────",
                );
              expect(raw).toContain("\x1b_G");
            }
            // A gutter-looking text row outside the protocol-declared span is not an image reservation.
            const gutter = " ".repeat(pad) + "│ ";
            const textLines = [
              ...lines.slice(0, -1),
              gutter,
              gutter,
              gutter,
              "end",
              "tail",
            ];
            const unrelated = new ScrollView(
              { render: () => textLines, invalidate() {} },
              { follow: "none", scrollbar: "hidden" },
            );
            renderLayoutFrame(unrelated, width, 3, () => {});
            unrelated.scrollTo(lines.length + 1);
            expect(
              renderLayoutFrame(unrelated, width, 3, () => {}).lines.some(
                (line: string) => line.includes("\x1b_G"),
              ),
            ).toBe(false);
            const unframedLines = [
              ...row.imageComponents[0].render(width),
              "tail",
              "tail",
              "tail",
            ];
            const unframed = new ScrollView(
              { render: () => unframedLines, invalidate() {} },
              { follow: "none", scrollbar: "hidden" },
            );
            renderLayoutFrame(unframed, width, 3, () => {});
            unframed.scrollTo(2);
            expect(
              renderLayoutFrame(unframed, width, 3, () => {}).lines[0],
            ).toContain("\x1b_G");
            // Real text inside a malformed reservation must remain a discovery boundary.
            const interrupted = [...lines];
            interrupted[anchor + 1] = "not image content";
            const broken = new ScrollView(
              { render: () => interrupted, invalidate() {} },
              { follow: "none", scrollbar: "hidden" },
            );
            renderLayoutFrame(broken, width, 3, () => {});
            broken.scrollTo(anchor + 2);
            expect(
              renderLayoutFrame(broken, width, 3, () => {}).lines.some(
                (line: string) => line.includes("\x1b_G"),
              ),
            ).toBe(false);
          }
      } finally {
        setCapabilities(previous);
        setCellDimensions(cells);
      }
    });

    it("reuses native image components and honors showImages", async () => {
      const { make, rows, result } = await sdk();
      const { getCapabilities, setCapabilities } =
        await import("@earendil-works/pi-tui");
      const previous = getCapabilities();
      try {
        setCapabilities({ ...previous, images: "kitty" });
        const image = {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq6kAAAAASUVORK5CYII=",
        };
        const component = make();
        component.updateResult({ ...result(""), content: [image] });
        const first = component.imageComponents[0];
        expect(first).toBeDefined();
        component.setExpanded(true);
        expect(component.imageComponents[0]).toBe(first);
        component.setOutputPad(3);
        expect(component.imageComponents[0]).toBe(first);
        component.setShowImages(false);
        expect(component.imageComponents).toHaveLength(0);
        expect(rows(component).join("\n")).toContain("image/png");
      } finally {
        setCapabilities(previous);
      }
    });

    it("composes local content renderers without duplicate lifecycle, padding or footer", async () => {
      const { make, rows, result, visibleWidth } = await sdk();
      const { createBashTool } = await import("../../extensions/bash/index.js");
      const { createReadTool } = await import("../../extensions/read/index.js");
      const github = await import("../../extensions/github/index.js");
      const { createWebSearchTool } =
        await import("../../extensions/web-search/index.js");
      const { createReadWebPageTool } =
        await import("../../extensions/read-web-page/index.js");
      const { createSkillTool } =
        await import("../../extensions/skill/index.js");
      const tools = [
        createBashTool(),
        createReadTool(),
        createWebSearchTool(),
        createReadWebPageTool(),
        createSkillTool(),
        github.createReadGithubTool(),
        github.createSearchGithubTool(),
        github.createListDirectoryGithubTool(),
        github.createListRepositoriesTool(),
        github.createGlobGithubTool(),
        github.createCommitSearchTool(),
        github.createDiffTool(),
      ];
      const args = {
        cmd: "echo first && echo second",
        path: "fixture.txt",
        read_range: [3, 5],
        repository: "https://github.com/owner/repo",
        name: "fixture-skill",
        objective: "fixture objective",
        url: "https://example.com",
        base: "before",
        head: "after",
      };
      for (const tool of tools) {
        expect(tool).not.toHaveProperty("renderShell");
        const component = make(tool, tool.name, args);
        expect(rows(component).join("\n").match(/●/g)).toHaveLength(1);
        for (const partial of [true, false]) {
          component.updateResult(result("fixture output"), partial);
          const text = rows(component).join("\n");
          expect(text.match(/╰────/g)).toHaveLength(1);
          expect(text.match(partial ? /●/g : /✓/g)).toHaveLength(1);
        }
        component.setExpanded(true);
        expect(rows(component).join("\n")).toContain("fixture output");
        component.updateResult(result("fixture failure", true));
        expect(rows(component).join("\n").match(/✕/g)).toHaveLength(1);
        expect(rows(component).join("\n")).toContain("fixture failure");
        component.setOutputPad(3);
        expect(rows(component).some((line) => line.startsWith("   ✕"))).toBe(
          true,
        );
        for (const width of [0, 1, 2, 3, 8, 20]) {
          expect(
            component
              .render(width)
              .every((line: string) => visibleWidth(line) <= width),
          ).toBe(true);
        }
        component.updateResult(result(""));
        expect(
          rows(component)
            .join("\n")
            .match(/╰────/g),
        ).toHaveLength(1);
      }
    });

    it("pulses only rendered pending rows and stops on settlement or detachment", async () => {
      const { make, result } = await sdk();
      vi.useFakeTimers();
      try {
        const component = make();
        const first = component.render(80).join("\n");
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(320);
        expect(vi.getTimerCount()).toBe(0);
        expect(component.render(80).join("\n")).not.toBe(first);
        expect(vi.getTimerCount()).toBe(1);
        component.updateResult(result());
        expect(vi.getTimerCount()).toBe(0);
        component.render(80);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("installed HTML shared shell", () => {
    it("completes settled renderer arguments without starting native edit file previews", async () => {
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const { pathToFileURL } = await import("node:url");
      const load = (path: string) =>
        import(pathToFileURL(`${getPackageDir()}/dist/${path}`).href);
      const { initTheme, theme } = await load(
        "modes/interactive/theme/theme.js",
      );
      initTheme("dark", false);
      const { createToolHtmlRenderer } = await load(
        "core/export-html/tool-renderer.js",
      );
      const { createEditToolDefinition } = await load("core/tools/edit.js");
      const contexts: Array<{
        kind: string;
        expanded: boolean;
        complete: boolean;
      }> = [];
      const definition = {
        renderCall(_args: unknown, _theme: unknown, context: any) {
          if (!context.isPartial)
            contexts.push({
              kind: "call",
              expanded: context.expanded,
              complete: context.argsComplete,
            });
          return new Text(
            context.argsComplete ? "ready call" : "loading call",
            0,
            0,
          );
        },
        renderResult(
          _result: unknown,
          _options: unknown,
          _theme: unknown,
          context: any,
        ) {
          if (!context.isPartial)
            contexts.push({
              kind: "result",
              expanded: context.expanded,
              complete: context.argsComplete,
            });
          return new Text(
            context.argsComplete ? "ready result" : "loading result",
            0,
            0,
          );
        },
      };
      const renderer = createToolHtmlRenderer({
        getToolRenderers: () => definition,
        theme,
        cwd: process.cwd(),
      });
      renderer.renderCall("complete", "custom", {});
      const rendered = renderer.renderResult(
        "complete",
        "custom",
        [{ type: "text", text: "out" }],
        undefined,
        false,
      );
      for (const html of [
        rendered.collapsed ?? rendered.expanded,
        rendered.expanded,
      ]) {
        expect(html).toContain("ready call");
        expect(html).toContain("ready result");
        expect(html).not.toContain("loading");
      }
      expect(contexts.every((context) => context.complete)).toBe(true);
      for (const kind of ["call", "result"])
        for (const expanded of [false, true]) {
          expect(
            contexts
              .filter(
                (context) =>
                  context.kind === kind && context.expanded === expanded,
              )
              .at(-1)?.complete,
          ).toBe(true);
        }
      const native = createEditToolDefinition(process.cwd());
      const calls: any[] = [];
      const edit = {
        ...native,
        renderCall(args: any, currentTheme: any, context: any) {
          const component = native.renderCall(args, currentTheme, context);
          calls.push(component);
          return component;
        },
      };
      const exporter = createToolHtmlRenderer({
        getToolRenderers: () => edit,
        theme,
        cwd: process.cwd(),
      });
      const fs = (await import("node:fs/promises")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const access = vi.spyOn(fs, "access");
      const read = vi.spyOn(fs, "readFile");
      syncBuiltinESMExports();
      vi.useFakeTimers();
      try {
        for (const isError of [false, true]) {
          const id = `edit-${isError}`;
          exporter.renderCall(id, "edit", {
            path: "/nonexistent/pi-export-fixture.ts",
            edits: [{ oldText: "before", newText: "after" }],
          });
          const result = exporter.renderResult(
            id,
            "edit",
            [{ type: "text", text: isError ? "edit failed" : "edited" }],
            isError
              ? undefined
              : { diff: "-1 before\n+1 after", firstChangedLine: 1 },
            isError,
          );
          expect(result.expanded).toContain(isError ? "edit failed" : "after");
          expect(calls.at(-1).previewPending).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        }
        await Promise.resolve();
        expect(calls.every((component) => !component.previewPending)).toBe(
          true,
        );
        expect(access).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        access.mockRestore();
        read.mockRestore();
        syncBuiltinESMExports();
      }
    });

    it("exports native, local, fallback and self-owned rows without timers or duplicate headers", async () => {
      const { getPackageDir, SessionManager } =
        await import("@earendil-works/pi-coding-agent");
      const { pathToFileURL } = await import("node:url");
      const { createContext, runInContext } = await import("node:vm");
      const { parseHTML } = await import("linkedom");
      const { mkdtemp, readFile, writeFile, rm } =
        await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const load = (path: string) =>
        import(pathToFileURL(`${getPackageDir()}/dist/${path}`).href);
      const { initTheme, theme } = await load(
        "modes/interactive/theme/theme.js",
      );
      initTheme("dark", false);
      const { createToolHtmlRenderer } = await load(
        "core/export-html/tool-renderer.js",
      );
      const { exportSessionToHtml } = await load("core/export-html/index.js");
      const { createAllToolDefinitions } = await load("core/tools/index.js");
      const { codemodeRenderers } = await load(
        "extensions/codemode/renderer.js",
      );
      const { createBashTool } = await import("../../extensions/bash/index.js");
      const directory = await mkdtemp(join(tmpdir(), "pi-html-shell-"));
      try {
        let reused = 0;
        let finalCalls = 0;
        const states = new Set();
        const themes = new Set();
        const custom = {
          renderCall(args: any, currentTheme: any, context: any) {
            states.add(context.state);
            themes.add(currentTheme);
            if (context.lastComponent) reused++;
            if (!context.isPartial) finalCalls++;
            return (
              context.lastComponent ?? new Text(`custom ${args.label}`, 0, 0)
            );
          },
          renderResult(_result: any, options: any, _theme: any, context: any) {
            states.add(context.state);
            return new Text(
              options.expanded ? "expanded detail" : "compact detail",
              0,
              0,
            );
          },
        };
        const native = createAllToolDefinitions(directory);
        const definitions: Record<string, any> = {
          ...native,
          custom,
          local_bash: createBashTool(),
          codemode: codemodeRenderers,
          self: {
            renderShell: "self",
            renderCall: () => new Text("OWN HEADER", 0, 0),
            renderResult: () => new Text("OWN RESULT", 0, 0),
          },
          broken: {
            renderCall() {
              throw Error("broken");
            },
            renderResult() {
              throw Error("broken");
            },
          },
          controls: {
            renderCall: () =>
              new Text(
                "\x1b]8;;https://example.com\x07linked\x1b]8;;\x07",
                0,
                0,
              ),
          },
        };
        const scenarios: Array<[string, any, boolean?, string?]> = [
          ["read", { path: "fixture.ts" }],
          ["bash", { command: "echo fixture" }],
          ["write", { path: "fixture.ts", content: "const fixture = 1;" }],
          [
            "edit",
            {
              path: "fixture.ts",
              edits: [{ oldText: "before", newText: "after" }],
            },
          ],
          ["ls", { path: "." }],
          ["custom", { label: "success" }],
          ["custom", { label: "error" }, true],
          ["unknown", { query: "fallback" }],
          ["self", {}],
          ["broken", {}],
          ["codemode", { code: 'console.log("fixture")' }],
          ["read", { path: "image.png" }, false, "image"],
          ["custom", { label: "pending" }, false, "pending"],
          ["local_bash", { cmd: "echo fixture" }],
          ["controls", {}],
          ["read", { path: "missing.ts" }, true],
          ["bash", { command: "false" }, true],
          ["write", { path: "missing.ts", content: "fixture" }, true],
          [
            "edit",
            {
              path: "missing.ts",
              edits: [{ oldText: "before", newText: "after" }],
            },
            true,
          ],
          ["ls", { path: "missing" }, true],
          ["broken", {}, true],
        ];
        const entries: any[] = [];
        let parentId: string | null = null;
        for (const [
          index,
          [name, args, isError = false, mode],
        ] of scenarios.entries()) {
          const id = `call-${index}`;
          const entryId = `assistant-${id}`;
          entries.push({
            type: "message",
            id: entryId,
            parentId,
            timestamp: new Date(0).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id, name, arguments: args }],
              api: "anthropic-messages",
              provider: "fixture",
              model: "fixture",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "toolUse",
              timestamp: 0,
            },
          });
          parentId = entryId;
          if (mode === "pending") continue;
          const content =
            mode === "image"
              ? [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]
              : [
                  {
                    type: "text",
                    text: isError ? "fixture failed" : "fixture output",
                  },
                ];
          const resultId = `result-${id}`;
          entries.push({
            type: "message",
            id: resultId,
            parentId,
            timestamp: new Date(0).toISOString(),
            message: {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              isError,
              durationMs: 1234,
              details:
                name === "edit"
                  ? { diff: "-1 before\n+1 after", firstChangedLine: 1 }
                  : name === "codemode"
                    ? {
                        calls: [
                          {
                            name: "read",
                            args: "fixture",
                            status: "ok",
                            durationMs: 4,
                          },
                        ],
                      }
                    : undefined,
              timestamp: 0,
            },
          });
          parentId = resultId;
        }
        const sessionFile = join(directory, "session.jsonl");
        await writeFile(
          sessionFile,
          [
            {
              type: "session",
              version: 3,
              id: "html-shell-fixture",
              timestamp: new Date(0).toISOString(),
              cwd: directory,
            },
            ...entries,
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );
        const renderer = createToolHtmlRenderer({
          getToolRenderers: (name: string) => definitions[name],
          theme,
          cwd: directory,
        });
        const outputPath = join(directory, "export.html");
        const timeout = vi.spyOn(globalThis, "setTimeout");
        const interval = vi.spyOn(globalThis, "setInterval");
        try {
          await exportSessionToHtml(
            SessionManager.open(sessionFile),
            undefined,
            { outputPath, toolRenderer: renderer, themeName: "dark" },
          );
          expect(timeout).not.toHaveBeenCalled();
          expect(interval).not.toHaveBeenCalled();
        } finally {
          timeout.mockRestore();
          interval.mockRestore();
        }
        const { window, document } = parseHTML(
          await readFile(outputPath, "utf8"),
        );
        window.HTMLElement.prototype.scrollIntoView = () => {};
        window.matchMedia = () =>
          ({
            matches: false,
            addEventListener() {},
            removeEventListener() {},
          }) as any;
        window.location = new URL("https://fixture.invalid/") as any;
        // Execute only our generated export scripts. This checks DOM composition,
        // not browser event-handler compilation or layout; clicks need a browser.
        const context = createContext({
          window,
          document,
          console,
          TextDecoder,
          TextEncoder,
          URL,
          URLSearchParams,
          atob,
          btoa,
          setTimeout,
          clearTimeout,
          localStorage: { getItem: () => null, setItem() {} },
          getComputedStyle: () => ({ getPropertyValue: () => "" }),
        });
        for (const script of document.querySelectorAll("script:not([src])")) {
          if (script.id !== "session-data")
            runInContext(script.textContent ?? "", context);
        }
        const data = JSON.parse(
          Buffer.from(
            document.getElementById("session-data").textContent,
            "base64",
          ).toString(),
        );
        const plain = (html: string) => {
          const fragment = document.createElement("div");
          fragment.innerHTML = html;
          return fragment.textContent;
        };
        for (const [index, [name, , isError, mode]] of scenarios.entries()) {
          const rendered = data.renderedTools[`call-${index}`];
          expect(rendered, name).toBeDefined();
          const text = plain(rendered.resultHtmlExpanded ?? rendered.callHtml);
          if (name === "self") {
            expect(text).toContain("OWN HEADER");
            expect(text).toContain("OWN RESULT");
            expect(text).not.toMatch(/[✓╰│]/);
          } else if (mode === "pending") {
            expect(text).toContain("● custom pending");
            expect(text).not.toContain("╰────");
          } else {
            expect(text, name).toContain(isError ? "✕" : "✓");
            expect(text.match(/╰────/g), name).toHaveLength(1);
            expect(rendered.callHtml, name).toBe("");
            expect(
              document.querySelector(`#tool-call-call-${index} > .tool-header`),
              name,
            ).toBeNull();
          }
          expect(text).not.toContain("\x1b");
          expect(
            document.getElementById(`tool-call-call-${index}`),
            name,
          ).not.toBeNull();
        }
        expect(
          plain(data.renderedTools["call-5"].resultHtmlCollapsed),
        ).toContain("compact detail");
        expect(
          plain(data.renderedTools["call-5"].resultHtmlExpanded),
        ).toContain("expanded detail");
        expect(
          plain(data.renderedTools["call-10"].resultHtmlExpanded),
        ).toContain("Took 1.2s");
        expect(
          plain(data.renderedTools["call-10"].resultHtmlExpanded),
        ).toContain("✓ read fixture 4ms");
        const expandable = document.querySelector(
          "#tool-call-call-5 .tool-output.expandable",
        );
        expect(expandable.classList.contains("expanded")).toBe(false);
        expect(
          expandable.querySelector(".output-preview").textContent,
        ).toContain("compact detail");
        expect(expandable.querySelector(".output-full").textContent).toContain(
          "expanded detail",
        );
        expect(document.querySelectorAll(".tool-image")).toHaveLength(1);
        expect(document.querySelector(".tool-image").src).toMatch(
          /^data:image\/png;base64,/,
        );
        expect(reused).toBeGreaterThan(0);
        expect(finalCalls).toBeGreaterThan(0);
        expect(states.size).toBe(3);
        expect(themes).toEqual(new Set([theme]));
        // A resolver overriding a template-native name must replace its native template too.
        const override = createToolHtmlRenderer({
          getToolRenderers: () => custom,
          theme,
          cwd: directory,
        });
        override.renderCall("override", "write", { label: "local override" });
        const overridden = override.renderResult(
          "override",
          "write",
          [{ type: "text", text: "out" }],
          undefined,
          true,
        );
        expect(plain(overridden.expanded)).toContain("✕ custom local override");
        expect(overridden.call).toBe("");
      } finally {
        await rm(directory, { recursive: true });
      }
    });
  });

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
      const result = truncateToWidth("hello world", 8, "…");
      expect(result).toContain("…");
      expect(visibleWidth(result.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(8);
    });

    it("preserves ANSI codes in truncated output", () => {
      const input = "\x1b[31mhello world\x1b[0m";
      const result = truncateToWidth(input, 8, "…");
      expect(result).toContain("\x1b[31m");
      expect(result).toContain("\x1b[0m");
      expect(result).toContain("…");
    });

    it("handles text shorter than ellipsis", () => {
      expect(truncateToWidth("hi", 1, "…").replace(/\x1b\[[0-9;]*m/g, "")).toBe(
        "…",
      );
    });
  });

  describe("chromeWidth", () => {
    it("reserves no outer chrome for unguttered content", () => {
      expect(chromeWidth(0)).toBe(0);
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

  describe("formatSectionsWindowed", () => {
    it("renders single section with header", () => {
      const sections: ContentSection[] = [
        {
          header: "Test",
          blocks: [{ lines: [{ text: "hello" }] }],
        },
      ];
      const result = formatSectionsWindowed(sections, {}, undefined, 80);
      expect(result).toContain("Test");
      expect(result).toContain("hello");
    });

    it("renders gutter with line numbers", () => {
      const sections: ContentSection[] = [
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
      const result = formatSectionsWindowed(sections, {}, undefined, 80);
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("first");
      expect(result).toContain("second");
    });

    it("respects maxSections option", () => {
      const sections: ContentSection[] = [
        { header: "A", blocks: [{ lines: [{ text: "a" }] }] },
        { header: "B", blocks: [{ lines: [{ text: "b" }] }] },
        { header: "C", blocks: [{ lines: [{ text: "c" }] }] },
      ];
      const result = formatSectionsWindowed(
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

    it("preserves labels, gutters, links and excerpts without an outer frame", () => {
      const sections: ContentSection[] = [
        {
          header: "file.ts",
          blocks: [
            {
              lines: Array.from({ length: 20 }, (_, index) => ({
                gutter: String(index + 1),
                text: osc8Link("https://example.com", `line ${index + 1} 界界`),
                highlight: true,
              })),
            },
          ],
        },
      ];
      const opts = {
        excerpts: [
          { focus: "head" as const, context: 2 },
          { focus: "tail" as const, context: 2 },
        ],
      };
      const text = formatSectionsWindowed(sections, opts, undefined, 80);
      expect(text).toContain("file.ts");
      expect(text).toContain(" 1 ");
      expect(text).toContain("20 ");
      expect(text).toContain("more lines");
      expect(text).toContain("\x1b]8;;https://example.com\x07");
      expect(text).not.toMatch(/[╭╰]/);
      expect(
        formatSectionsWindowed(
          [textSection(undefined, "abcdefgh")],
          {},
          undefined,
          8,
        ).replace(/\x1b\[[0-9;]*m/g, ""),
      ).toBe("abcdefgh");
      for (const width of [1, 2, 3, 8, 20]) {
        expect(
          formatSectionsWindowed(sections, opts, ["notice"], width)
            .split("\n")
            .every((line) => nativeVisibleWidth(line) <= width),
        ).toBe(true);
      }
    });

    it("appends notices", () => {
      const sections: ContentSection[] = [
        { header: "Test", blocks: [{ lines: [{ text: "content" }] }] },
      ];
      const result = formatSectionsWindowed(
        sections,
        {},
        ["Notice 1", "Notice 2"],
        80,
      );
      expect(result).toContain("[Notice 1. Notice 2]");
    });
  });
}
