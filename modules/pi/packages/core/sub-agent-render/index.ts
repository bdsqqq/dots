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
import { boxBottom } from "@bds_pi/box-chrome";
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

export type ToolDisplayItem = {
  id: string;
  name: string;
  summary: string;
  isError?: boolean;
};

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  /** Present only while a child is running and when reading legacy results. */
  messages?: Message[];
  /** Durable rendering state derived before the child transcript is released. */
  output?: string;
  toolCalls?: ToolDisplayItem[];
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
  const { messages, ...metadata } = details;
  const transcript = messages ?? [];
  return {
    content: [{ type: "text" as const, text }],
    details: {
      ...metadata,
      output: details.output ?? getFinalOutput(transcript),
      toolCalls: details.toolCalls ?? getToolDisplayItems(transcript),
      cost: details.usage.cost,
    },
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

const TOOL_SUMMARY_MAX_CHARS = 500;

export function getToolDisplayItems(messages: Message[]): ToolDisplayItem[] {
  return getDisplayItems(messages).flatMap((item) => {
    if (item.type !== "toolCall") return [];
    const rawSummary = toolArgSummary(item.name, item.args);
    const summary =
      rawSummary.length <= TOOL_SUMMARY_MAX_CHARS
        ? rawSummary
        : `${rawSummary.slice(0, TOOL_SUMMARY_MAX_CHARS - 1)}…`;
    return [
      {
        id: item.id,
        name: item.name,
        summary,
        isError: item.isError,
      },
    ];
  });
}

export function getResultOutput(result: SingleResult): string {
  return result.output ?? getFinalOutput(result.messages ?? []);
}

function renderToolLine(
  item: ToolDisplayItem,
  fg: (color: any, text: string) => string,
): string {
  const icon =
    item.isError === true
      ? fg("error", "✕")
      : item.isError === false
        ? fg("success", "✓")
        : fg("muted", "⋯");
  return `${icon} ${fg("accent", toolLabel(item.name))} ${fg("dim", item.summary)}`;
}

// --- tree rendering ---

const COLLAPSED_ITEM_COUNT = 10;
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

function trimBlankLines(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

function openFrame(
  child: Component,
  fg: (color: any, text: string) => string,
): Component {
  const marker = fg("muted", "│");
  return new MarkerColumn(marker, child, {
    continuationMarker: marker,
    footerMarker: boxBottom({
      variant: "open",
      style: { dim: (text) => fg("muted", text) },
    }),
  });
}

export function renderSubAgentFallback(result: any, theme: any): Component {
  const text =
    trimBlankLines(
      result.content
        ?.filter(
          (part: any) => part.type === "text" && typeof part.text === "string",
        )
        .map((part: any) => part.text)
        .join("\n") ?? "",
    ) || "(no output)";
  return openFrame(new Text(text, 0, 0), theme.fg.bind(theme));
}

class SubAgentCallComponent implements Component {
  private row: MarkerColumn;
  private icon: string;
  private content: string;

  constructor(icon: string, content: string) {
    this.icon = icon;
    this.content = content;
    this.row = new MarkerColumn(icon, new Text(content, 0, 0));
  }

  update(icon: string, content: string): void {
    if (this.icon !== icon) {
      this.icon = icon;
      this.row.setMarker(icon);
    }
    if (this.content !== content) {
      this.content = content;
      this.row.setChild(new Text(content, 0, 0));
    }
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
  const active = context.isPartial && !context.isError;

  const icon = context.isError
    ? theme.fg("error", "✕")
    : active
      ? theme.fg("accent", "●")
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
          summary: "open-box" as const,
        }
      : {
          label: labelOrOpts?.label,
          header: labelOrOpts?.header ?? ("full" as const),
          summary: labelOrOpts?.summary ?? ("open-box" as const),
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

  const toolCalls = r.toolCalls ?? getToolDisplayItems(r.messages ?? []);
  const finalOutput = getResultOutput(r);
  const boxedSummary =
    opts.summary === "open-box"
      ? trimBlankLines(finalOutput) || "(no output)"
      : undefined;

  type TreeChild =
    | { kind: "text"; content: string }
    | { kind: "tool"; item: ToolDisplayItem }
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
      openFrame(new Markdown(boxedSummary, 0, 0, mdTheme), fg),
    );
  }

  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) container.addChild(new Text(fg("dim", usageStr), 0, 0));
}

// --- inline tests ---

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
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
    it("removes surrounding blank lines without changing Markdown indentation", () => {
      expect(trimBlankLines("\n \n    code\n\n")).toBe("    code");
    });

    it("closes detail-less sub-agent results with one shared frame", () => {
      const component = renderSubAgentFallback(
        {
          content: [
            { type: "text", text: "first line" },
            { type: "text", text: "second line" },
          ],
        },
        mockTheme,
      );

      expect(component.render(40).map((line) => line.trimEnd())).toEqual([
        "│ first line",
        "│ second line",
        "╰────",
      ]);
    });

    it("closes final output with the shared open frame by default", () => {
      const result: SingleResult = {
        agent: "delegate",
        task: "summarize",
        exitCode: 0,
        messages: [
          assistantMessage([
            { type: "text", text: "summary line one\nsummary line two" },
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

      renderAgentTree(result, container, false, mockTheme, { header: "none" });

      expect(container.render(40).map((line) => line.trimEnd())).toEqual([
        "│ summary line one",
        "│ summary line two",
        "╰────",
      ]);
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

    it("keeps active calls static and reuses their component", () => {
      const colors: string[] = [];
      const theme = {
        fg: (color: string, text: string) => {
          if (text === "●") colors.push(color);
          return text;
        },
      };
      const first = renderSubAgentCall("Delegate task", theme, {
        isError: false,
        isPartial: true,
      });
      const second = renderSubAgentCall("Delegate task", theme, {
        isError: false,
        isPartial: true,
        lastComponent: first,
      });

      expect(second).toBe(first);
      expect(colors).toEqual(["accent", "accent"]);
      expect(second.render(80)[0]?.trimEnd()).toBe("● Delegate task");
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
        summary: "tree",
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
        "│ (no output)",
        "╰────",
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
      expect(result.details).not.toHaveProperty("messages");
      expect(result.details.output).toBe("");
      expect(result.details.toolCalls).toEqual([]);
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

    it("keeps compact render data instead of the child transcript", () => {
      const details: SingleResult = {
        agent: "finder",
        task: "inspect",
        exitCode: 0,
        messages: [
          assistantMessage([
            {
              type: "toolCall",
              id: "tc1",
              name: "read",
              arguments: { path: "/tmp/example.ts" },
            },
          ]),
          assistantMessage([{ type: "text", text: "final answer" }]),
        ],
        usage: {
          turns: 1,
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
        },
      };

      const result = subAgentResult("final answer", details);

      expect(result.details).not.toHaveProperty("messages");
      expect(result.details.output).toBe("final answer");
      expect(result.details.toolCalls).toEqual([
        {
          id: "tc1",
          name: "read",
          summary: "/tmp/example.ts",
          isError: undefined,
        },
      ]);
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
