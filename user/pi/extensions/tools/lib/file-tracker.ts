/**
 * file change tracker — persists before/after content to disk for undo_edit.
 *
 * mirrors the standard approach: each edit writes a JSON file to
 * ~/.pi/file-changes/{sessionId}/{toolCallId}.json containing
 * the full before/after content and a unified diff.
 *
 * branch awareness comes from the conversation tree, not from
 * this module. tool call IDs live in assistant messages — when
 * the user navigates branches, only tool calls on the active
 * branch are visible. the undo_edit tool filters by active
 * tool call IDs before consulting the disk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FILE_CHANGES_DIR = path.join(os.homedir(), ".pi", "file-changes");

export interface FileChange {
	/** unique id for this change record */
	id: string;
	/** file:// URI of the changed file */
	uri: string;
	/** full content before the edit */
	before: string;
	/** full content after the edit */
	after: string;
	/** unified diff */
	diff: string;
	/** true if this was a newly created file */
	isNewFile: boolean;
	/** true if undo_edit has reverted this change */
	reverted: boolean;
	/** epoch ms when the edit occurred */
	timestamp: number;
}

function sessionDir(sessionId: string): string {
	return path.join(FILE_CHANGES_DIR, sessionId);
}

function changePath(sessionId: string, toolCallId: string): string {
	return path.join(sessionDir(sessionId), `${toolCallId}.json`);
}

/** ensure the session's file-changes directory exists. */
function ensureDir(sessionId: string): void {
	const dir = sessionDir(sessionId);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/**
 * record a file change to disk. call after performing the edit.
 * the toolCallId comes from the execute() function's first argument.
 */
export function saveChange(
	sessionId: string,
	toolCallId: string,
	change: Omit<FileChange, "id" | "reverted">,
): void {
	ensureDir(sessionId);
	const record: FileChange = {
		...change,
		id: crypto.randomUUID(),
		reverted: false,
	};
	fs.writeFileSync(changePath(sessionId, toolCallId), JSON.stringify(record, null, 2), "utf-8");
}

/** read a change record from disk. returns null if not found. */
export function loadChange(sessionId: string, toolCallId: string): FileChange | null {
	const p = changePath(sessionId, toolCallId);
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as FileChange;
	} catch {
		return null;
	}
}

/**
 * mark a change as reverted and restore the file.
 * returns the change record, or null if not found / already reverted.
 */
export function revertChange(sessionId: string, toolCallId: string): FileChange | null {
	const change = loadChange(sessionId, toolCallId);
	if (!change || change.reverted) return null;

	// restore the file to its pre-edit state
	const filePath = change.uri.replace(/^file:\/\//, "");
	fs.writeFileSync(filePath, change.before, "utf-8");

	// mark as reverted on disk
	change.reverted = true;
	fs.writeFileSync(changePath(sessionId, toolCallId), JSON.stringify(change, null, 2), "utf-8");

	return change;
}

/**
 * find the most recent non-reverted change for a file path,
 * filtered to only the given tool call IDs (branch awareness).
 *
 * the caller gets activeToolCallIds by scanning the current
 * session branch for edit_file/create_file tool calls.
 */
export function findLatestChange(
	sessionId: string,
	filePath: string,
	activeToolCallIds: string[],
): { toolCallId: string; change: FileChange } | null {
	const uri = `file://${path.resolve(filePath)}`;

	// check in reverse order (most recent first)
	for (let i = activeToolCallIds.length - 1; i >= 0; i--) {
		const toolCallId = activeToolCallIds[i];
		const change = loadChange(sessionId, toolCallId);
		if (change && !change.reverted && change.uri === uri) {
			return { toolCallId, change };
		}
	}

	return null;
}

/**
 * generate a simple unified diff between two strings.
 * basic implementation — can be replaced with a proper diff lib later.
 */
export function simpleDiff(filePath: string, before: string, after: string): string {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");

	const lines: string[] = [
		`--- ${filePath}\toriginal`,
		`+++ ${filePath}\tmodified`,
	];

	// naive: show all removed then all added. good enough for
	// undo_edit display; not a real shortest-edit-distance diff.
	let i = 0;
	let j = 0;
	while (i < beforeLines.length || j < afterLines.length) {
		if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
			lines.push(` ${beforeLines[i]}`);
			i++;
			j++;
		} else if (i < beforeLines.length && (j >= afterLines.length || beforeLines[i] !== afterLines[j])) {
			lines.push(`-${beforeLines[i]}`);
			i++;
		} else {
			lines.push(`+${afterLines[j]}`);
			j++;
		}
	}

	return lines.join("\n");
}
