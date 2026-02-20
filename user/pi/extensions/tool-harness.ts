/**
 * tool-harness — custom includeTools for pi extensions.
 *
 * pi's --tools/--no-tools flags only gate built-in tools. extension tools
 * registered via pi.registerTool() always load. this extension reads
 * PI_INCLUDE_TOOLS on session start and calls pi.setActiveTools() to
 * filter down to exactly the specified set — both built-in and extension.
 *
 * env var format: PI_INCLUDE_TOOLS=read,grep,find,bash
 * when unset, all tools remain active (no filtering).
 *
 * designed for sub-agent spawning: the sub-agents extension passes
 * PI_INCLUDE_TOOLS in the child process env to control tool visibility.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const raw = process.env.PI_INCLUDE_TOOLS;
	if (!raw) return;

	const allowed = raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	if (allowed.length === 0) return;

	const applyFilter = () => pi.setActiveTools(allowed);

	// filter after all extensions have registered their tools
	pi.on("session_start", async () => {
		applyFilter();
	});

	// re-filter before each agent turn in case registerTool re-added tools
	pi.on("before_agent_start", async () => {
		applyFilter();
	});
}
