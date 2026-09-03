import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import { observeMemoryOperation } from "../observability.js";
import {
  unsafeCanonicalValue,
  type AdmissionDecision,
  type CanonicalChange,
  type EvidenceCapsule,
} from "./admission.js";
import {
  canonicalJson,
  durableCreate,
  durableRemove,
  durableWrite,
  object,
  safeRelativePath,
  sha256,
  timestamp,
  v3Data,
  v3State,
  withDirectoryLock,
  type JsonValue,
} from "./common.js";
import { ADMISSION_POLICY_VERSION, RESOURCE_LIMITS } from "./policy.js";
import type { ArtifactRef } from "./workflows.js";

export type CandidateChange = Omit<CanonicalChange, "afterContent"> & {
  afterArtifact: ArtifactRef | null;
};

export type CanonicalReceipt = {
  schemaVersion: 3;
  mutationId: string;
  proposalId: string;
  proposalSha256: string;
  admissionDecisionId: string;
  admissionPolicyVersion: number;
  admissionExpiresAt: string;
  admissionSummary: { path: string; sha256: string };
  evidenceCapsule: { path: string; sha256: string };
  parentCommit: string;
  changes: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
};

export type CandidateRecord = {
  schemaVersion: 3;
  proposalId: string;
  proposalSha256: string;
  mutationId: string;
  parentCommit: string;
  candidateCommit: string;
  tree: string;
  preparedAt: string;
  admissionDecisionId: string;
  admissionPolicyVersion: number;
  admissionExpiresAt: string;
  admissionSummary: { path: string; sha256: string; artifact: ArtifactRef };
  evidenceCapsule: { path: string; sha256: string; artifact: ArtifactRef };
  changes: CandidateChange[];
};

export type MergeOutcome =
  | {
      type: "accepted";
      commit: string;
      mutationId: string;
      idempotent: boolean;
      materialized: boolean;
    }
  | {
      type: "basis-changed";
      head: string;
      paths: string[];
    }
  | {
      type: "retry";
      reason: "remote-unavailable" | "remote-race" | "push-result-unknown";
    }
  | { type: "closed"; reason: "admission-expired" };

export type HistoryConfig = Pick<MemoryConfig, "data" | "state" | "root"> & {
  remote: string;
};

export interface HistoryTransport {
  push(cfg: HistoryConfig, commit: string): "accepted" | "rejected" | "unknown";
}

const TRAILER = "Pi-Memory-Receipt:";
const HASH = /^[a-f0-9]{40,64}$/;
const gitDir = (cfg: HistoryConfig): string => v3Data(cfg, "history.git");
const candidatePath = (cfg: HistoryConfig, proposalId: string): string =>
  v3Data(cfg, "history-candidates", `${proposalId}.json`);
const acceptedReceiptPath = (cfg: HistoryConfig, mutationId: string): string =>
  v3Data(
    cfg,
    "indexes/accepted-receipts",
    sha256(mutationId).slice(0, 2),
    `${mutationId}.json`,
  );

const gitIdentity = {
  GIT_AUTHOR_NAME: "pi-memory",
  GIT_AUTHOR_EMAIL: "pi-memory@local",
  GIT_COMMITTER_NAME: "pi-memory",
  GIT_COMMITTER_EMAIL: "pi-memory@local",
};

function git(
  cfg: HistoryConfig,
  args: string[],
  options: {
    input?: string | Buffer;
    tolerate?: boolean;
    env?: NodeJS.ProcessEnv;
    encoding?: BufferEncoding | "buffer";
  } = {},
): string | Buffer {
  const encoding =
    options.encoding === "buffer" ? null : (options.encoding ?? "utf8");
  const result = spawnSync(
    "git",
    [
      `--git-dir=${gitDir(cfg)}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    {
      input: options.input,
      encoding,
      env: { ...process.env, ...gitIdentity, ...options.env },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.tolerate)
    throw new Error(
      String(result.stderr || result.stdout || "git failed").trim(),
    );
  if (result.status !== 0) return encoding === null ? Buffer.alloc(0) : "";
  return result.stdout ?? (encoding === null ? Buffer.alloc(0) : "");
}

function text(
  cfg: HistoryConfig,
  args: string[],
  options: Parameters<typeof git>[2] = {},
): string {
  return git(cfg, args, options) as string;
}

function initLocalHistory(cfg: HistoryConfig): void {
  if (!existsSync(join(gitDir(cfg), "HEAD"))) {
    mkdirSync(dirname(gitDir(cfg)), { recursive: true, mode: 0o700 });
    const result = spawnSync("git", ["init", "--bare", gitDir(cfg)], {
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw (
        result.error ??
        new Error(result.stderr || "could not initialize history")
      );
  }
  const remote = text(cfg, ["remote", "get-url", "origin"], {
    tolerate: true,
  }).trim();
  if (!remote) text(cfg, ["remote", "add", "origin", cfg.remote]);
  else if (remote !== cfg.remote)
    throw new Error("history origin does not match configuration");
}

export function fetchCanonicalHead(cfg: HistoryConfig): string {
  initLocalHistory(cfg);
  text(cfg, [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const head = text(cfg, [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/main",
  ]).trim();
  if (!HASH.test(head)) throw new Error("invalid canonical remote head");
  validateTree(cfg, head);
  return head;
}

export function lastFetchedCanonicalHead(
  cfg: HistoryConfig,
): string | undefined {
  initLocalHistory(cfg);
  const head = text(
    cfg,
    ["rev-parse", "--verify", "refs/remotes/origin/main"],
    { tolerate: true },
  ).trim();
  if (!head) return undefined;
  if (!HASH.test(head)) throw new Error("invalid last fetched canonical head");
  validateTree(cfg, head);
  return head;
}

function canonicalTreePath(path: string): string {
  const result = safeRelativePath(path);
  const segments = result.split("/");
  const audit =
    /^\.pi-memory\/(?:evidence|admissions)\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(
      result,
    );
  if (
    ((!result.endsWith(".md") || result.startsWith(".")) && !audit) ||
    (!audit &&
      (segments.includes(".stversions") ||
        segments.includes(".qmd") ||
        segments.includes(".pi-memory") ||
        segments.some((part) => part.includes(".sync-conflict-"))))
  )
    throw new Error(`disallowed canonical path ${result}`);
  return result;
}

function validateTree(cfg: HistoryConfig, commit: string): void {
  const output = git(cfg, ["ls-tree", "-rz", commit], {
    encoding: "buffer",
  }) as Buffer;
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(record);
    if (!match || match[1] !== "100644")
      throw new Error("canonical tree contains non-regular content");
    canonicalTreePath(match[2]!);
  }
}

function treeContent(
  cfg: HistoryConfig,
  commit: string,
  path: string,
): Buffer | undefined {
  canonicalTreePath(path);
  const object = text(cfg, ["rev-parse", "--verify", `${commit}:${path}`], {
    tolerate: true,
  }).trim();
  if (!HASH.test(object)) return undefined;
  return git(cfg, ["show", `${commit}:${path}`], {
    encoding: "buffer",
  }) as Buffer;
}

function treeDigest(
  cfg: HistoryConfig,
  commit: string,
  path: string,
): string | null {
  const content = treeContent(cfg, commit, path);
  return content ? sha256(content) : null;
}

export function listCanonicalMarkdown(
  cfg: HistoryConfig,
  commit: string,
): string[] {
  validateTree(cfg, commit);
  return (
    git(cfg, ["ls-tree", "-rz", "--name-only", commit], {
      encoding: "buffer",
    }) as Buffer
  )
    .toString("utf8")
    .split("\0")
    .filter((path) => path.endsWith(".md"))
    .map(canonicalTreePath)
    .sort();
}

export function readCanonicalFile(
  cfg: HistoryConfig,
  commit: string,
  path: string,
): Buffer {
  const value = treeContent(cfg, commit, path);
  if (!value) throw new Error(`canonical path missing ${path}`);
  return value;
}

function persistArtifact(cfg: HistoryConfig, content: string): ArtifactRef {
  const digest = sha256(content);
  const path = v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
  if (!durableCreate(path, content) && readFileSync(path, "utf8") !== content)
    throw new Error("history artifact collision");
  return {
    sha256: digest,
    relativePath: relative(v3Data(cfg), path),
    bytes: Buffer.byteLength(content),
  };
}

function readArtifact(cfg: HistoryConfig, artifact: ArtifactRef): Buffer {
  const value = readFileSync(v3Data(cfg, artifact.relativePath));
  if (value.length !== artifact.bytes || sha256(value) !== artifact.sha256)
    throw new Error("history artifact binding changed");
  return value;
}

function receipt(record: CandidateRecord): CanonicalReceipt {
  return {
    schemaVersion: 3,
    mutationId: record.mutationId,
    proposalId: record.proposalId,
    proposalSha256: record.proposalSha256,
    admissionDecisionId: record.admissionDecisionId,
    admissionPolicyVersion: record.admissionPolicyVersion,
    admissionExpiresAt: record.admissionExpiresAt,
    admissionSummary: {
      path: record.admissionSummary.path,
      sha256: record.admissionSummary.sha256,
    },
    evidenceCapsule: {
      path: record.evidenceCapsule.path,
      sha256: record.evidenceCapsule.sha256,
    },
    parentCommit: record.parentCommit,
    changes: record.changes.map(({ path, beforeSha256, afterSha256 }) => ({
      path,
      beforeSha256,
      afterSha256,
    })),
  };
}

function createCommit(
  cfg: HistoryConfig,
  base: Omit<CandidateRecord, "candidateCommit" | "tree">,
): CandidateRecord {
  const index = join(
    dirname(candidatePath(cfg, base.proposalId)),
    `.${base.proposalId}.${process.pid}.index`,
  );
  mkdirSync(dirname(index), { recursive: true, mode: 0o700 });
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    text(cfg, ["read-tree", base.parentCommit], { env });
    const apply = (path: string, artifact: ArtifactRef | null): void => {
      canonicalTreePath(path);
      if (!artifact) {
        text(cfg, ["update-index", "--index-info"], {
          input: `0 ${"0".repeat(40)}\t${path}\n`,
          env,
        });
        return;
      }
      const blob = text(cfg, ["hash-object", "-w", "--stdin"], {
        input: readArtifact(cfg, artifact),
        env,
      }).trim();
      if (!HASH.test(blob)) throw new Error("invalid candidate blob");
      text(
        cfg,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
        {
          env,
        },
      );
    };
    for (const change of base.changes) apply(change.path, change.afterArtifact);
    apply(base.evidenceCapsule.path, base.evidenceCapsule.artifact);
    apply(base.admissionSummary.path, base.admissionSummary.artifact);
    const tree = text(cfg, ["write-tree"], { env }).trim();
    if (!HASH.test(tree)) throw new Error("invalid candidate tree");
    const provisional = { ...base, candidateCommit: "", tree };
    const receiptBytes = canonicalJson(receipt(provisional));
    const message = `pi-memory: accept ${base.mutationId}\n\n${TRAILER} ${Buffer.from(receiptBytes).toString("base64url")}\n`;
    const candidateCommit = text(
      cfg,
      ["commit-tree", tree, "-p", base.parentCommit],
      {
        input: message,
        env: {
          GIT_AUTHOR_DATE: base.preparedAt,
          GIT_COMMITTER_DATE: base.preparedAt,
        },
      },
    ).trim();
    if (!HASH.test(candidateCommit))
      throw new Error("invalid candidate commit");
    const record = { ...base, candidateCommit, tree };
    validateCandidate(cfg, record);
    text(cfg, [
      "update-ref",
      `refs/pi-memory/proposals/${base.proposalId}`,
      candidateCommit,
    ]);
    return record;
  } finally {
    rmSync(index, { force: true });
  }
}

function candidateBase(
  cfg: HistoryConfig,
  options: {
    head: string;
    decision: AdmissionDecision;
    changes: CanonicalChange[];
    preparedAt?: string;
  },
): Omit<CandidateRecord, "candidateCommit" | "tree"> {
  if (options.decision.result.type !== "merge-ready")
    throw new Error("admission is not merge-ready");
  if (options.decision.basis.targetHead !== options.head)
    throw new Error("admission target head changed");
  const changes = options.changes.map((change): CandidateChange => {
    canonicalTreePath(change.path);
    if (treeDigest(cfg, options.head, change.path) !== change.beforeSha256)
      throw new Error(`candidate base changed ${change.path}`);
    if (
      (change.afterContent === null) !== (change.afterSha256 === null) ||
      (change.afterContent !== null &&
        sha256(change.afterContent) !== change.afterSha256)
    )
      throw new Error("candidate content binding changed");
    return {
      path: change.path,
      beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256,
      afterArtifact:
        change.afterContent === null
          ? null
          : persistArtifact(cfg, change.afterContent),
    };
  });
  return {
    schemaVersion: 3,
    proposalId: options.decision.proposalId,
    proposalSha256: options.decision.proposalSha256,
    mutationId: options.decision.mutationId,
    parentCommit: options.head,
    preparedAt: options.preparedAt ?? options.decision.evaluatedAt,
    admissionDecisionId: options.decision.decisionId,
    admissionPolicyVersion: options.decision.policyVersion,
    admissionExpiresAt: options.decision.expiresAt,
    admissionSummary: {
      path: options.decision.result.acceptedSummary.relativePath,
      sha256: options.decision.result.acceptedSummary.sha256,
      artifact: options.decision.result.acceptedSummary.artifact,
    },
    evidenceCapsule: {
      path: options.decision.result.evidenceCapsule.relativePath,
      sha256: options.decision.result.evidenceCapsule.sha256,
      artifact: options.decision.result.evidenceCapsule.artifact,
    },
    changes,
  };
}

export function prepareCommit(
  cfg: HistoryConfig,
  options: {
    head: string;
    decision: AdmissionDecision;
    changes: CanonicalChange[];
    preparedAt?: string;
  },
): CandidateRecord {
  initLocalHistory(cfg);
  if (
    !text(cfg, ["rev-parse", "--verify", `${options.head}^{commit}`], {
      tolerate: true,
    }).trim()
  ) {
    fetchCanonicalHead(cfg);
  }
  const record = createCommit(cfg, candidateBase(cfg, options));
  durableWrite(
    candidatePath(cfg, record.proposalId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

export function loadCandidate(
  cfg: HistoryConfig,
  proposalId: string,
): CandidateRecord | undefined {
  const path = candidatePath(cfg, proposalId);
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, "utf8")) as CandidateRecord;
  if (
    record.schemaVersion !== 3 ||
    record.proposalId !== proposalId ||
    !HASH.test(record.candidateCommit) ||
    !HASH.test(record.parentCommit)
  )
    throw new Error("invalid persisted candidate");
  validateCandidate(cfg, record);
  return record;
}

function parseReceipt(message: string): CanonicalReceipt | undefined {
  const lines = message.split("\n").filter((line) => line.startsWith(TRAILER));
  if (lines.length !== 1) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(lines[0]!.slice(TRAILER.length).trim(), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("invalid v3 canonical receipt encoding");
  }
  const record = value as Partial<CanonicalReceipt>;
  if (
    record.schemaVersion !== 3 ||
    typeof record.mutationId !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(record.mutationId) ||
    typeof record.proposalId !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(record.proposalId) ||
    typeof record.proposalSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.proposalSha256) ||
    typeof record.admissionDecisionId !== "string" ||
    !/^adm_[a-f0-9]{32}$/.test(record.admissionDecisionId) ||
    record.admissionPolicyVersion !== ADMISSION_POLICY_VERSION ||
    typeof record.admissionExpiresAt !== "string" ||
    !object(record.admissionSummary) ||
    !object(record.evidenceCapsule) ||
    typeof record.parentCommit !== "string" ||
    !HASH.test(record.parentCommit) ||
    !Array.isArray(record.changes) ||
    record.changes.length < 1 ||
    record.changes.length > 64
  )
    throw new Error("invalid v3 canonical receipt");
  timestamp(record.admissionExpiresAt, "receipt admission expiry");
  const artifact = (
    value: Record<string, unknown>,
    kind: "admissions" | "evidence",
  ): void => {
    if (
      typeof value.path !== "string" ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.path !==
        `.pi-memory/${kind}/sha256/${value.sha256.slice(0, 2)}/${value.sha256}.json`
    )
      throw new Error("invalid v3 canonical artifact binding");
  };
  artifact(record.admissionSummary, "admissions");
  artifact(record.evidenceCapsule, "evidence");
  const paths = new Set<string>();
  for (const change of record.changes) {
    if (
      !object(change) ||
      typeof change.path !== "string" ||
      paths.has(change.path) ||
      (change.beforeSha256 !== null &&
        (typeof change.beforeSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(change.beforeSha256))) ||
      (change.afterSha256 !== null &&
        (typeof change.afterSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(change.afterSha256)))
    )
      throw new Error("invalid v3 canonical change binding");
    canonicalTreePath(change.path);
    paths.add(change.path);
  }
  return record as CanonicalReceipt;
}

function parseJsonArtifact(
  cfg: HistoryConfig,
  commit: string,
  binding: { path: string; sha256: string },
): Record<string, unknown> {
  const bytes = treeContent(cfg, commit, binding.path);
  if (
    !bytes ||
    bytes.length > RESOURCE_LIMITS.maxEvidenceCapsuleBytes ||
    sha256(bytes) !== binding.sha256 ||
    unsafeCanonicalValue(bytes.toString("utf8"))
  )
    throw new Error("unsafe or unbound canonical audit artifact");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid canonical audit json");
  }
  if (!object(value)) throw new Error("invalid canonical audit artifact");
  return value;
}

export function verifyCanonicalCommit(
  cfg: HistoryConfig,
  commit: string,
): CanonicalReceipt | undefined {
  validateTree(cfg, commit);
  const receipt = parseReceipt(
    text(cfg, ["show", "-s", "--format=%B", commit]),
  );
  if (!receipt) return undefined;
  const parents = text(cfg, ["show", "-s", "--format=%P", commit])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 1 || parents[0] !== receipt.parentCommit)
    throw new Error("canonical receipt parent changed");
  const changed = (
    git(
      cfg,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit],
      {
        encoding: "buffer",
      },
    ) as Buffer
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const expected = [
    ...receipt.changes.map((change) => change.path),
    receipt.admissionSummary.path,
    receipt.evidenceCapsule.path,
  ].sort();
  if (changed.join("\0") !== expected.join("\0"))
    throw new Error("canonical commit changed paths outside receipt");
  for (const change of receipt.changes) {
    if (
      treeDigest(cfg, receipt.parentCommit, change.path) !==
        change.beforeSha256 ||
      treeDigest(cfg, commit, change.path) !== change.afterSha256
    )
      throw new Error(`canonical receipt content changed ${change.path}`);
  }
  const summary = parseJsonArtifact(cfg, commit, receipt.admissionSummary);
  const capsule = parseJsonArtifact(
    cfg,
    commit,
    receipt.evidenceCapsule,
  ) as unknown as EvidenceCapsule;
  if (
    summary.schemaVersion !== 1 ||
    summary.decisionId !== receipt.admissionDecisionId ||
    summary.proposalId !== receipt.proposalId ||
    summary.proposalSha256 !== receipt.proposalSha256 ||
    summary.mutationId !== receipt.mutationId ||
    summary.policyVersion !== receipt.admissionPolicyVersion ||
    summary.expiresAt !== receipt.admissionExpiresAt ||
    !object(summary.evidenceCapsule) ||
    summary.evidenceCapsule.relativePath !== receipt.evidenceCapsule.path ||
    summary.evidenceCapsule.sha256 !== receipt.evidenceCapsule.sha256 ||
    capsule.schemaVersion !== 1 ||
    capsule.mutationId !== receipt.mutationId ||
    capsule.proposalId !== receipt.proposalId ||
    capsule.proposalSha256 !== receipt.proposalSha256 ||
    capsule.admission.decisionId !== receipt.admissionDecisionId ||
    capsule.admission.policyVersion !== receipt.admissionPolicyVersion ||
    capsule.admission.expiresAt !== receipt.admissionExpiresAt ||
    canonicalJson(capsule.affectedPaths as unknown as JsonValue) !==
      canonicalJson(receipt.changes as unknown as JsonValue) ||
    !Object.values(capsule.admission.checks).every(
      (outcome) => outcome.result === "pass",
    )
  )
    throw new Error("canonical admission binding changed");
  const evidence = new Map(
    capsule.evidence.map((entry) => [entry.evidenceEntryId, entry]),
  );
  const claimIds = new Set<string>();
  for (const entry of capsule.evidence) {
    if (
      evidence.get(entry.evidenceEntryId) !== entry ||
      sha256(entry.safeBytes) !== entry.safeBytesSha256 ||
      unsafeCanonicalValue(entry.safeBytes) ||
      unsafeCanonicalValue(canonicalJson(entry.source as unknown as JsonValue))
    )
      throw new Error("invalid canonical evidence entry");
  }
  for (const claim of capsule.claims) {
    const target = treeContent(cfg, commit, claim.path);
    if (
      claimIds.has(claim.claimId) ||
      !target ||
      claim.startByte < 0 ||
      claim.endByte <= claim.startByte ||
      claim.endByte > target.length ||
      sha256(target.subarray(claim.startByte, claim.endByte)) !==
        claim.textSha256 ||
      !claim.evidenceEntryIds.length ||
      !claim.evidenceEntryIds.some(
        (id) => evidence.get(id)?.kind === claim.epistemic,
      )
    )
      throw new Error("dead canonical claim mapping");
    claimIds.add(claim.claimId);
  }
  return receipt;
}

export function auditCanonicalHistory(
  cfg: HistoryConfig,
  head: string,
): { verifiedV3: number; legacyUnverified: number } {
  const commits = text(cfg, ["rev-list", "--first-parent", "--reverse", head])
    .split("\n")
    .filter(Boolean);
  let verifiedV3 = 0;
  let legacyUnverified = 0;
  const mutationIds = new Set<string>();
  for (const commit of commits) {
    const receipt = verifyCanonicalCommit(cfg, commit);
    if (!receipt) {
      legacyUnverified += 1;
      continue;
    }
    if (mutationIds.has(receipt.mutationId))
      throw new Error("duplicate mutation in canonical history");
    mutationIds.add(receipt.mutationId);
    verifiedV3 += 1;
  }
  return { verifiedV3, legacyUnverified };
}

export function findCanonicalMutation(
  cfg: HistoryConfig,
  head: string,
  identifier: string,
): { commit: string; receipt: CanonicalReceipt } | undefined {
  const commits = text(cfg, ["rev-list", "--first-parent", head])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const receipt = verifyCanonicalCommit(cfg, commit);
    if (
      receipt &&
      (identifier === commit ||
        identifier === receipt.mutationId ||
        identifier === receipt.proposalId)
    )
      return { commit, receipt };
  }
  return undefined;
}

function validateCandidate(cfg: HistoryConfig, record: CandidateRecord): void {
  const actualTree = text(cfg, [
    "show",
    "-s",
    "--format=%T",
    record.candidateCommit,
  ]).trim();
  const actualParent = text(cfg, [
    "show",
    "-s",
    "--format=%P",
    record.candidateCommit,
  ]).trim();
  const message = text(cfg, [
    "show",
    "-s",
    "--format=%B",
    record.candidateCommit,
  ]);
  const actualReceipt = parseReceipt(message);
  if (
    actualTree !== record.tree ||
    actualParent !== record.parentCommit ||
    canonicalJson(actualReceipt as unknown as JsonValue) !==
      canonicalJson(receipt(record) as unknown as JsonValue)
  )
    throw new Error("candidate commit binding changed");
  validateTree(cfg, record.candidateCommit);
  for (const change of record.changes)
    if (
      treeDigest(cfg, record.candidateCommit, change.path) !==
      change.afterSha256
    )
      throw new Error(`candidate after digest changed ${change.path}`);
  if (
    treeDigest(cfg, record.candidateCommit, record.evidenceCapsule.path) !==
      record.evidenceCapsule.sha256 ||
    treeDigest(cfg, record.candidateCommit, record.admissionSummary.path) !==
      record.admissionSummary.sha256
  )
    throw new Error("candidate admission artifacts changed");
}

function acceptedByMutation(
  cfg: HistoryConfig,
  head: string,
  record: CandidateRecord,
): { commit: string; receipt: CanonicalReceipt } | undefined {
  const commits = text(cfg, ["rev-list", "--first-parent", head])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const found = parseReceipt(
      text(cfg, ["show", "-s", "--format=%B", commit]),
    );
    if (!found || found.mutationId !== record.mutationId) continue;
    if (
      found.proposalId !== record.proposalId ||
      found.proposalSha256 !== record.proposalSha256
    )
      throw new Error("accepted mutation id collision");
    const verified = verifyCanonicalCommit(cfg, commit);
    if (!verified) throw new Error("accepted mutation lacks v3 receipt");
    return { commit, receipt: verified };
  }
  return undefined;
}

const nativeTransport: HistoryTransport = {
  push(cfg, commit) {
    const result = spawnSync(
      "git",
      [
        `--git-dir=${gitDir(cfg)}`,
        "push",
        "origin",
        `${commit}:refs/heads/main`,
      ],
      { encoding: "utf8", env: { ...process.env, ...gitIdentity } },
    );
    if (result.error) return "unknown";
    return result.status === 0 ? "accepted" : "rejected";
  },
};

function rebaseCandidate(
  cfg: HistoryConfig,
  record: CandidateRecord,
  head: string,
): CandidateRecord {
  const rebased = createCommit(cfg, { ...record, parentCommit: head });
  durableWrite(
    candidatePath(cfg, record.proposalId),
    `${JSON.stringify(rebased, null, 2)}\n`,
  );
  return rebased;
}

function persistAcceptedReceipt(
  cfg: HistoryConfig,
  commit: string,
  acceptedReceipt: CanonicalReceipt,
): void {
  const value = `${JSON.stringify({ commit, receipt: acceptedReceipt }, null, 2)}\n`;
  const path = acceptedReceiptPath(cfg, acceptedReceipt.mutationId);
  if (!durableCreate(path, value) && readFileSync(path, "utf8") !== value)
    throw new Error("accepted receipt collision");
}

function finalizeCandidate(cfg: HistoryConfig, proposalId: string): void {
  durableRemove(candidatePath(cfg, proposalId));
  text(cfg, ["update-ref", "-d", `refs/pi-memory/proposals/${proposalId}`], {
    tolerate: true,
  });
}

function copyCanonicalTree(
  cfg: HistoryConfig,
  head: string,
  destination: string,
): void {
  const output = git(cfg, ["ls-tree", "-rz", head], {
    encoding: "buffer",
  }) as Buffer;
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^100644 blob [a-f0-9]+\t(.+)$/.exec(record);
    if (!match) throw new Error("invalid canonical tree entry");
    const path = canonicalTreePath(match[1]!);
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, treeContent(cfg, head, path)!, { mode: 0o600 });
  }
}

function verifyMaterializedTree(
  cfg: HistoryConfig,
  head: string,
  root: string,
): boolean {
  const actual: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("materialized tree has symlink");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        actual.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error("materialized tree has special file");
    }
  };
  walk(root);
  const expected = (
    git(cfg, ["ls-tree", "-rz", "--name-only", head], {
      encoding: "buffer",
    }) as Buffer
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  if (actual.sort().join("\0") !== expected.join("\0")) return false;
  return expected.every(
    (path) =>
      sha256(readFileSync(join(root, path))) === treeDigest(cfg, head, path),
  );
}

type MaterializationJournal = {
  schemaVersion: 3;
  head: string;
  staging: string;
  backup: string;
  phase: "prepared" | "prior-moved" | "installed";
};

export type MaterializationCrashPoint =
  | "after-journal"
  | "after-prior-moved"
  | "after-installed"
  | "after-checkout-state";

function recoverMaterialization(cfg: HistoryConfig): void {
  const path = v3State(cfg, "checkout/materializing.json");
  if (!existsSync(path)) return;
  const value = JSON.parse(
    readFileSync(path, "utf8"),
  ) as MaterializationJournal;
  const rootParent = dirname(cfg.root);
  if (
    value.schemaVersion !== 3 ||
    !HASH.test(value.head) ||
    dirname(value.staging) !== rootParent ||
    dirname(value.backup) !== rootParent ||
    !value.staging.startsWith(join(rootParent, ".pi-memory-checkout-")) ||
    !value.backup.startsWith(join(rootParent, ".pi-memory-checkout-backup-"))
  )
    throw new Error("invalid materialization journal");
  if (
    existsSync(cfg.root) &&
    verifyMaterializedTree(cfg, value.head, cfg.root)
  ) {
    durableWrite(
      v3State(cfg, "checkout/current.json"),
      `${JSON.stringify({ schemaVersion: 3, head: value.head, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } else if (existsSync(value.backup)) {
    rmSync(cfg.root, { recursive: true, force: true });
    renameSync(value.backup, cfg.root);
  } else if (!existsSync(cfg.root)) {
    throw new Error("interrupted materialization has no recoverable checkout");
  }
  rmSync(value.staging, { recursive: true, force: true });
  rmSync(value.backup, { recursive: true, force: true });
  durableRemove(path);
}

function materializeCanonicalHeadImpl(
  cfg: HistoryConfig,
  head: string,
  fault?: (point: MaterializationCrashPoint) => void,
): boolean {
  validateTree(cfg, head);
  mkdirSync(dirname(cfg.root), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(cfg.root), ".pi-memory-checkout-"));
  const backup = join(
    dirname(cfg.root),
    `.pi-memory-checkout-backup-${process.pid}-${Date.now()}`,
  );
  try {
    copyCanonicalTree(cfg, head, staging);
    try {
      withDirectoryLock(v3State(cfg, "checkout/lock"), () => {
        recoverMaterialization(cfg);
        const journalPath = v3State(cfg, "checkout/materializing.json");
        const persistJournal = (phase: MaterializationJournal["phase"]): void =>
          durableWrite(
            journalPath,
            `${JSON.stringify({ schemaVersion: 3, head, staging, backup, phase } satisfies MaterializationJournal, null, 2)}\n`,
          );
        persistJournal("prepared");
        fault?.("after-journal");
        if (existsSync(cfg.root)) {
          if (lstatSync(cfg.root).isSymbolicLink())
            throw new Error("canonical root cannot be a symlink");
          chmodSync(cfg.root, 0o700);
          renameSync(cfg.root, backup);
          persistJournal("prior-moved");
          fault?.("after-prior-moved");
        }
        renameSync(staging, cfg.root);
        persistJournal("installed");
        fault?.("after-installed");
        if (!verifyMaterializedTree(cfg, head, cfg.root))
          throw new Error("materialized canonical tree did not verify");
        durableWrite(
          v3State(cfg, "checkout/current.json"),
          `${JSON.stringify({ schemaVersion: 3, head, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
        );
        fault?.("after-checkout-state");
        durableRemove(journalPath);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "lock-contended")
        return false;
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function materializeCanonicalHead(
  cfg: HistoryConfig,
  head: string,
  fault?: (point: MaterializationCrashPoint) => void,
): boolean {
  return observeMemoryOperation(
    {
      operation: "memory.checkout-materialize",
      correlation: { canonicalHead: head },
      result: (materialized) => ({
        outcome: materialized ? "success" : "degraded",
        fields: { canonicalHead: head, materialized },
      }),
    },
    () => materializeCanonicalHeadImpl(cfg, head, fault),
  );
}

function mergeCommitImpl(
  cfg: HistoryConfig,
  initial: CandidateRecord,
  transport: HistoryTransport = nativeTransport,
): MergeOutcome {
  let head: string;
  try {
    head = fetchCanonicalHead(cfg);
  } catch {
    return { type: "retry", reason: "remote-unavailable" };
  }
  const accepted = acceptedByMutation(cfg, head, initial);
  if (accepted) {
    persistAcceptedReceipt(cfg, accepted.commit, accepted.receipt);
    finalizeCandidate(cfg, initial.proposalId);
    return {
      type: "accepted",
      commit: accepted.commit,
      mutationId: initial.mutationId,
      idempotent: true,
      materialized: materializeCanonicalHead(cfg, head),
    };
  }
  if (Date.now() >= Date.parse(initial.admissionExpiresAt))
    return { type: "closed", reason: "admission-expired" };
  const conflicts: string[] = [];
  for (const change of initial.changes) {
    const observed = treeDigest(cfg, head, change.path);
    if (observed !== change.beforeSha256 && observed !== change.afterSha256)
      conflicts.push(change.path);
  }
  if (conflicts.length)
    return { type: "basis-changed", head, paths: conflicts.sort() };
  const record =
    initial.parentCommit === head
      ? initial
      : rebaseCandidate(cfg, initial, head);
  validateCandidate(cfg, record);
  const pushed = transport.push(cfg, record.candidateCommit);
  if (pushed === "unknown")
    return { type: "retry", reason: "push-result-unknown" };
  if (pushed === "rejected") return { type: "retry", reason: "remote-race" };
  let acceptedHead: string;
  try {
    acceptedHead = fetchCanonicalHead(cfg);
  } catch {
    return { type: "retry", reason: "push-result-unknown" };
  }
  if (acceptedHead !== record.candidateCommit)
    return { type: "retry", reason: "remote-race" };
  const acceptedReceipt = verifyCanonicalCommit(cfg, acceptedHead);
  if (!acceptedReceipt)
    throw new Error("accepted candidate lacks canonical receipt");
  persistAcceptedReceipt(cfg, acceptedHead, acceptedReceipt);
  finalizeCandidate(cfg, record.proposalId);
  return {
    type: "accepted",
    commit: acceptedHead,
    mutationId: record.mutationId,
    idempotent: false,
    materialized: materializeCanonicalHead(cfg, acceptedHead),
  };
}

export function mergeCommit(
  cfg: HistoryConfig,
  initial: CandidateRecord,
  transport: HistoryTransport = nativeTransport,
): MergeOutcome {
  return observeMemoryOperation(
    {
      operation: "memory.canonical-merge",
      correlation: {
        proposalId: initial.proposalId,
        mutationId: initial.mutationId,
      },
      fields: {
        preparedBase: initial.parentCommit,
        candidateCommit: initial.candidateCommit,
        admissionDecisionId: initial.admissionDecisionId,
      },
      result: (outcome) => ({
        outcome:
          outcome.type === "accepted"
            ? "success"
            : outcome.type === "retry"
              ? "degraded"
              : "degraded",
        fields: {
          mergeOutcome: outcome.type,
          acceptedRemoteHead:
            outcome.type === "accepted" ? outcome.commit : undefined,
          retryReason: outcome.type === "retry" ? outcome.reason : undefined,
          blockedPaths:
            outcome.type === "basis-changed" ? outcome.paths : undefined,
        },
      }),
    },
    () => mergeCommitImpl(cfg, initial, transport),
  );
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { tmpdir } = await import("node:os");
  const { evaluateAdmission } = await import("./admission.js");
  const { withMemoryWideEventFactory } = await import("../observability.js");

  function command(args: string[], cwd?: string): string {
    const result = spawnSync(
      "git",
      ["-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...gitIdentity },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  function fixture() {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-history-v3-"));
    const remote = join(base, "remote.git");
    const seed = join(base, "seed");
    command(["init", "--bare", "--initial-branch=main", remote]);
    command(["init", "--initial-branch=main", seed]);
    writeFileSync(join(seed, "baseline_source__agent.md"), "# baseline\n");
    command(["add", "baseline_source__agent.md"], seed);
    command(["commit", "-m", "baseline"], seed);
    command(["remote", "add", "origin", remote], seed);
    command(["push", "origin", "main"], seed);
    const host = (name: string): HistoryConfig => ({
      data: join(base, name, "data"),
      state: join(base, name, "state"),
      root: join(base, name, "memory"),
      remote,
    });
    return { base, remote, host };
  }

  function admitted(
    cfg: HistoryConfig,
    head: string,
    name: string,
    content: string,
    pathName = name,
  ) {
    const path = `${pathName}_source__agent.md`;
    const safeBytes = `the user requested ${name}`;
    const evaluatedAt = "2026-09-03T12:00:00.000Z";
    const change: CanonicalChange = {
      path,
      beforeSha256: null,
      afterContent: content,
      afterSha256: sha256(content),
    };
    const decision = evaluateAdmission(cfg, {
      proposalId: `prop_${name}`,
      proposalSha256: sha256(`proposal-${name}`),
      mutationId: `mut_${name}`,
      actor: "test",
      evaluatedAt,
      expiresAt: "2026-10-03T12:00:00.000Z",
      basis: {
        hostLocalSourceEvidence: [],
        catalogSha256: sha256("catalog"),
        targetHead: head,
        promptPolicyVersion: 1,
        modelPolicyVersion: 1,
      },
      changes: [change],
      claims: [
        {
          claimId: `claim_${name}`,
          path,
          startByte: 0,
          endByte: Buffer.byteLength(content),
          textSha256: sha256(content),
          epistemic: "user-statement",
          evidenceEntryIds: [`evidence_${name}`],
        },
      ],
      evidence: [
        {
          evidenceEntryId: `evidence_${name}`,
          kind: "user-statement",
          representation: "exact-excerpt",
          safeBytes,
          safeBytesSha256: sha256(safeBytes),
          source: {
            kind: "pi-session-jsonl",
            identity: `session-${name}`,
            observedAt: evaluatedAt,
            workspace: "/workspace",
            locator: `pi://session-${name}/checkpoint`,
          },
          safetyTransformationVersion: 1,
        },
      ],
    });
    return { decision, change };
  }

  describe("v3 canonical history", () => {
    it("serializes disjoint host candidates and materializes only accepted heads", () => {
      const test = fixture();
      const hostA = test.host("a");
      const hostB = test.host("b");
      const head = fetchCanonicalHead(hostA);
      expect(fetchCanonicalHead(hostB)).toBe(head);
      const a = admitted(hostA, head, "alpha", "# alpha\n");
      const b = admitted(hostB, head, "beta", "# beta\n");
      const candidateA = prepareCommit(hostA, {
        head,
        decision: a.decision,
        changes: [a.change],
      });
      const candidateB = prepareCommit(hostB, {
        head,
        decision: b.decision,
        changes: [b.change],
      });
      expect(existsSync(hostA.root)).toBe(false);
      expect(existsSync(hostB.root)).toBe(false);
      expect(mergeCommit(hostA, candidateA).type).toBe("accepted");
      expect(mergeCommit(hostB, candidateB).type).toBe("accepted");
      const remoteHead = fetchCanonicalHead(hostA);
      expect(text(hostA, ["rev-list", "--count", remoteHead]).trim()).toBe("3");
      expect(
        readFileSync(join(hostB.root, "alpha_source__agent.md"), "utf8"),
      ).toBe("# alpha\n");
      expect(
        readFileSync(join(hostB.root, "beta_source__agent.md"), "utf8"),
      ).toBe("# beta\n");
      expect(candidateA.candidateCommit).not.toBe(candidateB.candidateCommit);
    });

    it("emits one merge and one checkout terminal for an accepted mutation", () => {
      const test = fixture();
      const host = test.host("observed");
      const head = fetchCanonicalHead(host);
      const proposal = admitted(host, head, "observed", "# observed\n");
      const candidate = prepareCommit(host, {
        head,
        decision: proposal.decision,
        changes: [proposal.change],
      });
      const events: Array<{
        operation: string;
        terminals: Array<{ outcome: string; fields: unknown }>;
      }> = [];
      const result = withMemoryWideEventFactory(
        (options) => {
          const event: (typeof events)[number] = {
            operation: options.operation,
            terminals: [],
          };
          events.push(event);
          return {
            id: `history-observation-${events.length}`,
            set: () => {},
            error: () => {},
            finish: (outcome, fields) =>
              event.terminals.push({ outcome, fields }),
          };
        },
        () => mergeCommit(host, candidate),
      );

      expect(result.type).toBe("accepted");
      expect(events.map((event) => event.operation)).toEqual([
        "memory.canonical-merge",
        "memory.checkout-materialize",
      ]);
      expect(events.every((event) => event.terminals.length === 1)).toBe(true);
      expect(events.map((event) => event.terminals[0]?.outcome)).toEqual([
        "success",
        "success",
      ]);
    });

    it("blocks changed targets without mutating the checkout", () => {
      const test = fixture();
      const firstHost = test.host("first");
      const secondHost = test.host("second");
      const head = fetchCanonicalHead(firstHost);
      const first = admitted(firstHost, head, "first", "# first\n", "same");
      const second = admitted(secondHost, head, "second", "# second\n", "same");
      const firstCandidate = prepareCommit(firstHost, {
        head,
        decision: first.decision,
        changes: [first.change],
      });
      const secondCandidate = prepareCommit(secondHost, {
        head,
        decision: second.decision,
        changes: [second.change],
      });
      expect(mergeCommit(firstHost, firstCandidate).type).toBe("accepted");
      expect(mergeCommit(secondHost, secondCandidate)).toMatchObject({
        type: "basis-changed",
        paths: ["same_source__agent.md"],
      });
      expect(existsSync(secondHost.root)).toBe(false);
    });

    it("recovers a lost push response by immutable mutation receipt", () => {
      const test = fixture();
      const host = test.host("lost");
      const head = fetchCanonicalHead(host);
      const proposal = admitted(host, head, "lost", "# lost\n");
      const candidate = prepareCommit(host, {
        head,
        decision: proposal.decision,
        changes: [proposal.change],
      });
      const transport: HistoryTransport = {
        push(cfg, commit) {
          nativeTransport.push(cfg, commit);
          return "unknown";
        },
      };
      expect(mergeCommit(host, candidate, transport)).toEqual({
        type: "retry",
        reason: "push-result-unknown",
      });
      expect(existsSync(host.root)).toBe(false);
      expect(mergeCommit(host, candidate)).toMatchObject({
        type: "accepted",
        idempotent: true,
      });
      expect(
        readFileSync(join(host.root, "lost_source__agent.md"), "utf8"),
      ).toBe("# lost\n");
    });

    it("keeps the last checkout usable during a remote outage", () => {
      const test = fixture();
      const host = test.host("offline");
      const head = fetchCanonicalHead(host);
      materializeCanonicalHead(host, head);
      rmSync(test.remote, { recursive: true });
      const fake: CandidateRecord = {
        schemaVersion: 3,
        proposalId: "prop_offline",
        proposalSha256: sha256("offline"),
        mutationId: "mut_offline",
        parentCommit: head,
        candidateCommit: head,
        tree: text(host, ["show", "-s", "--format=%T", head]).trim(),
        preparedAt: "2026-09-03T12:00:00.000Z",
        admissionDecisionId: "adm_offline",
        admissionPolicyVersion: ADMISSION_POLICY_VERSION,
        admissionExpiresAt: "2026-10-03T12:00:00.000Z",
        admissionSummary: {
          path: ".pi-memory/admissions/sha256/aa/" + "a".repeat(64) + ".json",
          sha256: "a".repeat(64),
          artifact: {
            relativePath: "missing",
            sha256: "a".repeat(64),
            bytes: 1,
          },
        },
        evidenceCapsule: {
          path: ".pi-memory/evidence/sha256/bb/" + "b".repeat(64) + ".json",
          sha256: "b".repeat(64),
          artifact: {
            relativePath: "missing",
            sha256: "b".repeat(64),
            bytes: 1,
          },
        },
        changes: [],
      };
      expect(mergeCommit(host, fake)).toEqual({
        type: "retry",
        reason: "remote-unavailable",
      });
      expect(
        readFileSync(join(host.root, "baseline_source__agent.md"), "utf8"),
      ).toBe("# baseline\n");
    });

    it("returns a deterministic retry for a simultaneous push race", () => {
      const test = fixture();
      const hostA = test.host("race-a");
      const hostB = test.host("race-b");
      const head = fetchCanonicalHead(hostA);
      fetchCanonicalHead(hostB);
      const a = admitted(hostA, head, "race_a", "# race a\n");
      const b = admitted(hostB, head, "race_b", "# race b\n");
      const candidateA = prepareCommit(hostA, {
        head,
        decision: a.decision,
        changes: [a.change],
      });
      const candidateB = prepareCommit(hostB, {
        head,
        decision: b.decision,
        changes: [b.change],
      });
      const racingTransport: HistoryTransport = {
        push(cfg, commit) {
          expect(nativeTransport.push(hostA, candidateA.candidateCommit)).toBe(
            "accepted",
          );
          return nativeTransport.push(cfg, commit);
        },
      };
      expect(mergeCommit(hostB, candidateB, racingTransport)).toEqual({
        type: "retry",
        reason: "remote-race",
      });
      expect(mergeCommit(hostB, candidateB)).toMatchObject({
        type: "accepted",
        idempotent: false,
      });
      expect(auditCanonicalHistory(hostB, fetchCanonicalHead(hostB))).toEqual({
        verifiedV3: 2,
        legacyUnverified: 1,
      });
    });

    it("recovers the accepted rebased receipt after a lost response", () => {
      const test = fixture();
      const hostA = test.host("rebase-a");
      const hostB = test.host("rebase-b");
      const head = fetchCanonicalHead(hostA);
      fetchCanonicalHead(hostB);
      const a = admitted(hostA, head, "rebase_a", "# rebase a\n");
      const b = admitted(hostB, head, "rebase_b", "# rebase b\n");
      const candidateA = prepareCommit(hostA, {
        head,
        decision: a.decision,
        changes: [a.change],
      });
      const candidateB = prepareCommit(hostB, {
        head,
        decision: b.decision,
        changes: [b.change],
      });
      const acceptedA = mergeCommit(hostA, candidateA);
      expect(acceptedA.type).toBe("accepted");
      const unknown: HistoryTransport = {
        push(cfg, commit) {
          expect(nativeTransport.push(cfg, commit)).toBe("accepted");
          return "unknown";
        },
      };
      expect(mergeCommit(hostB, candidateB, unknown)).toEqual({
        type: "retry",
        reason: "push-result-unknown",
      });
      const recovered = mergeCommit(hostB, candidateB);
      expect(recovered).toMatchObject({ type: "accepted", idempotent: true });
      if (recovered.type !== "accepted" || acceptedA.type !== "accepted")
        return;
      const cached = JSON.parse(
        readFileSync(acceptedReceiptPath(hostB, candidateB.mutationId), "utf8"),
      ) as { receipt: CanonicalReceipt };
      expect(cached.receipt.parentCommit).toBe(acceptedA.commit);
      expect(cached.receipt.parentCommit).not.toBe(candidateB.parentCommit);
    });

    it("audits claim-bearing evidence from a fresh clone without local artifacts", () => {
      const test = fixture();
      const writer = test.host("audit-writer");
      const head = fetchCanonicalHead(writer);
      const proposal = admitted(writer, head, "audited", "# audited\n");
      const candidate = prepareCommit(writer, {
        head,
        decision: proposal.decision,
        changes: [proposal.change],
      });
      expect(mergeCommit(writer, candidate).type).toBe("accepted");
      rmSync(writer.data, { recursive: true, force: true });

      const fresh = test.host("fresh-clone");
      const acceptedHead = fetchCanonicalHead(fresh);
      expect(auditCanonicalHistory(fresh, acceptedHead)).toEqual({
        verifiedV3: 1,
        legacyUnverified: 1,
      });
      expect(materializeCanonicalHead(fresh, acceptedHead)).toBe(true);
      expect(existsSync(join(fresh.root, ".pi-memory/evidence"))).toBe(true);
    });

    it.each<MaterializationCrashPoint>([
      "after-journal",
      "after-prior-moved",
      "after-installed",
      "after-checkout-state",
    ])("converges after materialization crash point %s", (crashPoint) => {
      const test = fixture();
      const writer = test.host("materialize-writer");
      const victim = test.host("materialize-victim");
      const baseline = fetchCanonicalHead(writer);
      fetchCanonicalHead(victim);
      materializeCanonicalHead(victim, baseline);
      const proposal = admitted(writer, baseline, "materialized", "# final\n");
      const candidate = prepareCommit(writer, {
        head: baseline,
        decision: proposal.decision,
        changes: [proposal.change],
      });
      const accepted = mergeCommit(writer, candidate);
      expect(accepted.type).toBe("accepted");
      if (accepted.type !== "accepted") return;
      fetchCanonicalHead(victim);
      expect(() =>
        materializeCanonicalHead(victim, accepted.commit, (point) => {
          if (point === crashPoint)
            throw new Error("injected materialization crash");
        }),
      ).toThrow("injected materialization crash");
      expect(materializeCanonicalHead(victim, accepted.commit)).toBe(true);
      expect(
        readFileSync(
          join(victim.root, "materialized_source__agent.md"),
          "utf8",
        ),
      ).toBe("# final\n");
      expect(verifyMaterializedTree(victim, accepted.commit, victim.root)).toBe(
        true,
      );
    });
  });
}
