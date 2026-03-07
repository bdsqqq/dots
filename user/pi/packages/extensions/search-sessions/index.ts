/**
 * search_sessions tool — find session branches by keyword, file, or date.
 *
 * a session is a tree of entries (messages, tool calls, branches).
 * the searchable unit is a BRANCH — a root-to-leaf path through the tree.
 * each branch has its own files-touched set, message chain, and timestamp range.
 *
 * pipeline: glob session files → optional rg keyword pre-filter → parse JSONL →
 * enumerate branches → filter by params → return sorted results.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { getExtensionConfig } from "@bds_pi/config";
import { registerMentionSource } from "@bds_pi/mentions";
import { createSessionMentionSource } from "./session-mention-source";
import {
  type BoxSection,
  type Excerpt,
  boxRendererWindowed,
} from "@bds_pi/box-format";
import { Type } from "@sinclair/typebox";
import {
  enumerateBranches,
  listSessionFiles,
  parseSessionFile,
  type BranchResult,
} from "../../core/mentions/session-index";

type SearchSessionsExtConfig = {
  maxResults: number;
  sessionsDir: string;
  rgTimeoutMs: number;
};

const CONFIG_DEFAULTS: SearchSessionsExtConfig = {
  maxResults: 50,
  sessionsDir: path.join(os.homedir(), ".pi", "agent", "sessions"),
  rgTimeoutMs: 10000,
};

/** per-block excerpts for collapsed display — first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

// --- search filtering ---

function matchesKeyword(branch: BranchResult, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  if (branch.sessionName.toLowerCase().includes(lower)) return true;
  if (branch.searchableText.toLowerCase().includes(lower)) return true;
  return false;
}

function matchesFile(branch: BranchResult, fileQuery: string): boolean {
  const lower = fileQuery.toLowerCase();
  return branch.filesTouched.some((f) => f.toLowerCase().includes(lower));
}

function parseDate(dateStr: string): Date | null {
  // support ISO dates and relative (7d, 2w)
  const relMatch = dateStr.match(/^(\d+)([dw])$/);
  if (relMatch && relMatch[1] && relMatch[2]) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === "d") now.setDate(now.getDate() - n);
    else if (unit === "w") now.setDate(now.getDate() - n * 7);
    return now;
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function matchesDateRange(
  branch: BranchResult,
  after?: string,
  before?: string,
): boolean {
  const branchEnd = new Date(branch.timestampEnd);
  const branchStart = new Date(branch.timestampStart);

  if (after) {
    const afterDate = parseDate(after);
    if (afterDate && branchEnd < afterDate) return false;
  }
  if (before) {
    const beforeDate = parseDate(before);
    if (beforeDate && branchStart > beforeDate) return false;
  }
  return true;
}

// --- rg pre-filter ---

function rgFilterFiles(keyword: string, sessionsDir: string, timeoutMs: number): Set<string> | null {
  try {
    const result = execSync(
      `rg -l -i ${JSON.stringify(keyword)} ${JSON.stringify(sessionsDir)}`,
      { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs },
    )
      .toString()
      .trim();
    if (!result) return new Set();
    return new Set(result.split("\n").filter(Boolean));
  } catch {
    // rg not found or no matches — fall back to no filtering
    return null;
  }
}

// --- format results ---

function formatBranchResults(branches: BranchResult[]): {
  text: string;
  headerLineIndices: number[];
} {
  if (branches.length === 0)
    return { text: "(no matching sessions found)", headerLineIndices: [] };

  const lines: string[] = [];
  const headerLineIndices: number[] = [];

  lines.push(
    `found ${branches.length} matching branch${branches.length !== 1 ? "es" : ""}:`,
  );
  lines.push("");

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    if (!b) continue;
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    headerLineIndices.push(lines.length);
    lines.push(`### ${i + 1}. ${b.sessionName || "(unnamed)"}`);
    lines.push(`session: ${b.sessionId} / branch: ${b.leafId}`);
    if (b.parentSessionPath) {
      // extract session id from path (filename without extension)
      const parentId =
        b.parentSessionPath
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "")
          ?.split("_")[1] || b.parentSessionPath;
      lines.push(`forked from: ${parentId}`);
    }
    lines.push(`${dateStr} ${timeStr} — ${b.messageCount} messages`);
    if (b.models.length > 0) lines.push(`models: ${b.models.join(", ")}`);
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push(
        `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
      );
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push(`> ${preview}`);
    }

    if (i < branches.length - 1) lines.push("");
  }

  return { text: lines.join("\n"), headerLineIndices };
}

/** convert branch results to BoxSections for box-format rendering */
function branchesToSections(branches: BranchResult[]): BoxSection[] {
  return branches.map((b, i) => {
    const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const lines: { text: string; highlight?: boolean }[] = [];
    lines.push({
      text: `session: ${b.sessionId} / branch: ${b.leafId}`,
      highlight: true,
    });
    if (b.parentSessionPath) {
      const parentId =
        b.parentSessionPath
          .split("/")
          .pop()
          ?.replace(/\.jsonl$/, "")
          ?.split("_")[1] || b.parentSessionPath;
      lines.push({ text: `forked from: ${parentId}`, highlight: true });
    }
    lines.push({
      text: `${dateStr} ${timeStr} — ${b.messageCount} messages`,
      highlight: true,
    });
    if (b.models.length > 0)
      lines.push({ text: `models: ${b.models.join(", ")}`, highlight: true });
    if (b.filesTouched.length > 0) {
      const shown = b.filesTouched.slice(0, 10);
      lines.push({
        text: `files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`,
        highlight: true,
      });
    }
    if (b.firstUserMessage) {
      const preview =
        b.firstUserMessage.length > 150
          ? `${b.firstUserMessage.slice(0, 150)}...`
          : b.firstUserMessage;
      lines.push({ text: `> ${preview}`, highlight: false });
    }

    return {
      header: b.sessionName || `session ${i + 1}`,
      blocks: [{ lines }],
    };
  });
}

// --- tool ---

interface SearchSessionsParams {
  keyword?: string;
  file?: string;
  after?: string;
  before?: string;
  workspace?: string;
  all_workspaces?: boolean;
}

export function createSearchSessionsTool(config: SearchSessionsExtConfig = CONFIG_DEFAULTS): ToolDefinition {
  return {
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "Search pi session history by keyword, file path, or date range.\n\n" +
      "Sessions are trees with branches. Each branch (root-to-leaf path) is a " +
      "separate search result with its own files-touched set and message chain.\n\n" +
      "Scoped to current workspace by default. Use `all_workspaces: true` to search everywhere.\n\n" +
      "Use `read_session` to extract detailed content from a specific session.\n\n" +
      "WHEN TO USE:\n" +
      '- "Find the session where I worked on X"\n' +
      '- "What session touched this file?"\n' +
      '- "Show recent sessions"\n' +
      "- Looking up prior context from past conversations\n\n" +
      "WHEN NOT TO USE:\n" +
      "- Current session context (already available)\n" +
      "- Git history (use git log)",

    parameters: Type.Object({
      keyword: Type.Optional(
        Type.String({
          description:
            "Text to search for in session names, user messages, and assistant responses.",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            "File path (partial match) to find sessions that touched this file.",
        }),
      ),
      after: Type.Optional(
        Type.String({
          description:
            "Only return sessions after this date. ISO date (2026-02-20) or relative (7d, 2w).",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description:
            "Only return sessions before this date. ISO date or relative.",
        }),
      ),
      workspace: Type.Optional(
        Type.String({
          description:
            "Filter by workspace path (partial match against session cwd). Defaults to current workspace.",
        }),
      ),
      all_workspaces: Type.Optional(
        Type.Boolean({
          description:
            "Search across all workspaces instead of just the current one.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as SearchSessionsParams;
      if (!fs.existsSync(config.sessionsDir)) {
        return {
          content: [
            { type: "text" as const, text: "(no sessions directory found)" },
          ],
        } as any;
      }

      // 1. glob all session files
      let sessionFiles: string[] = [];
      try {
        sessionFiles = listSessionFiles(config.sessionsDir);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "(could not read sessions directory)",
            },
          ],
          isError: true,
        } as any;
      }

      if (sessionFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: "(no sessions found)" }],
        } as any;
      }

      // 2. rg pre-filter if keyword set
      if (p.keyword) {
        const matches = rgFilterFiles(p.keyword, config.sessionsDir, config.rgTimeoutMs);
        if (matches !== null) {
          sessionFiles = sessionFiles.filter((f) => matches.has(f));
        }
      }

      // 3. filename-based date pre-filter (timestamps are in filenames)
      if (p.after || p.before) {
        sessionFiles = sessionFiles.filter((f) => {
          const basename = path.basename(f);
          // format: 2026-02-20T14-50-17-926Z_uuid.jsonl
          const tsMatch = basename.match(/^(\d{4}-\d{2}-\d{2})T/);
          if (!tsMatch || !tsMatch[1]) return true; // keep if can't parse
          const fileDate = new Date(tsMatch[1]);

          if (p.after) {
            const afterDate = parseDate(p.after);
            if (afterDate && fileDate < afterDate) return false;
          }
          if (p.before) {
            const beforeDate = parseDate(p.before);
            if (beforeDate && fileDate > beforeDate) return false;
          }
          return true;
        });
      }

      // 4. parse and enumerate branches
      const allBranches: BranchResult[] = [];

      // workspace filter: default to current cwd unless all_workspaces is set
      const workspaceFilter = p.all_workspaces
        ? undefined
        : p.workspace || ctx.cwd;

      for (const file of sessionFiles) {
        const { header, entries, sessionName } = parseSessionFile(file);
        if (!header) continue;

        // workspace filter
        if (
          workspaceFilter &&
          !header.cwd.toLowerCase().includes(workspaceFilter.toLowerCase())
        ) {
          continue;
        }

        const branches = enumerateBranches(header, entries, sessionName, file);
        allBranches.push(...branches);
      }

      // 5. filter branches
      let filtered = allBranches;

      if (p.keyword) {
        filtered = filtered.filter((b) => matchesKeyword(b, p.keyword!));
      }
      if (p.file) {
        filtered = filtered.filter((b) => matchesFile(b, p.file!));
      }
      if (p.after || p.before) {
        filtered = filtered.filter((b) =>
          matchesDateRange(b, p.after, p.before),
        );
      }

      // 6. sort by most recent leaf timestamp
      filtered.sort(
        (a, b) =>
          new Date(b.timestampEnd).getTime() -
          new Date(a.timestampEnd).getTime(),
      );

      // 7. format with head+tail truncation
      const shown =
        filtered.length > config.maxResults
          ? [
              ...filtered.slice(0, Math.floor(config.maxResults / 2)),
              ...filtered.slice(-Math.floor(config.maxResults / 2)),
            ]
          : filtered;
      const truncated =
        filtered.length > config.maxResults ? filtered.length - shown.length : 0;

      const { text: output } = formatBranchResults(shown);
      const resultSections = branchesToSections(shown);

      return {
        content: [{ type: "text" as const, text: output }],
        details: { resultSections, truncated },
      } as any;
    },

    renderCall(args: any, theme: any) {
      const parts: string[] = [];
      if (args.keyword) parts.push(args.keyword);
      if (args.file) parts.push(`file:${args.file}`);
      if (args.after) parts.push(`after:${args.after}`);
      if (args.before) parts.push(`before:${args.before}`);
      if (args.workspace) parts.push(`ws:${args.workspace}`);
      const preview = parts.join(" ") || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("search_sessions ")) +
          theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length)
        return new Text(result.content?.[0]?.text ?? "(no output)", 0, 0);

      const truncated: number = result.details?.truncated ?? 0;
      const notices =
        truncated > 0 ? [`${truncated} sessions omitted`] : undefined;

      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        notices,
        expanded,
      );
    },
  };
}

export default function(pi: ExtensionAPI): void {
  registerMentionSource(createSessionMentionSource());

  const cfg = getExtensionConfig("@bds_pi/search-sessions", CONFIG_DEFAULTS);
  pi.registerTool(withPromptPatch(createSearchSessionsTool(cfg)));
}
