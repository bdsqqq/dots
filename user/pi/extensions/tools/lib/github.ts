/**
 * shared helpers for github tools.
 *
 * wraps `gh api` CLI calls. requires gh CLI authenticated
 * (GH_TOKEN or `gh auth login`). all tools parse repository
 * URLs in the format "https://github.com/owner/repo" or
 * shorthand "owner/repo".
 */

import { spawnSync } from "node:child_process";

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * parse a repository URL or shorthand into owner/repo.
 * accepts:
 *   - https://github.com/owner/repo
 *   - github.com/owner/repo
 *   - owner/repo
 */
export function parseRepoUrl(input: string): RepoRef {
  const cleaned = input
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const parts = cleaned.split("/");
  if (parts.length < 2) {
    throw new Error(
      `invalid repository: "${input}" — expected "owner/repo" or full URL`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

/** build the "owner/repo" string for gh api paths. */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * call `gh api` and return parsed JSON.
 * throws on non-zero exit or JSON parse failure.
 *
 * params are appended as query string (GET-safe). gh api's `-f` flag
 * forces POST, which breaks search/list endpoints.
 */
export function ghApi<T = any>(
  endpoint: string,
  opts?: {
    method?: string;
    params?: Record<string, string | number>;
    rawOutput?: boolean;
    accept?: string;
  },
): T {
  let url = endpoint;
  if (opts?.params) {
    const qs = Object.entries(opts.params)
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const args = ["gh", "api", url];

  if (opts?.method) args.push("--method", opts.method);
  if (opts?.accept) args.push("-H", `Accept: ${opts.accept}`);

  const result = spawnSync(args[0], args.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "unknown error";
    throw new Error(`gh api ${endpoint} failed: ${stderr}`);
  }

  const stdout = result.stdout?.trim() || "";
  if (opts?.rawOutput) return stdout as T;

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gh api ${endpoint}: invalid JSON response`);
  }
}

/**
 * paginated gh api call. collects items across pages.
 * github REST APIs return arrays for list endpoints.
 */
export function ghApiPaginated<T = any>(
  endpoint: string,
  opts?: {
    params?: Record<string, string | number>;
    limit?: number;
    offset?: number;
  },
): T[] {
  const limit = opts?.limit ?? 30;
  const offset = opts?.offset ?? 0;
  const perPage = Math.min(limit, 100);
  const page = Math.floor(offset / perPage) + 1;

  const params: Record<string, string | number> = {
    ...opts?.params,
    per_page: perPage,
    page,
  };

  const result = ghApi<T[]>(endpoint, { params });
  return Array.isArray(result) ? result.slice(0, limit) : [];
}

/** decode base64 content from github contents API. */
export function decodeBase64Content(encoded: string): string {
  return Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf-8");
}

/** add line numbers to file content. */
export function addLineNumbers(content: string, startLine = 1): string {
  return content
    .split("\n")
    .map((line, i) => `${startLine + i}: ${line}`)
    .join("\n");
}

/** truncate string to max length with indicator. */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... (truncated, ${text.length} total characters)`;
}
