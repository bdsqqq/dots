/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit_file, create_file)
 * - AGENTS.md discovery (read, edit_file, create_file)
 * - edit tracking for undo_edit
 *
 * edit history is persisted as session entries via appendEntry so
 * undo_edit survives process restarts within the same session.
 * custom entries participate in pi's tree branching — undo records
 * from abandoned branches are automatically invisible.
 *
 * tool registrations will be added here as each tool is implemented.
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearAll, restoreFromEntries } from "./lib/file-tracker";

export { withFileLock } from "./lib/mutex";
export { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
export { trackBeforeEdit, undoEdit, clearAll as clearEdits, UNDO_ENTRY_TYPE, UNDO_CONSUMED_TYPE } from "./lib/file-tracker";

export default function (pi: ExtensionAPI) {
	// rebuild undo state from persisted session entries
	const restoreUndoState = (_event: unknown, ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }) => {
		const branch = ctx.sessionManager.getBranch();
		restoreFromEntries(branch);
	};

	pi.on("session_start", async (event, ctx) => restoreUndoState(event, ctx));
	pi.on("session_switch", async (event, ctx) => restoreUndoState(event, ctx));

	// tree navigation changes which branch is active — undo records
	// from the old branch should no longer be visible
	pi.on("session_tree", async (event, ctx) => restoreUndoState(event, ctx));
	pi.on("session_fork", async (event, ctx) => restoreUndoState(event, ctx));
}
