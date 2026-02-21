/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit_file, create_file)
 * - AGENTS.md discovery (read, edit_file, create_file)
 * - file change tracking for undo_edit (disk-persisted, branch-aware)
 *
 * file changes persist to ~/.pi/file-changes/{sessionId}/ as JSON files
 * keyed by tool call ID. branch awareness comes from the conversation
 * tree — tool call IDs in assistant messages are inherently branch-scoped.
 *
 * tool registrations will be added here as each tool is implemented.
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export { withFileLock } from "./lib/mutex";
export { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
export { saveChange, loadChanges, revertChange, findLatestChange, simpleDiff } from "./lib/file-tracker";

export default function (_pi: ExtensionAPI) {
	// tool registrations will be added as each tool is implemented
}
