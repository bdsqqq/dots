/**
 * AGENTS.md discovery — walks directory hierarchy to find guidance files.
 *
 * injects AGENTS.md contents into tool results after file reads/writes
 * so the LLM sees directory-specific instructions. guidance files closer
 * to the target file take precedence (returned last in array).
 *
 * also checks the user's global AGENTS.md at ~/.config/amp/AGENTS.md
 * (we use ~/.config/pi/AGENTS.md for pi).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentsGuidance {
	/** absolute path to the AGENTS.md file */
	path: string;
	/** file contents */
	content: string;
	/** human-readable scope: "global", "project", or relative dir path */
	scope: string;
}

const FILENAME = "AGENTS.md";
const GLOBAL_PATH = path.join(os.homedir(), ".config", "pi", FILENAME);

/**
 * discover AGENTS.md files relevant to `filePath`, from broadest to
 * most specific scope. walks from workspace root down to the file's
 * directory, prepending the global config if it exists.
 */
export function discoverAgentsMd(filePath: string, workspaceRoot: string): AgentsGuidance[] {
	const results: AgentsGuidance[] = [];
	const root = path.resolve(workspaceRoot);

	// global user config
	if (fs.existsSync(GLOBAL_PATH)) {
		try {
			results.push({
				path: GLOBAL_PATH,
				content: fs.readFileSync(GLOBAL_PATH, "utf-8"),
				scope: "global",
			});
		} catch {
			// unreadable, skip
		}
	}

	// walk from file's directory up to workspace root (then reverse for
	// broadest-first ordering)
	const dirResults: AgentsGuidance[] = [];
	let dir = path.dirname(path.resolve(filePath));

	while (dir.startsWith(root) || dir === root) {
		const candidate = path.join(dir, FILENAME);
		if (fs.existsSync(candidate)) {
			try {
				const content = fs.readFileSync(candidate, "utf-8");
				const scope = dir === root ? "project" : path.relative(root, dir);
				dirResults.push({ path: candidate, content, scope });
			} catch {
				// unreadable, skip
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// walked upward, so reverse to get project root → specific directory
	results.push(...dirResults.reverse());
	return results;
}

/**
 * discover AGENTS.md files from cwd up to filesystem root.
 * used for session-level context injection on start and each turn.
 * returns broadest-first (root → cwd).
 */
export function discoverAgentsMdFromCwd(cwd: string): AgentsGuidance[] {
	const results: AgentsGuidance[] = [];

	// global user config
	if (fs.existsSync(GLOBAL_PATH)) {
		try {
			results.push({
				path: GLOBAL_PATH,
				content: fs.readFileSync(GLOBAL_PATH, "utf-8"),
				scope: "global",
			});
		} catch {
			// unreadable, skip
		}
	}

	// walk from cwd up to filesystem root
	const dirResults: AgentsGuidance[] = [];
	let dir = path.resolve(cwd);
	const parts = dir.split(path.sep);

	// collect all parent directories from cwd to root
	for (let i = parts.length; i > 0; i--) {
		const currentPath = parts.slice(0, i).join(path.sep) || "/";
		const candidate = path.join(currentPath, FILENAME);
		if (fs.existsSync(candidate)) {
			try {
				const content = fs.readFileSync(candidate, "utf-8");
				const scope = currentPath === cwd ? "cwd" : path.relative(currentPath, cwd) || "root";
				dirResults.push({ path: candidate, content, scope });
			} catch {
				// unreadable, skip
			}
		}
	}

	// reverse to get root → cwd ordering
	results.push(...dirResults.reverse());
	return results;
}

/**
 * format discovered guidance for injection into tool results.
 * output format: header with scope, then content.
 */
export function formatGuidance(guidance: AgentsGuidance[]): string {
	if (guidance.length === 0) return "";

	return guidance
		.map((g) => {
			const header = `Contents of ${g.path} (directory-specific instructions for ${g.scope}):`;
			return `${header}\n\n<instructions>\n${g.content}\n</instructions>`;
		})
		.join("\n\n");
}
