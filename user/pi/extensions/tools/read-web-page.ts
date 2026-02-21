/**
 * read_web_page tool — fetch web pages as markdown via curl.
 *
 * v1: sends `Accept: text/markdown` header. many sites and CDNs
 * respect this and return markdown directly. when they don't, you
 * get HTML — still usable but noisier.
 *
 * future iterations can add:
 * - readability extraction (mozilla/readability or similar)
 * - LLM-based objective extraction via piSpawn
 * - caching layer (forceRefetch would matter then)
 *
 * does NOT use pi's built-in tools — just spawns curl directly.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_OUTPUT_CHARS = 64_000;
const CURL_TIMEOUT_SECS = 30;
const MAX_REDIRECTS = 5;

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}\n\n... (truncated, ${text.length} total characters)`;
}

export function createReadWebPageTool(): ToolDefinition {
	return {
		name: "read_web_page",
		label: "Read Web Page",
		description:
			"Read the contents of a web page at a given URL.\n\n" +
			"Returns the page content as markdown when the server supports it, " +
			"otherwise returns raw HTML.\n\n" +
			"When an objective is provided, the full content is still returned " +
			"but the objective is noted for the caller to filter relevant sections.\n\n" +
			"Do NOT use for localhost or local URLs — use `curl` via Bash instead.",

		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to read.",
			}),
			objective: Type.Optional(
				Type.String({
					description:
						"A natural-language description of what you're looking for. " +
						"If set, focus on extracting relevant information from the response.",
				}),
			),
			forceRefetch: Type.Optional(
				Type.Boolean({
					description: "Force a live fetch (no caching). Currently always fetches live.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const url = params.url;

			// basic URL validation
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return {
					content: [{ type: "text" as const, text: `invalid URL: "${url}" — must start with http:// or https://` }],
					isError: true,
				} as any;
			}

			return new Promise((resolve) => {
				const args = [
					"-sL",
					"-H", "Accept: text/markdown",
					"-m", String(CURL_TIMEOUT_SECS),
					"--max-redirs", String(MAX_REDIRECTS),
					// common bot-hostile sites need a real user-agent
					"-A", "Mozilla/5.0 (compatible; pi-agent/1.0)",
					url,
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
					// cap memory
					if (stdout.length > MAX_OUTPUT_CHARS * 2) {
						stdout = stdout.slice(-MAX_OUTPUT_CHARS);
					}
				});

				child.stderr?.on("data", (data: Buffer) => {
					stderr += data.toString("utf-8");
				});

				child.on("error", (err) => {
					signal?.removeEventListener("abort", onAbort);
					resolve({
						content: [{ type: "text" as const, text: `curl error: ${err.message}` }],
						isError: true,
					} as any);
				});

				child.on("close", (code) => {
					signal?.removeEventListener("abort", onAbort);

					if (aborted) {
						resolve({
							content: [{ type: "text" as const, text: "fetch aborted" }],
							isError: true,
						} as any);
						return;
					}

					if (code !== 0) {
						const msg = stderr.trim() || `curl exited with code ${code}`;
						resolve({
							content: [{ type: "text" as const, text: `fetch failed: ${msg}` }],
							isError: true,
						} as any);
						return;
					}

					if (!stdout.trim()) {
						resolve({
							content: [{ type: "text" as const, text: "(empty response)" }],
						} as any);
						return;
					}

					let result = truncate(stdout, MAX_OUTPUT_CHARS);

					if (params.objective) {
						result = `Objective: ${params.objective}\n\n---\n\n${result}`;
					}

					resolve({ content: [{ type: "text" as const, text: result }] } as any);
				});
			});
		},
	};
}
