/**
 * rendering utilities for sub-agent tool results.
 *
 * extracts DisplayItem, message parsing, and TUI tree rendering
 * from the generic subagent extension. dedicated tools (finder,
 * oracle, delegate) use these for consistent renderResult display.
 *
 * reimplemented here because tools/ can't import from sub-agents/
 * (separate nix store paths).
 */

import * as os from "node:os";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  MarkerColumn,
  Markdown,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { boxBottom, boxRow } from "@bds_pi/box-chrome";
import {
  modelCliString,
  toToolUsage,
  type PiSpawnModel,
  type PiSpawnLifecycle,
  type PiSpawnSessionMeta,
  type PiWorkspaceResultApplyOutcome,
  type UsageStats,
} from "@bds_pi/pi-spawn";
import type { ToolCostDetails } from "@bds_pi/tool-cost";

// --- types ---

export type DisplayItem =
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: Record<string, any>;
      isError?: boolean;
    };

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  usage: UsageStats;
  model?: PiSpawnModel;
  stopReason?: string;
  errorMessage?: string;
  continueId?: string;
  sessionId?: string;
  sessionFile?: string;
  leafId?: string;
  resultRef?: string;
  workspaceApply?: PiWorkspaceResultApplyOutcome;
  lifecycle?: PiSpawnLifecycle;
}

// --- message parsing ---

export function applySessionMeta(
  target: SingleResult,
  session: PiSpawnSessionMeta | undefined,
): void {
  target.continueId = session?.continueId;
  target.sessionId = session?.sessionId;
  target.sessionFile = session?.sessionFile;
  target.leafId = session?.leafId;
  target.resultRef = session?.resultRef;
  target.workspaceApply = session?.workspaceApply;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text"
        ) {
          return (part as { type: "text"; text: string }).text;
        }
      }
    }
  }
  return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const errorMap = new Map<string, boolean>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      errorMap.set(msg.toolCallId, msg.isError);
    }
  }

  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") {
          items.push({
            type: "toolCall",
            id: part.id,
            name: part.name,
            args: part.arguments,
            isError: errorMap.get(part.id),
          });
        }
      }
    }
  }
  return items;
}

// --- tool result construction ---

/**
 * build the standard tool result for a piSpawn-based sub-agent.
 * all sub-agent tools should use this instead of constructing
 * return values manually — cost tagging is automatic.
 */
export function subAgentResult(
  text: string,
  details: SingleResult,
  isError = false,
): {
  content: { type: "text"; text: string }[];
  details: SingleResult & ToolCostDetails;
  usage: Usage;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text }],
    details: { ...details, cost: details.usage.cost },
    usage: toToolUsage(details.usage),
    ...(isError && { isError: true }),
  };
}

export function registerSubAgentErrorNormalization(
  pi: ExtensionAPI,
  toolName: string,
): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== toolName) return;
    const details = event.details as Partial<SingleResult> | undefined;
    const status = details?.lifecycle?.status;
    if (
      status === "failed" ||
      status === "cancelled" ||
      status === "timed_out" ||
      (typeof details?.exitCode === "number" && details.exitCode !== 0) ||
      details?.stopReason === "error" ||
      details?.stopReason === "aborted"
    ) {
      return { isError: true };
    }
  });
}

// --- formatting ---

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: PiSpawnModel,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(modelCliString(model));
  return parts.join(" ");
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function toolLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function toolArgSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash": {
      const command = (args.cmd ?? args.command ?? "...") as string;
      return command.split("\n")[0] ?? command;
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      let text = shortenPath(rawPath);
      const readRange = args.read_range as [number, number] | undefined;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      if (readRange) {
        text += `:${readRange[0]}-${readRange[1]}`;
      } else if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += `:${startLine}${endLine ? `-${endLine}` : ""}`;
      }
      return text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = shortenPath(rawPath);
      if (lines > 1) text += ` (${lines} lines)`;
      return text;
    }
    case "edit":
      return shortenPath((args.file_path || args.path || "...") as string);
    case "apply_patch": {
      const input = typeof args.input === "string" ? args.input : "";
      const paths = input.split("\n").flatMap((line) => {
        const match = line.match(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/);
        return match?.[1] ? [shortenPath(match[1])] : [];
      });
      return paths.length > 0 ? paths.join(", ") : "patch";
    }
    case "ls":
      return shortenPath((args.path || ".") as string);
    case "find": {
      const pattern = (args.filePattern || args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return `${pattern} in ${shortenPath(rawPath)}`;
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return `/${pattern}/ in ${shortenPath(rawPath)}`;
    }
    default:
      return JSON.stringify(args);
  }
}

function renderToolLine(
  item: DisplayItem & { type: "toolCall" },
  fg: (color: any, text: string) => string,
): string {
  const icon =
    item.isError === true
      ? fg("error", "✕")
      : item.isError === false
        ? fg("success", "✓")
        : fg("muted", "⋯");
  return `${icon} ${fg("accent", toolLabel(item.name))} ${fg("dim", toolArgSummary(item.name, item.args))}`;
}

// --- tree rendering ---

const COLLAPSED_ITEM_COUNT = 10;
const ACTIVE_BADGE_INTERVAL_MS = 320;
const ACTIVE_BADGE_STATE = Symbol("sub-agent-active-badge");

type ActiveBadgeState = {
  frame: number;
  interval?: ReturnType<typeof setInterval>;
  renderVersion: number;
};

type SubAgentCallContext = {
  isError: boolean;
  isPartial: boolean;
  invalidate?: () => void;
  lastComponent?: Component;
  state?: Record<PropertyKey, unknown>;
};

class SingleLineText implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    return safeWidth === 0
      ? []
      : [
          truncateToWidth(
            this.text.split(/\r\n|\r|\n/, 1)[0] ?? "",
            safeWidth,
            "…",
          ),
        ];
  }

  invalidate(): void {}
}

class OpenBox implements Component {
  constructor(
    private readonly child: Component,
    private readonly dim: (text: string) => string,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];

    const style = { dim: this.dim };
    if (safeWidth === 1) {
      return [this.dim("│"), this.dim("╰")];
    }
    if (safeWidth === 2) {
      return [this.dim("│ "), this.dim("╰─")];
    }

    const rows = this.child
      .render(safeWidth - 2)
      .map((line) =>
        truncateToWidth(
          boxRow({ variant: "open", style, inner: line }),
          safeWidth,
          "",
        ),
      );
    rows.push(
      truncateToWidth(boxBottom({ variant: "open", style }), safeWidth, ""),
    );
    return rows;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

function trimBlankLines(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

class SubAgentCallComponent implements Component {
  private row: MarkerColumn;

  constructor(icon: string, content: string) {
    this.row = new MarkerColumn(icon, new Text(content, 0, 0));
  }

  update(icon: string, content: string): void {
    this.row.setMarker(icon);
    this.row.setChild(new Text(content, 0, 0));
  }

  render(width: number): string[] {
    return this.row.render(width);
  }

  invalidate(): void {
    this.row.invalidate();
  }
}

export function renderSubAgentCall(
  content: string,
  theme: any,
  context: SubAgentCallContext,
): Component {
  const state = context.state as
    | (Record<PropertyKey, unknown> & {
        [ACTIVE_BADGE_STATE]?: ActiveBadgeState;
      })
    | undefined;
  const badge =
    state &&
    (state[ACTIVE_BADGE_STATE] ??= {
      frame: 0,
      renderVersion: 0,
    });
  if (badge) badge.renderVersion++;
  const active = context.isPartial && !context.isError;

  if (active && badge && context.invalidate && !badge.interval) {
    badge.interval = setInterval(() => {
      badge.frame = (badge.frame + 1) % 2;
      const renderedVersion = badge.renderVersion;
      context.invalidate?.();
      if (badge.renderVersion === renderedVersion && badge.interval) {
        clearInterval(badge.interval);
        badge.interval = undefined;
      }
    }, ACTIVE_BADGE_INTERVAL_MS);
    badge.interval.unref?.();
  } else if (!active && badge?.interval) {
    clearInterval(badge.interval);
    badge.interval = undefined;
  }

  const icon = context.isError
    ? theme.fg("error", "✕")
    : active
      ? theme.fg((badge?.frame ?? 0) % 2 === 0 ? "muted" : "accent", "●")
      : theme.fg("success", "✓");
  const component =
    context.lastComponent instanceof SubAgentCallComponent
      ? context.lastComponent
      : new SubAgentCallComponent(icon, content);
  component.update(icon, content);
  return component;
}

export function renderAgentTree(
  r: SingleResult,
  container: Container,
  showExpanded: boolean,
  theme: any,
  labelOrOpts?:
    | string
    | {
        label?: string;
        header?: "full" | "none";
        summary?: "tree" | "open-box";
      },
): void {
  const fg = theme.fg.bind(theme);
  const opts =
    typeof labelOrOpts === "string"
      ? {
          label: labelOrOpts,
          header: "full" as const,
          summary: "tree" as const,
        }
      : {
          label: labelOrOpts?.label,
          header: labelOrOpts?.header ?? ("full" as const),
          summary: labelOrOpts?.summary ?? ("tree" as const),
        };
  const MID = fg("muted", "├");
  const END = fg("muted", "╰");
  const CONT = fg("muted", "│");
  const mdTheme = getMarkdownTheme();

  const isError =
    r.lifecycle?.status === "failed" ||
    r.lifecycle?.status === "cancelled" ||
    r.lifecycle?.status === "timed_out" ||
    r.exitCode !== 0 ||
    r.stopReason === "error" ||
    r.stopReason === "aborted";
  const errorLabel = r.lifecycle?.errorKind ?? r.stopReason;
  const icon =
    r.exitCode === -1
      ? fg("warning", "⋯")
      : isError
        ? fg("error", "✕")
        : fg("success", "✓");

  if (opts.header === "full") {
    let header = fg("toolTitle", theme.bold(opts.label ?? r.agent));
    if (isError && errorLabel) header += ` ${fg("error", `[${errorLabel}]`)}`;
    container.addChild(new MarkerColumn(icon, new Text(header, 0, 0)));
  }

  if (isError && (errorLabel || r.errorMessage)) {
    const error = [
      errorLabel && fg("error", `[${errorLabel}]`),
      r.errorMessage && fg("error", `Error: ${r.errorMessage}`),
    ]
      .filter(Boolean)
      .join(" ");
    container.addChild(
      new MarkerColumn(MID, new Text(error, 0, 0), {
        continuationMarker: CONT,
      }),
    );
  }

  const displayItems = getDisplayItems(r.messages);
  const toolCalls = displayItems.filter(
    (d): d is DisplayItem & { type: "toolCall" } => d.type === "toolCall",
  );
  const finalOutput = getFinalOutput(r.messages);
  const boxedSummary =
    opts.summary === "open-box"
      ? trimBlankLines(finalOutput) || "(no output)"
      : undefined;

  type TreeChild =
    | { kind: "text"; content: string }
    | { kind: "tool"; item: DisplayItem & { type: "toolCall" } }
    | { kind: "summary"; output: string };
  const children: TreeChild[] = [];

  if (showExpanded) children.push({ kind: "text", content: r.task });

  const visibleTools = showExpanded
    ? toolCalls
    : toolCalls.slice(-COLLAPSED_ITEM_COUNT);
  const skippedTools = showExpanded
    ? 0
    : toolCalls.length - visibleTools.length;
  if (skippedTools > 0)
    children.push({
      kind: "text",
      content: `…${skippedTools} earlier calls`,
    });
  for (const tc of visibleTools) children.push({ kind: "tool", item: tc });
  if (finalOutput && opts.summary === "tree")
    children.push({ kind: "summary", output: finalOutput.trim() });

  if (children.length === 0 && !boxedSummary) {
    container.addChild(
      new MarkerColumn(END, new Text(fg("muted", "(no output)"), 0, 0)),
    );
  } else {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const isLast = i === children.length - 1 && !boxedSummary;
      const connector = isLast ? END : MID;
      const continuation = isLast ? "" : CONT;

      if (child.kind === "text") {
        container.addChild(
          new MarkerColumn(
            connector,
            new Text(fg("dim", child.content), 0, 0),
            { continuationMarker: continuation },
          ),
        );
      } else if (child.kind === "tool") {
        container.addChild(
          new MarkerColumn(
            connector,
            new SingleLineText(renderToolLine(child.item, fg)),
            { continuationMarker: continuation },
          ),
        );
      } else if (child.kind === "summary") {
        const summary = new Container();
        summary.addChild(new Text(fg("muted", "Summary:"), 0, 0));
        summary.addChild(new Markdown(child.output, 0, 0, mdTheme));
        container.addChild(
          new MarkerColumn(connector, summary, {
            continuationMarker: continuation,
          }),
        );
      }
    }
  }

  if (!showExpanded && toolCalls.length > COLLAPSED_ITEM_COUNT) {
    const hint = new Text(fg("muted", "(Ctrl+O to expand)"), 0, 0);
    container.addChild(
      boxedSummary
        ? new MarkerColumn(CONT, hint, { continuationMarker: CONT })
        : hint,
    );
  }

  if (boxedSummary) {
    container.addChild(
      new OpenBox(new Markdown(boxedSummary, 0, 0, mdTheme), (text) =>
        fg("muted", text),
      ),
    );
  }

  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) container.addChild(new Text(fg("dim", usageStr), 0, 0));
}

// --- inline tests ---

if (import.meta.vitest) {
  const { describe, it, expect, vi } = import.meta.vitest;
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const assistantMessage = (
    content: Extract<Message, { role: "assistant" }>["content"],
  ): Message => ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });

  describe("sub-agent rows", () => {
    it("keeps open-box chrome bounded when content has no width", () => {
      const child = {
        render: vi.fn(() => ["hidden"]),
        invalidate: vi.fn(),
      };
      const box = new OpenBox(child, (text) => text);

      expect(box.render(1)).toEqual(["│", "╰"]);
      expect(box.render(2)).toEqual(["│ ", "╰─"]);
      expect(child.render).not.toHaveBeenCalled();
    });

    it("removes surrounding blank lines without changing Markdown indentation", () => {
      expect(trimBlankLines("\n \n    code\n\n")).toBe("    code");
    });

    it("keeps wrapped call content aligned after its status column", () => {
      const component = renderSubAgentCall(
        "Delegate verify settlement and abort findings",
        mockTheme,
        { isError: false, isPartial: false },
      );

      expect(component.render(24).map((line) => line.trimEnd())).toEqual([
        "✓ Delegate verify",
        "  settlement and abort",
        "  findings",
      ]);
      expect(component.render(1)).toEqual(["✓"]);
      expect(component.render(2)).toEqual(["✓ "]);
      for (const width of [1, 2, 3, 12]) {
        expect(
          component.render(width).every((line) => visibleWidth(line) <= width),
        ).toBe(true);
      }
    });

    it("gives errors precedence over pending call status", () => {
      const line = renderSubAgentCall("Delegate task", mockTheme, {
        isError: true,
        isPartial: true,
      }).render(80)[0];

      expect(line?.trimEnd()).toBe("✕ Delegate task");
    });

    it("pulses active calls and settles the reused badge", () => {
      vi.useFakeTimers();
      try {
        const colors: string[] = [];
        const theme = {
          fg: (color: string, text: string) => {
            if (text === "●") colors.push(color);
            return text;
          },
        };
        const state: Record<PropertyKey, unknown> = {};
        let component: Component | undefined;
        const renderActive = (): void => {
          component = renderSubAgentCall("Delegate task", theme, {
            isError: false,
            isPartial: true,
            invalidate,
            lastComponent: component,
            state,
          });
        };
        const invalidate = vi.fn(renderActive);
        renderActive();
        const initialComponent = component;

        expect(colors.at(-1)).toBe("muted");
        vi.advanceTimersByTime(ACTIVE_BADGE_INTERVAL_MS);
        expect(invalidate).toHaveBeenCalledOnce();
        expect(component).toBe(initialComponent);
        expect(colors.at(-1)).toBe("accent");

        component = renderSubAgentCall("Delegate task", theme, {
          isError: false,
          isPartial: false,
          invalidate,
          lastComponent: component,
          state,
        });
        expect(component.render(80)[0]?.trimEnd()).toBe("✓ Delegate task");

        vi.clearAllMocks();
        vi.advanceTimersByTime(ACTIVE_BADGE_INTERVAL_MS * 2);
        expect(invalidate).not.toHaveBeenCalled();

        renderSubAgentCall("Delegate export", theme, {
          isError: false,
          isPartial: true,
          invalidate: () => {},
          state: {},
        });
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(ACTIVE_BADGE_INTERVAL_MS);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps wrapped tree content inside the connector column", () => {
      const result: SingleResult = {
        agent: "delegate",
        task: "verify settlement and abort findings",
        exitCode: 0,
        messages: [
          assistantMessage([
            {
              type: "toolCall",
              id: "tc1",
              name: "grep",
              arguments: { pattern: "failure", path: "." },
            },
          ]),
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      };
      const container = new Container();

      renderAgentTree(result, container, true, mockTheme, {
        header: "none",
      });

      expect(
        container
          .render(20)
          .map((line) => stripTerminalSequences(line).trimEnd()),
      ).toEqual([
        "├ verify settlement",
        "│ and abort findings",
        "╰ ⋯ Grep /failure/ …",
      ]);
    });

    it("renders collapsed call counts in the shared tree column", () => {
      const result: SingleResult = {
        agent: "delegate",
        task: "verify settlement",
        exitCode: 0,
        messages: [
          assistantMessage(
            Array.from({ length: 11 }, (_, index) => ({
              type: "toolCall" as const,
              id: `tc${index}`,
              name: "read",
              arguments: { path: `file-${index}.ts` },
            })),
          ),
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      };
      const container = new Container();

      renderAgentTree(result, container, false, mockTheme, {
        header: "none",
      });

      expect(
        stripTerminalSequences(container.render(80)[0] ?? "").trimEnd(),
      ).toBe("├ …1 earlier calls");
    });

    it("keeps failure metadata when the call owns the status", () => {
      const result: SingleResult = {
        agent: "delegate",
        task: "verify settlement",
        exitCode: 1,
        messages: [],
        stopReason: "aborted",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      };
      const container = new Container();

      renderAgentTree(result, container, false, mockTheme, {
        header: "none",
      });

      expect(container.render(80).map((line) => line.trimEnd())).toEqual([
        "├ [aborted]",
        "╰ (no output)",
      ]);
    });
  });

  describe("registerSubAgentErrorNormalization", () => {
    it("marks only matching failed lifecycle results as errors", async () => {
      let handler:
        | ((event: { toolName: string; details?: unknown }) => Promise<unknown>)
        | undefined;
      registerSubAgentErrorNormalization(
        {
          on(_event: string, registered: typeof handler) {
            handler = registered;
          },
        } as unknown as ExtensionAPI,
        "finder",
      );

      await expect(
        handler?.({
          toolName: "finder",
          details: { lifecycle: { status: "failed" } },
        }),
      ).resolves.toEqual({ isError: true });
      await expect(
        handler?.({
          toolName: "finder",
          details: { lifecycle: { status: "succeeded" }, exitCode: 0 },
        }),
      ).resolves.toBeUndefined();
      await expect(
        handler?.({
          toolName: "read",
          details: { lifecycle: { status: "failed" } },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("formatUsageStats", () => {
    it("formats all fields when present", () => {
      const result = formatUsageStats(
        {
          input: 1500,
          output: 500,
          cacheRead: 2000,
          cacheWrite: 1000,
          cost: 0.0023,
          contextTokens: 5000,
          turns: 2,
        },
        "gpt-4",
      );

      expect(result).toContain("2 turns");
      expect(result).toContain("↑1.5k");
      expect(result).toContain("↓500");
      expect(result).toContain("R2.0k");
      expect(result).toContain("W1.0k");
      expect(result).toContain("$0.0023");
      expect(result).toContain("ctx:5.0k");
      expect(result).toContain("gpt-4");
    });

    it("omits zero/undefined fields", () => {
      const result = formatUsageStats({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      });

      expect(result).toContain("↑100");
      expect(result).toContain("↓50");
      expect(result).not.toContain("turn");
      expect(result).not.toContain("R");
      expect(result).not.toContain("W");
      expect(result).not.toContain("$");
      expect(result).not.toContain("ctx");
    });

    it("formats large token counts", () => {
      expect(
        formatUsageStats({
          input: 1500000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }),
      ).toContain("↑1.5M");
      expect(
        formatUsageStats({
          input: 15000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }),
      ).toContain("↑15k");
      expect(
        formatUsageStats({
          input: 1500,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }),
      ).toContain("↑1.5k");
      expect(
        formatUsageStats({
          input: 500,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }),
      ).toContain("↑500");
    });

    it("handles single turn", () => {
      const result = formatUsageStats({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      });
      expect(result).toContain("1 turn");
      expect(result).not.toContain("1 turns");
    });

    it("handles plural turns", () => {
      const result = formatUsageStats({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 3,
      });
      expect(result).toContain("3 turns");
    });
  });

  describe("getFinalOutput", () => {
    it("returns text from last assistant message", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 0,
        } as Message,
        {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        } as Message,
        {
          role: "user",
          content: [{ type: "text", text: "more" }],
          timestamp: 0,
        } as Message,
        {
          role: "assistant",
          content: [{ type: "text", text: "final response" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        } as Message,
      ];

      expect(getFinalOutput(messages)).toBe("final response");
    });

    it("returns empty string when no assistant messages", () => {
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 0,
        } as Message,
      ];

      expect(getFinalOutput(messages)).toBe("");
    });

    it("skips tool calls, returns only text", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc1",
              name: "bash",
              arguments: { cmd: "ls" },
            },
            { type: "text", text: "here's the output" },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        } as Message,
      ];

      expect(getFinalOutput(messages)).toBe("here's the output");
    });

    it("handles empty message array", () => {
      expect(getFinalOutput([])).toBe("");
    });
  });

  describe("getDisplayItems", () => {
    it("extracts text and tool calls from messages", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "q" }] } as Message,
        {
          role: "assistant",
          content: [
            { type: "text", text: "response" },
            {
              type: "toolCall",
              id: "tc1",
              name: "read",
              arguments: { path: "/file" },
            },
          ],
        } as Message,
        {
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "file content" }],
        } as Message,
      ];

      const items = getDisplayItems(messages);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ type: "text", text: "response" });
      expect(items[1]).toEqual({
        type: "toolCall",
        id: "tc1",
        name: "read",
        args: { path: "/file" },
        isError: undefined,
      });
    });

    it("marks tool calls as error when toolResult has isError", () => {
      const messages: Message[] = [
        assistantMessage([
          {
            type: "toolCall",
            id: "tc1",
            name: "bash",
            arguments: { cmd: "false" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "error" }],
          isError: true,
        } as Message,
      ];

      const items = getDisplayItems(messages);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "toolCall",
        id: "tc1",
        isError: true,
      });
    });

    it("marks tool calls as success when isError is false", () => {
      const messages: Message[] = [
        assistantMessage([
          {
            type: "toolCall",
            id: "tc1",
            name: "bash",
            arguments: { cmd: "true" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "tc1",
          content: [{ type: "text", text: "done" }],
          isError: false,
        } as Message,
      ];

      const items = getDisplayItems(messages);

      expect(items[0]).toMatchObject({
        type: "toolCall",
        id: "tc1",
        isError: false,
      });
    });

    it("handles multiple assistant messages", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        } as Message,
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude",
          usage: {
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        } as Message,
      ];

      const items = getDisplayItems(messages);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ type: "text", text: "first" });
      expect(items[1]).toEqual({ type: "text", text: "second" });
    });
  });

  describe("subAgentResult", () => {
    it("builds result with cost from usage", () => {
      const details = {
        agent: "finder",
        task: "search for x",
        exitCode: 0,
        messages: [] as Message[],
        usage: {
          turns: 1,
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.002,
          contextTokens: 0,
        },
        model: "gemini-flash",
      };

      const result = subAgentResult("found it", details);

      expect(result.content).toEqual([{ type: "text", text: "found it" }]);
      expect(result.details.cost).toBe(0.002);
      expect(result.details.model).toBe("gemini-flash");
      expect(result.usage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.002,
        },
      });
      expect(result.isError).toBeUndefined();
    });

    it("sets isError when passed true", () => {
      const details = {
        agent: "oracle",
        task: "advise",
        exitCode: 1,
        messages: [] as Message[],
        usage: {
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
        },
      };

      const result = subAgentResult("failed", details, true);

      expect(result.isError).toBe(true);
    });
  });
}
