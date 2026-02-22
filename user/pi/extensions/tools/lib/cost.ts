/**
 * tool cost tagging — embeds cost metadata in tool result content.
 *
 * any tool that incurs costs (sub-agent spawns, API calls, etc.)
 * appends an HTML comment to its text output via tagCost(). the
 * editor extension scans tool results in the session branch via
 * extractCost() to reconstruct total spend.
 *
 * the tag is invisible in markdown rendering but persisted in the
 * session JSONL — single source of truth, survives session switches.
 */

const COST_TAG_RE = /\n<!-- (?:tool|subagent)-cost:([\d.]+) -->$/;

export function tagCost(text: string, cost: number): string {
	if (cost <= 0) return text;
	return `${text}\n<!-- tool-cost:${cost} -->`;
}

export function extractCost(text: string): number {
	const match = COST_TAG_RE.exec(text);
	return match ? parseFloat(match[1]) || 0 : 0;
}
