import {
  highlightCode,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { WorkflowSource } from "./source.js";

const MIN_PANEL_BODY_ROWS = 4;
const OVERLAY_HEIGHT_RATIO = 0.96;
const WIDE_LAYOUT_MIN_WIDTH = 72;

function escapeDisplayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`;
  });
}

function hardWrapAnsi(line: string, width: number): string[] {
  let spacePlaceholder = "\uE000";
  while (line.includes(spacePlaceholder))
    spacePlaceholder = String.fromCodePoint(
      spacePlaceholder.codePointAt(0)! + 1,
    );
  const protectedLine = line.replaceAll(" ", spacePlaceholder);
  return wrapTextWithAnsi(protectedLine, width).map((row) =>
    row.replaceAll(spacePlaceholder, " "),
  );
}

export async function approveWorkflowRun(
  ctx: ExtensionContext,
  source: WorkflowSource,
  limits: { maxConcurrency: number; maxAgents: number },
  mode: "run" | "resume",
  note?: string,
): Promise<boolean> {
  const sourceText = (source.text ?? source.body)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      (character) =>
        `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`,
    );
  let highlighted = highlightCode(sourceText, "javascript");
  const lineNumberWidth = String(Math.max(1, highlighted.length)).length;
  const displayName = escapeDisplayText(source.meta.name);
  const displayDescription = escapeDisplayText(source.meta.description);
  const displaySource = escapeDisplayText(source.source);
  const displayPhases = (source.meta.phases ?? []).map(escapeDisplayText);
  const displayNote = note ? escapeDisplayText(note) : undefined;
  let scroll = 0;
  let visibleSourceRows = MIN_PANEL_BODY_ROWS;
  let totalSourceRows = highlighted.length;

  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _keybindings, done) => ({
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (safeWidth < 20) {
          return [
            truncateToWidth(
              `${mode === "resume" ? "resume" : "run"}: ${displayName}`,
              safeWidth,
              "…",
            ),
            truncateToWidth("enter run · esc cancel", safeWidth, "…"),
          ];
        }
        const innerWidth = Math.max(1, safeWidth - 4);
        const horizontal = "─".repeat(Math.max(0, safeWidth - 2));
        const top = theme.fg("borderAccent", `╭${horizontal}╮`);
        const bottom = theme.fg("borderAccent", `╰${horizontal}╯`);
        const outerVertical = theme.fg("borderAccent", "│");
        const fit = (text: string, targetWidth: number) => {
          const truncated = truncateToWidth(text, targetWidth, "…");
          return `${truncated}${" ".repeat(Math.max(0, targetWidth - visibleWidth(truncated)))}`;
        };
        const row = (text = "") =>
          `${outerVertical} ${fit(text, innerWidth)} ${outerVertical}`;
        const panelTop = (panelWidth: number, title: string) => {
          const safeTitle = truncateToWidth(
            title,
            Math.max(1, panelWidth - 6),
            "…",
          );
          const fill = "─".repeat(
            Math.max(0, panelWidth - visibleWidth(safeTitle) - 5),
          );
          return theme.fg("borderMuted", `╭─ ${safeTitle} ${fill}╮`);
        };
        const panelBottom = (panelWidth: number) =>
          theme.fg(
            "borderMuted",
            `╰${"─".repeat(Math.max(0, panelWidth - 2))}╯`,
          );
        const panelRow = (panelWidth: number, text = "") => {
          const vertical = theme.fg("borderMuted", "│");
          return `${vertical}${fit(` ${text}`, Math.max(1, panelWidth - 2))}${vertical}`;
        };
        const panel = (
          panelWidth: number,
          title: string,
          body: string[],
          bodyRows: number,
        ) => {
          const rows = body
            .slice(0, bodyRows)
            .map((line) => panelRow(panelWidth, line));
          while (rows.length < bodyRows) rows.push(panelRow(panelWidth));
          return [
            panelTop(panelWidth, title),
            ...rows,
            panelBottom(panelWidth),
          ];
        };

        const terminalRows = process.stdout.rows ?? 24;
        const overlayRows = Math.max(
          2,
          Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO),
        );
        const wide = innerWidth >= WIDE_LAYOUT_MIN_WIDTH;
        const showDescription = overlayRows >= 14;
        const showMetadata = overlayRows >= 16;
        const showNote = Boolean(note) && overlayRows >= 18;
        const headerRows =
          1 + Number(showDescription) + Number(showMetadata) + Number(showNote);
        const fixedRows = 3 + headerRows;
        const panelBlockRows = overlayRows - fixedRows;
        const minimumPanelRows = wide ? 3 : 6;
        if (panelBlockRows < minimumPanelRows) {
          if (overlayRows < 4) {
            return [
              truncateToWidth(
                `${mode === "resume" ? "resume" : "run"}: ${displayName}`,
                safeWidth,
                "…",
              ),
              truncateToWidth("enter run · esc cancel", safeWidth, "…"),
            ].slice(0, overlayRows);
          }
          const sourceRows = highlighted.slice(0, Math.max(0, overlayRows - 4));
          return [
            top,
            row(
              theme.fg(
                "accent",
                `${mode === "resume" ? "Resume" : "Run"}: ${displayName}`,
              ),
            ),
            ...sourceRows.map((line) => row(line)),
            row(
              `${theme.fg("accent", "enter")} run · ${theme.fg("accent", "esc")} cancel`,
            ),
            bottom,
          ].slice(0, overlayRows);
        }
        const leftWidth = wide
          ? Math.min(36, Math.max(26, Math.floor(innerWidth * 0.3)))
          : innerWidth;
        const rightWidth = wide ? innerWidth - leftWidth - 1 : innerWidth;
        const wideBodyRows = Math.max(1, panelBlockRows - 2);
        const stackedBodyRows = Math.max(2, panelBlockRows - 4);
        const draftBodyRows = wide
          ? wideBodyRows
          : Math.max(1, Math.min(7, Math.floor(stackedBodyRows * 0.3)));
        visibleSourceRows = wide
          ? wideBodyRows
          : Math.max(1, stackedBodyRows - draftBodyRows);

        const codePrefixWidth = lineNumberWidth + 3;
        const codeInnerWidth = Math.max(1, rightWidth - 3);
        const codeWidth = Math.max(1, codeInnerWidth - codePrefixWidth);
        const wrappedSource = highlighted.flatMap((line, index) => {
          const wrapped = hardWrapAnsi(line, codeWidth);
          return wrapped.map((segment, segmentIndex) => {
            const gutter =
              segmentIndex === 0
                ? String(index + 1).padStart(lineNumberWidth)
                : "…".padStart(lineNumberWidth);
            return `${theme.fg("dim", gutter)} ${theme.fg("borderMuted", "│")} ${segment}`;
          });
        });
        totalSourceRows = wrappedSource.length;
        scroll = Math.min(
          scroll,
          Math.max(0, totalSourceRows - visibleSourceRows),
        );
        const last = Math.min(totalSourceRows, scroll + visibleSourceRows);
        const codeRows = wrappedSource.slice(scroll, last);
        const position =
          totalSourceRows > visibleSourceRows
            ? `rows ${scroll + 1}–${last} of ${totalSourceRows}`
            : `${totalSourceRows} rows`;

        const phases = displayPhases;
        const draftPrefixRows = [
          `${theme.fg("warning", "◐")} ${theme.fg("text", displayName)}`,
          theme.fg("dim", "draft · metadata only"),
          ...(phases.length === 0
            ? [
                `${theme.fg("muted", "╰──")} ${theme.fg("dim", "○")} phases not declared`,
              ]
            : phases.map((phase, index) => {
                const branch = index === phases.length - 1 ? "╰──" : "├──";
                return `${theme.fg("muted", branch)} ${theme.fg("accent", "◇")} ${phase}`;
              })),
        ];
        const runtimeDraftRow = `${theme.fg("dim", "○")} runtime nodes unresolved`;
        const draftRows = [...draftPrefixRows, runtimeDraftRow];
        const visibleDraftRows = (() => {
          if (draftRows.length <= draftBodyRows) return draftRows;
          if (draftBodyRows === 1) return [runtimeDraftRow];
          const prefixRows = draftPrefixRows.slice(
            0,
            Math.max(0, draftBodyRows - 2),
          );
          return [
            ...prefixRows,
            theme.fg(
              "dim",
              `… ${draftPrefixRows.length - prefixRows.length} more draft rows`,
            ),
            runtimeDraftRow,
          ];
        })();

        let panelRows: string[];
        if (wide) {
          const left = panel(
            leftWidth,
            "draft minimap",
            visibleDraftRows,
            draftBodyRows,
          );
          const right = panel(
            rightWidth,
            `javascript · ${position}`,
            codeRows,
            visibleSourceRows,
          );
          panelRows = left.map(
            (line, index) => `${line} ${right[index] ?? ""}`,
          );
        } else {
          panelRows = [
            ...panel(
              leftWidth,
              "draft minimap",
              visibleDraftRows,
              draftBodyRows,
            ),
            ...panel(
              rightWidth,
              `javascript · ${position}`,
              codeRows,
              visibleSourceRows,
            ),
          ];
        }

        const phaseText = phases.join(" · ") || "not declared";
        return [
          top,
          row(
            theme.fg(
              "accent",
              theme.bold(
                `${mode === "resume" ? "Resume" : "Run"} workflow: ${displayName}`,
              ),
            ),
          ),
          ...(showDescription ? [row(displayDescription)] : []),
          ...(showMetadata
            ? [
                row(
                  `${theme.fg("dim", "source")} ${displaySource}  ${theme.fg("dim", "declared phases")} ${phaseText}  ${theme.fg("dim", "limits")} ${limits.maxConcurrency} concurrent · ${limits.maxAgents} sessions`,
                ),
              ]
            : []),
          ...(showNote && displayNote
            ? [row(theme.fg("warning", displayNote))]
            : []),
          ...panelRows.map((line) => row(line)),
          row(
            `${theme.fg("accent", "enter")} run  ${theme.fg("dim", "↑↓")} scroll code  ${theme.fg("accent", "esc")} cancel`,
          ),
          bottom,
        ];
      },
      invalidate() {
        highlighted = highlightCode(sourceText, "javascript");
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.enter)) done(true);
        else if (matchesKey(data, Key.escape)) done(false);
        else if (matchesKey(data, Key.up)) {
          scroll = Math.max(0, scroll - 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.down)) {
          scroll = Math.min(
            Math.max(0, totalSourceRows - visibleSourceRows),
            scroll + 1,
          );
          tui.requestRender();
        }
      },
    }),
    {
      overlay: true,
      overlayOptions: {
        width: "96%",
        minWidth: 40,
        maxHeight: "96%",
        anchor: "center",
      },
    },
  );

  return result === true;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("workflow approval rendering", () => {
    it("hard-wraps code without changing whitespace", () => {
      const source = "    const value = 'a b c';";
      expect(hardWrapAnsi(source, 8).join("")).toBe(source);
    });

    it("escapes terminal controls in metadata", () => {
      expect(escapeDisplayText("safe\u001b[2J\nnext")).toBe(
        "safe\\x1b[2J\\nnext",
      );
    });
  });
}
