/**
 * editor extension — composable custom editor with box-drawing borders and label slots.
 *
 * replaces pi's default editor with ╭╮╰╯ borders. other extensions can inject
 * labels into the top/bottom border lines via the shared EventBus:
 *
 *   pi.events.emit("editor:set-label", { key: "status", text: "↳ ready", position: "top", align: "left" })
 *   pi.events.emit("editor:remove-label", { key: "status" })
 *
 * multiple labels on the same border are separated by " · ". left labels fill
 * from the left edge, right labels from the right edge.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  Theme,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type {
  TUI,
  EditorTheme,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boxBorderLR, boxRow } from "@bds_pi/box-chrome";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Label {
  key: string;
  text: string;
  position: "top" | "bottom";
  align: "left" | "right";
}

interface SetLabelPayload {
  key: string;
  text: string;
  position?: "top" | "bottom";
  align?: "left" | "right";
}

interface RemoveLabelPayload {
  key: string;
}

const SEPARATOR = " · ";
const HORIZONTAL = "─";

function translateFramedEditorMouseEvent(
  event: TuiMouseEvent,
): TuiMouseEvent | undefined {
  const innerWidth = event.width - 2;
  if (innerWidth < 4) return event;

  const x = event.x - 1;
  if (x < 0 || x >= innerWidth) return undefined;
  return { ...event, x, width: innerWidth };
}

class LabeledEditor extends CustomEditor {
  private labels: Map<string, Label> = new Map();
  private appTheme: Theme;
  private borderCache: Record<
    "top" | "bottom",
    { key: string; line: string } | null
  > = {
    top: null,
    bottom: null,
  };

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    appTheme: Theme,
  ) {
    super(tui, editorTheme, keybindings);
    this.appTheme = appTheme;
  }

  /** always-dim color for box chrome (corners, lines, rails) */
  private dim(str: string): string {
    return this.appTheme.fg("dim", str);
  }

  setLabel(
    key: string,
    text: string,
    position: "top" | "bottom" = "top",
    align: "left" | "right" = "left",
  ): void {
    const current = this.labels.get(key);
    if (
      current?.text === text &&
      current.position === position &&
      current.align === align
    )
      return;
    this.labels.set(key, { key, text, position, align });
    this.invalidate();
    this.tui.requestRender();
  }

  removeLabel(key: string): void {
    if (!this.labels.delete(key)) return;
    this.invalidate();
    this.tui.requestRender();
  }

  override invalidate(): void {
    this.borderCache.top = null;
    this.borderCache.bottom = null;
    super.invalidate();
  }

  private getLabelsFor(
    position: "top" | "bottom",
    align: "left" | "right",
  ): string {
    const matching = [...this.labels.values()].filter(
      (l) => l.position === position && l.align === align,
    );
    if (matching.length === 0) return "";
    return matching.map((l) => l.text).join(SEPARATOR);
  }

  private extractScrollIndicator(originalLine: string): string {
    if (!originalLine.includes("↑") && !originalLine.includes("↓")) return "";
    const match = originalLine.match(/[↑↓]\s+\d+\s+more/);
    return match ? match[0] : "";
  }

  /**
   * build a border line like: ╭─ left label ─────── right label ─╮
   *
   * inherits scroll indicator text from the original border line if present.
   * delegates chrome layout to boxBorderLR; caching stays here.
   */
  private buildBorderLine(
    outerWidth: number,
    corner: { left: string; right: string },
    position: "top" | "bottom",
    originalLine: string,
  ): string {
    const leftText = this.getLabelsFor(position, "left");
    const rightText = this.getLabelsFor(position, "right");
    const scrollIndicator = this.extractScrollIndicator(originalLine);

    const rightParts = [rightText, scrollIndicator].filter(Boolean);
    const rightCombined = rightParts.join(SEPARATOR);
    const cacheKey = `${outerWidth}|${position}|${leftText}|${rightCombined}`;
    const cached = this.borderCache[position];
    if (cached?.key === cacheKey) return cached.line;

    const chrome = { dim: (s: string) => this.dim(s) };
    const innerWidth = outerWidth - 2; // strip corner characters

    const line = boxBorderLR({
      corner,
      style: chrome,
      innerWidth,
      left: leftText
        ? { text: leftText, width: visibleWidth(leftText) }
        : undefined,
      right: rightCombined
        ? { text: rightCombined, width: visibleWidth(rightCombined) }
        : undefined,
    });

    this.borderCache[position] = { key: cacheKey, line };
    return line;
  }

  /**
   * find the bottom border index in the lines array from super.render().
   * the bottom border is a full-width line of ─ characters (possibly with a scroll indicator).
   * autocomplete lines appear after it and contain mixed content (not all ─).
   *
   * strategy: walk backward from the end, looking for a line whose stripped content
   * is predominantly ─ characters. the first such line (from the end) is the bottom border.
   */
  private findBottomBorderIndex(lines: string[]): number {
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i];
      if (!line) continue;
      const stripped = line
        .replace(/\x1b\[[0-9;]*[mGKHJ]/g, "")
        .replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\]8;;[^\x07]*\x07/g, "");
      if (stripped.length > 0 && stripped[0] === HORIZONTAL) {
        return i;
      }
    }
    return lines.length - 1;
  }

  override render(width: number): string[] {
    // render the base editor at (width - 2) to leave room for │ side rails
    const innerWidth = width - 2;
    if (innerWidth < 4) return super.render(width); // too narrow, bail

    const lines = super.render(innerWidth);
    if (lines.length < 2) return lines;

    const bottomIdx = this.findBottomBorderIndex(lines);
    const result: string[] = [];

    const chrome = { dim: (s: string) => this.dim(s) };

    // top border — replace line 0
    result.push(
      this.buildBorderLine(width, { left: "╭", right: "╮" }, "top", lines[0]!),
    );

    // content lines — wrap with dim │ side rails
    for (let i = 1; i < bottomIdx; i++) {
      result.push(
        boxRow({ variant: "closed", style: chrome, inner: lines[i]! }),
      );
    }

    // bottom border
    result.push(
      this.buildBorderLine(
        width,
        { left: "╰", right: "╯" },
        "bottom",
        lines[bottomIdx]!,
      ),
    );

    // autocomplete lines (if any) — pass through, offset to align with inner content
    for (let i = bottomIdx + 1; i < lines.length; i++) {
      result.push(" " + lines[i] + " ");
    }

    return result;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const translated = translateFramedEditorMouseEvent(event);
    return translated ? super.handleMouse(translated) : undefined;
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function shortenPath(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

/**
 * estimate context tokens from session entries using chars/4 heuristic.
 * fallback when provider hasn't reported usage yet (e.g., after compaction).
 */
function estimateContextFromEntries(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    switch (entry.type) {
      case "message":
        total += estimateTokens(entry.message as any);
        break;
      case "custom_message": {
        const content = entry.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("");
        total += Math.ceil(text.length / 4);
        break;
      }
      case "branch_summary":
        // branch summaries have a `summary` field
        if (entry.summary) {
          total += Math.ceil(entry.summary.length / 4);
        }
        break;
      case "compaction":
        // compaction entries also have a `summary` field
        if (entry.summary) {
          total += Math.ceil(entry.summary.length / 4);
        }
        break;
    }
  }
  return total;
}

function updateStatsLabels(
  editor: LabeledEditor | null,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!editor) return;

  const branch = ctx.sessionManager.getBranch();

  // top-left: context usage
  const usage = ctx.getContextUsage();
  const model = ctx.model;

  // use provider-reported usage if available and meaningful, otherwise estimate from entries
  if (usage?.percent != null && usage.tokens != null && usage.tokens > 0) {
    editor.setLabel(
      "stats",
      `${Math.round(usage.percent)}% of ${formatTokens(usage.contextWindow)}`,
      "top",
      "left",
    );
  } else if (model?.contextWindow) {
    // fallback: estimate tokens from session entries
    const estimatedTokens = estimateContextFromEntries(branch);
    const percent = (estimatedTokens / model.contextWindow) * 100;
    editor.setLabel(
      "stats",
      `~${Math.round(percent)}% of ${formatTokens(model.contextWindow)}`,
      "top",
      "left",
    );
  }

  // top-right: effort is the only model setting that changes during a session
  const thinkingLevel = pi.getThinkingLevel();
  if (thinkingLevel && thinkingLevel !== "off") {
    editor.setLabel("effort", thinkingLevel, "top", "right");
  } else {
    editor.removeLabel("effort");
  }
}

async function getGitDiffStats(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
      cwd,
      timeout: 3000,
    });
    const out = stdout.trim();
    if (!out) return "";
    // last line is summary: " N files changed, N insertions(+), N deletions(-)"
    const lines = out.split("\n");
    const summary = lines[lines.length - 1];
    if (!summary) return "";
    const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
    const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
    const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);
    if (!filesMatch) return "";
    const parts = [`${filesMatch[1]} files changed`];
    if (insMatch) parts.push(`+${insMatch[1]}`);
    if (delMatch) parts.push(`-${delMatch[1]}`);
    return parts.join(" ");
  } catch {
    return "";
  }
}

function editorExtension(pi: ExtensionAPI): void {
  let editor: LabeledEditor | null = null;
  let gitBranch: string | null = null;
  let branchUnsub: (() => void) | null = null;

  const updateGitLabel = async (cwd: string): Promise<void> => {
    const diffStats = await getGitDiffStats(cwd);
    if (diffStats) {
      editor?.setLabel("git-changes", diffStats, "bottom", "left");
    } else {
      editor?.removeLabel("git-changes");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // The border carries the durable state; transient activity adds noise and
    // reserves a row even when there is nothing useful to show.
    ctx.ui.setWorkingVisible(false);

    // replace editor with labeled box-drawing version
    ctx.ui.setEditorComponent(
      (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
        editor = new LabeledEditor(tui, editorTheme, keybindings, ctx.ui.theme);
        return editor;
      },
    );

    // replace footer with empty component — we show its data in the borders
    ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData) => {
      gitBranch = footerData.getGitBranch();
      branchUnsub = footerData.onBranchChange(() => {
        gitBranch = footerData.getGitBranch();
        updateBottomLabel();
        tui.requestRender();
      });

      updateBottomLabel();

      return {
        dispose: () => {
          branchUnsub?.();
          branchUnsub = null;
        },
        invalidate() {},
        render(_width: number): string[] {
          return [];
        },
      };
    });

    // set initial bottom label with cwd
    function updateBottomLabel() {
      if (!editor) return;
      const cwd = shortenPath(ctx.cwd);
      const branchText = gitBranch ? `(${gitBranch})` : "";
      editor.setLabel("cwd", `${cwd} ${branchText}`.trim(), "bottom", "right");
    }

    updateBottomLabel();
    updateStatsLabels(editor!, pi, ctx);
    await updateGitLabel(ctx.cwd);
  });

  pi.on("agent_end", async (_event, ctx) => {
    updateStatsLabels(editor, pi, ctx);
    await updateGitLabel(ctx.cwd);
  });

  // Provider usage becomes authoritative at message_end. Refresh there rather
  // than waiting for the whole tool/assistant loop to settle at agent_end.
  pi.on("message_end", async (_event, ctx) => {
    updateStatsLabels(editor, pi, ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    updateStatsLabels(editor, pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateStatsLabels(editor, pi, ctx);
  });

  pi.events.on("editor:set-label", (data: unknown) => {
    const payload = data as SetLabelPayload;
    if (!payload.key || !payload.text) return;
    editor?.setLabel(
      payload.key,
      payload.text,
      payload.position ?? "top",
      payload.align ?? "left",
    );
  });

  pi.events.on("editor:remove-label", (data: unknown) => {
    const payload = data as RemoveLabelPayload;
    if (!payload.key) return;
    editor?.removeLabel(payload.key);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatsLabels(editor, pi, ctx);
  });

  pi.on("thinking_level_select", async (event) => {
    if (event.level === "off") {
      editor?.removeLabel("effort");
    } else {
      editor?.setLabel("effort", event.level, "top", "right");
    }
  });

}

export default editorExtension;

// Export for testing
export {
  formatTokens,
  shortenPath,
  estimateContextFromEntries,
  updateStatsLabels,
  translateFramedEditorMouseEvent,
  LabeledEditor,
};

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  // --- LabeledEditor border tests ---
  // Testing buildBorderLine directly avoids mocking the entire CustomEditor

  describe("LabeledEditor border building", () => {
    function createPlainEditor(): LabeledEditor {
      return new LabeledEditor(
        { requestRender() {} } as any,
        {} as any,
        {} as any,
        {
          fg: (_: string, t: string) => t,
          bg: (_: string, t: string) => t,
        } as any,
      );
    }

    it("setLabel/removeLabel manages labels", () => {
      const editor = createPlainEditor();

      editor.setLabel("model", "glm-5", "top", "right");
      editor.setLabel("stats", "50%", "top", "left");

      // Internal state via buildBorderLine output
      const topLine = editor["buildBorderLine"](
        40,
        { left: "╭", right: "╮" },
        "top",
        "",
      );
      expect(topLine).toContain("50%");
      expect(topLine).toContain("glm-5");

      editor.removeLabel("model");
      const afterRemove = editor["buildBorderLine"](
        40,
        { left: "╭", right: "╮" },
        "top",
        "",
      );
      expect(afterRemove).not.toContain("glm-5");
      expect(afterRemove).toContain("50%");
    });

    it("multiple labels on same side are joined with ·", () => {
      const editor = createPlainEditor();
      editor.setLabel("a", "first", "top", "left");
      editor.setLabel("b", "second", "top", "left");

      const line = editor["buildBorderLine"](
        60,
        { left: "╭", right: "╮" },
        "top",
        "",
      );
      expect(line).toContain("first");
      expect(line).toContain("second");
      expect(line).toContain("·");
    });

    it("left and right labels appear on opposite ends", () => {
      const editor = createPlainEditor();
      editor.setLabel("left", "L-label", "top", "left");
      editor.setLabel("right", "R-label", "top", "right");

      const line = editor["buildBorderLine"](
        50,
        { left: "╭", right: "╮" },
        "top",
        "",
      );
      expect(line).toContain("L-label");
      expect(line).toContain("R-label");
    });

    it("scroll indicator preserved in border", () => {
      const editor = createPlainEditor();
      const originalWithScroll = "────── ↑ 5 more";

      const line = editor["buildBorderLine"](
        50,
        { left: "╭", right: "╮" },
        "top",
        originalWithScroll,
      );
      expect(line).toContain("↑ 5 more");
    });

    it("invalidate clears cached themed border output for repeated same-width renders", () => {
      let themeTag = "[old]";
      const editor = new LabeledEditor(
        { requestRender() {} } as any,
        {} as any,
        {} as any,
        {
          fg: (_: string, t: string) => `${themeTag}${t}`,
          bg: (_: string, t: string) => t,
        } as any,
      );

      editor.setLabel("stats", "50%", "top", "left");

      const renderBorder = (width: number, position: "top" | "bottom") =>
        editor["buildBorderLine"](
          width,
          position === "top"
            ? { left: "╭", right: "╮" }
            : { left: "╰", right: "╯" },
          position,
          "",
        );

      for (const width of [40, 72]) {
        const first = renderBorder(width, "top");
        expect(first).toContain("[old]");

        themeTag = "[new]";
        const stillCached = renderBorder(width, "top");
        expect(stillCached).toBe(first);

        editor.invalidate();
        const refreshed = renderBorder(width, "top");

        expect(refreshed).toContain("[new]");
        expect(refreshed).not.toBe(first);
        expect(refreshed).not.toContain("[old]");

        themeTag = "[old]";
        editor.invalidate();
      }
    });
  });

  describe("framed editor mouse coordinates", () => {
    const event: TuiMouseEvent = {
      type: "click",
      button: "left",
      x: 5,
      y: 2,
      screenX: 15,
      screenY: 12,
      width: 20,
      height: 6,
      shift: false,
      alt: false,
      ctrl: false,
    };

    it("maps content clicks into the inset editor", () => {
      expect(translateFramedEditorMouseEvent(event)).toMatchObject({
        x: 4,
        width: 18,
        screenX: 15,
        screenY: 12,
      });
    });

    it("leaves side-rail clicks to the outer transcript", () => {
      expect(
        translateFramedEditorMouseEvent({ ...event, x: 0 }),
      ).toBeUndefined();
      expect(
        translateFramedEditorMouseEvent({ ...event, x: 19 }),
      ).toBeUndefined();
    });
  });

  describe("editor extension", () => {
    describe("formatTokens", () => {
      it("formats tokens under 1k as-is", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(500)).toBe("500");
        expect(formatTokens(999)).toBe("999");
      });

      it("formats tokens >= 1k with k suffix", () => {
        expect(formatTokens(1000)).toBe("1.0k");
        expect(formatTokens(1500)).toBe("1.5k");
        expect(formatTokens(10000)).toBe("10.0k");
        expect(formatTokens(128000)).toBe("128.0k");
      });
    });

    describe("shortenPath", () => {
      it("replaces HOME with ~", () => {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        if (home) {
          expect(shortenPath(home + "/projects/foo")).toBe("~/projects/foo");
          expect(shortenPath(home)).toBe("~");
        }
      });

      it("returns path as-is when not under HOME", () => {
        expect(shortenPath("/tmp/something")).toBe("/tmp/something");
      });
    });

    it("shows and refreshes context usage and effort without model or cost", () => {
      let percent = 70;
      let effort = "high";
      const editor = new LabeledEditor(
        { requestRender() {} } as any,
        {} as any,
        {} as any,
        {
          fg: (_: string, text: string) => text,
          bg: (_: string, text: string) => text,
        } as any,
      );
      const ctx = {
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({
          percent,
          tokens: 190_000,
          contextWindow: 272_000,
        }),
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          contextWindow: 272_000,
        },
      } as any;

      updateStatsLabels(
        editor,
        { getThinkingLevel: () => effort } as any,
        ctx,
      );
      const border = editor["buildBorderLine"](
        80,
        { left: "╭", right: "╮" },
        "top",
        "",
      );

      expect(border).toContain("70% of 272.0k");
      expect(border).toContain("high");
      expect(border).not.toContain("openai-codex");
      expect(border).not.toContain("gpt-5.6-sol");
      expect(border).not.toContain("$");

      percent = 71;
      effort = "medium";
      updateStatsLabels(
        editor,
        { getThinkingLevel: () => effort } as any,
        ctx,
      );
      const refreshed = editor["buildBorderLine"](
        80,
        { left: "╭", right: "╮" },
        "top",
        "",
      );

      expect(refreshed).toContain("71% of 272.0k");
      expect(refreshed).toContain("medium");
      expect(refreshed).not.toContain("70% of 272.0k");
      expect(refreshed).not.toContain("high");
    });
  });
}
