/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit_file, create_file)
 * - AGENTS.md discovery (read, edit_file, create_file)
 * - edit tracking for undo_edit
 *
 * tool registrations will be added here as each tool is implemented.
 * shared infrastructure lives in ./lib/ and is imported by individual
 * tool modules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// verify lib imports resolve (will be used by tool implementations)
export { withFileLock } from "./lib/mutex";
export { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
export { trackBeforeEdit, undoEdit, clearAll as clearEdits } from "./lib/file-tracker";

export default function (pi: ExtensionAPI) {
	// clear edit tracker on session switch — undo state is per-session
	pi.on("session_switch", async () => {
		const { clearAll } = await import("./lib/file-tracker");
		clearAll();
	});
}
