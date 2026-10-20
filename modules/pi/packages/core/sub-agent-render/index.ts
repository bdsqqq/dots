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
import {
  modelCliString,
  isPiSpawnModelValue,
  toToolUsage,
  type PiSpawnModel,
  type PiSpawnLifecycle,
  type PiSpawnSessionMeta,
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
  lifecycle?: PiSpawnLifecycle;
}

type CompactAgentMessage = {
  role: "assistant";
  content: [{ type: "text"; text: string }];
};

export interface SharedAgentResultRecord {
  agent: string;
  task: string;
  model: string;
  exitCode?: number;
  finished: boolean;
  stopReason?: string;
  errorMessage?: string;
  messages: CompactAgentMessage[];
}

/** presentation opt-in only; piSpawn still owns execution and continuation. */
export interface SharedAgentResultDetails extends ToolCostDetails {
  kind: "pi.subagent";
  results: SharedAgentResultRecord[];
  pi: {
    toolCalls: ToolDisplayItem[];
    usage: UsageStats;
    lifecycle?: PiSpawnLifecycle;
    continueId?: string;
    sessionId?: string;
    sessionFile?: string;
    leafId?: string;
  };
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
}

export function getFinalOutput(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      continue;
    for (const part of message.content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
    }
  }
  return "";
}

export function getDisplayItems(messages: unknown[]): DisplayItem[] {
  const errorMap = new Map<string, boolean>();
  for (const msg of messages) {
    if (
      isRecord(msg) &&
      msg.role === "toolResult" &&
      typeof msg.toolCallId === "string" &&
      typeof msg.isError === "boolean"
    ) {
      errorMap.set(msg.toolCallId, msg.isError);
    }
  }

  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (
      isRecord(msg) &&
      msg.role === "assistant" &&
      Array.isArray(msg.content)
    ) {
      for (const part of msg.content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string")
          items.push({ type: "text", text: part.text });
        else if (
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string" &&
          isRecord(part.arguments)
        ) {
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
  details: SharedAgentResultDetails;
  usage: Usage;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text }],
    details: createSharedAgentResultDetails(
      text,
      details,
      "completed",
      isError,
    ),
    usage: toToolUsage(details.usage),
    ...(isError && { isError: true }),
  };
}

/**
 * snapshots the display state before the live child transcript is released.
 * upstream's reader only inspects assistant text on success and errorMessage
 * on failure, so persisting the raw transcript is unnecessary and leaks tools.
 */
export function createSharedAgentResultDetails(
  text: string,
  source: SingleResult,
  phase: "progress" | "completed",
  isError = false,
): SharedAgentResultDetails {
  const transcript = source.messages ?? [];
  // keep routing trailers in model-facing content, not in the child's display text.
  const output = source.output ?? (getFinalOutput(transcript) || text);
  const errorMessage = source.errorMessage ?? (isError ? text : undefined);
  const record: SharedAgentResultRecord = {
    agent: source.agent,
    task: source.task,
    model: source.model ? modelCliString(source.model) : "",
    // the live -1 sentinel is not an exit: receivers treat nonzero as failure.
    ...(phase === "completed" && { exitCode: source.exitCode }),
    finished: phase === "completed",
    ...(source.lifecycle?.status === "cancelled"
      ? { stopReason: "aborted" }
      : source.stopReason !== undefined && { stopReason: source.stopReason }),
    ...(errorMessage !== undefined && { errorMessage }),
    messages: [
      { role: "assistant", content: [{ type: "text", text: output }] },
    ],
  };
  const pi: SharedAgentResultDetails["pi"] = {
    toolCalls: cloneToolCalls(
      source.toolCalls ?? getToolDisplayItems(transcript),
    ),
    usage: {
      ...source.usage,
      ...(source.usage.costBreakdown && {
        costBreakdown: { ...source.usage.costBreakdown },
      }),
    },
    ...(source.lifecycle && {
      lifecycle: {
        ...source.lifecycle,
        ...(source.lifecycle.owner && { owner: { ...source.lifecycle.owner } }),
      },
    }),
    ...(source.continueId !== undefined && { continueId: source.continueId }),
    ...(source.sessionId !== undefined && { sessionId: source.sessionId }),
    ...(source.sessionFile !== undefined && {
      sessionFile: source.sessionFile,
    }),
    ...(source.leafId !== undefined && { leafId: source.leafId }),
  };
  return {
    kind: "pi.subagent",
    results: [record],
    pi,
    cost: source.usage.cost,
  };
}

function cloneToolCalls(items: ToolDisplayItem[]): ToolDisplayItem[] {
  return items.map((item) => ({ ...item }));
}

/** builds a detached progress snapshot using the same persisted contract. */
export function subAgentProgress(
  text: string,
  details: SingleResult,
): {
  content: { type: "text"; text: string }[];
  details: SharedAgentResultDetails;
} {
  return {
    content: [{ type: "text", text }],
    details: createSharedAgentResultDetails(text, details, "progress"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactOutput(record: SharedAgentResultRecord): string {
  return record.messages.at(-1)?.content[0]?.text ?? "";
}

function isSharedAgentResultRecord(
  value: unknown,
): value is SharedAgentResultRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.agent === "string" &&
    typeof value.task === "string" &&
    typeof value.model === "string" &&
    (value.exitCode === undefined || typeof value.exitCode === "number") &&
    typeof value.finished === "boolean" &&
    (!value.finished || typeof value.exitCode === "number") &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.length === 1 &&
        message.content.every(
          (part) =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string",
        ),
    ) &&
    (value.stopReason === undefined || typeof value.stopReason === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}

function isUsageStats(value: unknown): value is UsageStats {
  if (!isRecord(value)) return false;
  const costBreakdown = value.costBreakdown;
  return (
    [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cost",
      "contextTokens",
      "turns",
    ].every((key) => typeof value[key] === "number") &&
    (costBreakdown === undefined ||
      (isRecord(costBreakdown) &&
        ["input", "output", "cacheRead", "cacheWrite", "total"].every(
          (key) => typeof costBreakdown[key] === "number",
        ))) &&
    ["cacheWrite1h", "reasoning"].every(
      (key) => value[key] === undefined || typeof value[key] === "number",
    )
  );
}

function isToolDisplayItem(value: unknown): value is ToolDisplayItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.summary === "string" &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function isLifecycle(value: unknown): value is PiSpawnLifecycle {
  if (!isRecord(value)) return false;
  const owner = value.owner;
  const errorKinds = [
    "unsupported",
    "setup",
    "spawn",
    "agent",
    "exit",
    "signal",
    "transport",
    "cancelled",
    "timeout",
  ];
  return (
    typeof value.startedAt === "string" &&
    ["pid", "processGroupId", "exitCode", "timeoutMs"].every(
      (key) => value[key] === null || typeof value[key] === "number",
    ) &&
    ["endedAt", "signal", "cancellationRequestedAt", "timedOutAt"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    (owner === null ||
      (isRecord(owner) &&
        ["sessionId", "sessionFile", "toolCallId", "toolName"].every(
          (key) => owner[key] === undefined || typeof owner[key] === "string",
        ))) &&
    (value.errorKind === null ||
      errorKinds.includes(String(value.errorKind))) &&
    [
      "starting",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
    ].includes(String(value.status))
  );
}

function isSharedAgentResultDetails(
  value: unknown,
): value is SharedAgentResultDetails {
  if (!isRecord(value) || value.kind !== "pi.subagent") return false;
  if (!Array.isArray(value.results) || value.results.length !== 1) return false;
  if (!isSharedAgentResultRecord(value.results[0]) || !isRecord(value.pi))
    return false;
  const pi = value.pi;
  return (
    Array.isArray(pi.toolCalls) &&
    pi.toolCalls.every(isToolDisplayItem) &&
    isUsageStats(pi.usage) &&
    typeof value.cost === "number" &&
    (pi.lifecycle === undefined || isLifecycle(pi.lifecycle)) &&
    ["continueId", "sessionId", "sessionFile", "leafId"].every(
      (key) => pi[key] === undefined || typeof pi[key] === "string",
    )
  );
}

/** reads the shared envelope or an older persisted flat Pi result safely. */
export function readSubAgentResult(value: unknown): SingleResult | undefined {
  if (!isRecord(value)) return undefined;
  if ("kind" in value) {
    if (value.kind !== "pi.subagent") return undefined;
    if (!isSharedAgentResultDetails(value)) return undefined;
    const record = value.results[0]!;
    const pi = value.pi;
    return {
      agent: record.agent,
      task: record.task,
      model: record.model,
      exitCode: record.exitCode ?? -1,
      stopReason: record.stopReason,
      errorMessage: record.errorMessage,
      output: compactOutput(record),
      toolCalls: cloneToolCalls(pi.toolCalls),
      usage: { ...pi.usage },
      lifecycle: pi.lifecycle && { ...pi.lifecycle },
      continueId: pi.continueId,
      sessionId: pi.sessionId,
      sessionFile: pi.sessionFile,
      leafId: pi.leafId,
    };
  }
  const legacyUsage = value.usage;
  if (
    typeof value.agent === "string" &&
    typeof value.task === "string" &&
    typeof value.exitCode === "number" &&
    isUsageStats(legacyUsage)
  ) {
    const output =
      typeof value.output === "string"
        ? value.output
        : getFinalOutput(Array.isArray(value.messages) ? value.messages : []);
    const lifecycle = isLifecycle(value.lifecycle)
      ? value.lifecycle
      : undefined;
    return {
      agent: value.agent,
      task: value.task,
      exitCode: value.exitCode,
      output,
      toolCalls: Array.isArray(value.toolCalls)
        ? value.toolCalls.filter(isToolDisplayItem).map((item) => ({ ...item }))
        : getToolDisplayItems(
            Array.isArray(value.messages) ? value.messages : [],
          ),
      usage: { ...legacyUsage },
      model: isPiSpawnModelValue(value.model) ? value.model : undefined,
      stopReason:
        typeof value.stopReason === "string" ? value.stopReason : undefined,
      errorMessage:
        typeof value.errorMessage === "string" ? value.errorMessage : undefined,
      continueId:
        typeof value.continueId === "string" ? value.continueId : undefined,
      sessionId:
        typeof value.sessionId === "string" ? value.sessionId : undefined,
      sessionFile:
        typeof value.sessionFile === "string" ? value.sessionFile : undefined,
      leafId: typeof value.leafId === "string" ? value.leafId : undefined,
      lifecycle,
    };
  }
  return undefined;
}

export function registerSubAgentErrorNormalization(
  pi: ExtensionAPI,
  toolName: string,
): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== toolName) return;
    const details = readSubAgentResult(event.details);
    const raw =
      isRecord(event.details) && !("kind" in event.details)
        ? event.details
        : undefined;
    const lifecycle =
      details?.lifecycle ??
      (raw &&
      isRecord(raw.lifecycle) &&
      ["failed", "cancelled", "timed_out"].includes(
        String(raw.lifecycle.status),
      )
        ? { status: raw.lifecycle.status }
        : undefined);
    const status = lifecycle?.status;
    if (
      status === "failed" ||
      status === "cancelled" ||
      status === "timed_out" ||
      (typeof (details?.exitCode ?? raw?.exitCode) === "number" &&
        (details?.exitCode ?? raw?.exitCode) !== 0) ||
      (details?.stopReason ?? raw?.stopReason) === "error" ||
      (details?.stopReason ?? raw?.stopReason) === "aborted"
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
    // Retired tools still appear in recorded child transcripts.
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

export function getToolDisplayItems(messages: unknown[]): ToolDisplayItem[] {
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

export function renderSubAgentFallback(result: any, _theme: any): Component {
  const text =
    trimBlankLines(
      result.content
        ?.filter(
          (part: any) => part.type === "text" && typeof part.text === "string",
        )
        .map((part: any) => part.text)
        .join("\n") ?? "",
    ) || "(no output)";
  return new Text(text, 0, 0);
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
        summary?: "tree" | "plain";
      },
): void {
  const fg = theme.fg.bind(theme);
  const opts =
    typeof labelOrOpts === "string"
      ? {
          label: labelOrOpts,
          header: "full" as const,
          summary: "plain" as const,
        }
      : {
          label: labelOrOpts?.label,
          header: labelOrOpts?.header ?? ("full" as const),
          summary: labelOrOpts?.summary ?? ("plain" as const),
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
  if (opts.header === "full") {
    let header = fg("toolTitle", theme.bold(opts.label ?? r.agent));
    if (isError && errorLabel) header += ` ${fg("error", `[${errorLabel}]`)}`;
    container.addChild(new Text(header, 0, 0));
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
  const plainSummary =
    opts.summary === "plain"
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

  if (children.length === 0 && !plainSummary) {
    container.addChild(
      new MarkerColumn(END, new Text(fg("muted", "(no output)"), 0, 0)),
    );
  } else {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const isLast = i === children.length - 1 && !plainSummary;
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
      plainSummary
        ? new MarkerColumn(CONT, hint, { continuationMarker: CONT })
        : hint,
    );
  }

  if (plainSummary) {
    // The parent tool shell owns continuation markers and its single footer.
    container.addChild(new Markdown(plainSummary, 0, 0, mdTheme));
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

    it("returns detail-less content without a parent frame", () => {
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
        "first line",
        "second line",
      ]);
    });

    it("returns markdown summary content without a parent frame", () => {
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
        "summary line one",
        "summary line two",
      ]);
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
        "(no output)",
      ]);
    });
  });

  describe("installed sub-agent tool shell", () => {
    it("owns parent status, expansion, padding and one footer for all six renderers", async () => {
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const { pathToFileURL } = await import("node:url");
      const load = (path: string) =>
        import(pathToFileURL(`${getPackageDir()}/dist/${path}`).href);
      const { initTheme } = await load("modes/interactive/theme/theme.js");
      initTheme("dark", false);
      const { ToolExecutionComponent } = await load(
        "modes/interactive/components/tool-execution.js",
      );
      const tools = [
        (
          await import("../../extensions/code-review/index.js")
        ).createCodeReviewTool(),
        (
          await import("../../extensions/delegate/index.js")
        ).createDelegateTool(),
        (await import("../../extensions/finder/index.js")).createFinderTool(),
        (
          await import("../../extensions/librarian/index.js")
        ).createLibrarianTool(),
        (await import("../../extensions/look-at/index.js")).createLookAtTool(),
        (await import("../../extensions/oracle/index.js")).createOracleTool(),
      ];
      const args = {
        diff_description: "fixture review",
        description: "fixture delegate",
        query: "fixture query",
        path: "fixture.png",
        task: "fixture oracle",
      };
      for (const tool of tools) {
        expect(tool).not.toHaveProperty("renderShell");
        const callContent = tool.renderCall!(args, mockTheme as any, {} as any);
        expect(callContent.render(80).join("\n")).not.toMatch(/[●✓✕│╰]/);
        const component = new ToolExecutionComponent(
          tool.name,
          "fixture-call",
          args,
          {},
          tool,
          { requestRender() {} },
          process.cwd(),
        );
        const rows = () => component.render(80).map(stripTerminalSequences);
        expect(rows().join("\n")).toContain("●");
        expect(rows().join("\n")).not.toContain("╰────");
        const source: SingleResult = {
          agent: tool.name,
          task: "expanded task details",
          exitCode: 0,
          output: "**markdown summary**",
          toolCalls: Array.from({ length: 11 }, (_, index) => ({
            id: `child-${index}`,
            name: "read",
            summary: `child-${index}.ts`,
            isError: index === 1,
          })),
          model: "fixture/model",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            contextTokens: 1,
            turns: 1,
          },
        };
        component.markExecutionStarted();
        component.updateResult(
          subAgentProgress("working", { ...source, exitCode: -1 }),
          true,
        );
        expect(rows()[1]).toContain("●");
        component.updateResult(subAgentResult("answer", source));
        let text = rows().join("\n");
        expect(text).toContain("✓");
        expect(
          rows().filter((line: string) => line.includes("╰────")),
        ).toHaveLength(1);
        expect(text).toContain("│ ├ ✕ Read child-1.ts");
        expect(text).toContain("…1 earlier calls");
        expect(text).not.toContain("child-0.ts");
        expect(text).not.toContain("expanded task details");
        expect(text).toContain("markdown summary");
        expect(text).toContain("fixture/model");
        component.setExpanded(true);
        text = rows().join("\n");
        expect(text).toContain("expanded task details");
        expect(text).toContain("child-0.ts");
        for (const status of ["failed", "cancelled", "timed_out"] as const) {
          const failedSource: SingleResult = {
            ...source,
            exitCode: 1,
            errorMessage: status,
            lifecycle: {
              status,
              errorKind:
                status === "timed_out"
                  ? "timeout"
                  : status === "cancelled"
                    ? "cancelled"
                    : "agent",
              pid: null,
              processGroupId: null,
              owner: null,
              startedAt: "2026-10-19T00:00:00.000Z",
              endedAt: "2026-10-19T00:00:01.000Z",
              exitCode: 1,
              signal: null,
              cancellationRequestedAt: null,
              timeoutMs: status === "timed_out" ? 1000 : null,
              timedOutAt:
                status === "timed_out" ? "2026-10-19T00:00:01.000Z" : null,
            },
          };
          const failure = subAgentResult("child failed", failedSource, true);
          expect(readSubAgentResult(failure.details)?.lifecycle?.status).toBe(
            status,
          );
          let normalize: any;
          registerSubAgentErrorNormalization(
            {
              on(_event: string, handler: unknown) {
                normalize = handler;
              },
            } as unknown as ExtensionAPI,
            tool.name,
          );
          await expect(
            normalize({ toolName: tool.name, details: failure.details }),
          ).resolves.toEqual({ isError: true });
          component.updateResult(failure);
          expect(rows()[1]).toContain("✕");
          expect(rows().join("\n")).toContain(status);
          expect(
            rows().filter((line: string) => line.includes("╰────")),
          ).toHaveLength(1);
        }
        component.setOutputPad(3);
        expect(rows().some((line: string) => line.startsWith("   ✕"))).toBe(
          true,
        );
        for (const width of [0, 1, 2, 3, 8, 20, 40]) {
          expect(
            component
              .render(width)
              .every((line: string) => visibleWidth(line) <= width),
          ).toBe(true);
        }
        component.updateResult({
          content: [{ type: "text", text: "fallback text" }],
          details: undefined,
        });
        expect(rows().join("\n")).toContain("│ fallback text");
        expect(
          rows().filter((line: string) => line.includes("╰────")),
        ).toHaveLength(1);
      }
    });

    it("leaves messaging and history tools on native fallback", async () => {
      const { createAgentMessageTool } =
        await import("../../extensions/agent-message/index.js");
      const { default: history } =
        await import("../../extensions/session-history/index.js");
      const tools: any[] = [
        createAgentMessageTool({ queueDir: "/unused", sessionsDirs: [] }),
      ];
      history({
        registerTool: (tool: unknown) => tools.push(tool),
        on() {},
      } as unknown as ExtensionAPI);
      expect(tools.map((tool) => tool.name)).toEqual([
        "agent_message",
        "history_list",
        "history_read",
      ]);
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const { pathToFileURL } = await import("node:url");
      const { initTheme } = await import(
        pathToFileURL(
          `${getPackageDir()}/dist/modes/interactive/theme/theme.js`,
        ).href
      );
      initTheme("dark", false);
      const { ToolExecutionComponent } = await import(
        pathToFileURL(
          `${getPackageDir()}/dist/modes/interactive/components/tool-execution.js`,
        ).href
      );
      for (const tool of tools) {
        expect(tool).not.toHaveProperty("renderShell");
        expect(tool).not.toHaveProperty("renderCall");
        expect(tool).not.toHaveProperty("renderResult");
        const component = new ToolExecutionComponent(
          tool.name,
          "fixture-call",
          {},
          {},
          tool,
          { requestRender() {} },
          process.cwd(),
        );
        component.updateResult({
          content: [{ type: "text", text: "native fallback output" }],
          details: undefined,
        });
        const rows: string[] = component.render(80).map(stripTerminalSequences);
        expect(rows[1]).toContain("✓");
        expect(rows.join("\n")).toContain("│ native fallback output");
        expect(rows.filter((line) => line.includes("╰────"))).toHaveLength(1);
      }
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
      await expect(
        handler?.({
          toolName: "finder",
          details: {
            kind: "pi.subagent",
            exitCode: 1,
            lifecycle: { status: "failed" },
          },
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
      expect(result.details.kind).toBe("pi.subagent");
      expect(result.details.results[0]).toEqual({
        agent: "finder",
        task: "search for x",
        model: "gemini-flash",
        exitCode: 0,
        finished: true,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "found it" }] },
        ],
      });
      expect(result.details.pi.toolCalls).toEqual([]);
      expect(result.details.cost).toBe(0.002);
      expect(result.details.pi.usage.cost).toBe(0.002);
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
      expect(result.details.results[0]?.messages[0]?.content[0]?.text).toBe(
        "final answer",
      );
      expect(result.details.pi.toolCalls).toEqual([
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

    it("copies compact text and render state so later progress cannot rewrite a snapshot", () => {
      const liveMessages: Message[] = [
        assistantMessage([{ type: "text", text: "first" }]),
      ];
      const live: SingleResult = {
        agent: "delegate",
        task: "inspect safely",
        exitCode: -1,
        messages: liveMessages,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 1,
          turns: 1,
        },
        model: "openai-codex/gpt-6.1-sol",
      };
      const snapshot = subAgentProgress("first", live);
      liveMessages[0] = assistantMessage([{ type: "text", text: "later" }]);
      live.usage.cost = 2;

      expect(snapshot.details.results[0]?.messages[0]?.content[0]?.text).toBe(
        "first",
      );
      expect(snapshot.details.results[0]?.finished).toBe(false);
      expect(snapshot.details.results[0]).not.toHaveProperty("exitCode");
      expect(readSubAgentResult(snapshot.details)?.exitCode).toBe(-1);
      expect(snapshot.details.pi.usage.cost).toBe(0.01);
      expect(snapshot.details.results[0]?.model).toBe(
        "openai-codex/gpt-6.1-sol",
      );
    });
  });

  describe("readSubAgentResult", () => {
    it("reads old persisted flat details and rejects malformed marker data", () => {
      const legacy = {
        agent: "finder",
        task: "search",
        exitCode: 0,
        output: "old answer",
        toolCalls: [],
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.03,
          contextTokens: 2,
          turns: 1,
        },
      };
      expect(readSubAgentResult(legacy)?.output).toBe("old answer");
      expect(
        readSubAgentResult({
          ...legacy,
          output: undefined,
          messages: [
            assistantMessage([{ type: "text", text: "first thought" }]),
            assistantMessage([{ type: "text", text: "last answer" }]),
          ],
        })?.output,
      ).toBe("last answer");
      expect(
        readSubAgentResult({
          kind: "pi.subagent",
          results: [{ agent: "spoof" }],
        }),
      ).toBeUndefined();
      expect(
        readSubAgentResult({
          kind: "pi.subagent",
          results: [
            {
              agent: "finder",
              task: "search",
              model: "m",
              exitCode: 0,
              messages: [],
            },
          ],
          pi: { toolCalls: [], usage: legacy.usage },
          cost: 0,
        }),
      ).toBeUndefined();
      expect(
        readSubAgentResult({ kind: "other", agent: "spoof" }),
      ).toBeUndefined();
      const oldTranscript = {
        ...legacy,
        output: undefined,
        toolCalls: undefined,
        messages: [
          assistantMessage([
            {
              type: "toolCall",
              id: "old-read",
              name: "read",
              arguments: { path: "src/main.ts" },
            },
          ]),
          { role: "toolResult", toolCallId: "old-read", isError: false },
          assistantMessage([{ type: "text", text: "legacy final" }]),
        ],
      };
      const old = readSubAgentResult(oldTranscript);
      expect(old?.toolCalls).toEqual([
        {
          id: "old-read",
          name: "read",
          summary: "src/main.ts",
          isError: false,
        },
      ]);
      const rendered = new Container();
      renderAgentTree(old!, rendered, true, mockTheme, { header: "none" });
      expect(rendered.render(60).join("\n")).toContain("src/main.ts");
      expect(rendered.render(60).join("\n")).toContain("legacy final");
    });

    it("keeps upstream-readable success and diagnostic text while retaining Pi views", () => {
      const details: SingleResult = {
        agent: "finder",
        task: "find entry point",
        exitCode: 0,
        messages: [assistantMessage([{ type: "text", text: "src/main.ts" }])],
        usage: {
          input: 5,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: 0.004,
          contextTokens: 6,
          turns: 1,
        },
        model: "fixture/model",
        toolCalls: [{ id: "read-1", name: "read", summary: "src/main.ts" }],
      };
      const result = subAgentResult("src/main.ts", details);
      const read = readSubAgentResult(result.details);
      expect(result.details.results[0]?.messages[0]?.content[0]?.text).toBe(
        "src/main.ts",
      );
      expect(result.details.results[0]?.finished).toBe(true);
      expect(read?.output).toBe("src/main.ts");
      const routed = subAgentResult(
        "src/main.ts\\ncontinue: opaque-route",
        details,
      );
      expect(routed.content[0]?.text).toContain("continue: opaque-route");
      expect(readSubAgentResult(routed.details)?.output).toBe("src/main.ts");
      expect(read?.toolCalls).toEqual(details.toolCalls);
      expect(read?.usage.cost).toBe(0.004);

      const failure = subAgentResult(
        "child exited early",
        {
          ...details,
          exitCode: 1,
          errorMessage: undefined,
          stopReason: "aborted",
        },
        true,
      );
      expect(failure.details.results[0]?.errorMessage).toBe(
        "child exited early",
      );
      expect(readSubAgentResult(failure.details)?.output).toBe("src/main.ts");

      const cancelled = subAgentResult(
        "child cancelled",
        {
          ...details,
          exitCode: -1,
          stopReason: undefined,
          lifecycle: {
            pid: null,
            processGroupId: null,
            owner: null,
            startedAt: "2026-10-19T00:00:00.000Z",
            endedAt: null,
            status: "cancelled",
            exitCode: null,
            signal: null,
            errorKind: "cancelled",
            cancellationRequestedAt: "2026-10-19T00:00:01.000Z",
            timeoutMs: null,
            timedOutAt: null,
          },
        },
        true,
      );
      expect(cancelled.details.pi.lifecycle?.status).toBe("cancelled");
      expect(readSubAgentResult(cancelled.details)?.stopReason).toBe("aborted");
    });

    it("renders the envelope in collapsed and expanded Pi views", () => {
      const details = readSubAgentResult(
        subAgentResult("answer", {
          agent: "oracle",
          task: "explain the call path",
          exitCode: 0,
          messages: [],
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.001,
            contextTokens: 2,
            turns: 1,
          },
          model: "fixture/model",
        }).details,
      );
      if (!details) throw new Error("expected a valid shared result");

      const collapsed = new Container();
      renderAgentTree(details, collapsed, false, mockTheme, { header: "none" });
      expect(collapsed.render(40).join("\n")).toContain("answer");

      const expanded = new Container();
      renderAgentTree(details, expanded, true, mockTheme, { header: "none" });
      expect(expanded.render(40).join("\n")).toContain("explain the call path");
      expect(expanded.render(40).join("\n")).toContain("$0.0010");
    });
  });
}
