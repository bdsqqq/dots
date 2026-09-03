import { observeMemoryOperation } from "./observability.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  atomicWrite,
  contained,
  secureDir,
  sha256,
  scanCatalog,
  writeCatalog,
  type Catalog,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import {
  MEMORY_KINDS,
  REVIEW_REASON_CODES,
  canonicalProposalId,
  memoryRef,
  parseModelProposal,
  proposalFileName,
  renderMemory,
  type EvidenceRef,
  type MemoryArtifact,
  type MemoryKind,
  type MemoryMutationActor,
  type MemoryOperation,
  type MemoryPatch,
  type MemoryRef,
  type ModelProposal,
  type Proposal,
  type ReviewReasonCode,
  type ReviewReceipt,
  type SkillDraftOperation,
} from "./schema.js";
import {
  commitHistory,
  headHistoryReceipt,
  initHistory,
  isHistoryInitialized,
  listHistoryByKind,
  refreshHistory,
  syncHistory,
  verifyHistory,
  withWritableMemoryRoot,
  type HistoryChange,
} from "./history.js";

import {
  enqueueMaintenanceEvent,
  listMaintenanceEvents,
  type EventBasis,
} from "./events.js";
import { deriveTierState, tierStateDigest } from "./tiering.js";

const V2 = "v2";
const PROMPT_VERSION = 2;

function enqueueTieringAfterMutation(cfg: MemoryConfig): void {
  const catalog = scanCatalog(cfg.root);
  const catalogSha256 = sha256(JSON.stringify(catalog.entries));
  const stateSha256 = tierStateDigest(deriveTierState(cfg, catalog));
  enqueueMaintenanceEvent(cfg, {
    kind: "tiering-ready",
    cause: `${catalogSha256}:${stateSha256}:0`,
    basis: { catalogSha256, stateSha256, cursor: 0 },
  });
}

function safeOperationId(value: unknown): string {
  if (typeof value !== "string") return "invalid-id";
  if (
    /^(?:prop_[a-f0-9]{32}|review_[a-f0-9]{24}|tx_[a-f0-9]{24}|adapt_[a-f0-9]{64}|event_[a-f0-9]{64}|feedback_[a-f0-9]{32}|replay_[a-f0-9]{20}|case_[a-f0-9]{24}|mut_[a-f0-9]{24})$/.test(
      value,
    )
  )
    return value;
  return `hashed_${sha256(value.slice(0, 4096)).slice(0, 24)}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function v2(cfg: MemoryConfig, ...parts: string[]): string {
  return contained(cfg.data, join(cfg.data, V2, ...parts));
}

function exclusive(path: string, value: string): void {
  secureDir(dirname(path));
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.exclusive`,
  );
  atomicWrite(temporary, value);
  try {
    linkSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
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

function saveProposalImpl(cfg: MemoryConfig, proposal: Proposal): string {
  parseStoredProposal(JSON.stringify(proposal), cfg);
  ensureWorkflowDirs(cfg);
  const path = proposalPath(cfg, proposal);
  const value = `${JSON.stringify(proposal, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value)
      throw new Error(`proposal collision ${proposal.id}`);
  } else {
    const reviewedDir = v2(cfg, "proposals/reviewed");
    const reviewed = readdirSync(reviewedDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const reviewedPath = join(reviewedDir, name);
        return {
          path: reviewedPath,
          proposal: parseStoredProposal(
            readFileSync(reviewedPath, "utf8"),
            cfg,
            true,
          ),
        };
      })
      .filter((item) => item.proposal.id === proposal.id);
    if (reviewed.length > 1)
      throw new Error(`proposal collision ${proposal.id}`);
    if (reviewed[0]) return reviewed[0].path;
    exclusive(path, value);
  }
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
    .map((name) =>
      parseStoredProposal(
        readFileSync(join(dir, name), "utf8"),
        cfg,
        status === "reviewed",
      ),
    )
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
      const proposal = parseStoredProposal(
        readFileSync(path, "utf8"),
        cfg,
        status === "reviewed",
      );
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

function validateMemoryRef(value: unknown): void {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "memoryId,path,sha256" ||
    typeof value.memoryId !== "string" ||
    !/^(?:mem_[a-f0-9]{24}|legacy:[a-f0-9]{24})$/.test(value.memoryId) ||
    typeof value.path !== "string" ||
    !value.path ||
    value.path.length > 240 ||
    value.path.startsWith("/") ||
    value.path.includes("..") ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error("invalid stored memory ref");
}

function validateFullArtifact(value: unknown): void {
  if (
    !object(value) ||
    typeof value.memoryId !== "string" ||
    !/^mem_[a-f0-9]{24}$/.test(value.memoryId) ||
    !Array.isArray(value.sources) ||
    !value.sources.every(
      (source) => typeof source === "string" && source.length <= 500,
    ) ||
    typeof value.created !== "string" ||
    typeof value.updated !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.created) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.updated)
  )
    throw new Error("invalid stored artifact");
  const {
    memoryId: _memoryId,
    sources: _sources,
    created: _created,
    updated: _updated,
    ...draft
  } = value;
  parseModelProposal(
    JSON.stringify({
      version: 2,
      action: "propose",
      proposals: [
        {
          lane: "memory",
          evidenceWindowIds: ["stored-validation"],
          operation: { type: "create", artifact: draft },
        },
      ],
    }),
  );
}

function validatePatch(value: unknown): void {
  if (!object(value) || Object.keys(value).length === 0)
    throw new Error("invalid stored patch");
  const allowed = new Set([
    "title",
    "kind",
    "description",
    "triggers",
    "keywords",
    "body",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("invalid stored patch fields");
  for (const field of ["title", "kind", "description"] as const) {
    const change = value[field];
    if (
      change !== undefined &&
      (!object(change) ||
        Object.keys(change).sort().join(",") !== "from,to" ||
        typeof change.from !== "string" ||
        typeof change.to !== "string")
    )
      throw new Error(`invalid stored ${field} patch`);
  }
  const title = value.title;
  const description = value.description;
  const kind = value.kind;
  if (
    (object(title) &&
      (![title.from, title.to].every(
        (item) =>
          typeof item === "string" &&
          !!item.trim() &&
          item.length <= 120 &&
          !/[\r\n]/.test(item),
      ) ||
        title.from === title.to)) ||
    (object(description) &&
      (![description.from, description.to].every(
        (item) =>
          typeof item === "string" &&
          !!item.trim() &&
          item.length <= 240 &&
          !/[\r\n]/.test(item),
      ) ||
        description.from === description.to)) ||
    (object(kind) &&
      (!MEMORY_KINDS.includes(kind.from as MemoryKind) ||
        !MEMORY_KINDS.includes(kind.to as MemoryKind) ||
        kind.from === kind.to))
  )
    throw new Error("invalid stored scalar patch");
  for (const field of ["triggers", "keywords"] as const) {
    const change = value[field];
    if (
      change !== undefined &&
      (!object(change) ||
        Object.keys(change).sort().join(",") !== "add,remove" ||
        !Array.isArray(change.add) ||
        !Array.isArray(change.remove) ||
        ![...change.add, ...change.remove].every(
          (item) => typeof item === "string",
        ))
    )
      throw new Error(`invalid stored ${field} patch`);
  }
  const body = value.body;
  if (
    body !== undefined &&
    (!object(body) ||
      Object.keys(body).sort().join(",") !== "fromSha256,sourceRefs,to" ||
      typeof body.fromSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.fromSha256) ||
      typeof body.to !== "string" ||
      !body.to.trim() ||
      !Array.isArray(body.sourceRefs) ||
      body.sourceRefs.length === 0 ||
      !body.sourceRefs.every(
        (source) =>
          typeof source === "string" && /^(?:pi|https):\/\//.test(source),
      ))
  )
    throw new Error("invalid stored body patch");
}

function validateStoredOperation(
  lane: "memory" | "skill",
  value: Record<string, unknown>,
): void {
  if (lane === "skill") {
    parseModelProposal(
      JSON.stringify({
        version: 2,
        action: "propose",
        proposals: [
          {
            lane: "skill",
            evidenceWindowIds: ["stored-validation"],
            operation: value,
          },
        ],
      }),
    );
    if (
      !Array.isArray(value.files) ||
      value.files.some(
        (file) =>
          !object(file) ||
          typeof file.content !== "string" ||
          typeof file.sha256 !== "string" ||
          file.sha256 !== sha256(file.content),
      )
    )
      throw new Error("invalid stored skill file hash");
    return;
  }
  if (value.type === "create") {
    if (Object.keys(value).sort().join(",") !== "artifact,type")
      throw new Error("invalid stored create fields");
    validateFullArtifact(value.artifact);
  } else if (value.type === "update") {
    if (Object.keys(value).sort().join(",") !== "artifact,target,type")
      throw new Error("invalid stored update fields");
    validateMemoryRef(value.target);
    validateFullArtifact(value.artifact);
    if (
      (value.target as MemoryRef).memoryId !==
      (value.artifact as MemoryArtifact).memoryId
    )
      throw new Error("stored update changes memory identity");
  } else if (value.type === "patch") {
    if (Object.keys(value).sort().join(",") !== "changes,target,type")
      throw new Error("invalid stored patch fields");
    validateMemoryRef(value.target);
    validatePatch(value.changes);
  } else if (value.type === "replace") {
    if (Object.keys(value).sort().join(",") !== "newSpan,oldSpan,target,type")
      throw new Error("invalid stored replace fields");
    validateMemoryRef(value.target);
    if (
      typeof value.oldSpan !== "string" ||
      !value.oldSpan ||
      value.oldSpan.length > 4_000 ||
      typeof value.newSpan !== "string" ||
      value.newSpan.length > 8_000
    )
      throw new Error("invalid stored replacement spans");
  } else if (value.type === "deduplicate") {
    if (Object.keys(value).sort().join(",") !== "primary,targets,type")
      throw new Error("invalid stored deduplicate fields");
    validateMemoryRef(value.primary);
    if (!Array.isArray(value.targets) || value.targets.length < 1)
      throw new Error("invalid stored deduplicate targets");
    value.targets.forEach(validateMemoryRef);
  } else if (value.type === "merge") {
    if (Object.keys(value).sort().join(",") !== "artifact,primary,targets,type")
      throw new Error("invalid stored merge fields");
    validateMemoryRef(value.primary);
    if (!Array.isArray(value.targets) || value.targets.length < 1)
      throw new Error("invalid stored merge targets");
    value.targets.forEach(validateMemoryRef);
    validateFullArtifact(value.artifact);
    if (
      (value.primary as MemoryRef).memoryId !==
      (value.artifact as MemoryArtifact).memoryId
    )
      throw new Error("stored merge changes memory identity");
  } else if (value.type === "archive" || value.type === "retire") {
    const keys = Object.keys(value).sort().join(",");
    if (
      (value.type === "archive" && keys !== "reason,target,type") ||
      (value.type === "retire" &&
        keys !== "reason,target,type" &&
        keys !== "reason,supersededBy,target,type")
    )
      throw new Error("invalid stored lifecycle fields");
    validateMemoryRef(value.target);
    if (
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      value.reason.length > 500 ||
      (value.type === "retire" &&
        value.supersededBy !== undefined &&
        (typeof value.supersededBy !== "string" ||
          !/^(?:mem_[a-f0-9]{24}|legacy:[a-f0-9]{24})$/.test(
            value.supersededBy,
          )))
    )
      throw new Error("invalid stored operation reason");
  } else throw new Error("invalid stored operation type");
}

export function parseStoredProposalOperation(
  value: unknown,
): Proposal["operation"] {
  if (!object(value)) throw new Error("invalid stored operation");
  validateStoredOperation(
    value.type === "skill-draft" ? "skill" : "memory",
    value,
  );
  return value as Proposal["operation"];
}

export function parseStoredProposal(
  raw: string,
  cfg?: MemoryConfig,
  allowHistoricalMaintenance = false,
): Proposal {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    ![
      "evidence,id,lane,operation,provenance,status,supersedes,version",
      "digestVersion,evidence,id,lane,operation,provenance,status,supersedes,version",
    ].includes(Object.keys(value).sort().join(",")) ||
    value.version !== 2 ||
    (value.digestVersion !== undefined && value.digestVersion !== 2) ||
    typeof value.id !== "string" ||
    (value.lane !== "memory" && value.lane !== "skill") ||
    value.status !== "pending" ||
    !object(value.operation) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.supersedes) ||
    !object(value.provenance) ||
    !value.supersedes.every((item) => typeof item === "string") ||
    !value.evidence.every(
      (item) =>
        object(item) &&
        typeof item.windowId === "string" &&
        typeof item.sessionId === "string" &&
        Array.isArray(item.checkpointEntryIds) &&
        item.checkpointEntryIds.every(
          (id) => typeof id === "string" && id.length > 0,
        ) &&
        typeof item.throughLeafId === "string" &&
        typeof item.branchDigest === "string" &&
        typeof item.excerpt === "string" &&
        typeof item.excerptSha256 === "string",
    ) ||
    typeof value.provenance.runId !== "string" ||
    typeof value.provenance.promptVersion !== "number" ||
    typeof value.provenance.model !== "string" ||
    (value.provenance.reasoning !== undefined &&
      (typeof value.provenance.reasoning !== "string" ||
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          value.provenance.reasoning,
        ))) ||
    typeof value.provenance.createdAt !== "string" ||
    typeof value.provenance.corpusAware !== "boolean" ||
    (value.provenance.autonomous !== undefined &&
      typeof value.provenance.autonomous !== "boolean") ||
    (value.provenance.source !== undefined &&
      (typeof value.provenance.source !== "string" ||
        value.provenance.source.length > 500 ||
        !/^(?:pi|https):\/\//.test(value.provenance.source)))
  )
    throw new Error("invalid stored proposal");
  if (value.operation.type === "skill-draft" && value.lane !== "skill")
    throw new Error("proposal lane mismatch");
  if (value.operation.type !== "skill-draft" && value.lane !== "memory")
    throw new Error("proposal lane mismatch");
  parseStoredProposalOperation(value.operation);
  const proposal = value as Proposal;
  const { id: _id, ...identity } = proposal;
  const legacyId = (operation: Proposal["operation"]) =>
    `prop_${sha256(
      JSON.stringify({
        operation,
        evidence: proposal.evidence,
        runId: proposal.provenance.runId,
      }),
    ).slice(0, 32)}`;
  const expectedIds =
    proposal.digestVersion === 2
      ? [canonicalProposalId(identity)]
      : [
          legacyId(proposal.operation),
          ...(allowHistoricalMaintenance &&
          proposal.provenance.runId.startsWith("maintenance_")
            ? [
                `prop_${sha256(
                  `maintenance:${proposal.provenance.runId.slice(
                    "maintenance_".length,
                  )}`,
                ).slice(0, 32)}`,
                ...Array.from(
                  { length: 8 },
                  (_, index) =>
                    `prop_${sha256(
                      `${proposal.provenance.runId.slice(
                        "maintenance_".length,
                      )}:${index}:${JSON.stringify(proposal.operation)}`,
                    ).slice(0, 32)}`,
                ),
              ]
            : []),
          ...(proposal.provenance.model === "manual-cli" &&
          "artifact" in proposal.operation
            ? [
                legacyId({
                  ...proposal.operation,
                  artifact: { ...proposal.operation.artifact, sources: [] },
                }),
              ]
            : []),
        ];
  const legacyMigrationMatch =
    proposal.digestVersion === undefined &&
    proposal.provenance.migration === true &&
    proposal.provenance.model === "legacy-v1" &&
    proposal.provenance.runId.startsWith("migration_") &&
    /^prop_[a-f0-9]{32}$/.test(proposal.id) &&
    cfg !== undefined &&
    existsSync(join(cfg.data, "candidates")) &&
    readdirSync(join(cfg.data, "candidates"))
      .filter((name) => name.endsWith(".md"))
      .some((name) => {
        const path = join(cfg.data, "candidates", name);
        const parsed = legacyCandidate(path);
        const seed = sha256(
          `legacy-v1:${parsed.source}:${sha256(readFileSync(path))}`,
        );
        return (
          proposal.id === `prop_${seed.slice(0, 32)}` &&
          proposal.provenance.runId === `migration_${seed.slice(0, 24)}` &&
          JSON.stringify(proposal.operation) ===
            JSON.stringify({
              type: "create",
              artifact: {
                ...parsed.artifact,
                memoryId: `mem_${seed.slice(0, 24)}`,
              },
            })
        );
      });
  if (!expectedIds.includes(proposal.id) && !legacyMigrationMatch)
    throw new Error("stored proposal id does not match content");
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
  reasoning?: Proposal["provenance"]["reasoning"];
  scope: string;
  evidence: EvidenceRef[];
  catalog: Catalog;
  pending: Proposal[];
  supersessionBasis?: Array<{
    id: string;
    runId: string;
    operation: Proposal["operation"];
  }>;
  createdAt?: string;
  corpusAware?: boolean;
  autonomous?: boolean;
  source?: string;
  digestVersion?: 2;
}): Proposal[] {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const targets = new Map(
    options.catalog.entries.map((entry) => [entry.memoryId, entry]),
  );
  const supersessionBasis = options.supersessionBasis ?? options.pending;
  const pendingIds = new Set(supersessionBasis.map((item) => item.id));
  let skillCount = 0;
  return options.result.proposals.map((draft, index) => {
    const availableEvidence = new Map(
      options.evidence.map((item) => [item.windowId, item]),
    );
    const selectedEvidence =
      options.evidence.length === 0 && options.autonomous !== true
        ? []
        : draft.evidenceWindowIds.map((windowId) => {
            const item = availableEvidence.get(windowId);
            if (!item)
              throw new Error(
                `proposal references unavailable evidence ${windowId}`,
              );
            return item;
          });
    let operation: MemoryOperation | SkillDraftOperation;
    if (draft.lane === "skill") {
      skillCount += 1;
      if (skillCount > 2) throw new Error("too many skill proposals");
      if (new Set(selectedEvidence.map((item) => item.sessionId)).size < 2)
        throw new Error("skill proposal requires two sessions");
      operation = draft.operation;
    } else {
      const op = draft.operation;
      const seed = sha256(`${options.runId}:${index}:${JSON.stringify(op)}`);
      if (op.type === "create") {
        if (
          op.artifact.scope !== "global" &&
          op.artifact.scope !== options.scope
        )
          throw new Error("create proposal uses an unavailable scope");
        operation = {
          type: "create",
          artifact: completeArtifact(
            op.artifact,
            `mem_${seed.slice(0, 24)}`,
            selectedEvidence,
            createdAt,
          ),
        };
      } else if (op.type === "update") {
        const current = target(targets, op.targetId);
        if (op.artifact.scope !== current.scope)
          throw new Error("update proposal changes target scope");
        operation = {
          type: "update",
          target: memoryRef(current),
          artifact: completeArtifact(
            op.artifact,
            current.memoryId,
            selectedEvidence,
            createdAt,
          ),
        };
      } else if (op.type === "merge") {
        const primary = target(targets, op.primaryId);
        if (op.artifact.scope !== primary.scope)
          throw new Error("merge proposal changes primary scope");
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
            selectedEvidence,
            createdAt,
          ),
        };
      } else if (op.type === "replace") {
        operation = {
          type: "replace",
          target: memoryRef(target(targets, op.targetId)),
          oldSpan: op.oldSpan,
          newSpan: op.newSpan,
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
    if (options.source && "artifact" in operation)
      operation.artifact.sources = [options.source];
    const proposal = {
      version: 2 as const,
      ...(options.digestVersion === 2 ? { digestVersion: 2 as const } : {}),
      lane: draft.lane,
      status: "pending" as const,
      operation,
      supersedes: supersessionBasis
        .filter(
          (item) =>
            ("provenance" in item ? item.provenance.runId : item.runId) !==
              options.runId &&
            pendingIds.has(item.id) &&
            JSON.stringify(item.operation) === JSON.stringify(operation),
        )
        .map((item) => item.id),
      evidence: selectedEvidence,
      provenance: {
        runId: options.runId,
        promptVersion: PROMPT_VERSION,
        model: options.model,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        createdAt,
        corpusAware: options.corpusAware ?? true,
        ...(options.autonomous !== undefined
          ? { autonomous: options.autonomous }
          : {}),
        ...(options.source ? { source: options.source } : {}),
      },
    };
    const id =
      options.digestVersion === 2
        ? canonicalProposalId(proposal)
        : `prop_${sha256(
            JSON.stringify({
              operation,
              evidence: selectedEvidence,
              runId: options.runId,
            }),
          ).slice(0, 32)}`;
    return { ...proposal, id };
  });
}

export function assertNonOverlappingMemoryProposals(
  cfg: MemoryConfig,
  proposals: Proposal[],
): void {
  const touched = new Set<string>();
  const destinations = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.lane !== "memory") continue;
    const operation = proposal.operation as MemoryOperation;
    const ids =
      operation.type === "create"
        ? []
        : operation.type === "merge" || operation.type === "deduplicate"
          ? [
              operation.primary.memoryId,
              ...operation.targets.map((target) => target.memoryId),
            ]
          : [operation.target.memoryId];
    if (ids.some((id) => touched.has(id)))
      throw new Error("memory proposal batch contains overlapping targets");
    ids.forEach((id) => touched.add(id));
    for (const action of actionsFor(cfg, operation, "review_preflight")) {
      if (destinations.has(action.to))
        throw new Error("memory proposal batch contains overlapping paths");
      destinations.add(action.to);
    }
  }
}

function submitManualProposalImpl(
  cfg: MemoryConfig,
  raw: string,
  source?: string,
): Proposal[] {
  if (
    source !== undefined &&
    (!source.trim() ||
      source.length > 500 ||
      !/^(?:pi|https):\/\//.test(source))
  )
    throw new Error("manual proposal source must be a pi:// or https:// URI");
  const manualValue: unknown = JSON.parse(raw);
  if (object(manualValue) && Array.isArray(manualValue.proposals)) {
    manualValue.version = 2;
    for (const proposal of manualValue.proposals)
      if (object(proposal) && proposal.evidenceWindowIds === undefined)
        proposal.evidenceWindowIds = ["manual"];
  }
  const result = parseModelProposal(JSON.stringify(manualValue));
  if (result.action !== "propose")
    throw new Error("manual proposal payload must propose at least one change");
  if (result.proposals.some((proposal) => proposal.lane !== "memory"))
    throw new Error("manual proposal submission only supports memory changes");
  const first = result.proposals[0];
  const scope =
    first?.lane === "memory" && "artifact" in first.operation
      ? first.operation.artifact.scope
      : "global";
  const runId = `manual_${sha256(`${canonical(result)}:${source ?? ""}`).slice(
    0,
    24,
  )}`;
  const existingBatch = [
    ...listProposals(cfg, undefined, "pending"),
    ...listProposals(cfg, undefined, "reviewed"),
  ].filter((proposal) => proposal.provenance.runId === runId);
  const existing = new Map(
    existingBatch.map((proposal) => [proposal.id, proposal]),
  );
  const proposals = materializeModelProposals({
    result,
    runId,
    model: "manual-cli",
    scope,
    evidence: [],
    catalog: scanCatalog(cfg.root),
    pending: listProposals(cfg),
    corpusAware: false,
    ...(existingBatch[0]
      ? { createdAt: existingBatch[0].provenance.createdAt }
      : {}),
    ...(source ? { source } : {}),
    digestVersion: 2,
  });
  assertNonOverlappingMemoryProposals(
    cfg,
    proposals.filter((proposal) => !existing.has(proposal.id)),
  );
  return proposals.map((proposal) => {
    const saved = existing.get(proposal.id);
    if (saved) {
      if (
        saved.lane !== proposal.lane ||
        JSON.stringify(saved.operation) !== JSON.stringify(proposal.operation)
      )
        throw new Error("manual proposal retry conflicts with saved proposal");
      return saved;
    }
    saveProposal(cfg, proposal);
    return proposal;
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
  state: "prepared" | "applied" | "rollback-prepared" | "rolled-back";
  actions: TransactionAction[];
  review?: {
    proposalId: string;
    decision: "accepted" | "edited";
    reason: { code: ReviewReasonCode; text: string };
    reviewedAt: string;
    reviewer?: MemoryMutationActor;
    originalProposalSha256: string;
    editedProposalSha256?: string;
  };
  rollback?: {
    reviewId: string;
    reason: string;
    startedAt: string;
    actor?: "local-cli" | "tier-governor";
    policyDecisionId?: string;
  };
  history?: { mutationId: string; commit: string };
  rollbackHistory?: { mutationId: string; commit: string };
};

function parseTransaction(
  cfg: MemoryConfig,
  raw: string,
  expectedId?: string,
): Transaction {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    (expectedId !== undefined && value.id !== expectedId) ||
    typeof value.reviewId !== "string" ||
    !["prepared", "applied", "rollback-prepared", "rolled-back"].includes(
      String(value.state),
    ) ||
    !Array.isArray(value.actions)
  )
    throw new Error("invalid memory transaction");
  for (const action of value.actions) {
    if (
      !object(action) ||
      typeof action.to !== "string" ||
      typeof action.after !== "string" ||
      (action.from !== undefined && typeof action.from !== "string") ||
      (action.before !== undefined && typeof action.before !== "string")
    )
      throw new Error("invalid memory transaction action");
    for (const path of [action.from, action.to]) {
      if (path === undefined) continue;
      let safe = false;
      try {
        assertSafeMemoryPath(cfg, path);
        safe = true;
      } catch {}
      if (!safe)
        throw new Error("memory transaction path escapes configured root");
    }
  }
  return value as Transaction;
}

function assertSafeMemoryPath(cfg: MemoryConfig, path: string): void {
  const root = resolve(cfg.root);
  if (resolve(path) !== path || contained(root, path) !== path)
    throw new Error("memory path escapes configured root");
  const parts = relative(root, path).split(/[/\\]/).filter(Boolean);
  let current = root;
  if (existsSync(current) && lstatSync(current).isSymbolicLink())
    throw new Error("memory root cannot be a symlink");
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`memory path contains symlink ${current}`);
  }
}

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

function frontmatterValue(text: string, field: string): unknown {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
  const raw = frontmatter
    ? new RegExp(`^${field}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]
    : undefined;
  if (raw === undefined) throw new Error(`memory is missing ${field}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw.trim();
  }
}

function memoryArtifact(text: string): MemoryArtifact {
  const string = (field: string): string => {
    const value = frontmatterValue(text, field);
    if (typeof value !== "string") throw new Error(`invalid memory ${field}`);
    return value;
  };
  const strings = (field: string): string[] => {
    const value = frontmatterValue(text, field);
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    )
      throw new Error(`invalid memory ${field}`);
    return value;
  };
  const kind = string("kind");
  if (!["preference", "decision", "gotcha", "pattern"].includes(kind))
    throw new Error("invalid memory kind");
  return {
    memoryId: string("memory_id"),
    title: string("title"),
    kind: kind as MemoryKind,
    scope: string("scope"),
    description: string("description"),
    triggers: strings("triggers"),
    keywords: strings("keywords"),
    sources: strings("sources"),
    created: string("created"),
    updated: string("updated"),
    body: text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim(),
  };
}

function rewriteFrontmatter(
  text: string,
  fields: Record<string, unknown>,
  insertMissing = false,
): string {
  const match = /^(---\n)([\s\S]*?)(\n---)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("invalid memory frontmatter");
  let frontmatter = match[2]!;
  for (const [field, value] of Object.entries(fields)) {
    const line = `${field}: ${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${field}:.*$`, "m");
    if (!pattern.test(frontmatter) && !insertMissing)
      throw new Error(`memory is missing ${field}`);
    frontmatter = pattern.test(frontmatter)
      ? frontmatter.replace(pattern, line)
      : `${frontmatter}\n${line}`;
  }
  return `${match[1]}${frontmatter}${match[3]}${match[4]}`;
}

function patchedArtifact(
  current: MemoryArtifact,
  changes: MemoryPatch,
): MemoryArtifact {
  const next = { ...current };
  for (const field of ["title", "kind", "description"] as const) {
    const change = changes[field];
    if (!change) continue;
    if (current[field] !== change.from)
      throw new Error(`patch ${field} precondition failed`);
    Object.assign(next, { [field]: change.to });
  }
  for (const field of ["triggers", "keywords"] as const) {
    const change = changes[field];
    if (!change) continue;
    if (change.remove.some((item) => !current[field].includes(item)))
      throw new Error(`patch ${field} precondition failed`);
    next[field] = [
      ...new Set([
        ...current[field].filter((item) => !change.remove.includes(item)),
        ...change.add,
      ]),
    ];
  }
  if (changes.body) {
    if (sha256(current.body) !== changes.body.fromSha256)
      throw new Error("patch body precondition failed");
    next.body = changes.body.to;
    next.sources = [
      ...new Set([...current.sources, ...changes.body.sourceRefs]),
    ];
  }
  next.updated = new Date().toISOString().slice(0, 10);
  return next;
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
  if (operation.type === "patch") {
    const from = currentTarget(cfg, operation.target);
    const before = readFileSync(from, "utf8");
    return [
      {
        from,
        to: from,
        before,
        after: renderMemory(
          patchedArtifact(memoryArtifact(before), operation.changes),
          reviewId,
        ),
      },
    ];
  }
  if (operation.type === "replace") {
    const from = currentTarget(cfg, operation.target);
    const before = readFileSync(from, "utf8");
    const bodyStart = before.indexOf("\n---\n", 3) + 5;
    if (bodyStart < 5)
      throw new Error("replacement target has invalid frontmatter");
    const body = before.slice(bodyStart);
    const bodyOffset = body.indexOf(operation.oldSpan);
    if (bodyOffset < 0 || bodyOffset !== body.lastIndexOf(operation.oldSpan))
      throw new Error("replacement old span must occur exactly once");
    const first = bodyStart + bodyOffset;
    const replaced = `${before.slice(0, first)}${operation.newSpan}${before.slice(first + operation.oldSpan.length)}`;
    return [
      {
        from,
        to: from,
        before,
        after: rewriteFrontmatter(
          replaced,
          {
            updated: new Date().toISOString().slice(0, 10),
            review_id: reviewId,
          },
          true,
        ),
      },
    ];
  }
  if (operation.type === "deduplicate") {
    const primary = currentTarget(cfg, operation.primary);
    const before = readFileSync(primary, "utf8");
    const primaryArtifact = memoryArtifact(before);
    const duplicates = operation.targets.map((ref) => {
      if (ref.memoryId === operation.primary.memoryId)
        throw new Error("deduplicate target repeats primary");
      const from = currentTarget(cfg, ref);
      const text = readFileSync(from, "utf8");
      const artifact = memoryArtifact(text);
      if (artifact.scope !== primaryArtifact.scope)
        throw new Error("deduplicate cannot cross scopes");
      return { from, text, artifact };
    });
    const actions: TransactionAction[] = [
      {
        from: primary,
        to: primary,
        before,
        after: rewriteFrontmatter(before, {
          sources: [
            ...new Set([
              ...primaryArtifact.sources,
              ...duplicates.flatMap((item) => item.artifact.sources),
            ]),
          ],
          updated: new Date().toISOString().slice(0, 10),
          review_id: reviewId,
        }),
      },
    ];
    for (const duplicate of duplicates) {
      const to = archivedPath(cfg, duplicate.from, "retired");
      if (existsSync(to))
        throw new Error(`archive destination exists ${relative(cfg.root, to)}`);
      actions.push({
        from: duplicate.from,
        to,
        before: duplicate.text,
        after: withStatus(duplicate.text, "retired", reviewId),
      });
    }
    return actions;
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
      const to = archivedPath(cfg, from, "retired");
      if (existsSync(to))
        throw new Error(`archive destination exists ${relative(cfg.root, to)}`);
      actions.push({
        from,
        to,
        before: old,
        after: withStatus(old, "retired", reviewId),
      });
    }
    return actions;
  }
  const from = currentTarget(cfg, operation.target);
  const before = readFileSync(from, "utf8");
  const status = operation.type === "archive" ? "archived" : "retired";
  const to = archivedPath(cfg, from, status);
  if (existsSync(to))
    throw new Error(`archive destination exists ${relative(cfg.root, to)}`);
  return [
    {
      from,
      to,
      before,
      after: withStatus(before, status, reviewId),
    },
  ];
}

export function prepareCanonicalMemoryChanges(
  cfg: MemoryConfig,
  operation: MemoryOperation,
  mutationId: string,
): Array<{
  path: string;
  beforeSha256: string | null;
  afterContent: string | null;
  afterSha256: string | null;
}> {
  const changes = new Map<
    string,
    {
      path: string;
      beforeSha256: string | null;
      afterContent: string | null;
      afterSha256: string | null;
    }
  >();
  for (const action of actionsFor(cfg, operation, mutationId)) {
    if (action.from) {
      const path = relative(cfg.root, action.from).replaceAll("\\", "/");
      changes.set(path, {
        path,
        beforeSha256:
          action.before === undefined ? null : sha256(action.before),
        afterContent: action.from === action.to ? action.after : null,
        afterSha256: action.from === action.to ? sha256(action.after) : null,
      });
    }
    if (action.from !== action.to && !action.to.includes("/.archive/")) {
      const path = relative(cfg.root, action.to).replaceAll("\\", "/");
      changes.set(path, {
        path,
        beforeSha256: null,
        afterContent: action.after,
        afterSha256: sha256(action.after),
      });
    }
  }
  return [...changes.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function restoreTransactionActions(transaction: Transaction): void {
  const reversed = transaction.actions.slice().reverse();
  for (const action of reversed) {
    if (existsSync(action.to)) {
      const currentHash = sha256(readFileSync(action.to));
      const beforeHash =
        action.before === undefined ? undefined : sha256(action.before);
      if (
        currentHash !== sha256(action.after) &&
        (action.from !== action.to ||
          beforeHash === undefined ||
          currentHash !== beforeHash)
      )
        throw new Error(
          `cannot restore transaction with changed artifact ${action.to}`,
        );
    }
    if (
      action.from &&
      action.from !== action.to &&
      action.before !== undefined &&
      existsSync(action.from) &&
      sha256(readFileSync(action.from)) !== sha256(action.before)
    )
      throw new Error(
        `cannot restore transaction over changed source ${action.from}`,
      );
  }
  for (const action of reversed) {
    if (
      existsSync(action.to) &&
      sha256(readFileSync(action.to)) === sha256(action.after)
    )
      rmSync(action.to);
    if (action.from && action.before !== undefined && !existsSync(action.from))
      atomicWrite(action.from, action.before);
  }
}

function restoreAppliedTransactionActions(transaction: Transaction): void {
  for (const action of transaction.actions) {
    const beforeHash =
      action.before === undefined ? undefined : sha256(action.before);
    const afterHash = sha256(action.after);
    if (action.from && action.from !== action.to) {
      if (existsSync(action.from)) {
        if (
          beforeHash === undefined ||
          sha256(readFileSync(action.from)) !== beforeHash
        )
          throw new Error(
            `cannot recover rollback over changed source ${action.from}`,
          );
        if (existsSync(action.to))
          throw new Error(
            `cannot recover rollback with both paths present ${action.to}`,
          );
      } else if (
        !existsSync(action.to) ||
        sha256(readFileSync(action.to)) !== afterHash
      )
        throw new Error(
          `cannot recover rollback with changed artifact ${action.to}`,
        );
    } else if (existsSync(action.to)) {
      const current = sha256(readFileSync(action.to));
      if (current !== afterHash && current !== beforeHash)
        throw new Error(
          `cannot recover rollback over changed artifact ${action.to}`,
        );
    } else if (action.before !== undefined && action.from === action.to)
      throw new Error(
        `cannot recover rollback with missing artifact ${action.to}`,
      );
  }
  for (const action of transaction.actions) {
    if (action.from && action.from !== action.to) {
      if (existsSync(action.from)) rmSync(action.from);
      if (!existsSync(action.to)) atomicWrite(action.to, action.after);
    } else if (
      !existsSync(action.to) ||
      sha256(readFileSync(action.to)) !== sha256(action.after)
    )
      atomicWrite(action.to, action.after);
  }
}

function persistAppliedReceipt(
  cfg: MemoryConfig,
  transaction: Transaction,
): ReviewReceipt {
  if (!transaction.review)
    throw new Error("transaction is missing review recovery metadata");
  const receipt: ReviewReceipt = {
    version: 1,
    reviewId: transaction.reviewId,
    proposalId: transaction.review.proposalId,
    decision: transaction.review.decision,
    reason: transaction.review.reason,
    reviewedAt: transaction.review.reviewedAt,
    reviewer: transaction.review.reviewer ?? "local-cli",
    originalProposalSha256: transaction.review.originalProposalSha256,
    ...(transaction.review.editedProposalSha256
      ? { editedProposalSha256: transaction.review.editedProposalSha256 }
      : {}),
    transactionId: transaction.id,
    ...(transaction.history
      ? {
          mutationId: transaction.history.mutationId,
          historyCommit: transaction.history.commit,
        }
      : {}),
    finalArtifacts: finalArtifacts(cfg, transaction),
  };
  const path = v2(cfg, "reviews", `${receipt.reviewId}.json`);
  const value = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current !== value) {
      try {
        JSON.parse(current);
        throw new Error("review receipt collision");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "review receipt collision"
        )
          throw error;
        atomicWrite(path, value);
      }
    }
  } else atomicWrite(path, value);
  return receipt;
}

function persistRollbackReceipt(
  cfg: MemoryConfig,
  transaction: Transaction,
): ReviewReceipt | undefined {
  if (!transaction.rollback) return undefined;
  const path = v2(cfg, "reviews", `${transaction.rollback.reviewId}.json`);
  const original = persistAppliedReceipt(cfg, transaction);
  const receipt: ReviewReceipt = {
    version: 1,
    reviewId: transaction.rollback.reviewId,
    proposalId: original.proposalId,
    decision: "rolled-back",
    reason: { code: "other", text: transaction.rollback.reason },
    reviewedAt: transaction.rollback.startedAt,
    reviewer: transaction.rollback.actor ?? "local-cli",
    originalProposalSha256: original.originalProposalSha256,
    transactionId: transaction.id,
    ...(transaction.rollbackHistory
      ? {
          mutationId: transaction.rollbackHistory.mutationId,
          historyCommit: transaction.rollbackHistory.commit,
        }
      : {}),
    finalArtifacts: [],
  };
  const value = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current !== value) {
      try {
        JSON.parse(current);
        throw new Error("rollback receipt collision");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "rollback receipt collision"
        )
          throw error;
        atomicWrite(path, value);
      }
    }
  } else atomicWrite(path, value);
  return receipt;
}

function recoverTransactionsImpl(
  cfg: MemoryConfig,
  options: { publishCatalog?: boolean } = {},
): number {
  ensureWorkflowDirs(cfg);
  const dir = v2(cfg, "transactions");
  let recovered = 0;
  for (const name of readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .sort()) {
    const path = join(dir, name);
    const transaction = parseTransaction(
      cfg,
      readFileSync(path, "utf8"),
      name.slice(0, -".json".length),
    );
    if (transaction.state === "rolled-back" && transaction.rollback) {
      persistRollbackReceipt(cfg, transaction);
      continue;
    }
    if (transaction.state === "applied") {
      const receipt = persistAppliedReceipt(cfg, transaction);
      try {
        const found = findProposal(cfg, receipt.proposalId);
        if (found.path.includes("/pending/"))
          renameSync(found.path, proposalPath(cfg, found.proposal, "reviewed"));
      } catch {}
      continue;
    }
    if (
      transaction.state !== "prepared" &&
      transaction.state !== "rollback-prepared"
    )
      continue;
    const head = headHistoryReceipt(cfg);
    if (head?.transactionId === transaction.id) {
      if (
        transaction.state === "rollback-prepared" &&
        transaction.rollback &&
        head.reviewId === transaction.rollback.reviewId
      ) {
        transaction.rollbackHistory = {
          mutationId: head.mutationId,
          commit: head.commit,
        };
        transaction.state = "rolled-back";
        atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
        persistRollbackReceipt(cfg, transaction);
        recovered += 1;
        continue;
      }
      if (
        transaction.state === "prepared" &&
        head.reviewId === transaction.reviewId
      ) {
        transaction.history = {
          mutationId: head.mutationId,
          commit: head.commit,
        };
        transaction.state = "applied";
        atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
        const receipt = persistAppliedReceipt(cfg, transaction);
        try {
          const found = findProposal(cfg, receipt.proposalId);
          if (found.path.includes("/pending/"))
            renameSync(
              found.path,
              proposalPath(cfg, found.proposal, "reviewed"),
            );
        } catch {}
        recovered += 1;
        continue;
      }
    }
    withWritableMemoryRoot(cfg, () => {
      if (transaction.state === "rollback-prepared")
        restoreAppliedTransactionActions(transaction);
      else restoreTransactionActions(transaction);
    });
    if (transaction.state === "rollback-prepared") {
      transaction.state = "applied";
      delete transaction.rollback;
      delete transaction.rollbackHistory;
    } else transaction.state = "rolled-back";
    atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
    if (transaction.state === "rolled-back")
      persistRollbackReceipt(cfg, transaction);
    else persistAppliedReceipt(cfg, transaction);
    recovered += 1;
  }
  if (options.publishCatalog !== false) writeCatalog(cfg);
  return recovered;
}

function applyTransaction(
  cfg: MemoryConfig,
  transaction: Transaction,
  kind: string,
  reason: string,
): void {
  for (const action of transaction.actions) {
    if (action.from) assertSafeMemoryPath(cfg, action.from);
    assertSafeMemoryPath(cfg, action.to);
  }
  const path = v2(cfg, "transactions", `${transaction.id}.json`);
  atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
  const completed: TransactionAction[] = [];
  try {
    withWritableMemoryRoot(cfg, () => {
      for (const action of transaction.actions) {
        completed.push(action);
        if (!action.from) exclusive(action.to, action.after);
        else if (action.from === action.to) {
          if (
            action.before === undefined ||
            !existsSync(action.from) ||
            sha256(readFileSync(action.from)) !== sha256(action.before)
          )
            throw new Error(`transaction source changed ${action.from}`);
          atomicWrite(action.to, action.after);
        } else {
          if (
            action.before === undefined ||
            !existsSync(action.from) ||
            sha256(readFileSync(action.from)) !== sha256(action.before)
          )
            throw new Error(`transaction source changed ${action.from}`);
          exclusive(action.to, action.after);
          if (sha256(readFileSync(action.from)) !== sha256(action.before))
            throw new Error(`transaction source changed ${action.from}`);
          rmSync(action.from);
        }
      }
      commitTransactionHistory(
        cfg,
        transaction,
        kind,
        transaction.reviewId,
        reason,
      );
    });
    transaction.state = "applied";
    atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
  } catch (error) {
    const head = headHistoryReceipt(cfg);
    if (
      head?.transactionId === transaction.id &&
      head.reviewId === transaction.reviewId
    ) {
      transaction.history = {
        mutationId: head.mutationId,
        commit: head.commit,
      };
      transaction.state = "applied";
      atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
      return;
    }
    withWritableMemoryRoot(cfg, () =>
      restoreTransactionActions({ ...transaction, actions: completed }),
    );
    transaction.state = "rolled-back";
    atomicWrite(path, `${JSON.stringify(transaction, null, 2)}\n`);
    throw error;
  }
}

function finalArtifacts(
  cfg: MemoryConfig,
  transaction: Transaction,
): ReviewReceipt["finalArtifacts"] {
  return transaction.actions.map((action) => ({
    path: relative(cfg.root, action.to),
    sha256: sha256(action.after),
    status: action.to.includes("/.archive/archived/")
      ? "archived"
      : action.to.includes("/.archive/retired/")
        ? "retired"
        : "active",
  }));
}

function validatePatchProvenance(proposal: Proposal): void {
  if (
    proposal.lane !== "memory" ||
    proposal.operation.type !== "patch" ||
    !proposal.operation.changes.body
  )
    return;
  const allowed = new Set([
    ...proposal.evidence.flatMap((item) =>
      item.checkpointEntryIds.map(
        (checkpoint) => `pi://${item.sessionId}/${checkpoint}`,
      ),
    ),
    ...(proposal.provenance.source ? [proposal.provenance.source] : []),
  ]);
  if (
    proposal.operation.changes.body.sourceRefs.some(
      (source) => !allowed.has(source),
    )
  )
    throw new Error("patch body source is not backed by proposal evidence");
}

function historyStatus(path: string): "active" | "archived" | "retired" {
  return path.includes("/.archive/archived/")
    ? "archived"
    : path.includes("/.archive/retired/")
      ? "retired"
      : "active";
}

function historyChanges(
  cfg: MemoryConfig,
  transaction: Transaction,
  rollback = false,
): HistoryChange[] {
  const changes: HistoryChange[] = [];
  for (const action of transaction.actions) {
    const beforeSha256 =
      action.before === undefined ? undefined : sha256(action.before);
    const afterSha256 = sha256(action.after);
    if (action.from && action.from !== action.to) {
      changes.push({
        path: relative(cfg.root, action.from),
        ...(rollback ? { afterSha256: beforeSha256 } : { beforeSha256 }),
        status: rollback ? "active" : historyStatus(action.from),
      });
      changes.push({
        path: relative(cfg.root, action.to),
        ...(rollback ? { beforeSha256: afterSha256 } : { afterSha256 }),
        status: historyStatus(action.to),
      });
    } else {
      changes.push({
        path: relative(cfg.root, action.to),
        ...(rollback
          ? { beforeSha256: afterSha256, afterSha256: beforeSha256 }
          : { beforeSha256, afterSha256 }),
        status: historyStatus(action.to),
      });
    }
  }
  return changes;
}

function requireCleanHistory(cfg: MemoryConfig): void {
  if (!isHistoryInitialized(cfg))
    initHistory(cfg, {
      ...(process.env.PI_MEMORY_GIT_REMOTE
        ? { remote: process.env.PI_MEMORY_GIT_REMOTE }
        : {}),
    });
  const refresh = refreshHistory(cfg);
  if (!refresh.ok)
    throw new Error(`memory history refresh failed: ${refresh.error}`);
  const report = verifyHistory(cfg);
  if (!report.ok)
    throw new Error(
      `memory history verification failed: ${report.issues.join(", ")}`,
    );
}

function commitTransactionHistory(
  cfg: MemoryConfig,
  transaction: Transaction,
  kind: string,
  reviewId: string,
  reason: string,
  rollback = false,
): void {
  const mutationId = `mut_${sha256(`${transaction.id}:${reviewId}:${kind}`).slice(0, 24)}`;
  const result = commitHistory(cfg, {
    version: 2,
    mutationId,
    kind,
    transactionId: transaction.id,
    ...(transaction.review
      ? { proposalId: transaction.review.proposalId }
      : {}),
    reviewId,
    reason,
    changes: historyChanges(cfg, transaction, rollback),
    provenance: {
      reviewer: rollback
        ? (transaction.rollback?.actor ?? "local-cli")
        : (transaction.review?.reviewer ?? "local-cli"),
      reviewedAt:
        transaction.review?.reviewedAt ?? transaction.rollback?.startedAt,
      ...(rollback && transaction.rollback?.policyDecisionId
        ? { policyDecisionId: transaction.rollback.policyDecisionId }
        : {}),
    },
  });
  if (rollback)
    transaction.rollbackHistory = { mutationId, commit: result.commit };
  else transaction.history = { mutationId, commit: result.commit };
}

function reviewProposalImpl(options: {
  cfg: MemoryConfig;
  id: string;
  decision: "accept" | "reject";
  reasonCode: ReviewReasonCode;
  reason: string;
  editPath?: string;
  reviewer?: MemoryMutationActor;
  reviewedAt?: string;
}): ReviewReceipt {
  recoverTransactions(options.cfg);
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
  validatePatchProvenance(proposal);
  const reviewer = options.reviewer ?? "local-cli";
  const reviewedAt = options.reviewedAt ?? new Date().toISOString();
  const reviewId = `review_${sha256(`${proposal.id}:${reviewer}:${reviewedAt}:${options.reason}`).slice(0, 24)}`;
  let transaction: Transaction | undefined;
  let finals: ReviewReceipt["finalArtifacts"] = [];
  if (options.decision === "accept" && proposal.lane === "memory") {
    requireCleanHistory(options.cfg);
    transaction = {
      version: 1,
      id: `tx_${sha256(`${reviewId}:${JSON.stringify(proposal.operation)}`).slice(0, 24)}`,
      reviewId,
      state: "prepared",
      review: {
        proposalId: proposal.id,
        decision: options.editPath ? "edited" : "accepted",
        reason: { code: options.reasonCode, text: options.reason.trim() },
        reviewedAt,
        reviewer,
        originalProposalSha256: sha256(originalRaw),
        ...(editedHash ? { editedProposalSha256: editedHash } : {}),
      },
      actions: actionsFor(
        options.cfg,
        proposal.operation as MemoryOperation,
        reviewId,
      ),
    };
    for (const action of transaction.actions) {
      const afterPath = v2(
        options.cfg,
        "artifacts",
        `${sha256(action.after)}.md`,
      );
      if (!existsSync(afterPath)) exclusive(afterPath, action.after);
      else if (readFileSync(afterPath, "utf8") !== action.after)
        throw new Error("artifact hash collision");
      if (action.before !== undefined) {
        const beforePath = v2(
          options.cfg,
          "artifacts",
          `${sha256(action.before)}.md`,
        );
        if (!existsSync(beforePath)) exclusive(beforePath, action.before);
      }
    }
    applyTransaction(
      options.cfg,
      transaction,
      `review-${proposal.operation.type}`,
      options.reason.trim(),
    );
    finals = finalArtifacts(options.cfg, transaction);
    writeCatalog(options.cfg);
  } else if (options.decision === "accept") {
    const operation = proposal.operation as SkillDraftOperation;
    if (operation.mode === "update") {
      const installed = contained(
        options.cfg.skillsRoot,
        join(options.cfg.skillsRoot, operation.targetPath),
      );
      if (
        !existsSync(installed) ||
        sha256(readFileSync(installed)) !== operation.baseSha256
      )
        throw new Error("stale installed skill target");
    }
    const parent = v2(options.cfg, "approved-skills");
    const root = contained(parent, join(parent, proposal.id));
    const temporary = contained(parent, join(parent, `.${proposal.id}.tmp`));
    if (existsSync(root)) {
      for (const file of operation.files) {
        const path = contained(root, join(root, file.path));
        if (!existsSync(path) || sha256(readFileSync(path)) !== file.sha256)
          throw new Error("approved skill draft destination collision");
      }
    } else {
      rmSync(temporary, { recursive: true, force: true });
      secureDir(temporary);
      try {
        for (const file of operation.files) {
          const path = contained(temporary, join(temporary, file.path));
          exclusive(path, file.content);
        }
        renameSync(temporary, root);
      } catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    for (const file of operation.files)
      finals.push({
        path: relative(options.cfg.data, join(root, file.path)),
        sha256: file.sha256,
        status: "approved-skill-draft",
      });
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
    reviewer,
    originalProposalSha256: sha256(originalRaw),
    ...(editedHash ? { editedProposalSha256: editedHash } : {}),
    ...(transaction ? { transactionId: transaction.id } : {}),
    finalArtifacts: finals,
  };
  const persistedReceipt = transaction
    ? persistAppliedReceipt(options.cfg, transaction)
    : receipt;
  if (!transaction)
    atomicWrite(
      v2(options.cfg, "reviews", `${reviewId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  if (options.editPath)
    atomicWrite(found.path, `${JSON.stringify(proposal, null, 2)}\n`);
  renameSync(found.path, proposalPath(options.cfg, proposal, "reviewed"));
  if (transaction) syncHistory(options.cfg);
  return persistedReceipt;
}

function applyMemoryProposalImpl(options: {
  cfg: MemoryConfig;
  id: string;
  actor: Exclude<MemoryMutationActor, "local-cli">;
}): ReviewReceipt {
  recoverTransactions(options.cfg);
  const found = findProposal(options.cfg, options.id);
  if (found.proposal.lane !== "memory")
    throw new Error("autonomous application only supports memory proposals");
  const existing = readReviewReceipts(options.cfg)
    .filter((receipt) => receipt.proposalId === found.proposal.id)
    .sort(
      (left, right) =>
        left.reviewedAt.localeCompare(right.reviewedAt) ||
        left.reviewId.localeCompare(right.reviewId),
    )
    .at(-1);
  if (existing) {
    if (found.path.includes("/pending/"))
      renameSync(
        found.path,
        proposalPath(options.cfg, found.proposal, "reviewed"),
      );
    return existing;
  }
  return reviewProposal({
    cfg: options.cfg,
    id: found.proposal.id,
    decision: "accept",
    reasonCode: "autonomous",
    reason: "autonomously applied from bounded durable-memory evidence",
    reviewer: options.actor,
    reviewedAt: found.proposal.provenance.createdAt,
  });
}

export type VerifiedRollbackLinkage = {
  receipt: ReviewReceipt;
  transactionId: string;
};

function verifyPersistedRollbackLinkageImpl(
  cfg: MemoryConfig,
  input: {
    historyCommit: string;
    mutationId: string;
    reviewId: string;
    proposalId: string;
  },
): VerifiedRollbackLinkage {
  const reviewPath = v2(cfg, "reviews", `${input.reviewId}.json`);
  if (!existsSync(reviewPath))
    throw new Error("rollback review receipt is missing");
  const receipt = JSON.parse(readFileSync(reviewPath, "utf8")) as ReviewReceipt;
  if (
    receipt.decision !== "rolled-back" ||
    receipt.reviewId !== input.reviewId ||
    receipt.proposalId !== input.proposalId ||
    receipt.historyCommit !== input.historyCommit ||
    receipt.mutationId !== input.mutationId ||
    !receipt.transactionId
  )
    throw new Error("rollback review linkage does not match");
  const transaction = parseTransaction(
    cfg,
    readFileSync(
      v2(cfg, "transactions", `${receipt.transactionId}.json`),
      "utf8",
    ),
    receipt.transactionId,
  );
  if (
    transaction.state !== "rolled-back" ||
    transaction.review?.proposalId !== input.proposalId ||
    transaction.rollback?.reviewId !== input.reviewId ||
    transaction.rollbackHistory?.commit !== input.historyCommit ||
    transaction.rollbackHistory.mutationId !== input.mutationId
  )
    throw new Error("rollback transaction linkage does not match");
  return { receipt, transactionId: transaction.id };
}

type RollbackEventBasis = EventBasis & {
  historyCommit: string;
  mutationId: string;
  reviewId: string;
  proposalId: string;
};

function adaptationEventBasis(receipt: ReviewReceipt): RollbackEventBasis {
  if (!receipt.historyCommit || !receipt.mutationId)
    throw new Error("rollback did not publish verified history");
  return {
    historyCommit: receipt.historyCommit,
    mutationId: receipt.mutationId,
    reviewId: receipt.reviewId,
    proposalId: receipt.proposalId,
  };
}

function reconcileRollbackAdaptationEventsImpl(cfg: MemoryConfig): number {
  let enqueued = 0;
  for (const receipt of readReviewReceipts(cfg).filter(
    (candidate) => candidate.decision === "rolled-back",
  )) {
    const basis = adaptationEventBasis(receipt);
    verifyPersistedRollbackLinkage(cfg, {
      historyCommit: basis.historyCommit,
      mutationId: basis.mutationId,
      reviewId: receipt.reviewId,
      proposalId: receipt.proposalId,
    });
    const before = listMaintenanceEvents(cfg).some(
      ({ event }) =>
        event.kind === "adaptation-ready" &&
        event.cause === receipt.reviewId &&
        JSON.stringify(event.basis) === JSON.stringify(basis),
    );
    enqueueMaintenanceEvent(cfg, {
      kind: "adaptation-ready",
      cause: receipt.reviewId,
      basis,
    });
    if (!before) enqueued += 1;
  }
  return enqueued;
}

function rollbackReviewImpl(
  cfg: MemoryConfig,
  reviewId: string,
  reason: string,
  actor: "local-cli" | "tier-governor" = "local-cli",
  policyDecisionId?: string,
): ReviewReceipt {
  recoverTransactions(cfg);
  requireCleanHistory(cfg);
  if (!reason.trim()) throw new Error("rollback requires a reason");
  if (actor !== "local-cli" && actor !== "tier-governor")
    throw new Error("invalid rollback actor");
  if (
    actor === "tier-governor" &&
    (typeof policyDecisionId !== "string" ||
      !/^tierdec_[a-f0-9]{32}$/.test(policyDecisionId) ||
      !listHistoryByKind(cfg, "tier-decision").some(
        ({ receipt }) =>
          object(receipt.provenance) &&
          receipt.provenance.decisionId === policyDecisionId,
      ))
  )
    throw new Error("tier governor rollback lacks a verified policy decision");
  const path = v2(cfg, "reviews", `${reviewId}.json`);
  if (!existsSync(path)) throw new Error("review not found");
  const original = JSON.parse(readFileSync(path, "utf8")) as ReviewReceipt;
  if (!original.transactionId)
    throw new Error("review has no memory transaction");
  const txPath = v2(cfg, "transactions", `${original.transactionId}.json`);
  const transaction = parseTransaction(
    cfg,
    readFileSync(txPath, "utf8"),
    original.transactionId,
  );
  if (transaction.state === "rolled-back" && transaction.rollback) {
    const receipt = persistRollbackReceipt(cfg, transaction)!;
    enqueueMaintenanceEvent(cfg, {
      kind: "adaptation-ready",
      cause: receipt.reviewId,
      basis: adaptationEventBasis(receipt),
    });
    return receipt;
  }
  if (transaction.state !== "applied")
    throw new Error("transaction is not applied");
  for (const action of transaction.actions) {
    if (
      !existsSync(action.to) ||
      sha256(readFileSync(action.to)) !== sha256(action.after)
    )
      throw new Error(`rollback blocked by changed artifact ${action.to}`);
    if (
      action.from &&
      action.from !== action.to &&
      existsSync(action.from) &&
      (action.before === undefined ||
        sha256(readFileSync(action.from)) !== sha256(action.before))
    )
      throw new Error(`rollback blocked by changed source ${action.from}`);
  }
  const at = new Date().toISOString();
  transaction.rollback = {
    reviewId: `review_${sha256(`${reviewId}:rollback:${at}`).slice(0, 24)}`,
    reason: reason.trim(),
    startedAt: at,
    actor,
    ...(policyDecisionId ? { policyDecisionId } : {}),
  };
  transaction.state = "rollback-prepared";
  atomicWrite(txPath, `${JSON.stringify(transaction, null, 2)}\n`);
  withWritableMemoryRoot(cfg, () => {
    restoreTransactionActions(transaction);
    commitTransactionHistory(
      cfg,
      transaction,
      "rollback",
      transaction.rollback!.reviewId,
      transaction.rollback!.reason,
      true,
    );
  });
  transaction.state = "rolled-back";
  atomicWrite(txPath, `${JSON.stringify(transaction, null, 2)}\n`);
  writeCatalog(cfg);
  const receipt = persistRollbackReceipt(cfg, transaction)!;
  enqueueMaintenanceEvent(cfg, {
    kind: "adaptation-ready",
    cause: receipt.reviewId,
    basis: adaptationEventBasis(receipt),
  });
  syncHistory(cfg);
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

function migrateV1Impl(
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
  const processedDir = join(cfg.data, "queue/processed");
  const processed = existsSync(processedDir)
    ? readdirSync(processedDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  const v2LedgerDir = v2(cfg, "ledger");
  const v2Covered = existsSync(v2LedgerDir)
    ? readdirSync(v2LedgerDir)
        .filter((name) => name.endsWith(".json") && !name.startsWith("v1-"))
        .map((name) => basename(name, ".json"))
    : [];
  const outputs = new Set([
    ...candidates.map((name) => basename(name, ".md")),
    ...receipts.map((name) => basename(name, ".json")),
  ]);
  const missing = processed.filter((name) => {
    const id = basename(name, ".json");
    return (
      !outputs.has(id) &&
      !v2Covered.some(
        (covered) => covered === id || id.endsWith(`--${covered}`),
      )
    );
  });
  if (missing.length)
    throw new Error(
      `legacy migration missing outputs for ${missing.slice(0, 5).join(", ")}`,
    );
  if (processed.length < candidates.length + receipts.length)
    throw new Error("legacy migration output/processed count mismatch");
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
    const proposal: Omit<Proposal, "id"> = {
      version: 2,
      digestVersion: 2,
      lane: "memory",
      status: "pending",
      operation: { type: "create", artifact },
      supersedes: [],
      evidence: [],
      provenance: {
        runId: `migration_${seed.slice(0, 24)}`,
        promptVersion: 1,
        model: "legacy-v1",
        createdAt: `${parsed.artifact.created}T00:00:00.000Z`,
        migration: true,
        corpusAware: false,
      },
    };
    saveProposal(cfg, { ...proposal, id: canonicalProposalId(proposal) });
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

export function saveProposal(
  ...args: Parameters<typeof saveProposalImpl>
): ReturnType<typeof saveProposalImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.saveProposal",
      correlation: { proposalId: safeOperationId(args[1]?.id) },
      result: () => ({ fields: { proposalId: args[1].id } }),
    },
    () => saveProposalImpl(...args),
  );
}

export function submitManualProposal(
  ...args: Parameters<typeof submitManualProposalImpl>
): ReturnType<typeof submitManualProposalImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.submitManualProposal",
      result: (proposals) => ({
        outcome: proposals.length ? "success" : "skipped",
        fields: { proposalCount: proposals.length },
      }),
    },
    () => submitManualProposalImpl(...args),
  );
}

export function recoverTransactions(
  ...args: Parameters<typeof recoverTransactionsImpl>
): ReturnType<typeof recoverTransactionsImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.recoverTransactions",
      result: (recovered) => ({
        outcome: recovered ? "success" : "skipped",
        fields: { recoveredCount: recovered },
      }),
    },
    () => recoverTransactionsImpl(...args),
  );
}

export function reviewProposal(
  ...args: Parameters<typeof reviewProposalImpl>
): ReturnType<typeof reviewProposalImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.reviewProposal",
      correlation: { proposalId: safeOperationId(args[0]?.id) },
      result: (receipt) => ({
        fields: {
          proposalId: receipt.proposalId,
          reviewId: receipt.reviewId,
          ...(receipt.transactionId
            ? { transactionId: receipt.transactionId }
            : {}),
          decision: receipt.decision,
          artifactCount: receipt.finalArtifacts.length,
        },
      }),
    },
    () => reviewProposalImpl(...args),
  );
}

export function applyMemoryProposal(
  ...args: Parameters<typeof applyMemoryProposalImpl>
): ReturnType<typeof applyMemoryProposalImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.applyMemoryProposal",
      correlation: { proposalId: safeOperationId(args[0]?.id) },
      result: (receipt) => ({
        fields: {
          proposalId: receipt.proposalId,
          reviewId: receipt.reviewId,
          ...(receipt.transactionId
            ? { transactionId: receipt.transactionId }
            : {}),
          decision: receipt.decision,
          artifactCount: receipt.finalArtifacts.length,
        },
      }),
    },
    () => {
      const receipt = applyMemoryProposalImpl(...args);
      enqueueTieringAfterMutation(args[0].cfg);
      return receipt;
    },
  );
}

export function verifyPersistedRollbackLinkage(
  ...args: Parameters<typeof verifyPersistedRollbackLinkageImpl>
): ReturnType<typeof verifyPersistedRollbackLinkageImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.verifyPersistedRollbackLinkage",
      correlation: {
        proposalId: safeOperationId(args[1]?.proposalId),
        reviewId: safeOperationId(args[1]?.reviewId),
      },
      result: (linkage) => ({
        fields: {
          proposalId: linkage.receipt.proposalId,
          reviewId: linkage.receipt.reviewId,
          transactionId: linkage.transactionId,
          decision: linkage.receipt.decision,
        },
      }),
    },
    () => verifyPersistedRollbackLinkageImpl(...args),
  );
}

export function reconcileRollbackAdaptationEvents(
  ...args: Parameters<typeof reconcileRollbackAdaptationEventsImpl>
): ReturnType<typeof reconcileRollbackAdaptationEventsImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.reconcileRollbackAdaptationEvents",
      result: (enqueued) => ({
        outcome: enqueued ? "success" : "skipped",
        fields: { enqueuedCount: enqueued },
      }),
    },
    () => reconcileRollbackAdaptationEventsImpl(...args),
  );
}

export function rollbackReview(
  ...args: Parameters<typeof rollbackReviewImpl>
): ReturnType<typeof rollbackReviewImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.rollbackReview",
      correlation: { reviewId: safeOperationId(args[1]) },
      result: (receipt) => ({
        fields: {
          proposalId: receipt.proposalId,
          reviewId: receipt.reviewId,
          ...(receipt.transactionId
            ? { transactionId: receipt.transactionId }
            : {}),
          decision: receipt.decision,
          artifactCount: receipt.finalArtifacts.length,
        },
      }),
    },
    () => {
      const receipt = rollbackReviewImpl(...args);
      enqueueTieringAfterMutation(args[0]);
      return receipt;
    },
  );
}

export function migrateV1(
  ...args: Parameters<typeof migrateV1Impl>
): ReturnType<typeof migrateV1Impl> {
  return observeMemoryOperation(
    {
      operation: "memory.migrateV1",
      fields: { dryRun: args[1] ?? false },
      result: (migration) => ({
        outcome:
          migration.candidates || migration.receipts ? "success" : "skipped",
        fields: {
          proposalCount: migration.candidates,
          receiptCount: migration.receipts,
        },
      }),
    },
    () => migrateV1Impl(...args),
  );
}
