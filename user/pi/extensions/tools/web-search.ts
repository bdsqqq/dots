/**
 * web_search tool — search the web via Parallel AI's Search API.
 *
 * direct HTTP call (no sub-agent). posts to parallel's search endpoint,
 * formats results as markdown with title/url/excerpts per result.
 *
 * parallel AI is the same provider amp uses internally (confirmed via
 * their Series A blog post listing amp as a customer).
 *
 * auth: PARALLEL_API_KEY env var → x-api-key header.
 * pricing: $5/1k queries.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const ENDPOINT = "https://api.parallel.ai/v1beta/search";
const CURL_TIMEOUT_SECS = 30;
const DEFAULT_MAX_RESULTS = 5;

interface SearchResult {
	url: string;
	title: string;
	publish_date?: string;
	excerpts: string[];
}

interface SearchResponse {
	search_id?: string;
	results: SearchResult[];
	warnings?: string[];
	usage?: Record<string, unknown>;
}

function searchParallel(
	apiKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ data?: SearchResponse; error?: string }> {
	return new Promise((resolve) => {
		const payload = JSON.stringify(body);

		const args = [
			"-sL",
			"-X", "POST",
			"-H", "Content-Type: application/json",
			"-H", `x-api-key: ${apiKey}`,
			"-H", "parallel-beta: search-extract-2025-10-10",
			"-m", String(CURL_TIMEOUT_SECS),
			"-d", payload,
			ENDPOINT,
		];

		const child = spawn("curl", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			if (!child.killed) child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) { onAbort(); }
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf-8");
		});

		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf-8");
		});

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ error: `curl error: ${err.message}` });
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (aborted) { resolve({ error: "search aborted" }); return; }
			if (code !== 0) {
				resolve({ error: `search failed: ${stderr.trim() || `curl exited with code ${code}`}` });
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as SearchResponse;
				resolve({ data: parsed });
			} catch {
				resolve({ error: `invalid response from Parallel API: ${stdout.slice(0, 200)}` });
			}
		});
	});
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "(no results found)";

	const sections: string[] = [];
	for (const r of results) {
		const lines: string[] = [];
		lines.push(`### ${r.title || "(untitled)"}`);
		lines.push(r.url);
		if (r.publish_date) lines.push(`*${r.publish_date}*`);
		if (r.excerpts?.length) {
			lines.push("");
			lines.push(r.excerpts.join("\n\n"));
		}
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n---\n\n");
}

export function createWebSearchTool(): ToolDefinition {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information relevant to a research objective.\n\n" +
			"Use when you need up-to-date or precise documentation. " +
			"Use `read_web_page` to fetch full content from a specific URL.\n\n" +
			"# Examples\n\n" +
			"Get API documentation for a specific provider\n" +
			'```json\n{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe\'s docs site."}\n```\n\n' +
			"See usage documentation for newly released library features\n" +
			'```json\n{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}\n```',

		parameters: Type.Object({
			objective: Type.String({
				description:
					"A natural-language description of the broader task or research goal, " +
					"including any source or freshness guidance.",
			}),
			search_queries: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional keyword queries to ensure matches for specific terms are " +
						"prioritized (recommended for best results).",
				}),
			),
			max_results: Type.Optional(
				Type.Number({
					description: `The maximum number of results to return (default: ${DEFAULT_MAX_RESULTS}).`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const apiKey = process.env.PARALLEL_API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "PARALLEL_API_KEY not set. add it to secrets.yaml and export in shell.nix." }],
					isError: true,
				} as any;
			}

			const body: Record<string, unknown> = {
				objective: params.objective,
				max_results: params.max_results ?? DEFAULT_MAX_RESULTS,
				excerpts: { max_chars_per_result: 2000 },
			};
			if (params.search_queries?.length) {
				body.search_queries = params.search_queries;
			}

			const { data, error } = await searchParallel(apiKey, body, signal);

			if (error) {
				return {
					content: [{ type: "text" as const, text: error }],
					isError: true,
				} as any;
			}

			if (!data?.results) {
				return {
					content: [{ type: "text" as const, text: "(no results)" }],
				} as any;
			}

			let output = formatResults(data.results);

			if (data.warnings?.length) {
				output += `\n\n**Warnings:** ${data.warnings.join("; ")}`;
			}

			return { content: [{ type: "text" as const, text: output }] } as any;
		},

		renderCall(args: any, theme: any) {
			const objective = args.objective || "...";
			const short = objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
			let text = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", short);
			if (args.search_queries?.length) {
				text += theme.fg("muted", ` [${args.search_queries.join(", ")}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any) {
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	};
}
