import { execFileSync } from "node:child_process";
import { createCache, getOrSet } from "./cache";
import type { ResolvedCommitMention } from "./types";

export interface CommitIndex {
  root: string;
  commits: ResolvedCommitMention[];
}

export type CommitLookupResult =
  | { status: "resolved"; commit: ResolvedCommitMention }
  | { status: "ambiguous"; matches: ResolvedCommitMention[] }
  | { status: "not_found" };

const commitIndexCache = createCache<string, CommitIndex>();

export function clearCommitIndexCache(): void {
  commitIndexCache.clear();
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveGitRoot(cwd: string): string | null {
  try {
    return runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export function parseCommitLog(stdout: string): ResolvedCommitMention[] {
  const commits: ResolvedCommitMention[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha = "", committedAt = "", ...subjectParts] = line.split("\t");
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    commits.push({
      sha: sha.toLowerCase(),
      shortSha: sha.slice(0, 12).toLowerCase(),
      committedAt,
      subject: subjectParts.join("\t"),
    });
  }

  return commits;
}

export function getCommitIndex(cwd: string): CommitIndex | null {
  const root = resolveGitRoot(cwd);
  if (!root) return null;

  return getOrSet(commitIndexCache, root, () => ({
    root,
    commits: parseCommitLog(
      runGit(root, ["log", "--all", "--format=%H%x09%cI%x09%s"]),
    ),
  }));
}

export function lookupCommitByPrefix(
  prefix: string,
  index: CommitIndex,
): CommitLookupResult {
  const normalized = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) return { status: "not_found" };

  const matches = index.commits.filter((commit) =>
    commit.sha.startsWith(normalized),
  );
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length === 1) return { status: "resolved", commit: matches[0]! };
  return { status: "ambiguous", matches };
}
