/**
 * github tools — 7 tools for reading, searching, and exploring github repos.
 *
 * designed for the librarian sub-agent but registered as top-level extension
 * tools. the librarian spawns a pi process with PI_INCLUDE_TOOLS set to
 * include these tool names.
 *
 * all tools use `gh api` CLI under the hood. requires authenticated gh CLI.
 *
 * tool schemas:
 *   read_github, search_github, list_directory_github,
 *   list_repositories, glob_github, commit_search, diff
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	parseRepoUrl,
	repoSlug,
	ghApi,
	ghApiPaginated,
	decodeBase64Content,
	addLineNumbers,
	truncate,
} from "./lib/github";

// --- read_github ---

export function createReadGithubTool(): ToolDefinition {
	return {
		name: "read_github",
		label: "Read GitHub",
		description:
			"Read the contents of a file from a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to examine the contents of a specific file in a remote repo\n" +
			"- When you want to understand implementation details across repositories\n\n" +
			"PARAMETERS:\n" +
			"- path: The file path to read\n" +
			"- repository: Repository URL (e.g., https://github.com/owner/repo)\n" +
			"- read_range: Optional [start_line, end_line] to read only specific lines",

		parameters: Type.Object({
			path: Type.String({ description: "The path to the file to read" }),
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			read_range: Type.Optional(
				Type.Array(Type.Number(), {
					minItems: 2,
					maxItems: 2,
					description: "Optional [start_line, end_line] to read only specific lines",
				}),
			),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const data = ghApi<any>(`repos/${repoSlug(ref)}/contents/${params.path}`);

				if (Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a directory, not a file. Use list_directory_github instead." }], isError: true };
				}

				if (data.type !== "file" || !data.content) {
					return { content: [{ type: "text" as const, text: `Not a file: ${data.type}` }], isError: true };
				}

				let content = decodeBase64Content(data.content);

				if (params.read_range) {
					const [start, end] = params.read_range;
					const lines = content.split("\n");
					const startIdx = Math.max(0, start - 1);
					const endIdx = Math.min(lines.length, end);
					content = lines.slice(startIdx, endIdx).join("\n");
					return { content: [{ type: "text" as const, text: addLineNumbers(content, start) }] };
				}

				return { content: [{ type: "text" as const, text: truncate(addLineNumbers(content), 64_000) }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const path = args.path || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("read_github ")) + theme.fg("dim", `${repo}/${path}`),
				0, 0,
			);
		},
	};
}

// --- search_github ---

export function createSearchGithubTool(): ToolDefinition {
	return {
		name: "search_github",
		label: "Search GitHub",
		description:
			"Search for code patterns and content in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to find code patterns across a repository\n" +
			"- When you want to understand how functionality is implemented\n\n" +
			"Supports GitHub search qualifiers (language:, path:, extension:, etc.).",

		parameters: Type.Object({
			pattern: Type.String({
				description: "The search pattern. Supports GitHub search operators (AND, OR, NOT) and qualifiers.",
			}),
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			path: Type.Optional(Type.String({ description: "Optional path to limit search to" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 30, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip for pagination (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const limit = params.limit ?? 30;
				const page = params.offset ? Math.floor(params.offset / limit) + 1 : 1;

				let query = `${params.pattern} repo:${repoSlug(ref)}`;
				if (params.path) query += ` path:${params.path}`;

				const data = ghApi<any>(`search/code`, {
					params: {
						q: query,
						per_page: Math.min(limit, 100),
						page,
					},
					accept: "application/vnd.github.text-match+json",
				});

				if (!data.items || data.items.length === 0) {
					return { content: [{ type: "text" as const, text: `No results for "${params.pattern}" in ${repoSlug(ref)}` }] };
				}

				const results: string[] = [`Found ${data.total_count} results (showing ${data.items.length}):\n`];

				for (const item of data.items) {
					results.push(`## ${item.path}`);
					if (item.text_matches) {
						for (const match of item.text_matches) {
							if (match.fragment) {
								results.push("```");
								results.push(match.fragment);
								results.push("```");
							}
						}
					}
					results.push("");
				}

				return { content: [{ type: "text" as const, text: truncate(results.join("\n"), 64_000) }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const pattern = args.pattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("search_github ")) + theme.fg("dim", `/${pattern}/ in ${repo}`),
				0, 0,
			);
		},
	};
}

// --- list_directory_github ---

export function createListDirectoryGithubTool(): ToolDefinition {
	return {
		name: "list_directory_github",
		label: "List Directory GitHub",
		description:
			"List the contents of a directory in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to understand the structure of a directory\n" +
			"- When exploring a codebase to find relevant files\n\n" +
			"Returns files and directories with trailing / for directories.",

		parameters: Type.Object({
			path: Type.String({ description: "The directory path to list (defaults to root)" }),
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			limit: Type.Optional(Type.Number({ description: "Max entries (default: 100, max: 1000)", minimum: 1, maximum: 1000 })),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const limit = params.limit ?? 100;
				const apiPath = params.path === "" || params.path === "." || params.path === "/"
					? ""
					: params.path;

				const data = ghApi<any[]>(`repos/${repoSlug(ref)}/contents/${apiPath}`);

				if (!Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a file, not a directory. Use read_github instead." }], isError: true };
				}

				const entries = data.slice(0, limit).map((item: any) => {
					const suffix = item.type === "dir" ? "/" : "";
					const size = item.type === "file" && item.size ? ` (${item.size} bytes)` : "";
					return `${item.name}${suffix}${size}`;
				});

				return { content: [{ type: "text" as const, text: entries.join("\n") }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const path = args.path || "/";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("list_directory_github ")) + theme.fg("dim", `${repo}/${path}`),
				0, 0,
			);
		},
	};
}

// --- list_repositories ---

export function createListRepositoriesTool(): ToolDefinition {
	return {
		name: "list_repositories",
		label: "List Repositories",
		description:
			"List and search for repositories on GitHub.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to find repositories by name\n" +
			"- When exploring repositories in an organization\n" +
			"- When you need repository metadata (stars, forks, descriptions)\n\n" +
			"Prioritizes your own repositories, then supplements with public results.",

		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Pattern to match in repository names" })),
			organization: Type.Optional(Type.String({ description: "Organization name to filter" })),
			language: Type.Optional(Type.String({ description: "Programming language to filter" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 30, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const limit = params.limit ?? 30;
				const page = params.offset ? Math.floor(params.offset / limit) + 1 : 1;

				const queryParts: string[] = [];
				if (params.pattern) queryParts.push(params.pattern);
				if (params.organization) queryParts.push(`org:${params.organization}`);
				if (params.language) queryParts.push(`language:${params.language}`);
				if (queryParts.length === 0) queryParts.push("stars:>0");

				const data = ghApi<any>("search/repositories", {
					params: {
						q: queryParts.join(" "),
						sort: "stars",
						per_page: Math.min(limit, 100),
						page,
					},
				});

				if (!data.items || data.items.length === 0) {
					return { content: [{ type: "text" as const, text: "No repositories found." }] };
				}

				const lines: string[] = [`Found ${data.total_count} repositories (showing ${data.items.length}):\n`];
				for (const repo of data.items) {
					lines.push(`## ${repo.full_name}`);
					if (repo.description) lines.push(repo.description);
					const meta = [
						repo.language,
						`★ ${repo.stargazers_count}`,
						`forks: ${repo.forks_count}`,
					].filter(Boolean).join(" · ");
					lines.push(meta);
					lines.push(`${repo.html_url}\n`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const query = args.pattern || args.organization || "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("list_repositories ")) + theme.fg("dim", query),
				0, 0,
			);
		},
	};
}

// --- glob_github ---

export function createGlobGithubTool(): ToolDefinition {
	return {
		name: "glob_github",
		label: "Glob GitHub",
		description:
			"Find files matching a glob pattern in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to find specific file types (e.g., all TypeScript files)\n" +
			"- When exploring codebase structure quickly\n\n" +
			"Uses the git tree API to list all files, then filters by pattern.",

		parameters: Type.Object({
			filePattern: Type.String({ description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.test.js")' }),
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 100)" })),
			offset: Type.Optional(Type.Number({ description: "Results to skip (default: 0)" })),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const limit = params.limit ?? 100;
				const offset = params.offset ?? 0;

				// get default branch
				const repoData = ghApi<any>(`repos/${repoSlug(ref)}`);
				const branch = repoData.default_branch || "main";

				// get full tree
				const tree = ghApi<any>(`repos/${repoSlug(ref)}/git/trees/${branch}?recursive=1`);

				if (!tree.tree) {
					return { content: [{ type: "text" as const, text: "Could not read repository tree." }], isError: true };
				}

				// filter by glob pattern using simple matching
				const pattern = params.filePattern;
				const files = tree.tree
					.filter((item: any) => item.type === "blob")
					.map((item: any) => item.path as string)
					.filter((path: string) => matchGlob(path, pattern));

				const total = files.length;
				const sliced = files.slice(offset, offset + limit);

				const output = [
					`Found ${total} files matching "${pattern}" (showing ${sliced.length}):`,
					"",
					...sliced,
				];

				return { content: [{ type: "text" as const, text: output.join("\n") }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const pattern = args.filePattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("glob_github ")) + theme.fg("dim", `${pattern} in ${repo}`),
				0, 0,
			);
		},
	};
}

// --- commit_search ---

export function createCommitSearchTool(): ToolDefinition {
	return {
		name: "commit_search",
		label: "Commit Search",
		description:
			"Search commit history in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to understand how code evolved over time\n" +
			"- When looking for commits by a specific author or date range\n" +
			"- When finding commits that changed specific files",

		parameters: Type.Object({
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			query: Type.Optional(Type.String({ description: "Search query for commit messages" })),
			author: Type.Optional(Type.String({ description: "Filter by author username or email" })),
			since: Type.Optional(Type.String({ description: 'ISO 8601 date for earliest commit (e.g., "2024-01-01T00:00:00Z")' })),
			until: Type.Optional(Type.String({ description: 'ISO 8601 date for latest commit (e.g., "2024-02-01T00:00:00Z")' })),
			path: Type.Optional(Type.String({ description: "Filter commits that changed specific files/directories" })),
			limit: Type.Optional(Type.Number({ description: "Max commits (default: 50, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Commits to skip (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const limit = params.limit ?? 50;
				const page = params.offset ? Math.floor(params.offset / limit) + 1 : 1;

				const apiParams: Record<string, string | number> = {
					per_page: Math.min(limit, 100),
					page,
				};
				if (params.author) apiParams.author = params.author;
				if (params.since) apiParams.since = params.since;
				if (params.until) apiParams.until = params.until;

				let endpoint = `repos/${repoSlug(ref)}/commits`;
				if (params.path) apiParams.path = params.path;

				const commits = ghApi<any[]>(endpoint, { params: apiParams });

				if (!Array.isArray(commits) || commits.length === 0) {
					return { content: [{ type: "text" as const, text: "No commits found." }] };
				}

				// filter by query in commit message if specified
				let filtered = commits;
				if (params.query) {
					const q = params.query.toLowerCase();
					filtered = commits.filter((c: any) =>
						c.commit?.message?.toLowerCase().includes(q),
					);
				}

				const lines: string[] = [`Found ${filtered.length} commits:\n`];
				for (const c of filtered) {
					const sha = c.sha?.slice(0, 7) ?? "???????";
					const author = c.commit?.author?.name ?? c.author?.login ?? "unknown";
					const date = c.commit?.author?.date ?? "";
					const msg = c.commit?.message?.split("\n")[0] ?? "";
					lines.push(`${sha} ${date} (${author}) ${msg}`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const query = args.query || args.author || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("commit_search ")) + theme.fg("dim", `${repo} ${query}`.trim()),
				0, 0,
			);
		},
	};
}

// --- diff ---

export function createDiffTool(): ToolDefinition {
	return {
		name: "diff",
		label: "Diff",
		description:
			"Get a diff between two commits, branches, or tags in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to see what changed between two points in history\n" +
			"- When reviewing changes across branches\n" +
			"- When understanding the scope of a release",

		parameters: Type.Object({
			base: Type.String({ description: 'The base ref to compare from (e.g., "main", "v1.0.0", or commit SHA)' }),
			head: Type.String({ description: 'The head ref to compare to (e.g., "feature-branch", "v2.0.0", or commit SHA)' }),
			repository: Type.String({ description: 'Repository URL (e.g., https://github.com/owner/repo)' }),
			includePatches: Type.Optional(Type.Boolean({
				description: "Include unified diff patches per file (token heavy). Default false.",
			})),
		}),

		async execute(_id, params) {
			try {
				const ref = parseRepoUrl(params.repository);
				const data = ghApi<any>(
					`repos/${repoSlug(ref)}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
				);

				const lines: string[] = [
					`Comparing ${params.base}...${params.head}`,
					`Status: ${data.status}`,
					`Ahead by: ${data.ahead_by} commits`,
					`Behind by: ${data.behind_by} commits`,
					`Changed files: ${data.files?.length ?? 0}`,
					"",
				];

				if (data.files) {
					for (const file of data.files) {
						const stat = `+${file.additions} -${file.deletions}`;
						lines.push(`${file.status} ${file.filename} (${stat})`);

						if (params.includePatches && file.patch) {
							lines.push("```diff");
							lines.push(truncate(file.patch, 4000));
							lines.push("```");
							lines.push("");
						}
					}
				}

				return { content: [{ type: "text" as const, text: truncate(lines.join("\n"), 64_000) }] };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any) {
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const range = `${args.base || "?"}...${args.head || "?"}`;
			return new Text(
				theme.fg("toolTitle", theme.bold("diff ")) + theme.fg("dim", `${repo} ${range}`),
				0, 0,
			);
		},
	};
}

// --- glob matching (simple, no external deps) ---

/**
 * simple glob matcher. supports:
 *   ** (any path segments), * (any within segment), ? (single char)
 */
function matchGlob(path: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/\./g, "\\.")
		.replace(/\*\*\//g, "(.+/)?")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	try {
		return new RegExp(`^${regexStr}$`).test(path);
	} catch {
		return path.includes(pattern.replace(/[*?]/g, ""));
	}
}
