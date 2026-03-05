/**
 * system-prompt — injects interpolated prompt.amp.system.md into the agent's system prompt.
 *
 * pi's built-in system prompt only provides date + cwd. this extension appends
 * the full amp system prompt with runtime-interpolated template vars: workspace root,
 * OS info, git remote, session ID, and directory listing.
 *
 * uses before_agent_start return value { systemPrompt } to modify the
 * system prompt per-turn. handlers chain — each receives the previous handler's
 * systemPrompt via event.systemPrompt.
 *
 * identity/harness decoupling: {identity} and {harness} are interpolated with
 * configurable values. {harness_docs_section} is populated by reading the
 * appropriate harness docs file (prompt.harness-docs.<harness>.md).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readAgentPrompt } from "@bds_pi/pi-spawn";
import { interpolatePromptVars } from "@bds_pi/interpolate";
import { getExtensionConfig } from "@bds_pi/config";

type SystemPromptExtConfig = {
  identity: string;
  harness: string;
};

const CONFIG_DEFAULTS: SystemPromptExtConfig = {
  identity: "Amp",
  harness: "pi",
};

export default function (pi: ExtensionAPI) {
  const cfg = getExtensionConfig("@bds_pi/system-prompt", CONFIG_DEFAULTS);
  const body = readAgentPrompt("prompt.amp.system.md");
  if (!body) return;

  const harnessDocs = readAgentPrompt(`prompt.harness-docs.${cfg.harness}.md`) || "";

  pi.on("before_agent_start", async (event, ctx) => {
    const interpolated = interpolatePromptVars(body, ctx.cwd, {
      sessionId: ctx.sessionManager.getSessionId(),
      identity: cfg.identity,
      harness: cfg.harness,
      harnessDocsSection: harnessDocs,
    });

    if (!interpolated.trim()) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + interpolated,
    };
  });
}
