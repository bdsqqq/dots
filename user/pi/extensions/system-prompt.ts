/**
 * system-prompt — injects interpolated prompt.amp.system.md into the agent's system prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * the full amp system prompt with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses the undocumented before_agent_start return value { systemPrompt } to modify
 * the system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} is populated by reading the
 * appropriate harness docs file (prompt.harness-docs.<harness>.md).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readAgentPrompt } from "./tools/lib/pi-spawn";
import { interpolatePromptVars } from "./tools/lib/interpolate";

/** harness configuration. TODO: make this configurable via settings or env. */
const HARNESS = "pi";
const IDENTITY = "Amp";

export default function (pi: ExtensionAPI) {
  const body = readAgentPrompt("prompt.amp.system.md");
  if (!body) return;

  // load harness docs based on harness name
  const harnessDocs =
    readAgentPrompt(`prompt.harness-docs.${HARNESS}.md`) || "";

  pi.on("before_agent_start", async (event, ctx) => {
    const interpolated = interpolatePromptVars(body, ctx.cwd, {
      sessionId: ctx.sessionManager.getSessionId(),
      identity: IDENTITY,
      harness: HARNESS,
      harnessDocsSection: harnessDocs,
    });

    if (!interpolated.trim()) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + interpolated,
    };
  });
}
