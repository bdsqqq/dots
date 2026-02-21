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
 * PI_READ_COMPACT=1 switches read/ls to tighter limits for sub-agents.
 * shared infrastructure lives in ./lib/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadTool, NORMAL_LIMITS, COMPACT_LIMITS } from "./read";
import { createLsTool } from "./ls";
import { createEditFileTool } from "./edit-file";
import { createCreateFileTool } from "./create-file";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool } from "./bash";

export { withFileLock } from "./lib/mutex";
export { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
export { saveChange, loadChanges, revertChange, findLatestChange, simpleDiff } from "./lib/file-tracker";

export default function (pi: ExtensionAPI) {
	const limits = process.env.PI_READ_COMPACT ? COMPACT_LIMITS : NORMAL_LIMITS;

	pi.registerTool(createReadTool(limits));
	pi.registerTool(createLsTool(limits));
	pi.registerTool(createEditFileTool());
	pi.registerTool(createCreateFileTool());
	pi.registerTool(createGrepTool());
	pi.registerTool(createGlobTool());
	pi.registerTool(createBashTool());
}
