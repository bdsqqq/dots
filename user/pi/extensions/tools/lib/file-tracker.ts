/**
 * file change tracker — stores previous content for undo_edit.
 *
 * the undo_edit tool reverts the most recent edit to a file and returns
 * a reverse diff. this module tracks the "before" state so the undo
 * tool can restore it. only the last edit per file is stored (no
 * multi-level undo) — matches the expected behavior.
 *
 * in-memory only. state is lost when the process exits, which is
 * correct: undo should only work within the current session.
 */

import * as fs from "node:fs";

interface EditRecord {
	/** file content before the edit */
	previousContent: string;
	timestamp: number;
}

const edits = new Map<string, EditRecord>();

/** record the current file content before performing an edit. */
export function trackBeforeEdit(filePath: string): void {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		edits.set(filePath, { previousContent: content, timestamp: Date.now() });
	} catch {
		// file doesn't exist yet (create_file case) — store empty string
		// so undo can delete the file
		edits.set(filePath, { previousContent: "", timestamp: Date.now() });
	}
}

/** check if an undo is available for this file. */
export function hasUndo(filePath: string): boolean {
	return edits.has(filePath);
}

/**
 * restore the file to its pre-edit state. returns the previous content
 * that was restored, or null if no edit was tracked.
 */
export function undoEdit(filePath: string): { previousContent: string; restoredContent: string } | null {
	const record = edits.get(filePath);
	if (!record) return null;

	// capture current content before restoring (for diff generation)
	let currentContent = "";
	try {
		currentContent = fs.readFileSync(filePath, "utf-8");
	} catch {
		// file was deleted after edit — still allow undo
	}

	fs.writeFileSync(filePath, record.previousContent, "utf-8");
	edits.delete(filePath);

	return { previousContent: currentContent, restoredContent: record.previousContent };
}

/** clear all tracked edits. useful on session switch. */
export function clearAll(): void {
	edits.clear();
}
