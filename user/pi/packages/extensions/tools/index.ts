/**
 * tools extension — custom tool implementations for pi.
 *
 * replaces pi's built-in tools with versions that add:
 * - file mutex locking (edit_file, create_file)
 * - file change tracking for undo_edit (disk-persisted, branch-aware)
 *
 * file changes persist to ~/.pi/file-changes/{sessionId}/ as JSON files
 * keyed by tool call ID. branch awareness comes from the conversation
 * tree — tool call IDs in assistant messages are inherently branch-scoped.
 *
 * shared infrastructure lives in ./lib/.
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, NORMAL_LIMITS } from "@bds_pi/read";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import { createLsTool } from "@bds_pi/ls";
import { createEditFileTool } from "@bds_pi/edit-file";
import { createCreateFileTool } from "@bds_pi/create-file";
import { createGrepTool } from "@bds_pi/grep";
import { createGlobTool } from "@bds_pi/glob";
import { createBashTool } from "@bds_pi/bash";
import { createUndoEditTool } from "@bds_pi/undo-edit";
import { createFormatFileTool } from "@bds_pi/format-file";
import { createSkillTool } from "@bds_pi/skill";
import { createFinderTool } from "@bds_pi/finder";
import { createOracleTool } from "@bds_pi/oracle";
import { createTaskTool } from "@bds_pi/task";
import { createLibrarianTool } from "@bds_pi/librarian";
import { createCodeReviewTool } from "@bds_pi/code-review";
import { createLookAtTool } from "@bds_pi/look-at";
import { createReadWebPageTool } from "@bds_pi/read-web-page";
import { createWebSearchTool } from "@bds_pi/web-search";
import { createSearchSessionsTool } from "@bds_pi/search-sessions";
import { createReadSessionTool } from "@bds_pi/read-session";
import { readAgentPrompt } from "@bds_pi/pi-spawn";
import {
  createReadGithubTool,
  createSearchGithubTool,
  createListDirectoryGithubTool,
  createListRepositoriesTool,
  createGlobGithubTool,
  createCommitSearchTool,
  createDiffTool,
} from "@bds_pi/github";

export { withFileLock } from "@bds_pi/mutex";
export {
  saveChange,
  loadChanges,
  revertChange,
  findLatestChange,
  simpleDiff,
} from "@bds_pi/file-tracker";

export { withPromptPatch } from "@bds_pi/prompt-patch";

export default function (pi: ExtensionAPI) {
  const register = (tool: ToolDefinition) =>
    pi.registerTool(withPromptPatch(tool));

  register(createReadTool(NORMAL_LIMITS));
  register(createLsTool(NORMAL_LIMITS));
  register(createEditFileTool());
  register(createCreateFileTool());
  register(createGrepTool());
  register(createGlobTool());
  register(createBashTool());
  register(createUndoEditTool());
  register(createFormatFileTool());
  register(createSkillTool());
  register(
    createFinderTool({
      systemPrompt: readAgentPrompt("agent.amp.finder.md"),
    }),
  );
  register(
    createOracleTool({
      systemPrompt: readAgentPrompt("agent.amp.oracle.md"),
    }),
  );
  register(createTaskTool());
  register(
    createLibrarianTool({
      systemPrompt: readAgentPrompt("agent.amp.librarian.md"),
    }),
  );
  register(
    createCodeReviewTool({
      systemPrompt: readAgentPrompt("prompt.amp.code-review-system.md"),
      reportFormat: readAgentPrompt("prompt.amp.code-review-report.md"),
    }),
  );
  register(
    createLookAtTool({
      systemPrompt: readAgentPrompt("prompt.amp.look-at.md"),
    }),
  );
  register(
    createReadWebPageTool({
      systemPrompt: readAgentPrompt("prompt.amp.read-web-page.md"),
    }),
  );
  register(createWebSearchTool());
  register(createSearchSessionsTool());
  register(createReadSessionTool());

  // github tools — used by librarian sub-agent, also available to main agent
  register(createReadGithubTool());
  register(createSearchGithubTool());
  register(createListDirectoryGithubTool());
  register(createListRepositoriesTool());
  register(createGlobGithubTool());
  register(createCommitSearchTool());
  register(createDiffTool());
}
