/**
 * file change tracker — stores pre-edit content for undo_edit.
 *
 * persistence strategy: in-memory map for fast access, backed by
 * pi's session entries (appendEntry) for cross-restart durability.
 * the caller (tool implementation) is responsible for calling
 * appendEntry after trackBeforeEdit — this module doesn't hold
 * a reference to the ExtensionAPI.
 *
 * on session_start, call restoreFromEntries() with the current
 * branch to rebuild in-memory state from persisted entries.
 *
 * only the last edit per file is tracked (single-level undo),
 * matching expected behavior.
 */

import * as fs from "node:fs";

/** shape of the data persisted via pi.appendEntry("undo-edit", ...) */
export interface UndoEntryData {
	filePath: string;
	previousContent: string;
}

/** custom entry type string used with pi.appendEntry */
export const UNDO_ENTRY_TYPE = "undo-edit";

/** sentinel appended when an undo is consumed, so restore skips it */
export const UNDO_CONSUMED_TYPE = "undo-edit-consumed";

interface EditRecord {
	previousContent: string;
	timestamp: number;
}

const edits = new Map<string, EditRecord>();

/**
 * capture file content before an edit. call this BEFORE modifying
 * the file. after calling this, persist with:
 *   pi.appendEntry(UNDO_ENTRY_TYPE, getUndoRecord(filePath))
 */
export function trackBeforeEdit(filePath: string): void {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		edits.set(filePath, { previousContent: content, timestamp: Date.now() });
	} catch {
		// file doesn't exist yet (create_file) — empty string means
		// "undo should delete the file" (or restore to empty)
		edits.set(filePath, { previousContent: "", timestamp: Date.now() });
	}
}

/** get the tracked record for persistence via appendEntry. */
export function getUndoRecord(filePath: string): UndoEntryData | null {
	const record = edits.get(filePath);
	if (!record) return null;
	return { filePath, previousContent: record.previousContent };
}

/** check if an undo is available for this file. */
export function hasUndo(filePath: string): boolean {
	return edits.has(filePath);
}

/**
 * restore the file to its pre-edit state. returns current and restored
 * content for diff generation. after calling this, persist with:
 *   pi.appendEntry(UNDO_CONSUMED_TYPE, { filePath })
 */
export function undoEdit(filePath: string): { currentContent: string; restoredContent: string } | null {
	const record = edits.get(filePath);
	if (!record) return null;

	let currentContent = "";
	try {
		currentContent = fs.readFileSync(filePath, "utf-8");
	} catch {
		// file was deleted after edit — still allow undo
	}

	fs.writeFileSync(filePath, record.previousContent, "utf-8");
	edits.delete(filePath);

	return { currentContent, restoredContent: record.previousContent };
}

/**
 * rebuild in-memory state from session entries. call on session_start
 * with the current branch entries. processes entries in order —
 * undo-edit sets the record, undo-edit-consumed clears it.
 */
export function restoreFromEntries(entries: Array<{ type: string; customType?: string; data?: unknown }>): void {
	edits.clear();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;

		if (entry.customType === UNDO_ENTRY_TYPE) {
			const data = entry.data as UndoEntryData;
			if (data?.filePath) {
				edits.set(data.filePath, {
					previousContent: data.previousContent ?? "",
					timestamp: Date.now(),
				});
			}
		} else if (entry.customType === UNDO_CONSUMED_TYPE) {
			const data = entry.data as { filePath: string };
			if (data?.filePath) {
				edits.delete(data.filePath);
			}
		}
	}
}

/** clear all tracked edits. */
export function clearAll(): void {
	edits.clear();
}
