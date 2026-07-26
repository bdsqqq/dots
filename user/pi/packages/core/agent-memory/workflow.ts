import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  atomicWrite,
  contained,
  scanCatalog,
  secureDir,
  sha256,
  writeCatalog,
  type Catalog,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import {
  REVIEW_REASON_CODES,
  memoryRef,
  proposalFileName,
  renderMemory,
  type EvidenceRef,
  type MemoryArtifact,
  type MemoryOperation,
  type ModelProposal,
  type Proposal,
  type ReviewReasonCode,
  type ReviewReceipt,
  type SkillDraftOperation,
} from "./schema.js";

const V2 = "v2";
const PROMPT_VERSION = 2;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function v2(cfg: MemoryConfig, ...parts: string[]): string {
  return contained(cfg.data, join(cfg.data, V2, ...parts));
}

function exclusive(path: string, value: string): void {
  secureDir(dirname(path));
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function ensureWorkflowDirs(cfg: MemoryConfig): void {
  for (const path of [
    v2(cfg, "proposals/pending"),
    v2(cfg, "proposals/reviewed"),
    v2(cfg, "reviews"),
    v2(cfg, "transactions"),
    v2(cfg, "artifacts"),
    v2(cfg, "approved-skills"),
    v2(cfg, "runs"),
    v2(cfg, "ledger"),
    v2(cfg, "eval/replays"),
  ])
    secureDir(path);
}

function proposalPath(
  cfg: MemoryConfig,
  proposal: Proposal,
  status = "pending",
): string {
  return v2(cfg, `proposals/${status}`, proposalFileName(proposal));
}

export function saveProposal(cfg: MemoryConfig, proposal: Proposal): string {
  ensureWorkflowDirs(cfg);
  const path = proposalPath(cfg, proposal);
  const value = `${JSON.stringify(proposal, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value)
      throw new Error(`proposal collision ${proposal.id}`);
  } else exclusive(path, value);
  return path;
}

export function listProposals(
  cfg: MemoryConfig,
  lane?: "memory" | "skill",
  status: "pending" | "reviewed" = "pending",
): Proposal[] {
  ensureWorkflowDirs(cfg);
  const dir = v2(cfg, `proposals/${status}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseStoredProposal(readFileSync(join(dir, name), "utf8")))
    .filter((proposal) => lane === undefined || proposal.lane === lane);
}

export function findProposal(
  cfg: MemoryConfig,
  id: string,
): { proposal: Proposal; path: string } {
  const matches: Array<{ proposal: Proposal; path: string }> = [];
  for (const status of ["pending", "reviewed"] as const) {
    const dir = v2(cfg, `proposals/${status}`);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((item) =>
      item.endsWith(".json"),
    )) {
      const path = join(dir, name);
      const proposal = parseStoredProposal(readFileSync(path, "utf8"));
      if (proposal.id === id || proposal.id.startsWith(id))
        matches.push({ proposal, path });
    }
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length ? "ambiguous proposal id" : "proposal not found",
    );
  return matches[0]!;
}

export function parseStoredProposal(raw: string): Proposal {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    value.version !== 2 ||
    typeof value.id !== "string" ||
    (value.lane !== "memory" && value.lane !== "skill") ||
    value.status !== "pending" ||
    !object(value.operation) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.supersedes) ||
    !object(value.provenance)
  )
    throw new Error("invalid stored proposal");
  if (value.operation.type === "skill-draft" && value.lane !== "skill")
    throw new Error("proposal lane mismatch");
  if (value.operation.type !== "skill-draft" && value.lane !== "memory")
    throw new Error("proposal lane mismatch");
  return value as Proposal;
}

function target(targets: Map<string, CatalogEntry>, id: string): CatalogEntry {
  const entry = targets.get(id);
  if (!entry) throw new Error(`proposal references unavailable memory ${id}`);
  return entry;
}

function completeArtifact(
  artifact: Omit<
    MemoryArtifact,
    "memoryId" | "sources" | "created" | "updated"
  >,
  memoryId: string,
  evidence: EvidenceRef[],
  createdAt: string,
): MemoryArtifact {
  const day = createdAt.slice(0, 10);
  return {
    ...artifact,
    memoryId,
    sources: evidence.flatMap((item) =>
      item.checkpointEntryIds.map(
        (checkpoint) => `pi://${item.sessionId}/${checkpoint}`,
      ),
    ),
    created: day,
    updated: day,
  };
}

export function materializeModelProposals(options: {
  result: Extract<ModelProposal, { action: "propose" }>;
  runId: string;
  model: string;
  evidence: EvidenceRef[];
  catalog: Catalog;
  pending: Proposal[];
  createdAt?: string;
}): Proposal[] {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const targets = new Map(
    options.catalog.entries.map((entry) => [entry.memoryId, entry]),
  );
  const pendingIds = new Set(options.pending.map((item) => item.id));
  let skillCount = 0;
  return options.result.proposals.map((draft, index) => {
    let operation: MemoryOperation | SkillDraftOperation;
    if (draft.lane === "skill") {
      skillCount += 1;
      if (skillCount > 2) throw new Error("too many skill proposals");
      if (new Set(options.evidence.map((item) => item.sessionId)).size < 2)
        throw new Error("skill proposal requires two sessions");
      operation = draft.operation;
    } else {
      const op = draft.operation;
      const seed = sha256(`${options.runId}:${index}:${JSON.stringify(op)}`);
      if (op.type === "create")
        operation = {
          type: "create",
          artifact: completeArtifact(
            op.artifact,
            `mem_${seed.slice(0, 24)}`,
            options.evidence,
            createdAt,
          ),
        };
      else if (op.type === "update") {
        const current = target(targets, op.targetId);
        operation = {
          type: "update",
          target: memoryRef(current),
          artifact: completeArtifact(
            op.artifact,
            current.memoryId,
            options.evidence,
            createdAt,
          ),
        };
      } else if (op.type === "merge") {
        const primary = target(targets, op.primaryId);
        const mergeTargets = [...new Set(op.targetIds)]
          .filter((id) => id !== op.primaryId)
          .map((id) => memoryRef(target(targets, id)));
        if (mergeTargets.length < 1)
          throw new Error("merge requires another target");
        operation = {
          type: "merge",
          primary: memoryRef(primary),
          targets: mergeTargets,
          artifact: completeArtifact(
            op.artifact,
            primary.memoryId,
            options.evidence,
            createdAt,
          ),
        };
      } else {
        const current = target(targets, op.targetId);
        operation = {
          type: op.type,
          target: memoryRef(current),
          reason: op.reason,
          ...(op.type === "retire" && op.supersededBy
            ? { supersededBy: op.supersededBy }
            : {}),
        } as MemoryOperation;
      }
    }
    const canonical = JSON.stringify({
      operation,
      evidence: options.evidence,
      runId: options.runId,
    });
    return {
      version: 2,
      id: `prop_${sha256(canonical).slice(0, 32)}`,
      lane: draft.lane,
      status: "pending",
      operation,
      supersedes: options.pending
        .filter(
          (item) =>
            pendingIds.has(item.id) &&
            JSON.stringify(item.operation) === JSON.stringify(operation),
        )
        .map((item) => item.id),
      evidence: options.evidence,
      provenance: {
        runId: options.runId,
        promptVersion: PROMPT_VERSION,
        model: options.model,
        createdAt,
        corpusAware: true,
      },
    };
  });
}

function artifactSlug(artifact: MemoryArtifact): string {
  return (
    artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70) || "memory"
  );
}

function activePath(cfg: MemoryConfig, artifact: MemoryArtifact): string {
  return contained(
    cfg.root,
    join(
      cfg.root,
      `${artifact.created}-${artifactSlug(artifact)}-${artifact.memoryId.slice(-10)}--source__agent.md`,
    ),
  );
}

function currentTarget(
  cfg: MemoryConfig,
  ref: { path: string; sha256: string },
): string {
  const path = contained(cfg.root, join(cfg.root, ref.path));
  if (!existsSync(path) || sha256(readFileSync(path)) !== ref.sha256)
    throw new Error(`stale memory target ${ref.path}`);
  return path;
}

function existingCreated(text: string, fallback: string): string {
  const match = /^created:\s*(.+)$/m.exec(text)?.[1];
  if (!match) return fallback;
  try {
    const parsed: unknown = JSON.parse(match);
    return typeof parsed === "string" ? parsed : fallback;
  } catch {
    return match.replace(/^['"]|['"]$/g, "");
  }
}

function existingSources(text: string): string[] {
  const raw = /^sources:\s*(.+)$/m.exec(text)?.[1];
  if (!raw) {
    const source = /^source:\s*(.+)$/m.exec(text)?.[1]?.trim();
    return source ? [source.replace(/^['"]|['"]$/g, "")] : [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

type TransactionAction = {
  from?: string;
  to: string;
  before?: string;
  after: string;
};
type Transaction = {
  version: 1;
  id: string;
  reviewId: string;
  state: "prepared" | "applied" | "rolled-back";
  actions: TransactionAction[];
};

function archivedPath(
  cfg: MemoryConfig,
  source: string,
  status: "archived" | "retired",
): string {
  return contained(
    cfg.root,
    join(cfg.root, ".archive", status, basename(source)),
  );
}

function withStatus(
  text: string,
  status: "archived" | "retired",
  reviewId: string,
): string {
  let result = text;
  if (/^status:/m.test(result))
    result = result.replace(
      /^status:.*$/m,
      `status: ${JSON.stringify(status)}`,
    );
  else
    result = result.replace(
      /^---\n/,
      `---\nstatus: ${JSON.stringify(status)}\n`,
    );
  if (/^review_id:/m.test(result))
    result = result.replace(
      /^review_id:.*$/m,
      `review_id: ${JSON.stringify(reviewId)}`,
    );
  return result;
}

function actionsFor(
  cfg: MemoryConfig,
  operation: MemoryOperation,
  reviewId: string,
): TransactionAction[] {
  if (operation.type === "create") {
    const to = activePath(cfg, operation.artifact);
    if (existsSync(to)) throw new Error("memory destination exists");
    return [{ to, after: renderMemory(operation.artifact, reviewId) }];
  }
  if (operation.type === "update") {
    const from = currentTarget(cfg, operation.target);
    const before = readFileSync(from, "utf8");
    const artifact = {
      ...operation.artifact,
      created: existingCreated(before, operation.artifact.created),
      sources: [
        ...new Set([...existingSources(before), ...operation.artifact.sources]),
      ],
    };
    return [
      { from, to: from, before, after: renderMemory(artifact, reviewId) },
    ];
  }
  if (operation.type === "merge") {
    const primary = currentTarget(cfg, operation.primary);
    const before = readFileSync(primary, "utf8");
    const all = [operation.primary, ...operation.targets];
    const sources = all.flatMap((ref) =>
      existingSources(readFileSync(currentTarget(cfg, ref), "utf8")),
    );
    const actions: TransactionAction[] = [
      {
        from: primary,
        to: primary,
        before,
        after: renderMemory(
          {
            ...operation.artifact,
            created: existingCreated(before, operation.artifact.created),
            sources: [...new Set([...sources, ...operation.artifact.sources])],
          },
          reviewId,
        ),
      },
    ];
    for (const ref of operation.targets) {
      const from = currentTarget(cfg, ref);
      const old = readFileSync(from, "utf8");
      actions.push({
        from,
        to: archivedPath(cfg, from, "retired"),
        before: old,
        after: withStatus(old, "retired", reviewId),
      });
    }
    return actions;
  }
  const from = currentTarget(cfg, operation.target);
  const before = readFileSync(from, "utf8");
  const status = operation.type === "archive" ? "archived" : "retired";
  return [
    {
      from,
      to: archivedPath(cfg, from, status),
      before,
      after: withStatus(before, status, reviewId),
    },
  ];
}

function applyTransaction(cfg: MemoryConfig, transaction: Transaction): void {
  const path = v2(cfg, "transactions", `${transaction.id}.json`);
  atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
  const completed: TransactionAction[] = [];
  try {
    for (const action of transaction.actions) {
      if (action.from && action.from !== action.to && existsSync(action.from))
        rmSync(action.from);
      atomicWrite(action.to, action.after);
      completed.push(action);
    }
    transaction.state = "applied";
    atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
  } catch (error) {
    for (const action of completed.reverse()) {
      if (existsSync(action.to)) rmSync(action.to);
      if (action.from && action.before !== undefined)
        atomicWrite(action.from, action.before);
    }
    transaction.state = "rolled-back";
    atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
    throw error;
  }
}

function finalArtifacts(
  transaction: Transaction,
): ReviewReceipt["finalArtifacts"] {
  return transaction.actions.map((action) => ({
    path: action.to,
    sha256: sha256(action.after),
    status: action.to.includes("/.archive/archived/")
      ? "archived"
      : action.to.includes("/.archive/retired/")
        ? "retired"
        : "active",
  }));
}

export function reviewProposal(options: {
  cfg: MemoryConfig;
  id: string;
  decision: "accept" | "reject";
  reasonCode: ReviewReasonCode;
  reason: string;
  editPath?: string;
}): ReviewReceipt {
  if (
    !REVIEW_REASON_CODES.includes(options.reasonCode) ||
    !options.reason.trim()
  )
    throw new Error("review requires a valid reason code and non-empty reason");
  const found = findProposal(options.cfg, options.id);
  if (!found.path.includes("/pending/"))
    throw new Error("proposal already reviewed");
  const originalRaw = readFileSync(found.path, "utf8");
  let proposal = found.proposal;
  let editedHash: string | undefined;
  if (options.editPath) {
    const editedRaw = readFileSync(resolve(options.editPath), "utf8");
    const edited = parseStoredProposal(editedRaw);
    if (edited.id !== proposal.id || edited.lane !== proposal.lane)
      throw new Error("edited proposal changes identity or lane");
    proposal = edited;
    editedHash = sha256(editedRaw);
  }
  const reviewedAt = new Date().toISOString();
  const reviewId = `review_${sha256(`${proposal.id}:${reviewedAt}:${options.reason}`).slice(0, 24)}`;
  let transaction: Transaction | undefined;
  let finals: ReviewReceipt["finalArtifacts"] = [];
  if (options.decision === "accept" && proposal.lane === "memory") {
    transaction = {
      version: 1,
      id: `tx_${sha256(`${reviewId}:${JSON.stringify(proposal.operation)}`).slice(0, 24)}`,
      reviewId,
      state: "prepared",
      actions: actionsFor(
        options.cfg,
        proposal.operation as MemoryOperation,
        reviewId,
      ),
    };
    for (const action of transaction.actions) {
      exclusive(
        v2(options.cfg, "artifacts", `${sha256(action.after)}.md`),
        action.after,
      );
      if (action.before !== undefined) {
        const beforePath = v2(
          options.cfg,
          "artifacts",
          `${sha256(action.before)}.md`,
        );
        if (!existsSync(beforePath)) exclusive(beforePath, action.before);
      }
    }
    applyTransaction(options.cfg, transaction);
    finals = finalArtifacts(transaction);
    writeCatalog(options.cfg);
  } else if (options.decision === "accept") {
    const operation = proposal.operation as SkillDraftOperation;
    const root = v2(options.cfg, "approved-skills", proposal.id);
    for (const file of operation.files) {
      const path = contained(root, join(root, file.path));
      exclusive(path, file.content);
      finals.push({
        path: relative(options.cfg.data, path),
        sha256: file.sha256,
        status: "approved-skill-draft",
      });
    }
  }
  const receipt: ReviewReceipt = {
    version: 1,
    reviewId,
    proposalId: proposal.id,
    decision:
      options.decision === "reject"
        ? "rejected"
        : options.editPath
          ? "edited"
          : "accepted",
    reason: { code: options.reasonCode, text: options.reason.trim() },
    reviewedAt,
    reviewer: "local-cli",
    originalProposalSha256: sha256(originalRaw),
    ...(editedHash ? { editedProposalSha256: editedHash } : {}),
    ...(transaction ? { transactionId: transaction.id } : {}),
    finalArtifacts: finals,
  };
  exclusive(
    v2(options.cfg, "reviews", `${reviewId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  renameSync(found.path, proposalPath(options.cfg, proposal, "reviewed"));
  return receipt;
}

export function rollbackReview(
  cfg: MemoryConfig,
  reviewId: string,
  reason: string,
): ReviewReceipt {
  if (!reason.trim()) throw new Error("rollback requires a reason");
  const path = v2(cfg, "reviews", `${reviewId}.json`);
  if (!existsSync(path)) throw new Error("review not found");
  const original = JSON.parse(readFileSync(path, "utf8")) as ReviewReceipt;
  if (!original.transactionId)
    throw new Error("review has no memory transaction");
  const txPath = v2(cfg, "transactions", `${original.transactionId}.json`);
  const transaction = JSON.parse(readFileSync(txPath, "utf8")) as Transaction;
  if (transaction.state !== "applied")
    throw new Error("transaction is not applied");
  for (const action of transaction.actions) {
    if (
      !existsSync(action.to) ||
      sha256(readFileSync(action.to)) !== sha256(action.after)
    )
      throw new Error(`rollback blocked by changed artifact ${action.to}`);
  }
  for (const action of transaction.actions.slice().reverse()) {
    rmSync(action.to);
    if (action.from && action.before !== undefined)
      atomicWrite(action.from, action.before);
  }
  transaction.state = "rolled-back";
  atomicWrite(txPath, `${JSON.stringify(transaction, null, 2)}\n`);
  writeCatalog(cfg);
  const at = new Date().toISOString();
  const receipt: ReviewReceipt = {
    version: 1,
    reviewId: `review_${sha256(`${reviewId}:rollback:${at}`).slice(0, 24)}`,
    proposalId: original.proposalId,
    decision: "rolled-back",
    reason: { code: "other", text: reason.trim() },
    reviewedAt: at,
    reviewer: "local-cli",
    originalProposalSha256: original.originalProposalSha256,
    transactionId: transaction.id,
    finalArtifacts: [],
  };
  exclusive(
    v2(cfg, "reviews", `${receipt.reviewId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

function legacyCandidate(path: string): {
  artifact: Omit<MemoryArtifact, "memoryId">;
  source: string;
} {
  const text = readFileSync(path, "utf8");
  const field = (name: string): string => {
    const value = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text)?.[1];
    if (!value) throw new Error(`legacy candidate missing ${name}`);
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value.replace(/^['"]|['"]$/g, "");
    }
  };
  const list = (name: string): string[] =>
    JSON.parse(
      new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text)?.[1] || "[]",
    ) as string[];
  const body = text.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
  const source = field("source");
  return {
    source,
    artifact: {
      title: field("title"),
      kind: field("kind") as MemoryArtifact["kind"],
      scope: field("scope"),
      description: field("title"),
      triggers: list("triggers"),
      keywords: list("keywords"),
      sources: [source],
      created: field("created"),
      updated: field("updated"),
      body,
    },
  };
}

export function migrateV1(
  cfg: MemoryConfig,
  dryRun = false,
): { candidates: number; receipts: number } {
  ensureWorkflowDirs(cfg);
  const marker = v2(cfg, "migration-v1.json");
  if (existsSync(marker))
    return JSON.parse(readFileSync(marker, "utf8")) as {
      candidates: number;
      receipts: number;
    };
  const candidateDir = join(cfg.data, "candidates");
  const receiptDir = join(cfg.data, "receipts");
  const candidates = existsSync(candidateDir)
    ? readdirSync(candidateDir)
        .filter((name) => name.endsWith(".md"))
        .sort()
    : [];
  const receipts = existsSync(receiptDir)
    ? readdirSync(receiptDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  if (dryRun)
    return { candidates: candidates.length, receipts: receipts.length };
  for (const name of candidates) {
    const parsed = legacyCandidate(join(candidateDir, name));
    const seed = sha256(
      `legacy-v1:${parsed.source}:${sha256(readFileSync(join(candidateDir, name)))}`,
    );
    const artifact = {
      ...parsed.artifact,
      memoryId: `mem_${seed.slice(0, 24)}`,
    };
    saveProposal(cfg, {
      version: 2,
      id: `prop_${seed.slice(0, 32)}`,
      lane: "memory",
      status: "pending",
      operation: { type: "create", artifact },
      supersedes: [],
      evidence: [],
      provenance: {
        runId: `migration_${seed.slice(0, 24)}`,
        promptVersion: 1,
        model: "legacy-v1",
        createdAt: new Date().toISOString(),
        migration: true,
        corpusAware: false,
      },
    });
  }
  for (const name of receipts)
    copyFileSync(join(receiptDir, name), v2(cfg, "ledger", `v1-${name}`));
  const result = { candidates: candidates.length, receipts: receipts.length };
  exclusive(marker, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function readReviewReceipts(cfg: MemoryConfig): ReviewReceipt[] {
  ensureWorkflowDirs(cfg);
  return readdirSync(v2(cfg, "reviews"))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          readFileSync(v2(cfg, "reviews", name), "utf8"),
        ) as ReviewReceipt,
    );
}
