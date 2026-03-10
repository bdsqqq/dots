import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { walkDirSync } from "@bds_pi/fs";
import { createCache, getOrSet } from "./cache";

/**
 * shared session parsing for mentions.
 *
 * keep this small and boring: parse once, derive branch/session summaries,
 * let callers layer their own filtering or rendering.
 */

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments?: Record<string, unknown>;
    }
  | { type: string; [key: string]: unknown };

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: string;
    content: ContentPart[];
    [key: string]: unknown;
  };
}

export interface ParsedSessionFile {
  filePath: string;
  header: SessionHeader | null;
  entries: SessionEntry[];
  sessionName: string;
}

export interface BranchResult {
  sessionId: string;
  sessionName: string;
  leafId: string;
  workspace: string;
  filePath: string;
  timestampStart: string;
  timestampEnd: string;
  filesTouched: string[];
  models: string[];
  messageCount: number;
  firstUserMessage: string;
  searchableText: string;
  parentSessionPath?: string;
}

export interface MentionableSession {
  sessionId: string;
  sessionName: string;
  workspace: string;
  filePath: string;
  startedAt: string;
  updatedAt: string;
  firstUserMessage: string;
  searchableText: string;
  branchCount: number;
  parentSessionPath?: string;
  isHandoffCandidate: boolean;
}

export interface MentionableSessionQuery {
  text?: string;
  workspace?: string;
  kind?: "session" | "handoff";
  limit?: number;
}

export const DEFAULT_MENTION_SESSIONS_DIR: string = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "sessions",
);

const sessionMentionCache = createCache<string, MentionableSession[]>();

/** tool argument keys that usually contain file paths */
const PATH_KEYS = ["path", "filePath", "file_path"];

export function isTextContent(
  part: ContentPart,
): part is { type: "text"; text: string } {
  return part.type === "text" && typeof part.text === "string";
}

export function extractFilePaths(
  args: Record<string, unknown> | undefined,
): string[] {
  if (!args) return [];
  const paths: string[] = [];

  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string") paths.push(value);
  }

  return paths;
}

/** extract file paths from free text — @-mentions and absolute paths */
export function extractFilePathsFromText(text: string): string[] {
  const paths: string[] = [];

  for (const match of text.matchAll(/@([\w./-]+\/[\w./-]+)/g)) {
    if (match[1]) paths.push(match[1]);
  }

  for (const match of text.matchAll(/(?:^|\s)(\/[\w./-]+)/gm)) {
    if (match[1]) paths.push(match[1]);
  }

  return paths;
}

export function listSessionFiles(sessionsDir: string): string[] {
  return walkDirSync(sessionsDir, {
    filter: (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  });
}

export function parseSessionFile(filePath: string): ParsedSessionFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { filePath, header: null, entries: [], sessionName: "" };
  }

  const lines = raw.split("\n").filter((line) => line.trim());
  let header: SessionHeader | null = null;
  const entries: SessionEntry[] = [];
  let sessionName = "";

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        header = entry as SessionHeader;
      } else if (
        entry.type === "session_info" &&
        typeof entry.name === "string"
      ) {
        sessionName = entry.name;
      }

      if (typeof entry.id === "string") entries.push(entry as SessionEntry);
    } catch {
      /* skip malformed lines */
    }
  }

  return { filePath, header, entries, sessionName };
}

export function extractFirstUserMessage(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg?.role !== "user") continue;

    for (const part of msg.content || []) {
      if (isTextContent(part) && part.text) return part.text.slice(0, 200);
    }
  }

  return "";
}

export function enumerateBranches(
  header: SessionHeader,
  entries: SessionEntry[],
  sessionName: string,
  filePath: string,
): BranchResult[] {
  const parentSessionPath = header.parentSession;
  const children = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const parent = entry.parentId ?? null;
    const bucket = children.get(parent);
    if (bucket) bucket.push(entry);
    else children.set(parent, [entry]);
  }

  const hasChildren = new Set<string>();
  for (const entry of entries) {
    if (entry.parentId) hasChildren.add(entry.parentId);
  }

  const leaves = entries.filter((entry) => !hasChildren.has(entry.id));
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const branches: BranchResult[] = [];

  for (const leaf of leaves) {
    if (
      leaf.type === "session" ||
      leaf.type === "model_change" ||
      leaf.type === "thinking_level_change"
    ) {
      let hasMessages = false;
      let current: SessionEntry | undefined = leaf;
      while (current) {
        if (current.type === "message") {
          hasMessages = true;
          break;
        }
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      if (!hasMessages) continue;
    }

    const chain: SessionEntry[] = [];
    let current: SessionEntry | undefined = leaf;
    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    const files = new Set<string>();
    const models = new Set<string>();
    const textChunks: string[] = [];
    let messageCount = 0;
    let firstUserMessage = "";

    for (const entry of chain) {
      if (entry.type === "model_change" && typeof entry.modelId === "string") {
        models.add(entry.modelId);
      }

      if (entry.type !== "message") continue;
      const msg = (entry as MessageEntry).message;
      if (!msg) continue;
      messageCount++;

      if (msg.role === "user") {
        for (const part of msg.content || []) {
          if (!isTextContent(part) || !part.text) continue;
          if (!firstUserMessage) firstUserMessage = part.text.slice(0, 200);
          textChunks.push(part.text);
          for (const filePath of extractFilePathsFromText(part.text)) {
            files.add(filePath);
          }
        }
      }

      if (msg.role === "assistant") {
        for (const part of msg.content || []) {
          if (isTextContent(part) && part.text) {
            textChunks.push(part.text);
          }
          if (part.type === "toolCall" && part.arguments) {
            for (const filePath of extractFilePaths(
              part.arguments as Record<string, unknown>,
            )) {
              files.add(filePath);
            }
          }
        }
      }
    }

    const timestamps = chain
      .map((entry) => entry.timestamp)
      .filter(Boolean)
      .sort();

    branches.push({
      sessionId: header.id,
      sessionName,
      leafId: leaf.id,
      workspace: header.cwd,
      filePath,
      timestampStart: timestamps[0] || header.timestamp,
      timestampEnd: timestamps[timestamps.length - 1] || header.timestamp,
      filesTouched: [...files],
      models: [...models],
      messageCount,
      firstUserMessage,
      searchableText: textChunks.join("\n"),
      parentSessionPath,
    });
  }

  return branches;
}

function matchesMentionableText(
  session: MentionableSession,
  query: string,
): boolean {
  const lower = query.toLowerCase();
  return (
    session.sessionId.toLowerCase().includes(lower) ||
    session.sessionName.toLowerCase().includes(lower) ||
    session.firstUserMessage.toLowerCase().includes(lower) ||
    session.searchableText.toLowerCase().includes(lower)
  );
}

export function summarizeMentionableSession(
  parsed: ParsedSessionFile,
): MentionableSession | null {
  if (!parsed.header) return null;

  const branches = enumerateBranches(
    parsed.header,
    parsed.entries,
    parsed.sessionName,
    parsed.filePath,
  );

  if (branches.length === 0) return null;

  const firstWithUserMessage =
    branches.find((branch) => branch.firstUserMessage) ?? branches[0];
  if (!firstWithUserMessage) return null;

  const searchableText = branches
    .map((branch) => branch.searchableText)
    .filter(Boolean)
    .join("\n");

  const startedAt =
    branches
      .map((branch) => branch.timestampStart)
      .filter(Boolean)
      .sort()[0] || parsed.header.timestamp;

  const updatedAt =
    branches
      .map((branch) => branch.timestampEnd)
      .filter(Boolean)
      .sort()
      .at(-1) || parsed.header.timestamp;

  const firstUserMessage = firstWithUserMessage.firstUserMessage;

  return {
    sessionId: parsed.header.id,
    sessionName: parsed.sessionName,
    workspace: parsed.header.cwd,
    filePath: parsed.filePath,
    startedAt,
    updatedAt,
    firstUserMessage,
    searchableText,
    branchCount: branches.length,
    parentSessionPath: parsed.header.parentSession,
    isHandoffCandidate:
      typeof parsed.header.parentSession === "string" &&
      firstUserMessage.length > 0,
  };
}

export function clearSessionMentionCache(): void {
  sessionMentionCache.clear();
}

export function getSessionMentionsIndex(
  sessionsDir: string = DEFAULT_MENTION_SESSIONS_DIR,
): MentionableSession[] {
  if (!fs.existsSync(sessionsDir)) return [];
  return getOrSet(sessionMentionCache, sessionsDir, () =>
    listMentionableSessions(sessionsDir),
  );
}

export function listMentionableSessions(
  sessionsDir: string,
  query: MentionableSessionQuery = {},
): MentionableSession[] {
  const sessions = listSessionFiles(sessionsDir)
    .map((filePath) => summarizeMentionableSession(parseSessionFile(filePath)))
    .filter((session): session is MentionableSession => session !== null);

  return searchMentionableSessions(sessions, query);
}

export function searchMentionableSessions(
  sessions: MentionableSession[],
  query: MentionableSessionQuery = {},
): MentionableSession[] {
  let filtered = sessions;

  if (query.workspace) {
    const workspace = query.workspace.toLowerCase();
    filtered = filtered.filter((session) =>
      session.workspace.toLowerCase().includes(workspace),
    );
  }

  if (query.kind === "handoff") {
    filtered = filtered.filter((session) => session.isHandoffCandidate);
  }

  if (query.text) {
    filtered = filtered.filter((session) =>
      matchesMentionableText(session, query.text!),
    );
  }

  filtered = [...filtered].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  if (query.limit !== undefined) {
    return filtered.slice(0, query.limit);
  }

  return filtered;
}

export function resolveMentionableSession(
  sessions: MentionableSession[],
  value: string,
  kind: "session" | "handoff" = "session",
):
  | { status: "resolved"; session: MentionableSession }
  | { status: "ambiguous"; sessions: MentionableSession[] }
  | { status: "not_found" } {
  const normalized = value.toLowerCase();
  const candidates = searchMentionableSessions(sessions, { kind }).filter(
    (session) =>
      session.sessionId.toLowerCase() === normalized ||
      session.sessionId.toLowerCase().startsWith(normalized),
  );

  if (candidates.length === 0) return { status: "not_found" };
  if (candidates.length === 1)
    return { status: "resolved", session: candidates[0]! };

  const exact = candidates.find(
    (session) => session.sessionId.toLowerCase() === normalized,
  );
  if (exact) return { status: "resolved", session: exact };

  return { status: "ambiguous", sessions: candidates };
}
