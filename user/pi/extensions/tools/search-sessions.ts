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
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const MAX_RESULTS = 50;

// --- session JSONL types ---

interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

interface SessionInfo {
	type: "session_info";
	name: string;
}

interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: string;
		content: ContentPart[];
		[key: string]: unknown;
	};
}

type ContentPart =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
	| { type: string; [key: string]: unknown };

// --- branch extraction ---

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
	/** concatenated user + assistant text for keyword search (not displayed) */
	searchableText: string;
	/** path to parent session file if this session was forked */
	parentSessionPath?: string;
}

/** tool argument keys that contain file paths */
const PATH_KEYS = ["path", "filePath", "file_path"];

function extractFilePaths(args: Record<string, unknown> | undefined): string[] {
	if (!args) return [];
	const paths: string[] = [];
	for (const key of PATH_KEYS) {
		if (typeof args[key] === "string") paths.push(args[key] as string);
	}
	return paths;
}

/** extract file paths from free text — @-mentions and absolute paths */
function extractFilePathsFromText(text: string): string[] {
	const paths: string[] = [];
	// @-mentions like @user/pi/extensions/editor.ts (must contain at least one /)
	for (const m of text.matchAll(/@([\w.\/-]+\/[\w.\/-]+)/g)) {
		paths.push(m[1]);
	}
	// absolute paths like /Users/bdsqqq/foo.ts
	for (const m of text.matchAll(/(?:^|\s)(\/[\w.\/-]+)/gm)) {
		paths.push(m[1]);
	}
	return paths;
}

function parseSessionFile(filePath: string): {
	header: SessionHeader | null;
	entries: SessionEntry[];
	sessionName: string;
} {
	let raw: string;
	try { raw = fs.readFileSync(filePath, "utf-8"); } catch { return { header: null, entries: [], sessionName: "" }; }

	const lines = raw.split("\n").filter((l) => l.trim());
	let header: SessionHeader | null = null;
	const entries: SessionEntry[] = [];
	let sessionName = "";

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session") {
				header = entry as SessionHeader;
			} else if (entry.type === "session_info" && entry.name) {
				sessionName = entry.name;
			}
			if (entry.id) entries.push(entry as SessionEntry);
		} catch { /* skip malformed lines */ }
	}

	return { header, entries, sessionName };
}

function enumerateBranches(
	header: SessionHeader,
	entries: SessionEntry[],
	sessionName: string,
	filePath: string,
): BranchResult[] {
	const parentSessionPath = header.parentSession;
	// build parent → children map
	const children = new Map<string | null, SessionEntry[]>();
	for (const e of entries) {
		const parent = e.parentId ?? null;
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(e);
	}

	// find leaves (entries with no children)
	const hasChildren = new Set<string>();
	for (const e of entries) {
		if (e.parentId) hasChildren.add(e.parentId);
	}
	const leaves = entries.filter((e) => !hasChildren.has(e.id));

	// build entry lookup
	const byId = new Map<string, SessionEntry>();
	for (const e of entries) byId.set(e.id, e);

	const branches: BranchResult[] = [];

	for (const leaf of leaves) {
		// skip degenerate branches (header-only or config-only, no actual messages)
		if (leaf.type === "session" || leaf.type === "model_change" || leaf.type === "thinking_level_change") {
			// check if the chain has any messages at all
			let hasMsgs = false;
			let cur: SessionEntry | undefined = leaf;
			while (cur) {
				if (cur.type === "message") { hasMsgs = true; break; }
				cur = cur.parentId ? byId.get(cur.parentId) : undefined;
			}
			if (!hasMsgs) continue;
		}
		// walk back to root
		const chain: SessionEntry[] = [];
		let current: SessionEntry | undefined = leaf;
		while (current) {
			chain.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}

		// extract metadata from this branch
		const files = new Set<string>();
		const models = new Set<string>();
		const textChunks: string[] = [];
		let messageCount = 0;
		let firstUserMessage = "";

		for (const entry of chain) {
			if (entry.type === "model_change" && typeof entry.modelId === "string") {
				models.add(entry.modelId);
			}
			if (entry.type === "message") {
				const msg = (entry as MessageEntry).message;
				if (!msg) continue;
				messageCount++;

				if (msg.role === "user") {
					for (const part of msg.content || []) {
						if (part.type === "text" && part.text) {
							if (!firstUserMessage) firstUserMessage = part.text.slice(0, 200);
							textChunks.push(part.text);
							// extract file paths from user text (@-mentions, absolute paths)
							for (const p of extractFilePathsFromText(part.text)) {
								files.add(p);
							}
						}
					}
				}

				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							textChunks.push(part.text);
						}
						if (part.type === "toolCall" && part.arguments) {
							for (const p of extractFilePaths(part.arguments as Record<string, unknown>)) {
								files.add(p);
							}
						}
					}
				}
			}
		}

		const timestamps = chain
			.map((e) => e.timestamp)
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
	if (relMatch) {
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

function rgFilterFiles(keyword: string): Set<string> | null {
	try {
		const result = execSync(
			`rg -l -i ${JSON.stringify(keyword)} ${JSON.stringify(SESSIONS_DIR)}`,
			{ stdio: ["ignore", "pipe", "ignore"], timeout: 10000 },
		).toString().trim();
		if (!result) return new Set();
		return new Set(result.split("\n").filter(Boolean));
	} catch {
		// rg not found or no matches — fall back to no filtering
		return null;
	}
}

// --- format results ---

function formatBranchResults(branches: BranchResult[]): string {
	if (branches.length === 0) return "(no matching sessions found)";

	const parts: string[] = [];
	parts.push(`found ${branches.length} matching branch${branches.length !== 1 ? "es" : ""}:\n`);

	for (let i = 0; i < branches.length; i++) {
		const b = branches[i];
		const lines: string[] = [];

		const dateStr = new Date(b.timestampEnd).toLocaleDateString("en-US", {
			weekday: "short", year: "numeric", month: "short", day: "numeric",
		});
		const timeStr = new Date(b.timestampEnd).toLocaleTimeString("en-US", {
			hour: "2-digit", minute: "2-digit",
		});

		lines.push(`### ${i + 1}. ${b.sessionName || "(unnamed)"}`);
		lines.push(`session: ${b.sessionId} / branch: ${b.leafId}`);
		if (b.parentSessionPath) {
			// extract session id from path (filename without extension)
			const parentId = b.parentSessionPath.split("/").pop()?.replace(/\.jsonl$/, "")?.split("_")[1] || b.parentSessionPath;
			lines.push(`forked from: ${parentId}`);
		}
		lines.push(`${dateStr} ${timeStr} — ${b.messageCount} messages`);
		if (b.models.length > 0) lines.push(`models: ${b.models.join(", ")}`);
		if (b.filesTouched.length > 0) {
			const shown = b.filesTouched.slice(0, 10);
			lines.push(`files: ${shown.join(", ")}${b.filesTouched.length > 10 ? ` (+${b.filesTouched.length - 10} more)` : ""}`);
		}
		if (b.firstUserMessage) {
			const preview = b.firstUserMessage.length > 150
				? `${b.firstUserMessage.slice(0, 150)}...`
				: b.firstUserMessage;
			lines.push(`> ${preview}`);
		}

		parts.push(lines.join("\n"));
	}

	return parts.join("\n\n");
}

// --- tool ---

export function createSearchSessionsTool(): ToolDefinition {
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
			"- \"Find the session where I worked on X\"\n" +
			"- \"What session touched this file?\"\n" +
			"- \"Show recent sessions\"\n" +
			"- Looking up prior context from past conversations\n\n" +
			"WHEN NOT TO USE:\n" +
			"- Current session context (already available)\n" +
			"- Git history (use git log)",

		parameters: Type.Object({
			keyword: Type.Optional(
				Type.String({
					description: "Text to search for in session names, user messages, and assistant responses.",
				}),
			),
			file: Type.Optional(
				Type.String({
					description: "File path (partial match) to find sessions that touched this file.",
				}),
			),
			after: Type.Optional(
				Type.String({
					description: "Only return sessions after this date. ISO date (2026-02-20) or relative (7d, 2w).",
				}),
			),
			before: Type.Optional(
				Type.String({
					description: "Only return sessions before this date. ISO date or relative.",
				}),
			),
			workspace: Type.Optional(
				Type.String({
					description: "Filter by workspace path (partial match against session cwd). Defaults to current workspace.",
				}),
			),
			all_workspaces: Type.Optional(
				Type.Boolean({
					description: "Search across all workspaces instead of just the current one.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!fs.existsSync(SESSIONS_DIR)) {
				return {
					content: [{ type: "text" as const, text: "(no sessions directory found)" }],
				} as any;
			}

			// 1. glob all session files
			let sessionFiles: string[] = [];
			try {
				const walkDir = (dir: string) => {
					for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
						const full = path.join(dir, entry.name);
						if (entry.isDirectory()) walkDir(full);
						else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full);
					}
				};
				walkDir(SESSIONS_DIR);
			} catch {
				return {
					content: [{ type: "text" as const, text: "(could not read sessions directory)" }],
					isError: true,
				} as any;
			}

			if (sessionFiles.length === 0) {
				return {
					content: [{ type: "text" as const, text: "(no sessions found)" }],
				} as any;
			}

			// 2. rg pre-filter if keyword set
			if (params.keyword) {
				const matches = rgFilterFiles(params.keyword);
				if (matches !== null) {
					sessionFiles = sessionFiles.filter((f) => matches.has(f));
				}
			}

			// 3. filename-based date pre-filter (timestamps are in filenames)
			if (params.after || params.before) {
				sessionFiles = sessionFiles.filter((f) => {
					const basename = path.basename(f);
					// format: 2026-02-20T14-50-17-926Z_uuid.jsonl
					const tsMatch = basename.match(/^(\d{4}-\d{2}-\d{2})T/);
					if (!tsMatch) return true; // keep if can't parse
					const fileDate = new Date(tsMatch[1]);

					if (params.after) {
						const afterDate = parseDate(params.after);
						if (afterDate && fileDate < afterDate) return false;
					}
					if (params.before) {
						const beforeDate = parseDate(params.before);
						if (beforeDate && fileDate > beforeDate) return false;
					}
					return true;
				});
			}

			// 4. parse and enumerate branches
			const allBranches: BranchResult[] = [];

			// workspace filter: default to current cwd unless all_workspaces is set
			const workspaceFilter = params.all_workspaces
				? undefined
				: params.workspace || ctx.cwd;

			for (const file of sessionFiles) {
				const { header, entries, sessionName } = parseSessionFile(file);
				if (!header) continue;

				// workspace filter
				if (workspaceFilter && !header.cwd.toLowerCase().includes(workspaceFilter.toLowerCase())) {
					continue;
				}

				const branches = enumerateBranches(header, entries, sessionName, file);
				allBranches.push(...branches);
			}

			// 5. filter branches
			let filtered = allBranches;

			if (params.keyword) {
				filtered = filtered.filter((b) => matchesKeyword(b, params.keyword!));
			}
			if (params.file) {
				filtered = filtered.filter((b) => matchesFile(b, params.file!));
			}
			if (params.after || params.before) {
				filtered = filtered.filter((b) => matchesDateRange(b, params.after, params.before));
			}

			// 6. sort by most recent leaf timestamp
			filtered.sort((a, b) =>
				new Date(b.timestampEnd).getTime() - new Date(a.timestampEnd).getTime(),
			);

			// 7. cap results
			filtered = filtered.slice(0, MAX_RESULTS);

			const output = formatBranchResults(filtered);
			return { content: [{ type: "text" as const, text: output }] } as any;
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
				theme.fg("toolTitle", theme.bold("search_sessions ")) + theme.fg("dim", preview),
				0, 0,
			);
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any) {
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	};
}
