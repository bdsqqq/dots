/**
 * agents-md-context — injects AGENTS.md files into context at session start and each turn.
 *
 * walks from cwd up to filesystem root, collecting all AGENTS.md files.
 * appends to system prompt so it's fresh each turn without accumulating in history.
 *
 * refreshed on every turn to pick up changes (additions/deletions).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgentsMdFromCwd, formatGuidance } from "./tools/lib/agents-md";

export default function (pi: ExtensionAPI) {
	const buildAgentsMdPrompt = (cwd: string): string => {
		const guidance = discoverAgentsMdFromCwd(cwd);
		return formatGuidance(guidance);
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const content = buildAgentsMdPrompt(ctx.cwd);
		if (!content) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + content,
		};
	});
}
