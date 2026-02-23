/**
 * read tool — replaces pi's built-in with enhanced file reading.
 *
 * differences from pi's built-in:
 * - line-numbered output (`1: content`)
 * - directory listing integrated (no separate ls tool needed)
 * - AGENTS.md discovery after every read
 * - secret file blocking (.env etc.)
 * - `~` expansion and `@` prefix stripping
 * - image support via base64
 * - compact variant for sub-agents (PI_READ_COMPACT=1)
 *
 * uses `path` + optional `read_range` [start, end] interface.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { makeShowRenderer } from "./lib/show-renderer";
import { Type } from "@sinclair/typebox";
import { discoverAgentsMd, formatGuidance } from "./lib/agents-md";
import { formatHeadTail } from "./lib/output-buffer";

// --- limits ---

export interface ReadLimits {
	maxLines: number;
	maxFileBytes: number;
	maxLineBytes: number;
	maxDirEntries: number;
}

export const NORMAL_LIMITS: ReadLimits = {
	maxLines: 500,
	maxFileBytes: 64 * 1024,
	maxLineBytes: 4096,
	maxDirEntries: 1000,
};

/** sub-agents get tighter limits to conserve their smaller context window */
export const COMPACT_LIMITS: ReadLimits = {
	maxLines: 200,
	maxFileBytes: 32 * 1024,
	maxLineBytes: 1024,
	maxDirEntries: 1000,
};

const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+$/];
const SECRET_EXCEPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);

const IMAGE_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

// --- path resolution (reimplemented; pi's path-utils aren't re-exported) ---

export function expandPath(filePath: string): string {
	const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (stripped === "~") return os.homedir();
	if (stripped.startsWith("~/")) return os.homedir() + stripped.slice(1);
	return stripped;
}

export function resolveToAbsolute(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * try macOS filesystem variants when file doesn't exist at resolved path.
 * covers NFD normalization and narrow no-break space in AM/PM timestamps.
 */
export function resolveWithVariants(filePath: string, cwd: string): string {
	const resolved = resolveToAbsolute(filePath, cwd);
	if (fs.existsSync(resolved)) return resolved;

	const amPm = resolved.replace(/ (AM|PM)\./g, `\u202F$1.`);
	if (amPm !== resolved && fs.existsSync(amPm)) return amPm;

	const nfd = resolved.normalize("NFD");
	if (nfd !== resolved && fs.existsSync(nfd)) return nfd;

	return resolved;
}

// --- checks ---

export function isSecretFile(filePath: string): boolean {
	const basename = path.basename(filePath);
	if (SECRET_EXCEPTIONS.has(basename)) return false;
	return SECRET_PATTERNS.some((p) => p.test(basename));
}

function getImageMime(filePath: string): string | undefined {
	return IMAGE_MIME[path.extname(filePath).toLowerCase()];
}

// --- directory listing ---

export function listDirectory(dirPath: string, maxEntries: number): string {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch (err: any) {
		throw new Error(`cannot list directory: ${err.message}`);
	}

	const names = entries
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.sort((a, b) => a.localeCompare(b));

	return formatHeadTail(names, maxEntries, (n) => `... [${n} more entries] ...`);
}

// --- file reading ---

interface ReadResult {
	text: string;
	totalLines: number;
	shownStart: number;
	shownEnd: number;
}

function readFileContent(
	filePath: string,
	limits: ReadLimits,
	readRange?: [number, number],
): ReadResult {
	const raw = fs.readFileSync(filePath, "utf-8");
	const allLines = raw.split("\n");
	const totalLines = allLines.length;

	// determine the range to show
	const start = Math.max(1, readRange?.[0] ?? 1);
	const end = Math.min(totalLines, readRange?.[1] ?? start + limits.maxLines - 1);
	const requestedLines = end - start + 1;

	// number lines and truncate long lines
	const numbered: string[] = [];
	for (let i = start - 1; i < end; i++) {
		let line = allLines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8");

		if (lineBytes > limits.maxLineBytes) {
			while (Buffer.byteLength(line, "utf-8") > limits.maxLineBytes) {
				line = line.slice(0, Math.max(1, line.length - 100));
			}
			line += "... (line truncated)";
		}

		numbered.push(`${i + 1}: ${line}`);
	}

	// if numbered output fits in byte limit, return as-is
	const totalBytes = numbered.reduce((sum, l) => sum + Buffer.byteLength(l, "utf-8") + 1, 0);
	if (totalBytes <= limits.maxFileBytes) {
		return { text: numbered.join("\n"), totalLines, shownStart: start, shownEnd: end };
	}

	// otherwise apply head+tail truncation on the numbered lines
	const formatted = formatHeadTail(numbered, limits.maxLines, (n) =>
		`... [${n} lines truncated, ${limits.maxFileBytes / 1024}KB limit reached] ...`);

	return {
		text: formatted,
		totalLines,
		shownStart: start,
		shownEnd: end,
	};
}

// --- tool factory ---

export function createReadTool(limits: ReadLimits): ToolDefinition {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file or list a directory from the file system. If the path is a directory, it returns a list of entries. If the file or directory doesn't exist, an error is returned.\n\n" +
			`- The path parameter MUST be an absolute path.\n` +
			`- By default, this tool returns the first ${limits.maxLines} lines. To read more, call it multiple times with different read_ranges.\n` +
			"- Use the Grep tool to find specific content in large files or files with long lines.\n" +
			"- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n" +
			"- The contents are returned with each line prefixed by its line number. For example, if a file has contents \"abc\\n\", you will receive \"1: abc\\n\". For directories, entries are returned one per line (without line numbers) with a trailing \"/\" for subdirectories.\n" +
			"- This tool can read images (such as PNG, JPEG, and GIF files) and present them to the model visually.\n" +
			"- When possible, call this tool in parallel for all files you will want to read.\n" +
			"      - Avoid tiny repeated slices (e.g., 50‑line chunks). If you need more context from the same file, read a larger range or the full default window instead.",

		parameters: Type.Object({
			path: Type.String({
				description: "The absolute path to the file or directory (MUST be absolute, not relative).",
			}),
			read_range: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						`An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed. If not provided, defaults to [1, ${limits.maxLines}]. Examples: [500, 700], [700, 1400]`,
					minItems: 2,
					maxItems: 2,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveWithVariants(params.path, ctx.cwd);

			if (isSecretFile(resolved)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `refused to read ${path.basename(resolved)}: file may contain secrets. ask the user to share relevant values.`,
						},
					],
					isError: true,
				} as any;
			}

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text" as const, text: `file not found: ${resolved}` }],
					isError: true,
				} as any;
			}

			const stat = fs.statSync(resolved);

			// --- directory ---
			if (stat.isDirectory()) {
				try {
					let text = listDirectory(resolved, limits.maxDirEntries);
					const guidanceText = formatGuidance(discoverAgentsMd(resolved, ctx.cwd));
					if (guidanceText) text += "\n\n" + guidanceText;
					return { content: [{ type: "text" as const, text }] } as any;
				} catch (err: any) {
					return {
						content: [{ type: "text" as const, text: err.message }],
						isError: true,
					} as any;
				}
			}

			// --- image ---
			const mime = getImageMime(resolved);
			if (mime) {
				try {
					const base64 = fs.readFileSync(resolved).toString("base64");
					return { content: [{ type: "image" as const, data: base64, mimeType: mime }] } as any;
				} catch (err: any) {
					return {
						content: [{ type: "text" as const, text: `failed to read image: ${err.message}` }],
						isError: true,
					} as any;
				}
			}

			// --- text file ---
			try {
				const readRange = params.read_range as [number, number] | undefined;
				const { text, totalLines, shownStart, shownEnd } = readFileContent(resolved, limits, readRange);

				let result = text;

				if (shownEnd < totalLines) {
					result += `\n\n(showing lines ${shownStart}-${shownEnd} of ${totalLines}. use read_range to see more.)`;
				}

				const guidanceText = formatGuidance(discoverAgentsMd(resolved, ctx.cwd));
				if (guidanceText) result += "\n\n" + guidanceText;

				return { content: [{ type: "text" as const, text: result }] } as any;
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `failed to read file: ${err.message}` }],
					isError: true,
				} as any;
			}
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, _theme: any) {
			const text = result.content?.[0];
			if (text?.type !== "text") return undefined; // images — let pi handle
			const output: string = text.text;
			if (expanded) return new Text(output, 0, 0);

			// collapsed: head+tail so both the start of the file (imports, header,
			// function signatures) and the end are visible without scrolling.
			return makeShowRenderer(output, [
				{ focus: "head", context: 3 },
				{ focus: "tail", context: 5 },
			]);
		},
	};
}
