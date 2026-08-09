import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  atomicWrite,
  contained,
  sha256,
  type MemoryConfig,
} from "./catalog.js";
import { observeMemoryOperation } from "./observability.js";

export type HistoryChange = {
  path: string;
  memoryId?: string;
  beforeSha256?: string;
  afterSha256?: string;
  status: string;
};
export type HistoryReceiptCore = {
  version: 2;
  mutationId: string;
  kind: string;
  transactionId?: string;
  proposalId?: string;
  reviewId?: string;
  reason: string;
  parentCommit?: string;
  changes: HistoryChange[];
  provenance: unknown;
};
export type HistoryReceipt = HistoryReceiptCore & { commit: string };
export type InitHistoryReport = {
  initialized: boolean;
  dryRun: boolean;
  gitDir: string;
  commit?: string;
  remote?: string;
};
export type HistoryEntry = { commit: string; receipt: HistoryReceiptCore };
export type VerifiedHistoryBasis = Readonly<{
  head: string;
  repository: string;
  policyVersion: number;
}>;
export type VerifyHistoryReport = {
  ok: boolean;
  issues: string[];
  basis?: VerifiedHistoryBasis;
  telemetry?: Readonly<Record<string, string | number | boolean>>;
};
export type SyncHistoryReport = {
  ok: boolean;
  pushed: boolean;
  fastForwarded?: boolean;
  diverged?: boolean;
  error?: string;
};
export type RepairHistoryReport = {
  mode: "adopt" | "discard";
  commit?: string;
};

const TRAILER = "Pi-Memory-Receipt:";
const PATHS = [":(glob)**/*.md", ":(exclude,glob).qmd/**"];
const gitDir = (cfg: MemoryConfig) => join(cfg.data, "v2/history.git");
const receiptsDir = (cfg: MemoryConfig) => join(cfg.data, "v2/mutations");
const gitEnv: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_REPLACE_REF_BASE",
  ])
    delete env[name];
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "pi-memory",
    GIT_AUTHOR_EMAIL: "pi-memory@local",
    GIT_COMMITTER_NAME: "pi-memory",
    GIT_COMMITTER_EMAIL: "pi-memory@local",
  };
})();
const HISTORY_POLICY_VERSION = 1;
const checkpointPath = (cfg: MemoryConfig) =>
  join(cfg.data, "v2/history-verification.json");
const checkpointMarkerPath = (cfg: MemoryConfig) =>
  join(cfg.data, "v2/history-verification.initialized");
type HistoryCheckpoint = VerifiedHistoryBasis & {
  version: 1;
  root: string;
  objectFormat: string;
  expectedRemote: string | null;
};
let latestProcessAnchor:
  | { repository: string; head: string; policyVersion: number }
  | undefined;

function git(cfg: MemoryConfig, args: string[], tolerate = false): string {
  const result = spawnSync(
    "git",
    [`--git-dir=${gitDir(cfg)}`, `--work-tree=${cfg.root}`, ...args],
    { encoding: "utf8", env: gitEnv },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !tolerate)
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  return result.status === 0 ? result.stdout : "";
}
function gitInput(
  cfg: MemoryConfig,
  args: string[],
  input: string,
  tolerate = false,
): string {
  const result = spawnSync(
    "git",
    [`--git-dir=${gitDir(cfg)}`, `--work-tree=${cfg.root}`, ...args],
    { encoding: "utf8", env: gitEnv, input },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !tolerate)
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  return result.status === 0 ? result.stdout : "";
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
const encode = (receipt: HistoryReceiptCore) =>
  Buffer.from(canonical(receipt)).toString("base64url");
function decode(message: string): HistoryReceiptCore {
  const lines = message.split("\n").filter((line) => line.startsWith(TRAILER));
  if (lines.length !== 1)
    throw new Error("commit must contain exactly one receipt");
  const receipt: unknown = JSON.parse(
    Buffer.from(lines[0]!.slice(TRAILER.length).trim(), "base64url").toString(
      "utf8",
    ),
  );
  if (
    !receipt ||
    typeof receipt !== "object" ||
    (receipt as HistoryReceiptCore).version !== 2 ||
    !/^[A-Za-z0-9_.-]+$/.test(
      String((receipt as HistoryReceiptCore).mutationId ?? ""),
    ) ||
    typeof (receipt as HistoryReceiptCore).kind !== "string" ||
    typeof (receipt as HistoryReceiptCore).reason !== "string" ||
    !Array.isArray((receipt as HistoryReceiptCore).changes)
  )
    throw new Error("invalid history receipt");
  for (const change of (receipt as HistoryReceiptCore).changes) {
    if (
      !change ||
      typeof change !== "object" ||
      typeof change.path !== "string" ||
      typeof change.status !== "string"
    )
      throw new Error("invalid history receipt change");
    memoryPath(change.path);
  }
  return receipt as HistoryReceiptCore;
}
function revision(value: string): string {
  if (value !== "HEAD" && !/^[0-9a-f]{40,64}$/.test(value))
    throw new Error("invalid history revision");
  return value;
}
function memoryPath(value: string): string {
  if (
    isAbsolute(value) ||
    value.startsWith(":") ||
    value.includes(":") ||
    /[\0\r\n]/.test(value) ||
    !value.endsWith(".md") ||
    value.split(/[/\\]/).includes("..") ||
    value.includes("\\")
  )
    throw new Error("invalid memory path");
  return value;
}
function allowedTrackedPath(value: string): boolean {
  try {
    return memoryPath(value) === value && !value.startsWith(".qmd/");
  } catch {
    return false;
  }
}
const literalPath = (value: string): string => `:(literal)${memoryPath(value)}`;
function assertRealMemoryRoot(cfg: MemoryConfig): void {
  const stat = lstatSync(cfg.root, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink())
    throw new Error("memory root cannot be a symlink");
}
function markdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".qmd"
      ? markdown(join(dir, entry.name))
      : entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md")
        ? [join(dir, entry.name)]
        : [],
  );
}

function directories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return [
    dir,
    ...readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".qmd"
        ? directories(join(dir, entry.name))
        : [],
    ),
  ];
}

export function sealMemoryRoot(cfg: MemoryConfig): void {
  if (!existsSync(cfg.root)) return;
  assertRealMemoryRoot(cfg);
  const qmd = join(cfg.root, ".qmd");
  if (existsSync(qmd) && lstatSync(qmd).isSymbolicLink())
    throw new Error("qmd state directory cannot be a symlink");
  for (const file of markdown(cfg.root)) chmodSync(file, 0o400);
  for (const dir of directories(cfg.root).reverse()) chmodSync(dir, 0o500);
  if (existsSync(qmd))
    for (const dir of directories(qmd)) chmodSync(dir, 0o700);
}
export function withWritableMemoryRoot<T>(cfg: MemoryConfig, fn: () => T): T {
  assertRealMemoryRoot(cfg);
  mkdirSync(cfg.root, { recursive: true, mode: 0o700 });
  const qmd = join(cfg.root, ".qmd");
  if (existsSync(qmd) && lstatSync(qmd).isSymbolicLink())
    throw new Error("qmd state directory cannot be a symlink");
  for (const dir of directories(cfg.root)) chmodSync(dir, 0o700);
  for (const file of markdown(cfg.root)) chmodSync(file, 0o600);
  try {
    return fn();
  } finally {
    sealMemoryRoot(cfg);
  }
}
export function isHistoryInitialized(cfg: MemoryConfig): boolean {
  return (
    existsSync(join(gitDir(cfg), "HEAD")) &&
    !!git(cfg, ["rev-parse", "--verify", "HEAD"], true).trim()
  );
}
function initHistoryImpl(
  cfg: MemoryConfig,
  options: { remote?: string; dryRun?: boolean } = {},
): InitHistoryReport {
  assertRealMemoryRoot(cfg);
  if (isHistoryInitialized(cfg)) {
    if (options.remote && !options.dryRun) configureRemote(cfg, options.remote);
    if (!options.dryRun) sealMemoryRoot(cfg);
    return {
      initialized: false,
      dryRun: !!options.dryRun,
      gitDir: gitDir(cfg),
      remote: options.remote,
    };
  }
  if (options.remote && /[\r\n\0]/.test(options.remote))
    throw new Error("invalid remote");
  if (options.dryRun)
    return {
      initialized: true,
      dryRun: true,
      gitDir: gitDir(cfg),
      remote: options.remote,
    };
  mkdirSync(dirname(gitDir(cfg)), { recursive: true, mode: 0o700 });
  mkdirSync(cfg.root, { recursive: true, mode: 0o700 });
  if (!existsSync(join(gitDir(cfg), "HEAD"))) {
    const result = spawnSync(
      "git",
      ["init", "--bare", "--initial-branch=main", gitDir(cfg)],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(result.stderr);
  }
  git(cfg, ["config", "core.bareRepository", "true"]);
  if (options.remote) configureRemote(cfg, options.remote);
  const remoteHead = options.remote ? resolveRemoteMain(cfg) : undefined;
  if (remoteHead) {
    git(cfg, ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
    const remoteIssues = committedHistoryIssues(cfg, remoteHead);
    if (remoteIssues.length)
      throw new Error(
        `remote memory history verification failed: ${remoteIssues.join(", ")}`,
      );
    git(cfg, ["update-ref", "refs/heads/main", remoteHead]);
    git(cfg, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    if (markdown(cfg.root).length === 0)
      withWritableMemoryRoot(cfg, () => git(cfg, ["reset", "--hard", "HEAD"]));
    else {
      git(cfg, ["reset", "--mixed", "HEAD"]);
      if (git(cfg, ["status", "--porcelain", "--", ...PATHS]).trim())
        throw new Error(
          "existing memory root differs from private remote history",
        );
    }
    const verification = verifyHistory(cfg);
    if (!verification.ok)
      throw new Error(
        `remote memory history verification failed: ${verification.issues.join(", ")}`,
      );
    sealMemoryRoot(cfg);
    return {
      initialized: true,
      dryRun: false,
      gitDir: gitDir(cfg),
      commit: remoteHead,
      remote: options.remote,
    };
  }
  const changes = markdown(cfg.root).map((file) => ({
    path: relative(cfg.root, file),
    afterSha256: sha256(readFileSync(file)),
    status: statusFor(relative(cfg.root, file)),
  }));
  const commit = withWritableMemoryRoot(
    cfg,
    () =>
      commitInternal(
        cfg,
        {
          version: 2,
          mutationId: `baseline_${randomUUID().replaceAll("-", "")}`,
          kind: "baseline",
          reason: "initial history baseline",
          changes,
          provenance: { source: "pi-memory init" },
        },
        true,
      ).commit,
  );
  return {
    initialized: true,
    dryRun: false,
    gitDir: gitDir(cfg),
    commit,
    remote: options.remote,
  };
}

function resolveRemoteMain(cfg: MemoryConfig): string | undefined {
  const result = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "ls-remote",
      "--exit-code",
      "origin",
      "refs/heads/main",
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (result.error) throw result.error;
  if (result.status === 2) return undefined;
  if (result.status !== 0)
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        "could not inspect history remote"
      ).trim(),
    );
  const hash = result.stdout.trim().split(/\s+/)[0];
  if (!hash || !/^[0-9a-f]{40,64}$/.test(hash))
    throw new Error("invalid remote history head");
  return hash;
}

function configureRemote(cfg: MemoryConfig, remote: string): void {
  if (!remote.trim() || /[\r\n\0]/.test(remote))
    throw new Error("invalid remote");
  const existing = remoteUrls(cfg, false);
  const push = remoteUrls(cfg, true);
  if (
    existing.length > 1 ||
    push.length > 1 ||
    (existing.length === 1 && (existing[0] !== remote || push[0] !== remote))
  )
    throw new Error("history origin does not match configured remote");
  if (existing.length === 0) git(cfg, ["remote", "add", "origin", remote]);
  git(cfg, ["config", "piMemory.expectedRemote", remote]);
}

function remoteUrls(cfg: MemoryConfig, push: boolean): string[] {
  return git(
    cfg,
    ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"],
    true,
  )
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);
}

function expectedRemote(cfg: MemoryConfig): string | undefined {
  return (
    git(cfg, ["config", "--get", "piMemory.expectedRemote"], true).trim() ||
    undefined
  );
}

function validateRemote(cfg: MemoryConfig): string | undefined {
  const expected = expectedRemote(cfg);
  const remotes = git(cfg, ["remote"]).trim();
  if (!remotes) {
    if (expected) throw new Error("configured history remote is missing");
    return undefined;
  }
  if (remotes !== "origin" || !expected)
    throw new Error("unexpected git remotes");
  const fetch = remoteUrls(cfg, false);
  const push = remoteUrls(cfg, true);
  if (
    fetch.length !== 1 ||
    push.length !== 1 ||
    fetch[0] !== expected ||
    push[0] !== expected
  )
    throw new Error("history origin does not match configured remote");
  return expected;
}

function readRevisionFile(
  cfg: MemoryConfig,
  rev: string,
  path: string,
): Buffer | undefined {
  const object = rev === ":" ? `:${path}` : `${rev}:${path}`;
  const exists = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "cat-file",
      "-e",
      object,
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (exists.status !== 0) return undefined;
  const result = spawnSync(
    "git",
    [`--git-dir=${gitDir(cfg)}`, `--work-tree=${cfg.root}`, "show", object],
    { env: gitEnv },
  );
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function statusFor(path: string): string {
  return path.startsWith(".archive/archived/")
    ? "archived"
    : path.startsWith(".archive/retired/")
      ? "retired"
      : "active";
}

function memoryId(text: Buffer | undefined): string | undefined {
  return /^memory_id:\s*["']?([^"'\n]+)["']?$/m.exec(
    text?.toString("utf8") ?? "",
  )?.[1];
}

function stagedChanges(cfg: MemoryConfig): HistoryChange[] {
  const fields = git(cfg, [
    "diff",
    "--cached",
    "--name-status",
    "--no-renames",
    "-z",
    "--",
    ...PATHS,
  ])
    .split("\0")
    .filter(Boolean);
  const changes: HistoryChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;
    const before = readRevisionFile(cfg, "HEAD", path);
    const after = status === "D" ? undefined : readRevisionFile(cfg, ":", path);
    if (status !== "D" && after === undefined)
      throw new Error(`staged memory is missing ${path}`);
    changes.push({
      path,
      ...(memoryId(after ?? before)
        ? { memoryId: memoryId(after ?? before) }
        : {}),
      ...(before === undefined ? {} : { beforeSha256: sha256(before) }),
      ...(after === undefined ? {} : { afterSha256: sha256(after) }),
      status: statusFor(path),
    });
  }
  return changes;
}

function normalizedChanges(changes: HistoryChange[]): string {
  return canonical(
    changes
      .map(({ memoryId: _, ...change }) => change)
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function committedHistoryIssues(cfg: MemoryConfig, ref: string): string[] {
  return verifyCommittedSemanticHistory(cfg, revision(ref)).issues;
}

function writeReceiptCache(cfg: MemoryConfig, receipt: HistoryReceipt): void {
  atomicWrite(
    contained(
      receiptsDir(cfg),
      join(receiptsDir(cfg), `${receipt.mutationId}.json`),
    ),
    `${canonical(receipt)}\n`,
  );
}

function commitInternal(
  cfg: MemoryConfig,
  core: HistoryReceiptCore,
  empty = false,
): { commit: string; mutationId: string } {
  if (core.version !== 2 || !/^[A-Za-z0-9_.-]+$/.test(core.mutationId))
    throw new Error("invalid history receipt");
  const parent = git(cfg, ["rev-parse", "HEAD"], true).trim() || undefined;
  if (core.parentCommit && core.parentCommit !== parent)
    throw new Error("receipt parent does not match HEAD");
  let receipt = { ...core, parentCommit: core.parentCommit ?? parent };
  git(cfg, ["add", "-A", "--", ...PATHS], empty);
  const actualChanges = stagedChanges(cfg);
  if (
    core.kind !== "baseline" &&
    !core.kind.startsWith("repair-") &&
    normalizedChanges(core.changes) !== normalizedChanges(actualChanges)
  )
    throw new Error("history receipt changes do not match staged memory diff");
  receipt = { ...receipt, changes: actualChanges };
  if (!empty && git(cfg, ["diff", "--cached", "--quiet"], true) === "") {
    const changed = git(cfg, ["diff", "--cached", "--name-only"]);
    if (!changed.trim()) throw new Error("no memory changes to commit");
  }
  const tree = git(cfg, ["write-tree"]).trim();
  const message = `pi-memory ${core.kind}\n\n${TRAILER} ${encode(receipt)}\n`;
  const hash = gitInput(
    cfg,
    ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
    message,
  ).trim();
  const ref = git(cfg, ["symbolic-ref", "-q", "HEAD"]).trim();
  if (!ref) throw new Error("history HEAD must be symbolic");
  const update = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "update-ref",
      "-m",
      `pi-memory ${core.kind}`,
      ref,
      hash,
      parent ?? "0".repeat(hash.length),
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (update.error) throw update.error;
  if (update.status !== 0)
    throw new Error("history parent changed before ref update; retry mutation");
  writeReceiptCache(cfg, { ...receipt, commit: hash });
  return { commit: hash, mutationId: core.mutationId };
}
function commitHistoryImpl(
  cfg: MemoryConfig,
  receiptCore: HistoryReceiptCore,
  options: { allowEmpty?: boolean } = {},
): { commit: string; mutationId: string } {
  if (!isHistoryInitialized(cfg)) throw new Error("history not initialized");
  if (historyEntryByMutationId(cfg, receiptCore.mutationId))
    throw new Error(`duplicate history mutation id ${receiptCore.mutationId}`);
  return withWritableMemoryRoot(cfg, () => {
    try {
      return commitInternal(cfg, receiptCore, options.allowEmpty);
    } catch (error) {
      git(cfg, ["reset", "--mixed", "HEAD"], true);
      throw error;
    }
  });
}
export function headHistoryReceipt(cfg: MemoryConfig): HistoryReceipt | null {
  if (!isHistoryInitialized(cfg)) return null;
  const commit = git(cfg, ["rev-parse", "HEAD"]).trim();
  return { ...decode(git(cfg, ["show", "-s", "--format=%B", "HEAD"])), commit };
}
export function historyReceiptAt(
  cfg: MemoryConfig,
  commit: string,
): HistoryReceipt {
  const exact = revision(commit);
  const resolved = git(cfg, [
    "rev-parse",
    "--verify",
    `${exact}^{commit}`,
  ]).trim();
  if (resolved !== exact)
    throw new Error("history commit did not resolve exactly");
  return {
    ...decode(git(cfg, ["show", "-s", "--format=%B", exact])),
    commit: exact,
  };
}

export function historyContainsAncestor(
  cfg: MemoryConfig,
  ancestor: string,
  descendant = "HEAD",
): boolean {
  const result = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "merge-base",
      "--is-ancestor",
      revision(ancestor),
      revision(descendant),
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    (result.stderr || "could not verify history ancestry").trim(),
  );
}

function allHistoryEntries(cfg: MemoryConfig, ref = "HEAD"): HistoryEntry[] {
  if (!isHistoryInitialized(cfg)) return [];
  const fields = git(cfg, ["log", "--format=%H%x00%B%x00", revision(ref)])
    .split("\0")
    .filter(Boolean);
  const entries: HistoryEntry[] = [];
  const mutationIds = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const receipt = decode(fields[index + 1]!);
    if (mutationIds.has(receipt.mutationId))
      throw new Error(`duplicate history mutation id ${receipt.mutationId}`);
    mutationIds.add(receipt.mutationId);
    entries.push({ commit: fields[index]!.trim(), receipt });
  }
  return entries;
}

export function historyEntryByMutationId(
  cfg: MemoryConfig,
  mutationId: string,
): HistoryEntry | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(mutationId))
    throw new Error("invalid history mutation id");
  return allHistoryEntries(cfg).find(
    (entry) => entry.receipt.mutationId === mutationId,
  );
}

export function listHistoryByKind(
  cfg: MemoryConfig,
  kind: string,
  ref = "HEAD",
): HistoryEntry[] {
  if (!kind.trim()) throw new Error("invalid history kind");
  return allHistoryEntries(cfg, ref).filter(
    (entry) => entry.receipt.kind === kind,
  );
}

export function listHistory(
  cfg: MemoryConfig,
  options: { memory?: string; limit?: number } = {},
): HistoryEntry[] {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("invalid history limit");
  const args = ["log", `--max-count=${limit}`, "--format=%H%x00%B%x00"];
  if (options.memory) args.push("--", literalPath(options.memory));
  const fields = git(cfg, args)
    .split("\0")
    .filter((field) => field.length);
  const entries: HistoryEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    entries.push({
      commit: fields[i]!.trim(),
      receipt: decode(fields[i + 1]!),
    });
  return entries;
}
export function showHistory(
  cfg: MemoryConfig,
  rev: string,
  path?: string,
): string {
  return path
    ? git(cfg, ["show", `${revision(rev)}:${memoryPath(path)}`])
    : git(cfg, ["show", "--stat", "--patch", revision(rev)]);
}
export function diffHistory(
  cfg: MemoryConfig,
  from?: string,
  to = "HEAD",
  memory?: string,
): string {
  const resolvedFrom = from ?? git(cfg, ["rev-parse", "HEAD^"], true).trim();
  if (!resolvedFrom) throw new Error("history has no parent commit");
  const args = ["diff", revision(resolvedFrom), revision(to)];
  if (memory) args.push("--", literalPath(memory));
  return git(cfg, args);
}
function repositoryIdentity(cfg: MemoryConfig): string {
  const path = realpathSync(gitDir(cfg));
  const stat = statSync(path);
  return `${path}:${stat.dev}:${stat.ino}`;
}

function readCheckpoint(cfg: MemoryConfig): HistoryCheckpoint | undefined {
  if (!existsSync(checkpointPath(cfg))) {
    if (existsSync(checkpointMarkerPath(cfg)))
      throw new Error(
        "history verification checkpoint is missing; explicit history recovery is required",
      );
    return undefined;
  }
  try {
    const value = JSON.parse(
      readFileSync(checkpointPath(cfg), "utf8"),
    ) as HistoryCheckpoint;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.policyVersion) ||
      !/^[0-9a-f]{40,64}$/.test(value.head) ||
      typeof value.repository !== "string" ||
      typeof value.root !== "string" ||
      typeof value.objectFormat !== "string" ||
      (value.expectedRemote !== null &&
        typeof value.expectedRemote !== "string")
    )
      throw new Error("shape");
    return value;
  } catch {
    throw new Error(
      "history verification checkpoint is corrupt; explicit history recovery is required",
    );
  }
}

type SemanticCommit = {
  commit: string;
  parent: string;
  receipt: HistoryReceiptCore;
};

function semanticCommits(
  cfg: MemoryConfig,
  range: string,
): SemanticCommit[] {
  const fields = git(cfg, ["log", "--format=%H%x00%P%x00%B%x00", range])
    .split("\0");
  const commits: SemanticCommit[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const commit = fields[index]!.trim();
    if (!commit) continue;
    const parents = fields[index + 1]!.trim().split(/\s+/).filter(Boolean);
    if (parents.length > 1)
      throw new Error(`merge commit is not allowed ${commit}`);
    commits.push({
      commit,
      parent: parents[0] ?? "",
      receipt: decode(fields[index + 2]!),
    });
  }
  return commits;
}

function semanticDiffs(
  cfg: MemoryConfig,
  commits: SemanticCommit[],
): Map<string, Array<{ status: string; path: string }>> {
  const output = gitInput(
    cfg,
    ["diff-tree", "--stdin", "--root", "--no-renames", "-r", "-z", "--name-status"],
    `${commits.map(({ commit }) => commit).join("\n")}\n`,
  );
  const fields = output.split("\0").filter(Boolean);
  const result = new Map<string, Array<{ status: string; path: string }>>();
  let current: Array<{ status: string; path: string }> | undefined;
  for (let index = 0; index < fields.length; ) {
    const field = fields[index]!;
    if (/^[0-9a-f]{40,64}$/.test(field)) {
      current = [];
      result.set(field, current);
      index += 1;
      continue;
    }
    if (!current || index + 1 >= fields.length)
      throw new Error("invalid batched history diff");
    current.push({ status: field, path: fields[index + 1]! });
    index += 2;
  }
  return result;
}

function batchRevisionFiles(
  cfg: MemoryConfig,
  objects: string[],
): Map<string, Buffer | undefined> {
  if (objects.length === 0) return new Map();
  const result = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "cat-file",
      "--batch",
    ],
    { env: gitEnv, input: Buffer.from(`${objects.join("\n")}\n`) },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(String(result.stderr || "batched git object read failed").trim());
  const output = result.stdout as Buffer;
  const files = new Map<string, Buffer | undefined>();
  let offset = 0;
  for (const object of objects) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("truncated batched git object response");
    const header = output.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    if (header.endsWith(" missing")) {
      files.set(object, undefined);
      continue;
    }
    const match = /^[0-9a-f]{40,64} blob (\d+)$/.exec(header);
    if (!match) throw new Error("invalid batched git object response");
    const size = Number(match[1]);
    const end = offset + size;
    if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 0x0a)
      throw new Error("truncated batched git blob");
    files.set(object, output.subarray(offset, end));
    offset = end + 1;
  }
  return files;
}

function verifyCommittedSemanticHistory(
  cfg: MemoryConfig,
  range: string,
): { issues: string[]; commits: number; blobs: number; processes: number } {
  const issues: string[] = [];
  const commits = semanticCommits(cfg, range);
  const diffs = semanticDiffs(cfg, commits);
  const objectNames: string[] = [];
  for (const item of commits)
    for (const change of diffs.get(item.commit) ?? []) {
      if (!allowedTrackedPath(change.path))
        issues.push(`history contains disallowed path ${change.path}`);
      if (item.parent) objectNames.push(`${item.parent}:${change.path}`);
      if (change.status !== "D") objectNames.push(`${item.commit}:${change.path}`);
    }
  const uniqueObjects = [...new Set(objectNames)];
  const files = batchRevisionFiles(cfg, uniqueObjects);
  for (const item of commits) {
    if ((item.receipt.parentCommit ?? "") !== item.parent)
      issues.push(`receipt parent mismatch ${item.commit}`);
    const actual: HistoryChange[] = [];
    for (const change of diffs.get(item.commit) ?? []) {
      const before = item.parent
        ? files.get(`${item.parent}:${change.path}`)
        : undefined;
      const after =
        change.status === "D"
          ? undefined
          : files.get(`${item.commit}:${change.path}`);
      if (change.status !== "D" && after === undefined)
        throw new Error(`committed memory is missing ${change.path}`);
      actual.push({
        path: change.path,
        ...(memoryId(after ?? before)
          ? { memoryId: memoryId(after ?? before) }
          : {}),
        ...(before === undefined ? {} : { beforeSha256: sha256(before) }),
        ...(after === undefined ? {} : { afterSha256: sha256(after) }),
        status: statusFor(change.path),
      });
    }
    if (normalizedChanges(item.receipt.changes) !== normalizedChanges(actual))
      issues.push(`receipt diff mismatch ${item.commit}`);
  }
  return {
    issues,
    commits: commits.length,
    blobs: uniqueObjects.length,
    processes: uniqueObjects.length > 0 ? 3 : 2,
  };
}

function verifyHistoryImpl(cfg: MemoryConfig): VerifyHistoryReport {
  const started = Date.now();
  const issues: string[] = [];
  if (!isHistoryInitialized(cfg))
    return { ok: false, issues: ["history not initialized"] };
  const head = git(cfg, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const repository = repositoryIdentity(cfg);
  let mode = "full";
  let commitsVerified = 0;
  let blobsVerified = 0;
  let semanticProcesses = 0;
  let checkpointStatus = "migration";
  if (git(cfg, ["status", "--porcelain", "--", ...PATHS], true).trim())
    issues.push("dirty memory worktree");
  try {
    const remote = validateRemote(cfg) ?? null;
    const root = realpathSync(cfg.root);
    const objectFormat =
      git(cfg, ["rev-parse", "--show-object-format"], true).trim() || "sha1";
    const checkpoint = readCheckpoint(cfg);
    if (checkpoint) {
      checkpointStatus = "loaded";
      if (
        checkpoint.repository !== repository ||
        checkpoint.root !== root ||
        checkpoint.objectFormat !== objectFormat ||
        checkpoint.expectedRemote !== remote
      )
        throw new Error(
          "history verification checkpoint identity changed; explicit history recovery is required",
        );
      if (checkpoint.policyVersion !== HISTORY_POLICY_VERSION) {
        mode = "full";
        checkpointStatus = "policy-reverify";
      } else if (checkpoint.head === head) mode = "durable-hit";
      else if (historyContainsAncestor(cfg, checkpoint.head, head)) mode = "suffix";
      else
        throw new Error(
          "history was rewritten or moved backward; explicit history recovery is required",
        );
    }
    if (
      latestProcessAnchor?.repository === repository &&
      latestProcessAnchor.policyVersion === HISTORY_POLICY_VERSION
    ) {
      if (latestProcessAnchor.head === head) mode = "process-hit";
      else if (!historyContainsAncestor(cfg, latestProcessAnchor.head, head))
        throw new Error(
          "history moved behind the in-process verification anchor; restart and explicit recovery are required",
        );
    }
    const tracked = git(cfg, ["ls-files", "-z"]).split("\0").filter(Boolean);
    for (const path of tracked)
      if (!allowedTrackedPath(path))
        issues.push(`history contains disallowed path ${path}`);
    const range =
      mode === "suffix" && checkpoint ? `${checkpoint.head}..${head}` : head;
    if (mode !== "durable-hit" && mode !== "process-hit") {
      const semantic = verifyCommittedSemanticHistory(cfg, range);
      issues.push(...semantic.issues);
      commitsVerified = semantic.commits;
      blobsVerified = semantic.blobs;
      semanticProcesses = semantic.processes;
    }
    // Receipt caches are volatile projections. Validate or reconstruct every
    // call even when the immutable commit prefix already has a proof.
    for (const { commit, receipt } of allHistoryEntries(cfg)) {
      const file = join(receiptsDir(cfg), `${receipt.mutationId}.json`);
      contained(receiptsDir(cfg), file);
      if (!existsSync(file)) {
        writeReceiptCache(cfg, {
          ...receipt,
          commit,
        });
        continue;
      }
      const saved = JSON.parse(readFileSync(file, "utf8"));
      const { commit: savedCommit, ...savedCore } = saved;
      if (savedCommit !== commit || canonical(savedCore) !== canonical(receipt))
        issues.push(`receipt cache mismatch ${receipt.mutationId}`);
    }
    if (git(cfg, ["rev-parse", "HEAD"]).trim() !== head)
      throw new Error(
        "history head changed during verification; retry verification",
      );
    if (
      issues.length === 0 &&
      mode !== "durable-hit" &&
      mode !== "process-hit"
    ) {
      atomicWrite(
        checkpointPath(cfg),
        `${canonical({ version: 1, policyVersion: HISTORY_POLICY_VERSION, head, repository, root, objectFormat, expectedRemote: remote })}\n`,
      );
      atomicWrite(checkpointMarkerPath(cfg), "initialized\n");
      checkpointStatus = "advanced";
    }
    if (issues.length === 0)
      latestProcessAnchor = {
        repository,
        head,
        policyVersion: HISTORY_POLICY_VERSION,
      };
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "invalid history receipt",
    );
  }
  return {
    ok: issues.length === 0,
    issues,
    ...(issues.length === 0
      ? { basis: { head, repository, policyVersion: HISTORY_POLICY_VERSION } }
      : {}),
    telemetry: {
      mode,
      head,
      anchor: latestProcessAnchor?.head ?? "none",
      commits: commitsVerified,
      blobs: blobsVerified,
      semanticProcesses,
      checkpointStatus,
      elapsedMs: Date.now() - started,
    },
  };
}
function syncHistoryImpl(cfg: MemoryConfig): SyncHistoryReport {
  if (!isHistoryInitialized(cfg))
    return { ok: false, pushed: false, error: "history not initialized" };
  try {
    const refreshed = refreshHistory(cfg);
    if (!refreshed.ok) return refreshed;
    const verification = verifyHistory(cfg);
    if (!verification.ok)
      throw new Error(
        `history verification failed: ${verification.issues.join(", ")}`,
      );
    if (!validateRemote(cfg))
      return {
        ok: true,
        pushed: false,
        ...(refreshed.fastForwarded ? { fastForwarded: true } : {}),
      };
    git(cfg, ["push", "origin", "main"]);
    return {
      ok: true,
      pushed: true,
      ...(refreshed.fastForwarded ? { fastForwarded: true } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isAncestor(
  cfg: MemoryConfig,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      `--work-tree=${cfg.root}`,
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw result.error ?? new Error(result.stderr || "could not compare history");
}

function refreshHistoryImpl(cfg: MemoryConfig): SyncHistoryReport {
  if (!isHistoryInitialized(cfg))
    return { ok: false, pushed: false, error: "history not initialized" };
  try {
    if (!validateRemote(cfg)) return { ok: true, pushed: false };
    const remoteHead = resolveRemoteMain(cfg);
    if (!remoteHead) return { ok: true, pushed: false };
    git(cfg, ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
    const localHead = git(cfg, ["rev-parse", "HEAD"]).trim();
    if (localHead === remoteHead) return { ok: true, pushed: false };
    if (isAncestor(cfg, remoteHead, localHead))
      return { ok: true, pushed: false };
    if (!isAncestor(cfg, localHead, remoteHead))
      return {
        ok: false,
        pushed: false,
        diverged: true,
        error: "local and remote memory history diverged",
      };
    const remoteIssues = committedHistoryIssues(cfg, remoteHead);
    if (remoteIssues.length)
      throw new Error(
        `remote memory history verification failed: ${remoteIssues.join(", ")}`,
      );
    if (git(cfg, ["status", "--porcelain", "--", ...PATHS]).trim())
      throw new Error("cannot fast-forward a dirty memory worktree");
    withWritableMemoryRoot(cfg, () =>
      git(cfg, ["reset", "--hard", remoteHead]),
    );
    const verification = verifyHistory(cfg);
    if (!verification.ok) {
      withWritableMemoryRoot(cfg, () =>
        git(cfg, ["reset", "--hard", localHead]),
      );
      throw new Error(
        `remote memory history verification failed: ${verification.issues.join(", ")}`,
      );
    }
    return { ok: true, pushed: false, fastForwarded: true };
  } catch (error) {
    return {
      ok: false,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
function repairHistoryImpl(
  cfg: MemoryConfig,
  options: { mode: "adopt" | "discard"; reason: string },
): RepairHistoryReport {
  if (!options.reason.trim()) throw new Error("repair reason is required");
  const refreshed = refreshHistory(cfg);
  if (!refreshed.ok)
    throw new Error(`memory history refresh failed: ${refreshed.error}`);
  if (options.mode === "adopt") {
    const result = commitHistory(cfg, {
      version: 2,
      mutationId: `repair_${randomUUID().replaceAll("-", "")}`,
      kind: "repair-adopt",
      reason: options.reason,
      changes: [],
      provenance: { source: "pi-memory repair" },
    });
    return { mode: "adopt", commit: result.commit };
  }
  withWritableMemoryRoot(cfg, () => {
    git(cfg, ["checkout", "-f", "HEAD", "--", ...PATHS]);
    git(cfg, ["clean", "-f", "-d", "--", ...PATHS], true);
  });
  const result = commitHistory(
    cfg,
    {
      version: 2,
      mutationId: `repair_${randomUUID().replaceAll("-", "")}`,
      kind: "repair-discard",
      reason: options.reason,
      changes: [],
      provenance: { source: "pi-memory repair" },
    },
    { allowEmpty: true },
  );
  return { mode: "discard", commit: result.commit };
}

export function initHistory(
  cfg: MemoryConfig,
  options: { remote?: string; dryRun?: boolean } = {},
): InitHistoryReport {
  return observeMemoryOperation(
    {
      operation: "memory.history.init",
      fields: { dryRun: !!options.dryRun, remoteConfigured: !!options.remote },
      result: (report) => ({
        outcome: report.initialized ? "success" : "skipped",
        fields: {
          initialized: report.initialized,
          dryRun: report.dryRun,
          hasCommit: !!report.commit,
        },
      }),
    },
    () => initHistoryImpl(cfg, options),
  );
}
export function commitHistory(
  cfg: MemoryConfig,
  receiptCore: HistoryReceiptCore,
  options: { allowEmpty?: boolean } = {},
): { commit: string; mutationId: string } {
  return observeMemoryOperation(
    {
      operation: "memory.history.commit",
      fields: { allowEmpty: !!options.allowEmpty },
      result: (result) => ({
        fields: { mutationId: result.mutationId, hasCommit: !!result.commit },
      }),
    },
    () => commitHistoryImpl(cfg, receiptCore, options),
  );
}
export function verifyHistory(cfg: MemoryConfig): VerifyHistoryReport {
  return observeMemoryOperation(
    {
      operation: "memory.history.verify",
      result: (report) => ({
        outcome: report.ok ? "success" : "degraded",
        fields: { ok: report.ok, issueCount: report.issues.length },
      }),
    },
    () => verifyHistoryImpl(cfg),
  );
}
export function syncHistory(cfg: MemoryConfig): SyncHistoryReport {
  return observeMemoryOperation(
    {
      operation: "memory.history.sync",
      result: (report) => ({
        outcome: report.ok
          ? report.pushed || report.fastForwarded
            ? "success"
            : "skipped"
          : "degraded",
        fields: {
          ok: report.ok,
          pushed: report.pushed,
          fastForwarded: !!report.fastForwarded,
          diverged: !!report.diverged,
        },
      }),
    },
    () => syncHistoryImpl(cfg),
  );
}
export function refreshHistory(cfg: MemoryConfig): SyncHistoryReport {
  return observeMemoryOperation(
    {
      operation: "memory.history.refresh",
      result: (report) => ({
        outcome: report.ok
          ? report.fastForwarded
            ? "success"
            : "skipped"
          : "degraded",
        fields: {
          ok: report.ok,
          fastForwarded: !!report.fastForwarded,
          diverged: !!report.diverged,
        },
      }),
    },
    () => refreshHistoryImpl(cfg),
  );
}
export function repairHistory(
  cfg: MemoryConfig,
  options: { mode: "adopt" | "discard"; reason: string },
): RepairHistoryReport {
  return observeMemoryOperation(
    {
      operation: "memory.history.repair",
      fields: { mode: options.mode },
      result: (report) => ({
        fields: { mode: report.mode, hasCommit: !!report.commit },
      }),
    },
    () => repairHistoryImpl(cfg, options),
  );
}
