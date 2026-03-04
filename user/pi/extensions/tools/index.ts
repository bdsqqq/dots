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
 * PI_READ_COMPACT=1 switches read/ls to tighter limits for sub-agents.
 * shared infrastructure lives in ./lib/.
 */

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, NORMAL_LIMITS, COMPACT_LIMITS } from "@pi/read";
import { createLsTool } from "@pi/ls";
import { createEditFileTool } from "@pi/edit-file";
import { createCreateFileTool } from "@pi/create-file";
import { createGrepTool } from "@pi/grep";
import { createGlobTool } from "@pi/glob";
import { createBashTool } from "@pi/bash";
import { createUndoEditTool } from "@pi/undo-edit";
import { createFormatFileTool } from "@pi/format-file";
import { createSkillTool } from "@pi/skill";
import { createFinderTool } from "./finder";
import { createOracleTool } from "./oracle";
import { createTaskTool } from "./task";
import { createLibrarianTool } from "./librarian";
import { createCodeReviewTool } from "./code-review";
import { createLookAtTool } from "./look-at";
import { createReadWebPageTool } from "./read-web-page";
import { createWebSearchTool } from "./web-search";
import { createSearchSessionsTool } from "./search-sessions";
import { createReadSessionTool } from "./read-session";
import { readAgentPrompt } from "@pi/pi-spawn";
import {
  createReadGithubTool,
  createSearchGithubTool,
  createListDirectoryGithubTool,
  createListRepositoriesTool,
  createGlobGithubTool,
  createCommitSearchTool,
  createDiffTool,
} from "./github";

export { withFileLock } from "@pi/mutex";
export {
  saveChange,
  loadChanges,
  revertChange,
  findLatestChange,
  simpleDiff,
} from "@pi/file-tracker";

export function withPromptPatch(tool: ToolDefinition): ToolDefinition {
  const snippet = (tool.description?.split("\n\n")[0] ?? "").trim();
  const guidelines = (tool.description ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  const patched: ToolDefinition = { ...tool };
  if (!patched.promptSnippet) patched.promptSnippet = snippet;
  if (!patched.promptGuidelines && guidelines.length > 0) {
    patched.promptGuidelines = guidelines;
  }

  return patched;
}

export default function (pi: ExtensionAPI) {
  const limits = process.env.PI_READ_COMPACT ? COMPACT_LIMITS : NORMAL_LIMITS;
  const register = (tool: ToolDefinition) =>
    pi.registerTool(withPromptPatch(tool));

  register(createReadTool(limits));
  register(createLsTool(limits));
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
