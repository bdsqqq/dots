import {
  highlightCode,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
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
const MAX_DRAFT_ITERATIONS = 20;
const MAX_DRAFT_CHAINS = 32;
const MAX_DRAFT_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_FEEDBACK_BYTES = 8 * 1024;

export type WorkflowApprovalDecision =
  | { type: "run" }
  | { type: "cancel" }
  | {
      type: "feedback";
      feedback: string;
      iteration: number;
      sourceHash: string;
    };

interface DraftIteration {
  source: WorkflowSource;
  limits: { maxConcurrency: number; maxAgents: number };
  feedback?: string;
}

interface DraftChain {
  iterations: DraftIteration[];
  offset: number;
  awaitingRevision: boolean;
  expectedRevisionOf?: string;
  expectedFeedbackParentId?: string | null;
  expectedFeedbackIteration?: number;
}

const draftChains = new Map<string, DraftChain>();

interface PendingRevision {
  sourceHash: string;
  iteration: number;
  parentId: string | null;
}

function branchPendingRevision(
  ctx: ExtensionContext,
): PendingRevision | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult")
      continue;
    const message = entry.message as {
      toolName?: string;
      details?: Record<string, unknown>;
      isError?: boolean;
    };
    if (message.toolName !== "workflow") continue;
    if (message.isError) continue;
    const details = message.details;
    if (
      details?.status === "feedback" &&
      typeof details.sourceHash === "string" &&
      typeof details.iteration === "number"
    )
      return {
        sourceHash: details.sourceHash,
        iteration: details.iteration,
        parentId: entry.parentId,
      };
    return undefined;
  }
  return undefined;
}

function storeDraftChain(key: string, chain: DraftChain): void {
  draftChains.delete(key);
  if (draftChains.size >= MAX_DRAFT_CHAINS) {
    const oldest = draftChains.keys().next().value;
    if (oldest) draftChains.delete(oldest);
  }
  draftChains.set(key, chain);
}

function openDraftChain(
  ctx: ExtensionContext,
  source: WorkflowSource,
  limits: { maxConcurrency: number; maxAgents: number },
  revisionOf?: string,
): { key: string; chain: DraftChain } {
  const key = ctx.sessionManager.getSessionId();
  const pending = branchPendingRevision(ctx);
  if (pending) {
    if (!revisionOf || revisionOf !== pending.sourceHash)
      throw new Error(
        `workflow revision must include revisionOf: ${pending.sourceHash}`,
      );
  } else if (revisionOf) {
    throw new Error("workflow revisionOf has no pending feedback request");
  }

  const existing = draftChains.get(key);
  const canReuse =
    pending &&
    existing?.awaitingRevision === true &&
    existing.expectedRevisionOf === pending.sourceHash &&
    existing.expectedFeedbackParentId === pending.parentId &&
    existing.expectedFeedbackIteration === pending.iteration;
  if (!canReuse) {
    const chain: DraftChain = {
      iterations: [{ source, limits }],
      offset: pending?.iteration ?? 0,
      awaitingRevision: false,
    };
    storeDraftChain(key, chain);
    return { key, chain };
  }

  existing.awaitingRevision = false;
  delete existing.expectedRevisionOf;
  delete existing.expectedFeedbackParentId;
  delete existing.expectedFeedbackIteration;
  existing.iterations.push({ source, limits });
  while (
    existing.iterations.length > 1 &&
    (existing.iterations.length > MAX_DRAFT_ITERATIONS ||
      existing.iterations.reduce(
        (bytes, iteration) =>
          bytes +
          Buffer.byteLength(iteration.source.text) +
          Buffer.byteLength(iteration.feedback ?? ""),
        0,
      ) > MAX_DRAFT_HISTORY_BYTES)
  ) {
    existing.iterations.shift();
    existing.offset++;
  }
  storeDraftChain(key, existing);
  return { key, chain: existing };
}

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
  revisionOf?: string,
): Promise<WorkflowApprovalDecision> {
  const { key: chainKey, chain } = openDraftChain(
    ctx,
    source,
    limits,
    revisionOf,
  );
  let iterationIndex = chain.iterations.length - 1;
  let activeIteration = chain.iterations[iterationIndex]!;
  let activeSource = activeIteration.source;
  let activeLimits = activeIteration.limits;
  let sourceText = activeSource.text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      (character) =>
        `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`,
    );
  let highlighted = highlightCode(sourceText, "javascript");
  let lineNumberWidth = String(Math.max(1, highlighted.length)).length;
  let displayName = escapeDisplayText(activeSource.meta.name);
  let displayDescription = escapeDisplayText(activeSource.meta.description);
  let displaySource = escapeDisplayText(activeSource.source);
  let displayPhases = (activeSource.meta.phases ?? []).map(escapeDisplayText);
  const displayNote = note ? escapeDisplayText(note) : undefined;
  const loadIteration = (index: number): void => {
    iterationIndex = Math.max(0, Math.min(chain.iterations.length - 1, index));
    activeIteration = chain.iterations[iterationIndex]!;
    activeSource = activeIteration.source;
    activeLimits = activeIteration.limits;
    sourceText = activeSource.text
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
        (character) =>
          `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`,
      );
    highlighted = highlightCode(sourceText, "javascript");
    lineNumberWidth = String(Math.max(1, highlighted.length)).length;
    displayName = escapeDisplayText(activeSource.meta.name);
    displayDescription = escapeDisplayText(activeSource.meta.description);
    displaySource = escapeDisplayText(activeSource.source);
    displayPhases = (activeSource.meta.phases ?? []).map(escapeDisplayText);
    scroll = 0;
  };
  let scroll = 0;
  let visibleSourceRows = MIN_PANEL_BODY_ROWS;
  let totalSourceRows = highlighted.length;

  const result = await ctx.ui.custom<WorkflowApprovalDecision>(
    (tui, theme, keybindings, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const feedbackEditor = new Editor(tui, editorTheme, { paddingX: 0 });
      let feedbackMode = false;
      let feedbackError: string | undefined;
      let focused = false;
      const submitFeedback = (value: string): void => {
        const feedback = value.trim();
        if (!feedback) {
          feedbackError = "feedback cannot be empty";
          return;
        }
        if (Buffer.byteLength(feedback, "utf8") > MAX_FEEDBACK_BYTES) {
          feedbackError = `feedback must be at most ${MAX_FEEDBACK_BYTES} UTF-8 bytes`;
          return;
        }
        feedbackError = undefined;
        activeIteration.feedback = feedback;
        chain.awaitingRevision = true;
        chain.expectedRevisionOf = activeSource.hash;
        chain.expectedFeedbackParentId = ctx.sessionManager.getLeafId();
        chain.expectedFeedbackIteration = chain.offset + iterationIndex + 1;
        done({
          type: "feedback",
          feedback,
          iteration: chain.offset + iterationIndex + 1,
          sourceHash: activeSource.hash,
        });
      };
      feedbackEditor.onSubmit = submitFeedback;

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          feedbackEditor.focused = value && feedbackMode;
        },
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          if (safeWidth < 20) {
            if (feedbackMode)
              return [
                ...feedbackEditor.render(safeWidth),
                truncateToWidth("enter send · esc cancel", safeWidth, "…"),
              ];
            return [
              truncateToWidth(
                `${mode === "resume" ? "resume" : "run"}: ${displayName}`,
                safeWidth,
                "…",
              ),
              truncateToWidth("enter run · esc feedback", safeWidth, "…"),
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
          const cropEditorRows = (
            lines: string[],
            maxRows: number,
          ): string[] => {
            if (lines.length <= maxRows) return lines;
            const cursorRow = Math.max(
              0,
              lines.findIndex((line) => line.includes(CURSOR_MARKER)),
            );
            const start = Math.max(
              0,
              Math.min(
                lines.length - maxRows,
                cursorRow - Math.floor(maxRows / 2),
              ),
            );
            return lines.slice(start, start + maxRows);
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
            1 +
            Number(showDescription) +
            Number(showMetadata) +
            Number(showNote);
          const fixedRows = 3 + headerRows;
          const panelBlockRows = overlayRows - fixedRows;
          const minimumPanelRows = wide ? 3 : 6;
          if (panelBlockRows < minimumPanelRows) {
            if (feedbackMode && overlayRows <= 5) {
              const status = feedbackError
                ? theme.fg("error", feedbackError)
                : theme.fg("accent", "enter submit · esc cancel");
              return [
                ...cropEditorRows(
                  feedbackEditor.render(safeWidth),
                  Math.max(1, overlayRows - 1),
                ),
                truncateToWidth(status, safeWidth, "…"),
              ].slice(0, overlayRows);
            }
            if (overlayRows < 4) {
              return [
                truncateToWidth(
                  `${mode === "resume" ? "resume" : "run"}: ${displayName}`,
                  safeWidth,
                  "…",
                ),
                truncateToWidth(
                  feedbackMode
                    ? "enter submit feedback · esc cancel"
                    : "enter run · esc feedback",
                  safeWidth,
                  "…",
                ),
              ].slice(0, overlayRows);
            }
            const bodyRows = Math.max(0, overlayRows - 4);
            const feedbackErrorRows =
              feedbackMode && feedbackError
                ? [theme.fg("error", feedbackError)]
                : [];
            const sourceRows = feedbackMode
              ? [
                  ...feedbackErrorRows,
                  ...cropEditorRows(
                    feedbackEditor.render(innerWidth),
                    Math.max(1, bodyRows - feedbackErrorRows.length),
                  ),
                ].slice(0, bodyRows)
              : highlighted.slice(0, bodyRows);
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
                feedbackMode
                  ? `${theme.fg("accent", "enter")} submit feedback · ${theme.fg("accent", "esc")} cancel without feedback`
                  : `${theme.fg("accent", "enter")} run · ${theme.fg("accent", "esc")} feedback or cancel`,
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
            : Math.max(
                1,
                Math.min(
                  feedbackMode
                    ? Math.max(7, Math.floor(stackedBodyRows * 0.5))
                    : 7,
                  feedbackMode
                    ? Math.floor(stackedBodyRows * 0.5)
                    : Math.floor(stackedBodyRows * 0.3),
                ),
              );
          visibleSourceRows = wide
            ? wideBodyRows
            : Math.max(1, stackedBodyRows - draftBodyRows);
          const feedbackRows = feedbackMode
            ? feedbackEditor.render(Math.max(1, leftWidth - 4))
            : [];
          const draftReserve = feedbackMode && draftBodyRows >= 5 ? 2 : 0;
          const feedbackCapacity = Math.max(1, draftBodyRows - draftReserve);
          const showFeedbackLabel = feedbackCapacity >= 2;
          const maxFeedbackRows = Math.max(
            1,
            feedbackCapacity - Number(showFeedbackLabel),
          );
          const croppedFeedbackRows = cropEditorRows(
            feedbackRows,
            maxFeedbackRows,
          );
          const visibleFeedbackRows = feedbackMode
            ? [
                ...(showFeedbackLabel
                  ? [
                      feedbackError
                        ? theme.fg("error", feedbackError)
                        : theme.fg(
                            "accent",
                            "feedback · enter submit · esc cancel",
                          ),
                    ]
                  : []),
                ...croppedFeedbackRows,
              ]
            : [];
          const draftViewportRows = feedbackMode ? draftReserve : draftBodyRows;

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
            ...(activeIteration.feedback
              ? [
                  theme.fg(
                    "dim",
                    `↳ feedback: ${escapeDisplayText(activeIteration.feedback)}`,
                  ),
                ]
              : []),
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
            if (draftViewportRows === 0) return [];
            if (draftRows.length <= draftViewportRows) return draftRows;
            if (draftViewportRows === 1) return [runtimeDraftRow];
            const prefixRows = draftPrefixRows.slice(
              0,
              Math.max(0, draftViewportRows - 2),
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
              [...visibleDraftRows, ...visibleFeedbackRows],
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
                [...visibleDraftRows, ...visibleFeedbackRows],
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
                  `${mode === "resume" ? "Resume" : "Run"} workflow: ${displayName} · iteration ${chain.offset + iterationIndex + 1}/${chain.offset + chain.iterations.length}`,
                ),
              ),
            ),
            ...(showDescription ? [row(displayDescription)] : []),
            ...(showMetadata
              ? [
                  row(
                    `${theme.fg("dim", "source")} ${displaySource}  ${theme.fg("dim", "declared phases")} ${phaseText}  ${theme.fg("dim", "limits")} ${activeLimits.maxConcurrency} concurrent · ${activeLimits.maxAgents} sessions`,
                  ),
                ]
              : []),
            ...(showNote && displayNote
              ? [row(theme.fg("warning", displayNote))]
              : []),
            ...panelRows.map((line) => row(line)),
            row(
              feedbackMode
                ? `${theme.fg("accent", "enter")} submit feedback  ${theme.fg("accent", "esc")} cancel without feedback`
                : `${theme.fg("accent", "enter")} run  ${theme.fg("dim", "↑↓")} scroll code  ${theme.fg("dim", "alt+←→")} iterations  ${theme.fg("accent", "esc")} feedback or cancel`,
            ),
            bottom,
          ];
        },
        invalidate() {
          highlighted = highlightCode(sourceText, "javascript");
          feedbackEditor.invalidate();
        },
        handleInput(data: string) {
          if (feedbackMode) {
            if (matchesKey(data, Key.escape)) {
              done({ type: "cancel" });
              return;
            }
            if (
              matchesKey(data, Key.enter) ||
              keybindings.matches(data, "tui.input.submit")
            )
              submitFeedback(feedbackEditor.getExpandedText());
            else feedbackEditor.handleInput(data);
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.enter)) {
            if (iterationIndex !== chain.iterations.length - 1) {
              loadIteration(chain.iterations.length - 1);
              tui.requestRender();
              return;
            }
            done({ type: "run" });
          } else if (matchesKey(data, Key.escape)) {
            if (iterationIndex !== chain.iterations.length - 1)
              loadIteration(chain.iterations.length - 1);
            feedbackMode = true;
            feedbackError = undefined;
            feedbackEditor.setText(activeIteration.feedback ?? "");
            feedbackEditor.focused = focused;
            tui.requestRender();
          } else if (matchesKey(data, Key.alt("left"))) {
            loadIteration(iterationIndex - 1);
            tui.requestRender();
          } else if (matchesKey(data, Key.alt("right"))) {
            loadIteration(iterationIndex + 1);
            tui.requestRender();
          } else if (matchesKey(data, Key.up)) {
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
      };
    },
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

  if (result.type !== "feedback") draftChains.delete(chainKey);
  return result;
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

    it("treats the proposal after feedback as the next session iteration", () => {
      const branch: unknown[] = [];
      const ctx = {
        sessionManager: {
          getSessionId: () => "iteration-test",
          getLeafId: () => "assistant-entry",
          getBranch: () => branch,
        },
      } as unknown as ExtensionContext;
      const makeSource = (hash: string): WorkflowSource => ({
        source: "inline",
        text: hash,
        code: `exports.meta = { name: "test", description: "test" };`,
        meta: { name: "test", description: "test" },
        hash,
        projectLocal: false,
      });
      const first = openDraftChain(ctx, makeSource("one"), {
        maxConcurrency: 1,
        maxAgents: 1,
      });
      first.chain.iterations[0]!.feedback = "revise it";
      first.chain.awaitingRevision = true;
      first.chain.expectedRevisionOf = "one";
      first.chain.expectedFeedbackParentId = "assistant-entry";
      first.chain.expectedFeedbackIteration = 1;
      branch.push({
        type: "message",
        parentId: "assistant-entry",
        message: {
          role: "toolResult",
          toolName: "workflow",
          details: { status: "feedback", sourceHash: "one", iteration: 1 },
        },
      });
      branch.push({
        type: "message",
        parentId: "failed-revision",
        message: {
          role: "toolResult",
          toolName: "workflow",
          details: {},
          isError: true,
        },
      });
      expect(() =>
        openDraftChain(ctx, makeSource("stale"), {
          maxConcurrency: 2,
          maxAgents: 2,
        }),
      ).toThrow("revisionOf: one");
      const second = openDraftChain(
        ctx,
        makeSource("two"),
        {
          maxConcurrency: 2,
          maxAgents: 2,
        },
        "one",
      );
      expect(second.chain.iterations.map((entry) => entry.source.hash)).toEqual(
        ["one", "two"],
      );
      expect(second.chain.iterations[0]!.feedback).toBe("revise it");
      branch.push({
        type: "message",
        parentId: "cancelled-revision",
        message: {
          role: "toolResult",
          toolName: "workflow",
          details: { status: "cancelled", approvalCancelled: true },
        },
      });
      const forked = openDraftChain(ctx, makeSource("forked"), {
        maxConcurrency: 1,
        maxAgents: 1,
      });
      expect(forked.chain.iterations.map((entry) => entry.source.hash)).toEqual(
        ["forked"],
      );
      draftChains.delete("iteration-test");
    });
  });
}
