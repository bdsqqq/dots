import { normalizeTranscript } from "@letta-ai/trajectory";
import { sha256 } from "./catalog.js";
import type { EvidenceRef } from "./schema.js";

export type BranchEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: unknown;
  [key: string]: unknown;
};

export type SafeEvidence = {
  version: 1;
  window: EvidenceRef;
  workspace: string;
  records: unknown[];
  tools: Array<{
    name: string;
    calls: number;
    successes: number;
    errors: number;
  }>;
  redactions: Record<string, number>;
  checkpointFrontiers?: Record<string, string>;
  emittedEntryIds?: string[];
};

const REDACTIONS: Array<[string, RegExp]> = [
  [
    "pem",
    /-----BEGIN [^-\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\n]+PRIVATE KEY-----/gi,
  ],
  ["bearer", /\bBearer\s+[^\s,;]+/gi],
  ["basic-auth", /\bBasic\s+[^\s,;]+/gi],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "provider-token",
    /\b(?:sk|rk|ghp|github_pat|glpat|npm|pypi|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
  ],
  [
    "opaque-token",
    /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-]))(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-])/g,
  ],
  [
    "padded-base64",
    /(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4}){3,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?![A-Za-z0-9+/=])/g,
  ],
  ["credential-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi],
  [
    "secret-field",
    /(?<![A-Za-z0-9_])(["']?)(?:(?:[a-z0-9]+[_-])*(?:token|secret|password|passwd|api[_-]?key|cookie|authorization|client[_-]?secret|access[_-]?token|access[_-]?key|(?:aws[_-]?)?secret[_-]?access[_-]?key|private[_-]?key|session[_-]?token)|accessToken|apiKey|clientSecret|privateKey|sessionToken)\1(?:\s*[:=]\s*|\s+is\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
  ],
];

export function redact(value: string): {
  text: string;
  counts: Record<string, number>;
} {
  let text = value;
  const counts: Record<string, number> = {};
  for (const [kind, pattern] of REDACTIONS) {
    let count = 0;
    text = text.replace(pattern, () => {
      count += 1;
      return `[REDACTED:${kind}]`;
    });
    if (count) counts[kind] = count;
  }
  return { text, counts };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(source))
    target[key] = (target[key] || 0) + value;
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(object)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function boundedRedacted(
  value: unknown,
  limit: number,
  redactions: Record<string, number>,
): string {
  let raw: string;
  if (typeof value === "string") raw = value;
  else
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  const clean = redact(raw);
  addCounts(redactions, clean.counts);
  if (clean.text.length <= limit) return clean.text;
  const half = Math.floor((limit - 20) / 2);
  return `${clean.text.slice(0, half)}\n[TRUNCATED]\n${clean.text.slice(-half)}`;
}

function iso(entry: BranchEntry, index: number): string {
  if (
    typeof entry.timestamp === "string" &&
    !Number.isNaN(Date.parse(entry.timestamp))
  )
    return new Date(entry.timestamp).toISOString();
  return new Date(index * 1_000).toISOString();
}

function syntheticTranscript(
  sessionId: string,
  workspace: string,
  entries: BranchEntry[],
  redactions: Record<string, number>,
): string {
  const rows: unknown[] = [
    {
      type: "session",
      id: sessionId,
      cwd: workspace,
      timestamp: new Date(0).toISOString(),
    },
  ];
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || !object(entry.message)) continue;
    const message = entry.message;
    if (message.role === "user") {
      const clean = redact(textParts(message.content));
      addCounts(redactions, clean.counts);
      if (clean.text.trim())
        rows.push({
          type: "message",
          id: entry.id,
          parentId: entry.parentId,
          timestamp: iso(entry, index),
          message: { role: "user", content: clean.text.slice(0, 12_000) },
        });
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (typeof message.content === "string") {
        const clean = redact(message.content);
        addCounts(redactions, clean.counts);
        if (clean.text.trim())
          content.push({ type: "text", text: clean.text.slice(0, 12_000) });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content.filter(object)) {
          if (part.type === "text" && typeof part.text === "string") {
            const clean = redact(part.text);
            addCounts(redactions, clean.counts);
            if (clean.text.trim())
              content.push({ type: "text", text: clean.text.slice(0, 12_000) });
          } else if (part.type === "toolCall")
            content.push({
              type: "toolCall",
              id:
                typeof part.id === "string" && part.id
                  ? part.id
                  : `tool-${entry.id}`,
              name:
                typeof part.name === "string" && part.name
                  ? part.name
                  : "unknown",
              arguments: boundedRedacted(
                part.arguments ?? {},
                2_048,
                redactions,
              ),
            });
        }
      }
      if (content.length)
        rows.push({
          type: "message",
          id: entry.id,
          parentId: entry.parentId,
          timestamp: iso(entry, index),
          message: { role: "assistant", content },
        });
    } else if (message.role === "toolResult" || message.role === "tool") {
      const result = boundedRedacted(message.content ?? "", 4_096, redactions);
      rows.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp: iso(entry, index),
        message: {
          role: "toolResult",
          toolCallId:
            typeof message.toolCallId === "string" && message.toolCallId
              ? message.toolCallId
              : `tool-${entry.parentId || entry.id}`,
          content: result || (message.isError === true ? "error" : "ok"),
          isError: message.isError === true,
        },
      });
    }
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

export function buildSafeEvidence(options: {
  sessionId: string;
  workspace: string;
  entries: BranchEntry[];
  checkpointEntryIds: string[];
  checkpointFrontiers: Record<string, string>;
  throughLeafId: string;
  branchEntryIds: string[];
}): SafeEvidence {
  const branchDigest = sha256(
    `${options.sessionId}\0${options.branchEntryIds.join("\0")}`,
  );
  const windowId = sha256(
    `${options.sessionId}\0${branchDigest}\0${options.checkpointEntryIds.join("\0")}`,
  );
  const redactions: Record<string, number> = {};
  const transcript = syntheticTranscript(
    options.sessionId,
    options.workspace,
    options.entries,
    redactions,
  );
  const normalized = normalizeTranscript({
    source: "pi",
    transcript,
    sourceContext: { partial: true },
    bounds: {
      toolArguments: { maxCharacters: 2_048 },
      toolResults: { maxCharacters: 4_096, strategy: "head-tail" },
    },
    filters: { toolResults: "include" },
  });
  const allRecords = normalized.records.filter(
    (record) => record.role !== "reasoning",
  );
  const tools = new Map<
    string,
    { name: string; calls: number; successes: number; errors: number }
  >();
  const callNames = new Map<string, string>();
  for (const record of allRecords) {
    if (
      record.role === "assistant" &&
      "tool_calls" in record &&
      record.tool_calls
    )
      for (const call of record.tool_calls) {
        callNames.set(call.id, call.name);
        const summary = tools.get(call.name) || {
          name: call.name,
          calls: 0,
          successes: 0,
          errors: 0,
        };
        summary.calls += 1;
        tools.set(call.name, summary);
      }
    if (record.role === "tool") {
      const name = callNames.get(record.tool_call_id) || "unknown";
      const summary = tools.get(name) || {
        name,
        calls: 0,
        successes: 0,
        errors: 0,
      };
      if (/^error/i.test(record.content)) summary.errors += 1;
      else summary.successes += 1;
      tools.set(name, summary);
    }
  }
  const authored = allRecords
    .filter(
      (record) =>
        record.role === "user" ||
        (record.role === "assistant" && record.content),
    )
    .map((record) => ("content" in record ? record.content || "" : ""))
    .join("\n");
  const excerpt = authored.slice(-400);
  const records: unknown[] = [];
  let recordChars = 0;
  for (const record of allRecords.slice().reverse()) {
    if (records.length >= 200) break;
    const size = JSON.stringify(record).length;
    if (recordChars + size > 48_000) continue;
    records.unshift(record);
    recordChars += size;
  }
  const meta = allRecords.find((record) => record.role === "meta");
  if (meta && !records.includes(meta)) records.unshift(meta);
  const window: EvidenceRef = {
    windowId,
    sessionId: options.sessionId,
    checkpointEntryIds: options.checkpointEntryIds,
    throughLeafId: options.throughLeafId,
    branchDigest,
    excerpt,
    excerptSha256: sha256(excerpt),
  };
  return {
    version: 1,
    window,
    workspace: options.workspace,
    records,
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    redactions,
    checkpointFrontiers: options.checkpointFrontiers,
    emittedEntryIds: options.entries.map((entry) => entry.id),
  };
}
