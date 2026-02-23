#!/usr/bin/env bun
/**
 * wt - unified worktree management
 *
 * DESIGN: errors as values throughout. no throwing. exhaustive state modeling.
 * every failure mode is typed and must be handled by the caller.
 *
 * WHY bun: TypeScript + shell integration in one runtime. better error
 * handling than shell scripts, better DX than full CLI frameworks.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, readlinkSync, rmSync } from "fs";
import { join, dirname, basename, relative, resolve } from "path";

// ============================================================================
// RESULT TYPE (errors as values)
// ============================================================================

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ============================================================================
// DOMAIN TYPES
// ============================================================================

interface BareRepo {
  gitDir: string;
  root: string;
}

interface Worktree {
  path: string;
  branch: string;
  name: string;
  head: string;
  isDetached: boolean;
}

interface WorktreeStatus {
  merged: boolean;
  changes: number;
}

// ============================================================================
// CONTEXT TYPES
// ============================================================================

type Context =
  | { type: "no_bare_repo" }
  | { type: "at_bare_root"; bareRepo: BareRepo }
  | { type: "in_worktree"; bareRepo: BareRepo; worktree: Worktree };

// ============================================================================
// ERROR TYPES - EXHAUSTIVE
// ============================================================================

type WtError =
  | WtError_NotInWorktree
  | WtError_NoBareRepo
  | WtError_DefaultBranchDetection
  | WtError_FetchFailed
  | WtError_WorktreeNotFound
  | WtError_WorktreeExists
  | WtError_WorktreeExistsWrongBranch
  | WtError_IsDefaultBranch
  | WtError_InvalidURL
  | WtError_CloneFailed
  | WtError_WorktreeAddFailed
  | WtError_WorktreeRemoveFailed
  | WtError_BranchDeleteFailed
  | WtError_TrashFailed
  | WtError_GhNotFound
  | WtError_GhCommandFailed
  | WtError_PrNotFound
  | WtError_PathCollision
  | WtError_ParseError
  | WtError_SymlinkFailed
  | WtError_GitNotARepo;

interface WtError_NotInWorktree {
  type: "not_in_worktree";
}
interface WtError_NoBareRepo {
  type: "no_bare_repo";
}
interface WtError_DefaultBranchDetection {
  type: "default_branch_detection_failed";
  reason: "origin_head_not_set" | "git_command_failed";
}
interface WtError_FetchFailed {
  type: "fetch_failed";
  remote: string;
  exitCode: number;
  stderr: string;
}
interface WtError_WorktreeNotFound {
  type: "worktree_not_found";
  name: string;
}
interface WtError_WorktreeExists {
  type: "worktree_exists";
  name: string;
}
interface WtError_WorktreeExistsWrongBranch {
  type: "worktree_exists_wrong_branch";
  name: string;
  expectedBranch: string;
  actualBranch: string;
}
interface WtError_IsDefaultBranch {
  type: "is_default_branch";
  branch: string;
}
interface WtError_InvalidURL {
  type: "invalid_url";
  url: string;
}
interface WtError_CloneFailed {
  type: "clone_failed";
  url: string;
  exitCode: number;
  stderr: string;
}
interface WtError_WorktreeAddFailed {
  type: "worktree_add_failed";
  path: string;
  exitCode: number;
  stderr: string;
}
interface WtError_WorktreeRemoveFailed {
  type: "worktree_remove_failed";
  path: string;
  exitCode: number;
  stderr: string;
}
interface WtError_BranchDeleteFailed {
  type: "branch_delete_failed";
  branch: string;
  exitCode: number;
  stderr: string;
}
interface WtError_TrashFailed {
  type: "trash_failed";
  path: string;
  reason: string;
}
interface WtError_GhNotFound {
  type: "gh_not_found";
}
interface WtError_GhCommandFailed {
  type: "gh_command_failed";
  exitCode: number;
  stderr: string;
}
interface WtError_PrNotFound {
  type: "pr_not_found";
  prNumber: number;
}
interface WtError_PathCollision {
  type: "path_collision";
  path: string;
  reason: "file_exists" | "directory_exists";
}
interface WtError_ParseError {
  type: "parse_error";
  raw: string;
  reason: string;
}
interface WtError_SymlinkFailed {
  type: "symlink_failed";
  source: string;
  target: string;
  cause: string;
}
interface WtError_GitNotARepo {
  type: "git_not_a_repo";
}

// ============================================================================
// SHELL UTILITIES
// ============================================================================

/**
 * run git command, return stdout on success.
 */
async function git(cwd: string, ...args: string[]): Promise<Result<string, WtError>> {
  const cmd = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
  if (cmd.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: cmd.exitCode, stderr: cmd.stderr.toString() },
    };
  }
  return { ok: true, value: cmd.text().trim() };
}

/**
 * run git command that might fail, ignore errors.
 */
async function gitQuiet(cwd: string, ...args: string[]): Promise<string> {
  const cmd = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
  return cmd.text().trim();
}

// ============================================================================
// CONTEXT DETECTION
// ============================================================================

/**
 * detect current context: no repo, at bare root, or in worktree.
 *
 * WHY: check directory existence first, then git repo status.
 * bare-repo.git is a directory, not a git repo (it's a bare repo).
 */
async function detectContext(cwd: string): Promise<Result<Context, WtError>> {
  // check for bare-repo.git directory (not git repo, just a directory)
  const bareRepoDir = join(cwd, "bare-repo.git");
  if (existsSync(bareRepoDir) && lstatSync(bareRepoDir).isDirectory()) {
    return {
      ok: true,
      value: {
        type: "at_bare_root",
        bareRepo: { gitDir: bareRepoDir, root: cwd },
      },
    };
  }

  // check if we're in a git repo
  const gitDirResult = await Bun.$`git rev-parse --git-dir 2>/dev/null`.quiet().nothrow();
  if (gitDirResult.exitCode !== 0) {
    return { ok: true, value: { type: "no_bare_repo" } };
  }

  const gitDir = gitDirResult.text().trim();
  const resolvedGitDir = resolve(cwd, gitDir);

  // check if in worktree (path contains /worktrees/)
  if (resolvedGitDir.includes("/worktrees/")) {
    // /path/to/repo/bare-repo.git/worktrees/<name>
    const parts = resolvedGitDir.split("/");
    const worktreesIdx = parts.indexOf("worktrees");
    const worktreeName = parts[worktreesIdx + 1];
    const bareRoot = parts.slice(0, worktreesIdx - 1).join("/");

    const bareRepo: BareRepo = {
      gitDir: join(bareRoot, "bare-repo.git"),
      root: bareRoot,
    };

    // check if bare-repo.git exists in parent
    if (!existsSync(bareRepo.gitDir)) {
      return { ok: true, value: { type: "no_bare_repo" } };
    }

    const worktreeResult = await getWorktreeInfo(bareRepo, worktreeName);
    if (!worktreeResult.ok) {
      return { ok: false, error: worktreeResult.error };
    }

    return {
      ok: true,
      value: { type: "in_worktree", bareRepo, worktree: worktreeResult.value },
    };
  }

  // in a regular git repo, not a worktree setup
  return { ok: true, value: { type: "no_bare_repo" } };
}

// ============================================================================
// WORKTREE HELPERS
// ============================================================================

/**
 * get worktree info by name.
 */
async function getWorktreeInfo(bareRepo: BareRepo, name: string): Promise<Result<Worktree, WtError>> {
  const worktreesResult = await listWorktrees(bareRepo);
  if (!worktreesResult.ok) {
    return { ok: false, error: worktreesResult.error };
  }

  const match = worktreesResult.value.find((wt) => wt.name === name);
  if (!match) {
    return { ok: false, error: { type: "worktree_not_found", name } };
  }

  return { ok: true, value: match };
}

/**
 * list all worktrees.
 */
async function listWorktrees(bareRepo: BareRepo): Promise<Result<Worktree[], WtError>> {
  // fetch first to get accurate merge status
  await Bun.$`git -C ${bareRepo.gitDir} fetch origin --quiet`.quiet().nothrow();

  const defaultBranchResult = await getDefaultBranch(bareRepo.gitDir);
  const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

  const result = await Bun.$`git -C ${bareRepo.gitDir} worktree list --porcelain`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: result.exitCode, stderr: result.stderr.toString() },
    };
  }

  const worktrees = parseWorktreeList(result.text());
  const filtered = worktrees.filter((wt) => !wt.path.endsWith("bare-repo.git"));

  // check merge status for each
  for (const wt of filtered) {
    const mergeResult = await Bun.$`git -C ${bareRepo.gitDir} merge-base --is-ancestor ${wt.head} origin/${defaultBranch} 2>/dev/null`
      .quiet()
      .nothrow();
    wt.isDetached = mergeResult.exitCode !== 0; // if is-ancestor fails, not merged
  }

  return { ok: true, value: filtered };
}

/**
 * parse worktree list output.
 */
function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let currentPath: string | null = null;
  let currentHead: string | null = null;
  let currentBranch: string | null = null;
  let isDetached = false;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentHead) {
        worktrees.push({
          path: currentPath,
          branch: currentBranch || "detached",
          head: currentHead,
          name: basename(currentPath),
          isDetached,
        });
      }
      currentPath = line.slice("worktree ".length);
      currentHead = null;
      currentBranch = null;
      isDetached = false;
    } else if (line.startsWith("HEAD ")) {
      currentHead = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.replace(/^branch refs\/heads\//, "");
    } else if (line === "detached") {
      isDetached = true;
    }
  }

  if (currentPath && currentHead) {
    worktrees.push({
      path: currentPath,
      branch: currentBranch || "detached",
      head: currentHead,
      name: basename(currentPath),
      isDetached,
    });
  }

  return worktrees;
}

/**
 * get default branch name.
 */
async function getDefaultBranch(gitDir: string): Promise<Result<string, WtError>> {
  const result = await Bun.$`git -C ${gitDir} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    // fall back to main
    return { ok: true, value: "main" };
  }

  const output = result.text().trim();
  const branch = output.replace(/^refs\/remotes\/origin\//, "");

  return { ok: true, value: branch || "main" };
}

/**
 * get current branch name.
 */
async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await Bun.$`git -C ${cwd} rev-parse --abbrev-ref HEAD 2>/dev/null`.quiet().nothrow();
  return result.text().trim() || "detached";
}

/**
 * get uncommitted changes count.
 */
async function getChangesCount(cwd: string): Promise<number> {
  const result = await Bun.$`git -C ${cwd} status --porcelain 2>/dev/null`.quiet().nothrow();
  const lines = result.text().trim().split("\n").filter((l) => l.length > 0);
  return lines.length;
}

// ============================================================================
// URL PARSING
// ============================================================================

function isUrl(s: string): boolean {
  return s.includes("://") || s.startsWith("git@");
}

function isPrUrl(s: string): boolean {
  return /github\.com\/.*\/pull\/[0-9]+/.test(s);
}

function extractPrNumber(url: string): number | null {
  const match = url.match(/pull\/([0-9]+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractOrgRepo(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

// ============================================================================
// CLONE BARE REPO
// ============================================================================

type CloneResult = {
  bareRepo: BareRepo;
  defaultBranch: string;
};

async function cloneBareRepo(url: string, targetDir: string): Promise<Result<CloneResult, WtError>> {
  // validate URL
  if (!url.includes("github.com")) {
    return { ok: false, error: { type: "invalid_url", url } };
  }

  // create target directory
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      return { ok: false, error: { type: "path_collision", path: targetDir, reason: "directory_exists" } };
    }
  }

  const gitDir = join(targetDir, "bare-repo.git");

  // clone bare
  const cloneResult = await Bun.$`git clone --bare ${url} ${gitDir}`.quiet().nothrow();
  if (cloneResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "clone_failed", url, exitCode: cloneResult.exitCode, stderr: cloneResult.stderr.toString() },
    };
  }

  // configure fetch
  await Bun.$`git -C ${gitDir} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`.quiet().nothrow();

  // fetch
  const fetchResult = await Bun.$`git -C ${gitDir} fetch origin`.quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: fetchResult.exitCode, stderr: fetchResult.stderr.toString() },
    };
  }

  // get default branch
  const defaultBranchResult = await getDefaultBranch(gitDir);
  const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

  // create main worktree
  const mainWt = join(targetDir, defaultBranch);
  const wtResult = await Bun.$`git -C ${gitDir} worktree add ${mainWt} ${defaultBranch}`.quiet().nothrow();
  if (wtResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "worktree_add_failed", path: mainWt, exitCode: wtResult.exitCode, stderr: wtResult.stderr.toString() },
    };
  }

  return {
    ok: true,
    value: { bareRepo: { gitDir, root: targetDir }, defaultBranch },
  };
}

// ============================================================================
// ADD WORKTREE
// ============================================================================

async function addBranchWorktree(
  bareRepo: BareRepo,
  name: string,
): Promise<Result<Worktree, WtError>> {
  // fetch first to ensure we have latest
  const fetchResult = await Bun.$`git -C ${bareRepo.gitDir} fetch origin --quiet`.quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: fetchResult.exitCode, stderr: fetchResult.stderr.toString() },
    };
  }

  const defaultBranchResult = await getDefaultBranch(bareRepo.gitDir);
  if (!defaultBranchResult.ok) {
    return { ok: false, error: defaultBranchResult.error };
  }
  const defaultBranch = defaultBranchResult.value;

  const wtPath = join(bareRepo.root, name);

  // create worktree with --no-track (allows first push to create remote branch)
  const result = await Bun.$`git -C ${bareRepo.gitDir} worktree add --no-track -b ${name} ${wtPath} origin/${defaultBranch}`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "worktree_add_failed", path: wtPath, exitCode: result.exitCode, stderr: result.stderr.toString() },
    };
  }

  // symlink env files
  const envResult = await symlinkEnvFiles(bareRepo, { path: wtPath, branch: name, name, head: "", isDetached: false });
  if (!envResult.ok) {
    // log but don't fail
    console.error(`warning: failed to symlink .env files: ${envResult.error.type}`);
  }

  const worktreeResult = await getWorktreeInfo(bareRepo, name);
  return worktreeResult;
}

// ============================================================================
// ADD PR WORKTREE
// ============================================================================

async function addPrWorktree(
  bareRepo: BareRepo,
  prNumber: number,
): Promise<Result<Worktree, WtError>> {
  // fetch first
  const fetchResult = await Bun.$`git -C ${bareRepo.gitDir} fetch origin --quiet`.quiet().nothrow();
  if (fetchResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: fetchResult.exitCode, stderr: fetchResult.stderr.toString() },
    };
  }

  // get PR branch name from gh
  const ghResult = await Bun.$`gh pr view ${prNumber} --json headRefName`.quiet().nothrow();
  if (ghResult.exitCode !== 0) {
    return { ok: false, error: { type: "pr_not_found", prNumber } };
  }

  let branch: string;
  try {
    const json = JSON.parse(ghResult.text());
    branch = json.headRefName;
  } catch {
    return { ok: false, error: { type: "pr_not_found", prNumber } };
  }

  const wtName = `pr-${prNumber}`;
  const wtPath = join(bareRepo.root, wtName);

  // check if worktree already exists
  if (existsSync(wtPath)) {
    // check if it's the right branch
    const existingBranch = await getCurrentBranch(wtPath);
    if (existingBranch === branch) {
      // already exists with correct branch
      return { ok: false, error: { type: "worktree_exists", name: wtName } };
    }
    return {
      ok: false,
      error: {
        type: "worktree_exists_wrong_branch",
        name: wtName,
        expectedBranch: branch,
        actualBranch: existingBranch,
      },
    };
  }

  // fetch the branch
  const fetchBranchResult = await Bun.$`git -C ${bareRepo.gitDir} fetch origin ${branch}`.quiet().nothrow();
  if (fetchBranchResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "fetch_failed", remote: "origin", exitCode: fetchBranchResult.exitCode, stderr: fetchBranchResult.stderr.toString() },
    };
  }

  // check if branch exists locally
  const branchExistsResult = await Bun.$`git -C ${bareRepo.gitDir} show-ref --verify refs/heads/${branch}`.quiet().nothrow();

  let addResult;
  if (branchExistsResult.exitCode === 0) {
    addResult = await Bun.$`git -C ${bareRepo.gitDir} worktree add ${wtPath} ${branch}`.quiet().nothrow();
  } else {
    addResult = await Bun.$`git -C ${bareRepo.gitDir} worktree add --track -b ${branch} ${wtPath} origin/${branch}`
      .quiet()
      .nothrow();
  }

  if (addResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "worktree_add_failed", path: wtPath, exitCode: addResult.exitCode, stderr: addResult.stderr.toString() },
    };
  }

  // symlink env files
  const envResult = await symlinkEnvFiles(bareRepo, { path: wtPath, branch, name: wtName, head: "", isDetached: false });
  if (!envResult.ok) {
    console.error(`warning: failed to symlink .env files: ${envResult.error.type}`);
  }

  return getWorktreeInfo(bareRepo, wtName);
}

// ============================================================================
// REMOVE WORKTREE
// ============================================================================

async function removeWorktree(
  bareRepo: BareRepo,
  name: string,
): Promise<Result<void, WtError>> {
  const wtPath = join(bareRepo.root, name);

  // get branch name BEFORE removal (can't lookup after)
  const worktreeResult = await getWorktreeInfo(bareRepo, name);
  const branch = worktreeResult.ok ? worktreeResult.value.branch : null;

  // remove worktree via git
  const removeResult = await Bun.$`git -C ${bareRepo.gitDir} worktree remove ${wtPath} --force`.quiet().nothrow();
  if (removeResult.exitCode !== 0) {
    return {
      ok: false,
      error: { type: "worktree_remove_failed", path: wtPath, exitCode: removeResult.exitCode, stderr: removeResult.stderr.toString() },
    };
  }

  // delete branch if not default
  if (branch && branch !== "detached") {
    const defaultBranchResult = await getDefaultBranch(bareRepo.gitDir);
    const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

    if (branch !== defaultBranch) {
      const deleteResult = await Bun.$`git -C ${bareRepo.gitDir} branch -D ${branch}`.quiet().nothrow();
      if (deleteResult.exitCode !== 0) {
        return {
          ok: false,
          error: { type: "branch_delete_failed", branch, exitCode: deleteResult.exitCode, stderr: deleteResult.stderr.toString() },
        };
      }
    }
  }

  // trash the directory if it still exists
  if (existsSync(wtPath)) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch (e) {
      return {
        ok: false,
        error: { type: "trash_failed", path: wtPath, reason: String(e) },
      };
    }
  }

  return { ok: true, value: undefined };
}

// ============================================================================
// SYMLINK ENV FILES (from earlier prototype)
// ============================================================================

async function symlinkEnvFiles(
  bareRepo: BareRepo,
  targetWt: Worktree,
): Promise<Result<{ created: string[]; skipped: string[] }, WtError>> {
  const defaultBranchResult = await getDefaultBranch(bareRepo.gitDir);
  if (!defaultBranchResult.ok) {
    return { ok: false, error: { type: "default_branch_detection_failed", reason: "origin_head_not_set" } };
  }
  const defaultBranch = defaultBranchResult.value;

  // find worktree on default branch
  const worktreesResult = await listWorktrees(bareRepo);
  if (!worktreesResult.ok) {
    return { ok: false, error: worktreesResult.error };
  }

  const sourceWt = worktreesResult.value.find((wt) => wt.branch === defaultBranch);
  if (!sourceWt) {
    // silent skip if no worktree on default branch
    return { ok: true, value: { created: [], skipped: [] } };
  }

  // find .env files
  const envFiles = findEnvFiles(sourceWt.path);
  const created: string[] = [];
  const skipped: string[] = [];

  for (const envFile of envFiles) {
    const relPath = relative(sourceWt.path, envFile);
    const targetPath = join(targetWt.path, relPath);

    if (existsSync(targetPath)) {
      skipped.push(relPath);
      continue;
    }

    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) {
      try {
        mkdirSync(targetDir, { recursive: true });
      } catch {
        // ignore
      }
    }

    const relLink = relative(targetDir, envFile);
    try {
      symlinkSync(relLink, targetPath);
      created.push(relPath);
    } catch {
      // ignore symlink failures
    }
  }

  return { ok: true, value: { created, skipped } };
}

function findEnvFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(".env")) {
        const entryPath = join(entry.parentPath || dir, entry.name);
        if (entryPath.includes("/node_modules/")) continue;
        files.push(entryPath);
      }
    }
  } catch {
    // ignore
  }
  return files;
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

function printHelp() {
  console.log(`
wt - worktree management

usage: wt [cmd] [args]

commands:
  (none)              list worktrees (or status if in worktree)
  <branch>            add worktree for branch
  pr <num>            add worktree for PR
  pr-<num>            alias for pr <num>
  <pr-url>            add worktree from github PR url
  rm [name]           remove worktree (current if no name)
  env                 (re)symlink .env files from default branch
  <repo-url>          clone bare repo, add default branch worktree
  <repo-url> <dir>    clone into specific directory
  help, --help, -h    show this help

examples:
  wt                  # list worktrees
  wt axm-11400       # create worktree for branch axm-11400
  wt pr 231           # create worktree for PR #231
  wt rm               # remove current worktree
  wt rm pr-231        # remove pr-231 worktree
  wt env              # symlink .env files from main
  wt https://github.com/org/repo.git
  wt https://github.com/org/repo.git myrepo
`);
}

function printHelpEnv() {
  console.log(`
wt env - symlink .env files from default branch worktree

usage: wt env

finds the worktree on the default branch (main/master) and
symlinks all .env* files to the current worktree.
skips files that already exist. uses relative symlinks.

run from within a worktree.
`);
}

function printHelpRm() {
  console.log(`
wt rm - remove a worktree

usage: wt rm [name]

if no name: removes current worktree (must be in one).
if name: removes named worktree.

also deletes local branch (unless default) and removes folder.
refuses to remove default branch worktree.

examples:
  wt rm           # remove current
  wt rm pr-231    # remove pr-231
`);
}

function printHelpPr() {
  console.log(`
wt pr - add worktree for PR

usage: wt pr <num>
       wt pr-<num>
       wt <github-pr-url>

fetches PR branch from origin, creates worktree at ../pr-<num>.
if worktree exists and branch matches, prints message.
if worktree exists but branch differs, error.

examples:
  wt pr 231
  wt pr-231
  wt https://github.com/org/repo/pull/231
`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = Bun.argv.slice(2);
  const cwd = resolve(process.cwd());

  // help
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // detect context
  const contextResult = await detectContext(cwd);
  if (!contextResult.ok) {
    console.error("error: failed to detect git context");
    process.exit(1);
  }
  const ctx = contextResult.value;

  // no args - list or status
  if (args.length === 0) {
    if (ctx.type === "no_bare_repo") {
      console.log(`
no bare-repo.git found. clone one:
  wt <repo-url>
  wt <repo-url> <dir>
`);
      process.exit(1);
    }

    if (ctx.type === "in_worktree") {
      // show status
      const branch = await getCurrentBranch(cwd);
      const changes = await getChangesCount(cwd);
      const defaultBranchResult = await getDefaultBranch(ctx.bareRepo.gitDir);
      const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

      const mergeCheck = await Bun.$`git -C ${ctx.bareRepo.gitDir} merge-base --is-ancestor HEAD origin/${defaultBranch} 2>/dev/null`
        .quiet()
        .nothrow();
      const merged = mergeCheck.exitCode === 0;

      console.log(`worktree: ${ctx.worktree.name}`);
      console.log(`branch:   ${branch}`);
      console.log(`status:   ${merged ? "✓" : "○"} ${merged ? "merged into " + defaultBranch : "not merged"}`);
      if (changes > 0) {
        console.log(`changes:  ${changes} file(s) modified`);
      }
      return;
    }

    // at bare root - list worktrees
    const worktreesResult = await listWorktrees(ctx.bareRepo);
    if (!worktreesResult.ok) {
      console.error("error: failed to list worktrees");
      process.exit(1);
    }

    const defaultBranchResult = await getDefaultBranch(ctx.bareRepo.gitDir);
    const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

    if (worktreesResult.value.length === 0) {
      console.log("no worktrees");
      return;
    }

    for (const wt of worktreesResult.value) {
      const merged = wt.head && (await Bun.$`git -C ${ctx.bareRepo.gitDir} merge-base --is-ancestor ${wt.head} origin/${defaultBranch} 2>/dev/null`.quiet().nothrow()).exitCode === 0;
      const symbol = merged ? "✓" : "○";
      if (wt.name === wt.branch) {
        console.log(`${symbol} ${wt.name}`);
      } else {
        console.log(`${symbol} ${wt.name} (${wt.branch})`);
      }
    }
    return;
  }

  const arg0 = args[0].toLowerCase();

  // env command
  if (arg0 === "env") {
    if (args[1] === "--help" || args[1] === "-h") {
      printHelpEnv();
      return;
    }

    if (ctx.type !== "in_worktree") {
      console.error("error: not in a worktree");
      process.exit(1);
    }

    const result = await symlinkEnvFiles(ctx.bareRepo, ctx.worktree);
    if (!result.ok) {
      console.error(`error: ${result.error.type}`);
      process.exit(1);
    }

    const { created, skipped } = result.value;
    if (created.length > 0) {
      console.log(`symlinked ${created.length} .env file(s)`);
    } else if (skipped.length > 0) {
      console.log(`skipped ${skipped.length} existing .env file(s)`);
    } else {
      console.log("no .env files to symlink");
    }
    return;
  }

  // rm command
  if (arg0 === "rm") {
    if (args[1] === "--help" || args[1] === "-h") {
      printHelpRm();
      return;
    }

    const name = args[1] || (ctx.type === "in_worktree" ? ctx.worktree.name : null);

    if (!name) {
      console.error("error: not in a worktree, specify name");
      process.exit(1);
    }

    if (ctx.type === "no_bare_repo") {
      console.error("error: no bare-repo.git found");
      process.exit(1);
    }

    const bareRepo = ctx.type === "in_worktree" ? ctx.bareRepo : ctx.bareRepo;

    const defaultBranchResult = await getDefaultBranch(bareRepo.gitDir);
    const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.value : "main";

    // check if default branch
    if (name === defaultBranch) {
      console.error(`error: refusing to remove default branch worktree (${defaultBranch})`);
      process.exit(1);
    }

    // check if exists
    const exists = existsSync(join(bareRepo.root, name));
    if (!exists) {
      console.error(`error: worktree not found: ${name}`);
      process.exit(1);
    }

    console.log(`removing: ${name}`);
    const result = await removeWorktree(bareRepo, name);
    if (!result.ok) {
      console.error(`error: ${result.error.type}`);
      process.exit(1);
    }
    console.log("done");
    return;
  }

  // pr command
  if (arg0 === "pr") {
    if (args[1] === "--help" || args[1] === "-h") {
      printHelpPr();
      return;
    }

    const prNum = args[1];
    if (!prNum) {
      console.error("usage: wt pr <number>");
      process.exit(1);
    }

    if (ctx.type === "no_bare_repo") {
      console.error("error: no bare-repo.git found");
      process.exit(1);
    }

    const bareRepo = ctx.type === "in_worktree" ? ctx.bareRepo : ctx.bareRepo;
    const prNumber = parseInt(prNum, 10);

    if (isNaN(prNumber)) {
      console.error("error: invalid PR number");
      process.exit(1);
    }

    const result = await addPrWorktree(bareRepo, prNumber);
    if (!result.ok) {
      const err = result.error;
      if (err.type === "worktree_exists") {
        console.log(`worktree already exists for PR #${prNumber}`);
        return;
      }
      if (err.type === "worktree_exists_wrong_branch") {
        console.error(`error: worktree ${err.name} exists but has branch '${err.actualBranch}', PR #${prNumber} is on '${err.expectedBranch}'`);
        process.exit(1);
      }
      console.error(`error: ${err.type}`);
      process.exit(1);
    }

    console.log(`done. pr-${prNumber} (${result.value.branch})`);
    return;
  }

  // pr-N shorthand
  const prMatch = arg0.match(/^pr-([0-9]+)$/);
  if (prMatch) {
    const prNum = prMatch[1];
    if (ctx.type === "no_bare_repo") {
      console.error("error: no bare-repo.git found");
      process.exit(1);
    }

    const bareRepo = ctx.type === "in_worktree" ? ctx.bareRepo : ctx.bareRepo;
    const prNumber = parseInt(prNum, 10);

    const result = await addPrWorktree(bareRepo, prNumber);
    if (!result.ok) {
      const err = result.error;
      if (err.type === "worktree_exists") {
        console.log(`worktree already exists for PR #${prNumber}`);
        return;
      }
      if (err.type === "worktree_exists_wrong_branch") {
        console.error(`error: worktree ${err.name} exists but has branch '${err.actualBranch}', PR #${prNumber} is on '${err.expectedBranch}'`);
        process.exit(1);
      }
      console.error(`error: ${err.type}`);
      process.exit(1);
    }

    console.log(`done. pr-${prNumber} (${result.value.branch})`);
    return;
  }

  // URL handling
  if (isUrl(arg0)) {
    if (isPrUrl(arg0)) {
      const prNum = extractPrNumber(arg0);
      const orgRepo = extractOrgRepo(arg0);

      if (!prNum || !orgRepo) {
        console.error("error: invalid PR URL");
        process.exit(1);
      }

      // check if we have a matching bare repo
      if (ctx.type !== "no_bare_repo") {
        const bareRepo = ctx.type === "in_worktree" ? ctx.bareRepo : ctx.bareRepo;
        const remoteResult = await Bun.$`git -C ${bareRepo.gitDir} remote get-url origin`.quiet().nothrow();
        const remoteUrl = remoteResult.text().trim();
        const remoteOrgRepo = extractOrgRepo(remoteUrl);

        if (remoteOrgRepo === orgRepo) {
          // same repo, handle as pr
          const result = await addPrWorktree(bareRepo, prNum);
          if (!result.ok && result.error.type !== "worktree_exists") {
            console.error(`error: ${result.error.type}`);
            process.exit(1);
          }
          if (result.error?.type === "worktree_exists") {
            console.log(`worktree already exists for PR #${prNum}`);
          } else {
            console.log(`done. pr-${prNum} (${result.value?.branch})`);
          }
          return;
        }
      }

      // different repo, clone it
      const targetDir = args[1] || orgRepo.split("/")[1];
      console.log(`cloning ${orgRepo}...`);

      const cloneResult = await cloneBareRepo(`https://github.com/${orgRepo}.git`, targetDir);
      if (!cloneResult.ok) {
        console.error(`error: ${cloneResult.error.type}`);
        process.exit(1);
      }

      // add PR worktree
      const prResult = await addPrWorktree(cloneResult.value.bareRepo, prNum);
      if (!prResult.ok && prResult.error.type !== "worktree_exists") {
        console.error(`error: ${prResult.error.type}`);
        process.exit(1);
      }

      console.log("done.");
      return;
    }

    // repo URL
    const targetDir = args[1] || (arg0.includes("/") ? arg0.split("/").pop()?.replace(/\.git$/, "") || "repo" : "repo");
    console.log(`cloning ${arg0}...`);

    const result = await cloneBareRepo(arg0, targetDir);
    if (!result.ok) {
      console.error(`error: ${result.error.type}`);
      process.exit(1);
    }

    console.log(`done. ${result.value.defaultBranch}`);
    return;
  }

  // branch name - create worktree
  if (ctx.type === "no_bare_repo") {
    console.error("error: no bare-repo.git found. use 'wt <repo-url>' to set up.");
    process.exit(1);
  }

  const bareRepo = ctx.type === "in_worktree" ? ctx.bareRepo : ctx.bareRepo;
  const name = arg0;

  // check if exists
  const exists = existsSync(join(bareRepo.root, name));
  if (exists) {
    // check branch
    const existingBranch = await getCurrentBranch(join(bareRepo.root, name));
    if (existingBranch === name) {
      console.log(`worktree already exists: ${name}`);
      return;
    }
    console.error(`error: worktree ${name} exists but has branch '${existingBranch}', not '${name}'`);
    process.exit(1);
  }

  const result = await addBranchWorktree(bareRepo, name);
  if (!result.ok) {
    console.error(`error: ${result.error.type}`);
    process.exit(1);
  }

  console.log(`done. ${name}`);
}

main();
