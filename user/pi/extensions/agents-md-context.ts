/**
 * agents-md-context — injects AGENTS.md files into context at session start and each turn.
 *
 * walks from cwd up to filesystem root, collecting all AGENTS.md files.
 * injects them as a custom message so the LLM sees directory-specific
 * instructions without needing to read a file first.
 *
 * refreshed on every turn to pick up changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgentsMdFromCwd, formatGuidance } from "./tools/lib/agents-md";

export default function (pi: ExtensionAPI) {
	const injectAgentsMd = (cwd: string) => {
		const guidance = discoverAgentsMdFromCwd(cwd);
		const content = formatGuidance(guidance);
		if (!content) return;

		return {
			message: {
				customType: "agents-md-context",
				content,
				display: "collapsed" as const,
			},
		};
	};

	pi.on("session_start", async (_event, ctx) => {
		return injectAgentsMd(ctx.cwd);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		return injectAgentsMd(ctx.cwd);
	});
}
