import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Snapshot } from "./types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function assertGitRepo(cwd: string): void {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }
}

export function resolveSnapshots(
  from: string | undefined,
  to: string | undefined,
): { from: Snapshot; to: Snapshot } {
  // git-diff defaults: no args → HEAD vs worktree; one arg → that vs worktree
  const left: Snapshot = {
    kind: "commit",
    ref: from ?? "HEAD",
  };
  const right: Snapshot =
    to === undefined
      ? { kind: "worktree", ref: "WORKTREE" }
      : { kind: "commit", ref: to };
  return { from: left, to: right };
}

function isCommitRef(cwd: string, ref: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isPathOnDisk(cwd: string, value: string): boolean {
  return existsSync(resolve(cwd, value));
}

/**
 * Resolve diff from/to/paths with git-diff defaults, treating on-disk path
 * positionals as path filters when they are not valid git refs.
 *
 * Examples:
 * - `diff main src` → main vs worktree, paths=[src]
 * - `diff main feature src` → main vs feature, paths=[src]
 * - `diff src` → HEAD vs worktree, paths=[src]
 */
export function resolveDiffSnapshotsAndPaths(
  cwd: string,
  from: string | undefined,
  to: string | undefined,
  paths: string[],
): { from: Snapshot; to: Snapshot; paths: string[] } {
  if (from === undefined && to === undefined) {
    return { ...resolveSnapshots(undefined, undefined), paths };
  }

  if (from !== undefined && to === undefined) {
    if (isCommitRef(cwd, from)) {
      return { ...resolveSnapshots(from, undefined), paths };
    }
    if (isPathOnDisk(cwd, from)) {
      return {
        ...resolveSnapshots(undefined, undefined),
        paths: [from, ...paths],
      };
    }
    throw new Error(`Unknown git ref: ${from}`);
  }

  if (from !== undefined && to !== undefined) {
    if (!isCommitRef(cwd, from)) {
      throw new Error(`Unknown git ref: ${from}`);
    }
    if (isCommitRef(cwd, to)) {
      return { ...resolveSnapshots(from, to), paths };
    }
    if (isPathOnDisk(cwd, to)) {
      return {
        ...resolveSnapshots(from, undefined),
        paths: [to, ...paths],
      };
    }
    throw new Error(`Unknown git ref: ${to}`);
  }

  // to without from shouldn't happen via CLI positionals, but honor options.
  return { ...resolveSnapshots(from, to), paths };
}

/** Single snapshot for `calldiff tree` / `reach` — no ref → working tree. */
export function resolveSnapshot(ref: string | undefined): Snapshot {
  if (ref === undefined) {
    return { kind: "worktree", ref: "WORKTREE" };
  }
  return { kind: "commit", ref };
}

/**
 * Resolve optional ref + path filters for tree/reach.
 * A lone positional that isn't a git ref but exists on disk is treated as a
 * path filter on the working tree (`calldiff tree -e foo src/lib`).
 */
export function resolveSnapshotAndPaths(
  cwd: string,
  ref: string | undefined,
  paths: string[],
): { snapshot: Snapshot; paths: string[] } {
  if (ref === undefined) {
    return { snapshot: resolveSnapshot(undefined), paths };
  }

  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return { snapshot: resolveSnapshot(ref), paths };
  } catch {
    const abs = resolve(cwd, ref);
    if (existsSync(abs)) {
      return {
        snapshot: resolveSnapshot(undefined),
        paths: [ref, ...paths],
      };
    }
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

export function verifyCommit(cwd: string, ref: string): void {
  try {
    git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new Error(`Unknown git ref: ${ref}`);
  }
}

import { listSupportedExtensions } from "./languages/registry.js";

const SOURCE_EXT = new Set(listSupportedExtensions());
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  "out",
]);

function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXT.has(lower.slice(dot));
}

function walkWorktree(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkWorktree(root, full, out);
      continue;
    }
    if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

function listCommitSourceFiles(cwd: string, ref: string): string[] {
  const output = git(cwd, ["ls-tree", "-r", "--name-only", ref]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && isSourceFile(line));
}

function pathAllowed(file: string, pathFilters: string[]): boolean {
  if (pathFilters.length === 0) return true;
  return pathFilters.some((filter) => {
    const normalized = filter.replace(/^\.\//, "").replace(/\/$/, "");
    return (
      file === normalized ||
      file.startsWith(`${normalized}/`) ||
      file.endsWith(normalized)
    );
  });
}

/** @deprecated Use listSourceFiles */
export function listTsFiles(
  cwd: string,
  snapshot: Snapshot,
  pathFilters: string[] = [],
): string[] {
  return listSourceFiles(cwd, snapshot, pathFilters);
}

export function listSourceFiles(
  cwd: string,
  snapshot: Snapshot,
  pathFilters: string[] = [],
): string[] {
  const files =
    snapshot.kind === "worktree"
      ? (() => {
          const out: string[] = [];
          walkWorktree(cwd, cwd, out);
          return out;
        })()
      : listCommitSourceFiles(cwd, snapshot.ref);

  return files.filter((file) => pathAllowed(file, pathFilters)).sort();
}

export function readSnapshotFile(
  cwd: string,
  snapshot: Snapshot,
  file: string,
): string | null {
  if (snapshot.kind === "worktree") {
    const full = resolve(cwd, file);
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full, "utf8");
  }

  try {
    return git(cwd, ["show", `${snapshot.ref}:${file}`]);
  } catch {
    return null;
  }
}

export function describeSnapshot(snapshot: Snapshot): string {
  return snapshot.kind === "worktree" ? "working tree" : snapshot.ref;
}
