import { observeMemoryOperation } from "./observability.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  atomicWrite,
  contained,
  scanCatalog,
  secureDir,
  sha256,
  type Catalog,
  type MemoryConfig,
} from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { REASONING_LEVELS, type ReasoningLevel } from "./audit.js";
import {
  buildReflectionPrompt,
  freezePipelineInput,
  PRODUCTION_TARGET_LIMIT,
  rankRetrieval,
  parseStoredPipelineInput,
  parseStoredPipelineResult,
  type PipelineInput,
} from "./pipeline.js";
import {
  parseModelProposal,
  type Proposal,
  type ReviewReceipt,
} from "./schema.js";
import { findProposal, listProposals, readReviewReceipts } from "./workflow.js";
import {
  CHECKPOINT_ENTRY_TYPE,
  parseTurnReceiptObservation,
  TURN_RECEIPT_ENTRY_TYPE,
  validateTurnReceiptBinding,
  type MemoryRef,
  type TurnReceipt,
} from "./receipt.js";
import { adaptationQualityKey, deriveAdaptationQuality } from "./quality.js";
import {
  parseAdaptationDecisions,
  parseRollbackEvidence,
  parseTurnObservation,
  type AdaptationDecision,
} from "./adaptation.js";
import {
  MAINTENANCE_EVENT_KINDS,
  parseMaintenanceEvent,
  type MaintenanceEventStatus,
} from "./events.js";
import {
  commitHistory,
  historyContainsAncestor,
  historyEntryByMutationId,
  historyReceiptAt,
  isHistoryInitialized,
  listHistoryByKind,
  verifyHistory,
} from "./history.js";

export const FEEDBACK_REASON_CODES = [
  "retrieved-relevant",
  "improved-outcome",
  "retrieved-irrelevant",
  "caused-error",
  "stale-or-wrong",
] as const;
export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];
type RetrievalObservation = {
  query: string;
  workspaces: string[];
  catalogSha256: string;
  ranked: Array<{ memoryId: string; artifactSha256: string }>;
};
export type FeedbackReceipt = {
  version: 2;
  feedbackId: string;
  proposalId: string;
  reviewId: string;
  historyCommit: string;
  reviewReceiptSha256: string;
  outcome: "useful" | "harmful";
  reasonCode: FeedbackReasonCode;
  recordedAt: string;
  relevant: Array<{ memoryId: string; artifactSha256: string }>;
  observation?: RetrievalObservation;
  supersedes?: string;
};
export type FeedbackRecord = FeedbackReceipt & { commit: string };

export type EvalCase = {
  schemaVersion: 2;
  caseId: string;
  source: {
    runId: string;
    windowIds: string[];
    evidenceSha256: string;
  };
  input: { scope: string; sanitizedEvidence: SafeEvidence[] };
  candidate: Proposal;
  review: ReviewReceipt;
  gold: {
    operation: Proposal["operation"];
    artifactSha256?: string;
    artifactPath?: string;
    context: Pick<
      PipelineInput,
      "catalog" | "targets" | "pending" | "reviewSignals" | "skills"
    >;
  };
  retrieval: { targetIds: string[]; catalogSha256: string };
};

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

function goldContext(
  cfg: MemoryConfig,
  input: PipelineInput,
  candidate: Proposal,
  review: ReviewReceipt,
): EvalCase["gold"]["context"] {
  const context = {
    catalog: { ...input.catalog, entries: [...input.catalog.entries] },
    targets: [...input.targets],
    pending: [...input.pending],
    reviewSignals: [...input.reviewSignals],
    skills: [...input.skills],
  };
  const operation = candidate.operation;
  if (operation.type === "skill-draft") {
    const skillFile = operation.files.find(
      (file) => file.path === operation.targetPath,
    );
    const description = skillFile?.content
      ? /^description:\s*["']?(.+?)["']?$/m.exec(skillFile.content)?.[1]?.trim()
      : undefined;
    if (skillFile && description) {
      context.skills = context.skills.filter(
        (skill) => skill.name !== operation.skillName,
      );
      context.skills.push({
        name: operation.skillName,
        description: description.slice(0, 300),
        sha256: skillFile.sha256,
      });
      context.skills.sort((a, b) => a.name.localeCompare(b.name));
      if (context.skills.length > 100) {
        const gold = context.skills.find(
          (skill) => skill.name === operation.skillName,
        )!;
        context.skills = context.skills
          .filter((skill) => skill.name !== operation.skillName)
          .slice(0, 99);
        context.skills.push(gold);
        context.skills.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return context;
  }

  const removed = new Set<string>();
  if (operation.type === "update") removed.add(operation.target.memoryId);
  else if (operation.type === "merge") {
    removed.add(operation.primary.memoryId);
    for (const target of operation.targets) removed.add(target.memoryId);
  } else if (operation.type === "archive" || operation.type === "retire")
    removed.add(operation.target.memoryId);
  context.catalog.entries = context.catalog.entries.filter(
    (entry) => !removed.has(entry.memoryId),
  );
  context.targets = context.targets.filter(
    (entry) => !removed.has(entry.memoryId),
  );

  if ("artifact" in operation) {
    const artifact = operation.artifact;
    const final = review.finalArtifacts.find(
      (item) => item.status === "active",
    );
    const snapshot = final
      ? contained(
          cfg.data,
          join(cfg.data, "v2", "artifacts", `${final.sha256}.md`),
        )
      : undefined;
    const entry = {
      memoryId: artifact.memoryId,
      path: final?.path || "gold.md",
      title: artifact.title,
      description: artifact.description,
      kind: artifact.kind,
      scope: artifact.scope,
      triggers: artifact.triggers,
      keywords: artifact.keywords,
      status: "active" as const,
      sha256: final?.sha256 || sha256(artifact.body),
      updated: artifact.updated,
      legacy: false,
    };
    context.catalog.entries.push(entry);
    context.catalog.entries.sort(
      (a, b) =>
        b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
    );
    if (context.catalog.entries.length > 100) {
      const bounded = context.catalog.entries.slice(0, 100);
      if (!bounded.some((item) => item.memoryId === entry.memoryId))
        bounded[bounded.length - 1] = entry;
      context.catalog.entries = bounded.sort(
        (a, b) =>
          b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
      );
    }
    const target = {
      ...entry,
      body:
        snapshot && existsSync(snapshot)
          ? readFileSync(snapshot, "utf8").slice(0, 12_000)
          : artifact.body,
    };
    context.targets.push(target);
    if (context.targets.length > 8)
      context.targets = [...context.targets.slice(0, 7), target];
  }
  return context;
}

function evalRoot(cfg: MemoryConfig, ...parts: string[]): string {
  return contained(cfg.data, join(cfg.data, "v2", "eval", ...parts));
}

function runInput(cfg: MemoryConfig, runId: string): PipelineInput | undefined {
  const path = contained(
    cfg.data,
    join(cfg.data, "v2", "runs", runId, "input.json"),
  );
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as PipelineInput)
    : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .filter((key) => item[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function feedbackRequest(
  receipt: Omit<FeedbackReceipt, "feedbackId"> | FeedbackReceipt,
): unknown {
  const {
    feedbackId: _feedbackId,
    recordedAt: _recordedAt,
    ...request
  } = receipt as FeedbackReceipt;
  return request;
}

function feedbackIdentity(
  receipt: Omit<FeedbackReceipt, "feedbackId">,
): string {
  return `feedback_${sha256(canonical(feedbackRequest(receipt))).slice(0, 32)}`;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function parseFeedback(raw: string): FeedbackReceipt {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid feedback receipt");
  const item = value as Record<string, unknown>;
  const optional = [
    item.observation === undefined ? undefined : "observation",
    item.supersedes === undefined ? undefined : "supersedes",
  ].filter((key): key is string => !!key);
  if (
    !exact(item, [
      "version",
      "feedbackId",
      "proposalId",
      "reviewId",
      "historyCommit",
      "reviewReceiptSha256",
      "outcome",
      "reasonCode",
      "recordedAt",
      "relevant",
      ...optional,
    ]) ||
    item.version !== 2 ||
    typeof item.feedbackId !== "string" ||
    typeof item.proposalId !== "string" ||
    typeof item.reviewId !== "string" ||
    typeof item.historyCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(item.historyCommit) ||
    !/^[a-f0-9]{64}$/.test(String(item.reviewReceiptSha256)) ||
    (item.outcome !== "useful" && item.outcome !== "harmful") ||
    !FEEDBACK_REASON_CODES.includes(item.reasonCode as FeedbackReasonCode) ||
    typeof item.recordedAt !== "string" ||
    Number.isNaN(Date.parse(item.recordedAt)) ||
    (item.supersedes !== undefined &&
      (typeof item.supersedes !== "string" ||
        !/^feedback_[a-f0-9]{32}$/.test(item.supersedes)))
  )
    throw new Error("invalid feedback receipt");
  const relevant = item.relevant;
  if (
    !Array.isArray(relevant) ||
    relevant.length > 100 ||
    !relevant.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        exact(entry as Record<string, unknown>, [
          "memoryId",
          "artifactSha256",
        ]) &&
        /^mem_[a-f0-9]{24}$/.test(
          String((entry as Record<string, unknown>).memoryId),
        ) &&
        /^[a-f0-9]{64}$/.test(
          String((entry as Record<string, unknown>).artifactSha256),
        ),
    )
  )
    throw new Error("invalid feedback receipt");
  if (item.observation !== undefined) {
    const observation = item.observation as Record<string, unknown>;
    if (
      !observation ||
      typeof observation !== "object" ||
      !exact(observation, ["query", "workspaces", "catalogSha256", "ranked"]) ||
      typeof observation.query !== "string" ||
      !observation.query.trim() ||
      observation.query.length > 500 ||
      /[\r\n]/.test(observation.query) ||
      !Array.isArray(observation.workspaces) ||
      observation.workspaces.length === 0 ||
      !observation.workspaces.every(
        (workspace) =>
          typeof workspace === "string" &&
          !!workspace.trim() &&
          workspace.length <= 1000 &&
          !/[\r\n]/.test(workspace),
      ) ||
      !/^[a-f0-9]{64}$/.test(String(observation.catalogSha256)) ||
      !Array.isArray(observation.ranked) ||
      !observation.ranked.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          exact(entry as Record<string, unknown>, [
            "memoryId",
            "artifactSha256",
          ]) &&
          /^mem_[a-f0-9]{24}$/.test(
            String((entry as Record<string, unknown>).memoryId),
          ) &&
          /^[a-f0-9]{64}$/.test(
            String((entry as Record<string, unknown>).artifactSha256),
          ),
      ) ||
      new Set(
        (observation.ranked as Array<{ memoryId: string }>).map(
          (entry) => entry.memoryId,
        ),
      ).size !== observation.ranked.length
    )
      throw new Error("invalid feedback observation");
  }
  const receipt = item as FeedbackReceipt;
  const { feedbackId: _id, ...identity } = receipt;
  if (feedbackIdentity(identity) !== receipt.feedbackId)
    throw new Error("feedback receipt id does not match content");
  return receipt;
}

function reviewForFeedback(
  cfg: MemoryConfig,
  receipt: FeedbackReceipt,
  feedbackCommit?: string,
): ReviewReceipt {
  const review = readReviewReceipts(cfg).find(
    (item) => item.reviewId === receipt.reviewId,
  );
  if (
    !review ||
    review.proposalId !== receipt.proposalId ||
    review.historyCommit !== receipt.historyCommit ||
    review.decision !== "accepted" ||
    sha256(canonical(review)) !== receipt.reviewReceiptSha256
  )
    throw new Error("feedback review linkage is invalid");
  const history = historyReceiptAt(cfg, receipt.historyCommit);
  if (
    history.reviewId !== review.reviewId ||
    history.proposalId !== review.proposalId ||
    history.mutationId !== review.mutationId
  )
    throw new Error("feedback history linkage is invalid");
  if (
    !historyContainsAncestor(
      cfg,
      receipt.historyCommit,
      feedbackCommit ?? "HEAD",
    )
  )
    throw new Error("feedback artifact history is not an ancestor");
  for (const relevant of receipt.relevant)
    if (
      !history.changes.some(
        (change) =>
          change.memoryId === relevant.memoryId &&
          change.afterSha256 === relevant.artifactSha256,
      )
    )
      throw new Error("feedback artifact is not bound to history");
  return review;
}

export function readFeedbackReceipts(cfg: MemoryConfig): FeedbackRecord[] {
  const entries = listHistoryByKind(cfg, "evaluation-feedback");
  const receipts = entries.map((entry) => {
    const provenance = entry.receipt.provenance;
    if (
      !provenance ||
      typeof provenance !== "object" ||
      Array.isArray(provenance) ||
      Object.keys(provenance).sort().join(",") !== "feedback"
    )
      throw new Error("invalid feedback history provenance");
    const receipt = parseFeedback(
      JSON.stringify((provenance as { feedback: unknown }).feedback),
    );
    if (entry.receipt.mutationId !== receipt.feedbackId)
      throw new Error("feedback history mutation mismatch");
    reviewForFeedback(cfg, receipt, entry.commit);
    return { ...receipt, commit: entry.commit };
  });
  const ids = new Set(receipts.map((receipt) => receipt.feedbackId));
  const children = new Map<string, number>();
  for (const receipt of receipts) {
    if (receipt.supersedes && !ids.has(receipt.supersedes))
      throw new Error("feedback supersedes unknown receipt");
    if (receipt.supersedes) {
      children.set(
        receipt.supersedes,
        (children.get(receipt.supersedes) ?? 0) + 1,
      );
      const prior = receipts.find(
        (item) => item.feedbackId === receipt.supersedes,
      )!;
      if (!historyContainsAncestor(cfg, prior.commit, receipt.commit))
        throw new Error("superseded feedback commit is not an ancestor");
    }
  }
  if ([...children.values()].some((count) => count > 1))
    throw new Error("feedback receipt has conflicting corrections");
  return receipts;
}

function feedbackKey(receipt: FeedbackReceipt): string {
  return sha256(
    canonical([
      receipt.reviewId,
      receipt.historyCommit,
      receipt.relevant,
      receipt.observation,
    ]),
  );
}

function activeFeedback(cfg: MemoryConfig): FeedbackReceipt[] {
  const receipts = readFeedbackReceipts(cfg);
  const byId = new Map(
    receipts.map((receipt) => [receipt.feedbackId, receipt]),
  );
  const superseded = new Set(
    receipts.flatMap((receipt) =>
      receipt.supersedes ? [receipt.supersedes] : [],
    ),
  );
  for (const receipt of receipts)
    if (receipt.supersedes) {
      const prior = byId.get(receipt.supersedes)!;
      if (feedbackKey(prior) !== feedbackKey(receipt))
        throw new Error(
          "feedback correction must preserve observation and artifact version",
        );
    }
  const active = receipts.filter(
    (receipt) => !superseded.has(receipt.feedbackId),
  );
  const keys = active.map(feedbackKey);
  if (new Set(keys).size !== keys.length)
    throw new Error("feedback key has multiple active receipts");
  return active;
}

function recordMemoryFeedbackImpl(options: {
  cfg: MemoryConfig;
  reference: string;
  outcome: "useful" | "harmful";
  reasonCode: FeedbackReasonCode;
  query?: string;
  workspace?: string;
  memoryIds?: string[];
  supersedes?: string;
}): FeedbackRecord {
  if (!FEEDBACK_REASON_CODES.includes(options.reasonCode))
    throw new Error("unknown feedback reason code");
  if ((options.query === undefined) !== (options.workspace === undefined))
    throw new Error("retrieval feedback requires query and workspace");
  const reviews = readReviewReceipts(options.cfg);
  const matches = reviews.filter(
    (review) =>
      review.reviewId === options.reference ||
      review.proposalId === options.reference,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "ambiguous feedback reference"
        : "reviewed proposal/history receipt not found",
    );
  const review = matches[0]!;
  if (!review.historyCommit)
    throw new Error("feedback requires committed history");
  if (review.decision !== "accepted")
    throw new Error("feedback requires an unedited accepted review");
  const history = historyReceiptAt(options.cfg, review.historyCommit);
  if (
    history.reviewId !== review.reviewId ||
    history.proposalId !== review.proposalId ||
    history.mutationId !== review.mutationId
  )
    throw new Error("feedback history linkage is invalid");
  if (!historyContainsAncestor(options.cfg, review.historyCommit))
    throw new Error("feedback artifact history is not an ancestor");
  findProposal(options.cfg, review.proposalId);
  const requested = new Set(
    options.memoryIds ??
      history.changes
        .map((change) => change.memoryId)
        .filter((id): id is string => !!id),
  );
  let relevant = [...requested].sort().map((memoryId) => {
    const change = history.changes.find(
      (item) => item.memoryId === memoryId && item.afterSha256,
    );
    if (!change?.afterSha256)
      throw new Error(`feedback references unavailable artifact ${memoryId}`);
    return { memoryId, artifactSha256: change.afterSha256 };
  });
  const catalog = scanCatalog(options.cfg.root);
  let observation =
    options.query && options.workspace
      ? {
          query: options.query.trim(),
          workspaces: [options.workspace.trim()],
          catalogSha256: sha256(JSON.stringify(catalog.entries)),
          ranked: rankRetrieval(catalog, options.query, [
            options.workspace,
          ]).map((entry) => ({
            memoryId: entry.memoryId,
            artifactSha256: entry.sha256,
          })),
        }
      : undefined;
  if (options.outcome === "useful" && relevant.length === 0)
    throw new Error(
      "useful feedback requires a relevant history-bound artifact",
    );
  if (observation && relevant.length === 0)
    throw new Error("retrieval feedback requires relevant memories");
  const prior = options.supersedes
    ? activeFeedback(options.cfg).find(
        (item) => item.feedbackId === options.supersedes,
      )
    : undefined;
  if (options.supersedes && !prior)
    throw new Error("feedback supersedes unknown receipt");
  if (prior) {
    if (
      options.query !== prior.observation?.query ||
      options.workspace !== prior.observation?.workspaces[0]
    )
      throw new Error(
        "feedback correction must preserve observation and artifact version",
      );
    relevant = prior.relevant;
    observation = prior.observation;
  }
  const recordedAt = new Date().toISOString();
  const identity: Omit<FeedbackReceipt, "feedbackId"> = {
    version: 2,
    proposalId: review.proposalId,
    reviewId: review.reviewId,
    historyCommit: review.historyCommit,
    reviewReceiptSha256: sha256(canonical(review)),
    outcome: options.outcome,
    reasonCode: options.reasonCode,
    recordedAt,
    relevant,
    ...(observation ? { observation } : {}),
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
  };
  if (prior) {
    const candidate = { ...identity, feedbackId: "" } as FeedbackReceipt;
    if (feedbackKey(prior) !== feedbackKey(candidate))
      throw new Error(
        "feedback correction must preserve observation and artifact version",
      );
  }
  const receipt = { ...identity, feedbackId: feedbackIdentity(identity) };
  const recovered = historyEntryByMutationId(options.cfg, receipt.feedbackId);
  if (recovered) {
    if (
      recovered.receipt.kind !== "evaluation-feedback" ||
      !recovered.receipt.provenance ||
      typeof recovered.receipt.provenance !== "object"
    )
      throw new Error("duplicate feedback mutation id");
    const stored = parseFeedback(
      JSON.stringify(
        (recovered.receipt.provenance as { feedback?: unknown }).feedback,
      ),
    );
    if (
      canonical(feedbackRequest(stored)) !== canonical(feedbackRequest(receipt))
    )
      throw new Error("duplicate feedback id has different request");
    return { ...stored, commit: recovered.commit };
  }
  const sameKey = activeFeedback(options.cfg).find(
    (item) => feedbackKey(item) === feedbackKey(receipt),
  );
  if (sameKey && sameKey.feedbackId !== options.supersedes)
    throw new Error("feedback key already has an active receipt; supersede it");
  const published = commitHistory(
    options.cfg,
    {
      version: 2,
      mutationId: receipt.feedbackId,
      kind: "evaluation-feedback",
      reason: receipt.reasonCode,
      changes: [],
      provenance: { feedback: receipt },
    },
    { allowEmpty: true },
  );
  return { ...receipt, commit: published.commit };
}

function eligibleUsefulReviews(cfg: MemoryConfig): Set<string> {
  return new Set(
    activeFeedback(cfg)
      .filter((item) => item.outcome === "useful")
      .map((item) => item.reviewId),
  );
}

export function buildEvalCases(cfg: MemoryConfig): EvalCase[] {
  const usefulReviews = eligibleUsefulReviews(cfg);
  const cases: EvalCase[] = [];
  const reviews = readReviewReceipts(cfg);
  const rolledBackTransactions = new Set(
    reviews
      .filter((review) => review.decision === "rolled-back")
      .map((review) => review.transactionId)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const review of reviews) {
    if (
      !usefulReviews.has(review.reviewId) ||
      review.decision !== "accepted" ||
      (review.transactionId && rolledBackTransactions.has(review.transactionId))
    )
      continue;
    let candidate: Proposal;
    try {
      candidate = findProposal(cfg, review.proposalId).proposal;
    } catch {
      continue;
    }
    if (
      candidate.operation.type !== "create" &&
      candidate.operation.type !== "update"
    )
      continue;
    const input = runInput(cfg, candidate.provenance.runId);
    if (!input) continue;
    const artifact = review.finalArtifacts.find(
      (item) => item.status === "active",
    );
    cases.push({
      schemaVersion: 2,
      caseId: `case_${sha256(`${review.reviewId}:${candidate.id}`).slice(0, 24)}`,
      source: {
        runId: candidate.provenance.runId,
        windowIds: input.evidence.map((item) => item.window.windowId),
        evidenceSha256: sha256(JSON.stringify(input.evidence)),
      },
      input: { scope: input.scope, sanitizedEvidence: input.evidence },
      candidate,
      review,
      gold: {
        operation: candidate.operation,
        context: goldContext(cfg, input, candidate, review),
        ...(artifact
          ? { artifactSha256: artifact.sha256, artifactPath: artifact.path }
          : {}),
      },
      retrieval: {
        targetIds: input.targets.map((target) => target.memoryId),
        catalogSha256: sha256(JSON.stringify(input.catalog)),
      },
    });
  }
  return cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function exportEvalDatasetImpl(
  cfg: MemoryConfig,
  output: string,
): { cases: number; path: string } {
  const path = resolve(output);
  const cases = buildEvalCases(cfg);
  atomicWrite(
    path,
    `${cases.map((item) => JSON.stringify(item)).join("\n")}${cases.length ? "\n" : ""}`,
  );
  return { cases: cases.length, path };
}

function readDataset(path: string): EvalCase[] {
  return readFileSync(resolve(path), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const item = JSON.parse(line) as Partial<EvalCase>;
      if (item.schemaVersion !== 2 || !item.gold?.context)
        throw new Error("unsupported evaluation dataset; export it again");
      return item as EvalCase;
    });
}

function replayInput(
  cfg: MemoryConfig,
  item: EvalCase,
  mode: "memory-off" | "current" | "gold",
  model: string,
  reasoning: ReasoningLevel,
): PipelineInput {
  const current = freezePipelineInput(
    cfg,
    item.input.scope,
    item.input.sanitizedEvidence,
    model,
    [],
    reasoning,
  );
  if (mode === "current") return current;
  if (mode === "memory-off")
    return {
      ...current,
      catalog: { ...current.catalog, entries: [] },
      targets: [],
      pending: [],
      reviewSignals: [],
      skills: [],
    };
  return {
    ...current,
    ...item.gold.context,
  };
}

function replayDatasetImpl(options: {
  cfg: MemoryConfig;
  dataset: string;
  modes: Array<"memory-off" | "current" | "gold">;
  limit: number;
  model: string;
  reasoning?: ReasoningLevel;
  invoke: (
    prompt: string,
    invocation: {
      identity: string;
      replayId: string;
      model: string;
      reasoning: ReasoningLevel;
    },
  ) => string;
}): { replayId: string; cases: number; outputs: number } {
  const cases = readDataset(options.dataset).slice(0, options.limit);
  const replayId = `replay_${sha256(`${options.dataset}:${Date.now()}`).slice(0, 20)}`;
  const dir = evalRoot(options.cfg, "replays", replayId);
  secureDir(dir);
  let outputs = 0;
  const manifestOutputs: Array<{
    caseId: string;
    mode: string;
    outputSha256: string;
  }> = [];
  for (const item of cases)
    for (const mode of options.modes) {
      const reasoning = options.reasoning ?? "low";
      const input = replayInput(
        options.cfg,
        item,
        mode,
        options.model,
        reasoning,
      );
      const raw = options.invoke(buildReflectionPrompt(input), {
        identity: `${replayId}:${item.caseId}:${mode}`,
        replayId,
        model: options.model,
        reasoning,
      });
      const parsed = parseModelProposal(raw);
      const outputSha256 = sha256(canonical(parsed));
      atomicWrite(
        join(dir, `${item.caseId}-${mode}.json`),
        `${JSON.stringify(
          {
            version: 1,
            replayId,
            caseId: item.caseId,
            mode,
            model: options.model,
            reasoning: options.reasoning ?? "low",
            output: parsed,
            outputSha256,
          },
          null,
          2,
        )}\n`,
      );
      manifestOutputs.push({ caseId: item.caseId, mode, outputSha256 });
      outputs += 1;
    }
  atomicWrite(
    join(dir, "manifest.json"),
    `${JSON.stringify({ version: 2, replayId, dataset: resolve(options.dataset), cases: cases.length, modes: options.modes, model: options.model, reasoning: options.reasoning ?? "low", outputs: manifestOutputs }, null, 2)}\n`,
  );
  return { replayId, cases: cases.length, outputs };
}

type ReplayManifest = {
  version: 2;
  replayId: string;
  cases: number;
  modes: string[];
  model: string;
  reasoning: ReasoningLevel;
  outputs: Array<{ caseId: string; mode: string; outputSha256: string }>;
};
function readReplayManifest(
  cfg: MemoryConfig,
  replayId: string,
): ReplayManifest {
  const path = evalRoot(cfg, "replays", replayId, "manifest.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink())
    throw new Error("replay not found");
  const value = JSON.parse(readFileSync(path, "utf8")) as ReplayManifest;
  if (
    value.version !== 2 ||
    value.replayId !== replayId ||
    !Number.isInteger(value.cases) ||
    value.cases < 0 ||
    !Array.isArray(value.modes) ||
    typeof value.model !== "string" ||
    !REASONING_LEVELS.includes(value.reasoning) ||
    !Array.isArray(value.outputs) ||
    !value.outputs.every(
      (output) =>
        output &&
        /^case_[a-f0-9]{24}$/.test(output.caseId) &&
        (output.mode === "memory-off" ||
          output.mode === "current" ||
          output.mode === "gold") &&
        /^[a-f0-9]{64}$/.test(output.outputSha256),
    )
  )
    throw new Error("invalid replay manifest");
  const keys = value.outputs.map((output) => `${output.caseId}:${output.mode}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("invalid replay manifest");
  const dir = evalRoot(cfg, "replays", replayId);
  for (const expected of value.outputs) {
    const outputPath = join(dir, `${expected.caseId}-${expected.mode}.json`);
    if (!existsSync(outputPath) || lstatSync(outputPath).isSymbolicLink())
      throw new Error("manifest replay output is unavailable");
    const output = JSON.parse(readFileSync(outputPath, "utf8")) as {
      replayId: string;
      caseId: string;
      mode: string;
      model: string;
      reasoning: ReasoningLevel;
      output: unknown;
      outputSha256: string;
    };
    const digest = sha256(canonical(output.output));
    if (
      output.replayId !== replayId ||
      output.caseId !== expected.caseId ||
      output.mode !== expected.mode ||
      output.model !== value.model ||
      output.reasoning !== value.reasoning ||
      output.outputSha256 !== digest ||
      expected.outputSha256 !== digest
    )
      throw new Error("manifest replay output digest mismatch");
  }
  return value;
}

function gradeReplayImpl(options: {
  cfg: MemoryConfig;
  replayId: string;
  caseId: string;
  mode: "memory-off" | "current" | "gold";
  score: number;
  reason: string;
}): string {
  if (!Number.isFinite(options.score) || options.score < 0 || options.score > 1)
    throw new Error("score must be between 0 and 1");
  if (!options.reason.trim()) throw new Error("grade requires a reason");
  const manifest = readReplayManifest(options.cfg, options.replayId);
  const expected = manifest.outputs.filter(
    (output) =>
      output.caseId === options.caseId && output.mode === options.mode,
  );
  if (expected.length !== 1)
    throw new Error("grade does not match a replay output");
  const outputPath = evalRoot(
    options.cfg,
    "replays",
    options.replayId,
    `${options.caseId}-${options.mode}.json`,
  );
  if (!existsSync(outputPath) || lstatSync(outputPath).isSymbolicLink())
    throw new Error("replay output is unavailable");
  const output = JSON.parse(readFileSync(outputPath, "utf8")) as {
    replayId: string;
    caseId: string;
    mode: string;
    output: unknown;
    outputSha256: string;
  };
  const outputSha256 = sha256(canonical(output.output));
  if (
    output.replayId !== options.replayId ||
    output.caseId !== options.caseId ||
    output.mode !== options.mode ||
    output.outputSha256 !== outputSha256 ||
    expected[0]!.outputSha256 !== outputSha256
  )
    throw new Error("replay output digest mismatch");
  const path = evalRoot(
    options.cfg,
    "replays",
    options.replayId,
    `${options.caseId}-${options.mode}.grade.json`,
  );
  if (existsSync(path)) throw new Error("replay grade already exists");
  atomicWrite(
    path,
    `${JSON.stringify({ version: 2, replayId: options.replayId, caseId: options.caseId, mode: options.mode, outputSha256, score: options.score, reason: options.reason, gradedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function evalReportImpl(
  cfg: MemoryConfig,
  replayId: string,
): Record<string, unknown> {
  const manifest = readReplayManifest(cfg, replayId);
  const dir = evalRoot(cfg, "replays", replayId);
  const allowed = new Map(
    manifest.outputs.map((output) => [
      `${output.caseId}:${output.mode}`,
      output,
    ]),
  );
  const grades = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".grade.json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("grade must be a regular file");
      const grade = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as {
        version: number;
        replayId: string;
        caseId: string;
        mode: string;
        outputSha256: string;
        score: number;
      };
      const expected = allowed.get(`${grade.caseId}:${grade.mode}`);
      if (expected) {
        const outputPath = join(dir, `${grade.caseId}-${grade.mode}.json`);
        if (!existsSync(outputPath) || lstatSync(outputPath).isSymbolicLink())
          throw new Error("retained replay output is unavailable");
        const retained = JSON.parse(readFileSync(outputPath, "utf8")) as {
          output: unknown;
          outputSha256: string;
        };
        const retainedSha256 = sha256(canonical(retained.output));
        if (
          retained.outputSha256 !== retainedSha256 ||
          expected.outputSha256 !== retainedSha256
        )
          throw new Error("retained replay output digest mismatch");
      }
      if (
        grade.version !== 2 ||
        grade.replayId !== replayId ||
        !expected ||
        grade.outputSha256 !== expected.outputSha256 ||
        !Number.isFinite(grade.score) ||
        grade.score < 0 ||
        grade.score > 1 ||
        entry.name !== `${grade.caseId}-${grade.mode}.grade.json`
      )
        return [];
      return [grade];
    });
  const byCase = new Map<string, Map<string, number>>();
  for (const grade of grades) {
    const modes = byCase.get(grade.caseId) ?? new Map();
    modes.set(grade.mode, grade.score);
    byCase.set(grade.caseId, modes);
  }
  const pairable = new Set(
    manifest.outputs
      .filter((output) => output.mode === "current")
      .map((output) => output.caseId)
      .filter((caseId) =>
        manifest.outputs.some(
          (output) => output.caseId === caseId && output.mode === "memory-off",
        ),
      ),
  );
  const paired = [...byCase.entries()]
    .filter(
      ([caseId, modes]) =>
        pairable.has(caseId) && modes.has("current") && modes.has("memory-off"),
    )
    .map(([, modes]) => modes);
  const average = (mode: string) =>
    paired.length
      ? paired.reduce((sum, modes) => sum + modes.get(mode)!, 0) / paired.length
      : 0;
  return {
    version: 2,
    replayId,
    pairedCases: paired.length,
    pairableCases: pairable.size,
    coverage: pairable.size ? Math.min(1, paired.length / pairable.size) : 0,
    current: average("current"),
    memoryOff: average("memory-off"),
    delta: average("current") - average("memory-off"),
    ignoredUnpaired: grades.length - paired.length * 2,
  };
}

export function retrievalMetrics(
  labels: Array<{
    relevant: Array<{ memoryId: string; artifactSha256: string }>;
    ranked: Array<{ memoryId: string; artifactSha256: string }>;
  }>,
  k: number,
): { relevant: number; recallAtK: number; mrr: number } {
  if (!Number.isInteger(k) || k < 1 || k > PRODUCTION_TARGET_LIMIT)
    throw new Error("invalid retrieval k");
  let relevantTotal = 0,
    recallTotal = 0,
    reciprocalRanks = 0;
  for (const label of labels) {
    const rankedIds = label.ranked.map((item) => item.memoryId);
    if (new Set(rankedIds).size !== rankedIds.length)
      throw new Error("duplicate ranked memory id");
    const relevant = new Set(
      label.relevant.map((item) => `${item.memoryId}:${item.artifactSha256}`),
    );
    const ranked = label.ranked.map(
      (item) => `${item.memoryId}:${item.artifactSha256}`,
    );
    relevantTotal += relevant.size;
    recallTotal += relevant.size
      ? ranked.slice(0, k).filter((item) => relevant.has(item)).length /
        relevant.size
      : 0;
    const first = ranked.findIndex((item) => relevant.has(item));
    if (first >= 0) reciprocalRanks += 1 / (first + 1);
  }
  return {
    relevant: relevantTotal,
    recallAtK: labels.length ? recallTotal / labels.length : 0,
    mrr: labels.length ? reciprocalRanks / labels.length : 0,
  };
}

function retrievalBenchmarkImpl(
  cfg: MemoryConfig,
  k = 5,
): Record<string, unknown> {
  if (!Number.isInteger(k) || k < 1 || k > PRODUCTION_TARGET_LIMIT)
    throw new Error("invalid retrieval k");
  const feedback = activeFeedback(cfg);
  const labels = feedback.filter(
    (item) => item.observation && item.outcome === "useful",
  );
  const metrics = retrievalMetrics(
    labels.map((item) => ({
      relevant: item.relevant,
      ranked: item.observation!.ranked,
    })),
    k,
  );
  return {
    version: 2,
    labels: labels.length,
    ...metrics,
    k,
    negativeLabels: feedback.filter(
      (item) => item.observation && item.outcome === "harmful",
    ).length,
  };
}

function operationalMetrics(cfg: MemoryConfig, now: string) {
  const statuses: MaintenanceEventStatus[] = [
    "pending",
    "processing",
    "done",
    "failed",
  ];
  const byKind = Object.fromEntries(
    MAINTENANCE_EVENT_KINDS.map((kind) => [kind, 0]),
  );
  const byStatus = Object.fromEntries(statuses.map((status) => [status, 0]));
  const records: Array<{
    status: MaintenanceEventStatus;
    event: ReturnType<typeof parseMaintenanceEvent>;
  }> = [];
  let malformedArtifacts = 0;
  for (const status of statuses) {
    const dir = join(cfg.data, "v2", "events", status);
    let names: string[];
    try {
      const metadata = lstatSync(dir);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("invalid event status directory");
      names = readdirSync(dir)
        .filter((item) => item.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      malformedArtifacts++;
      continue;
    }
    for (const name of names) {
      try {
        const path = join(dir, name);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
          throw new Error("invalid event artifact");
        const event = parseMaintenanceEvent(readFileSync(path, "utf8"));
        records.push({ status, event });
        byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      } catch {
        malformedArtifacts++;
      }
    }
  }
  const age = (date: string) =>
    Math.max(0, (Date.parse(now) - Date.parse(date)) / 1000);
  const pending = records.filter((item) => item.status === "pending");
  const failed = records.filter((item) => item.status === "failed");
  const reasons: Record<string, number> = {};
  for (const { event } of failed)
    if (typeof event.basis.reason === "string")
      reasons[event.basis.reason] = (reasons[event.basis.reason] ?? 0) + 1;
  return {
    byKind,
    byStatus,
    oldestPendingAgeSeconds: pending.length
      ? Math.max(...pending.map(({ event }) => age(event.createdAt)))
      : 0,
    maxAttempts: records.length
      ? Math.max(...records.map(({ event }) => event.attempt))
      : 0,
    failedAgesSeconds: failed
      .map(({ event }) => age(event.createdAt))
      .sort((a, b) => b - a),
    failedReasons: Object.fromEntries(
      Object.entries(reasons).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    malformedArtifacts,
  };
}

function durablePipelineMetrics(cfg: MemoryConfig) {
  const root = join(cfg.data, "v2", "runs");
  const results: Array<{ action: string; coveredCheckpointIds: string[] }> = [];
  let malformedArtifacts = 0,
    modelParseFailures = 0;
  if (existsSync(root))
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name),
        inputPath = join(dir, "input.json"),
        outputPath = join(dir, "output.json"),
        resultPath = join(dir, "result.json");
      let input: PipelineInput;
      try {
        input = parseStoredPipelineInput(readFileSync(inputPath, "utf8"));
      } catch {
        malformedArtifacts++;
        continue;
      }
      if (existsSync(outputPath))
        try {
          parseModelProposal(
            readFileSync(outputPath, "utf8"),
            input.evidence.map((item) => item.window.windowId),
          );
        } catch {
          modelParseFailures++;
        }
      if (existsSync(resultPath))
        try {
          results.push(
            parseStoredPipelineResult(readFileSync(resultPath, "utf8"), input),
          );
        } catch {
          malformedArtifacts++;
        }
    }
  return { results, malformedArtifacts, modelParseFailures };
}

function replayMetrics(cfg: MemoryConfig) {
  const root = join(cfg.data, "v2", "eval", "replays"),
    reports: Record<string, unknown>[] = [];
  let malformedArtifacts = 0;
  if (existsSync(root))
    for (const id of readdirSync(root).sort())
      try {
        reports.push(evalReport(cfg, id));
      } catch {
        malformedArtifacts++;
      }
  const pairedCases = reports.reduce(
    (sum, item) => sum + Number(item.pairedCases),
    0,
  );
  const pairable = reports.reduce(
    (sum, item) => sum + Number(item.pairableCases),
    0,
  );
  return {
    replays: reports.length,
    pairedCases,
    pairableCases: pairable,
    coverage: pairable ? pairedCases / pairable : 0,
    delta: pairedCases
      ? reports.reduce(
          (sum, item) => sum + Number(item.delta) * Number(item.pairedCases),
          0,
        ) / pairedCases
      : 0,
    malformedArtifacts,
  };
}

type SessionMetricEntry = {
  type: string;
  id: string;
  parentId: string | null;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
};

const explicitPositiveFeedback =
  /\b(?:thank you|thanks|that worked|works now|solved|fixed it|exactly right|helpful)\b/i;

function sessionFiles(roots: string[]): {
  files: string[];
  malformedRoots: number;
} {
  const files: string[] = [];
  const walk = (root: string, dir: string): void => {
    if (!existsSync(dir)) return;
    const rel = relative(resolve(root), resolve(dir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("session path escapes root");
    const metadata = lstatSync(dir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("invalid session directory");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(root, path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(path);
    }
  };
  let malformedRoots = 0;
  for (const root of [...new Set(roots.map((root) => resolve(root)))])
    try {
      walk(root, root);
    } catch {
      malformedRoots++;
    }
  return { files: files.sort(), malformedRoots };
}

function messageText(entry: SessionMetricEntry): string {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object"
  )
    return "";
  const message = entry.message as Record<string, unknown>;
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string"
            ? [String((part as Record<string, unknown>).text)]
            : [],
        )
        .join("\n")
    : "";
}

function refVersionKey(
  ref: Pick<MemoryRef, "memoryId" | "artifactSha256">,
): string {
  return `${ref.memoryId}\0${ref.artifactSha256}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}

function adaptationEvaluationMetricsImpl(
  cfg: MemoryConfig & { sessions?: string[] },
): Record<string, unknown> {
  const exposures = { injected: 0, searched: 0, opened: 0, cited: 0 };
  const workspaces: Record<string, number> = {};
  let nativeCheckpoints = 0;
  let coveredNativeCheckpoints = 0;
  let validReceipts = 0;
  let malformedReceiptArtifacts = 0;
  const sessions = sessionFiles(cfg.sessions ?? []);
  let malformedSessionArtifacts = sessions.malformedRoots;
  let opened = 0;
  let openedThenCited = 0;
  let cited = 0;
  let citedThenExplicitPositive = 0;
  let citedWithObjectiveToolOutcomeDiagnostic = 0;
  const rankDeltas: number[] = [];

  for (const path of sessions.files) {
    let records: unknown[];
    try {
      const raw = readFileSync(path, "utf8");
      records = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      malformedSessionArtifacts++;
      continue;
    }
    const header = records[0];
    if (
      !header ||
      typeof header !== "object" ||
      (header as Record<string, unknown>).type !== "session" ||
      typeof (header as Record<string, unknown>).id !== "string" ||
      typeof (header as Record<string, unknown>).cwd !== "string"
    ) {
      malformedSessionArtifacts++;
      continue;
    }
    const sessionId = String((header as Record<string, unknown>).id);
    const workspace = String((header as Record<string, unknown>).cwd);
    const entries = records.slice(1) as SessionMetricEntry[];
    if (
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          typeof entry.type !== "string" ||
          typeof entry.id !== "string" ||
          !(entry.parentId === null || typeof entry.parentId === "string"),
      )
    ) {
      malformedSessionArtifacts++;
      continue;
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    if (byId.size !== entries.length) {
      malformedSessionArtifacts++;
      continue;
    }
    const chainThrough = (entry: SessionMetricEntry): SessionMetricEntry[] => {
      const chain: SessionMetricEntry[] = [];
      const seen = new Set<string>();
      let current: SessionMetricEntry | undefined = entry;
      while (current) {
        if (seen.has(current.id)) throw new Error("cyclic session ancestry");
        seen.add(current.id);
        chain.unshift(current);
        current =
          current.parentId === null ? undefined : byId.get(current.parentId);
        if (current === undefined && chain[0]!.parentId !== null)
          throw new Error("dangling session ancestry");
      }
      return chain;
    };
    const receiptRecords: Array<{
      entry: SessionMetricEntry;
      receipt: TurnReceipt;
      chain: SessionMetricEntry[];
    }> = [];
    for (const entry of entries) {
      if (
        entry.type !== "custom" ||
        entry.customType !== TURN_RECEIPT_ENTRY_TYPE
      )
        continue;
      try {
        const observed = parseTurnReceiptObservation(entry.data);
        const chain = chainThrough(entry);
        validateTurnReceiptBinding(chain, entry.id, observed.receipt, {
          sessionId,
          workspace,
        });
        if (observed.diagnostics.length) malformedReceiptArtifacts++;
        receiptRecords.push({ entry, receipt: observed.receipt, chain });
        validReceipts++;
        workspaces[workspace] = (workspaces[workspace] ?? 0) + 1;
        for (const exposure of observed.receipt.exposures)
          exposures[exposure.kind] += 1;
      } catch {
        malformedReceiptArtifacts++;
      }
    }
    for (const record of receiptRecords) {
      const openedRefs = new Set(
        record.receipt.exposures
          .filter((item) => item.kind === "opened")
          .map(refVersionKey),
      );
      const citedRefs = new Set(
        record.receipt.exposures
          .filter((item) => item.kind === "cited")
          .map(refVersionKey),
      );
      opened += openedRefs.size;
      openedThenCited += [...openedRefs].filter((key) =>
        citedRefs.has(key),
      ).length;
      cited += citedRefs.size;
      if (record.receipt.outcomes.length)
        citedWithObjectiveToolOutcomeDiagnostic += citedRefs.size;
      const responses = receiptRecords.filter(
        (candidate) =>
          candidate.receipt.responseToReceiptId === record.receipt.receiptId,
      );
      const explicit = responses.some((response) =>
        response.receipt.userEntryIds.some((id) => {
          const entry = byId.get(id);
          return entry
            ? explicitPositiveFeedback.test(messageText(entry))
            : false;
        }),
      );
      if (explicit) {
        citedThenExplicitPositive += citedRefs.size;
        for (const retrieval of record.receipt.retrievals ?? [])
          for (const key of citedRefs) {
            const production = retrieval.production.findIndex(
              (item) => refVersionKey(item) === key,
            );
            const shadow = retrieval.shadow.findIndex(
              (item) => refVersionKey(item) === key,
            );
            if (production >= 0 && shadow >= 0)
              rankDeltas.push(shadow - production);
          }
      }
    }
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE)
        continue;
      const checkpoint = entry.data as Record<string, unknown>;
      if (
        !checkpoint ||
        typeof checkpoint !== "object" ||
        checkpoint.sessionId !== sessionId
      )
        continue;
      nativeCheckpoints++;
      try {
        if (
          Object.keys(checkpoint).sort().join(",") !==
            "acceptedUserTurns,sessionId,throughLeafId,version" ||
          checkpoint.version !== 2 ||
          typeof checkpoint.throughLeafId !== "string" ||
          !Number.isInteger(checkpoint.acceptedUserTurns)
        )
          throw new Error("invalid native checkpoint");
        const chain = chainThrough(entry);
        const checkpointIndex = chain.findIndex((item) => item.id === entry.id);
        const throughIndex = chain.findIndex(
          (item) => item.id === checkpoint.throughLeafId,
        );
        if (
          throughIndex < 0 ||
          throughIndex >= checkpointIndex ||
          chain
            .slice(0, throughIndex + 1)
            .filter(
              (item) =>
                item.type === "message" &&
                item.message &&
                typeof item.message === "object" &&
                (item.message as Record<string, unknown>).role === "user",
            ).length !== checkpoint.acceptedUserTurns
        )
          throw new Error("invalid native checkpoint count");
        const linked = receiptRecords.some(
          (record) =>
            record.receipt.assistantEntryIds.at(-1) ===
              checkpoint.throughLeafId &&
            chain
              .slice(0, checkpointIndex)
              .some((item) => item.id === record.entry.id),
        );
        if (linked) coveredNativeCheckpoints++;
      } catch {
        // The denominator intentionally retains malformed native checkpoint artifacts.
      }
    }
  }

  let malformedAdaptationArtifacts = 0;
  let publishedDecisions = 0;
  const terminalOutcomes = { applied: 0, stale: 0, error: 0 };
  let staleTargetRejects = 0;
  let recoveryFailures = 0;
  const shadowRoot = join(cfg.data, "v2/adaptation/shadow");
  const shadows = new Map<
    string,
    { eventId: string; decisions: AdaptationDecision[] }
  >();
  if (existsSync(shadowRoot))
    for (const name of readdirSync(shadowRoot)
      .filter((item) => item.endsWith(".json"))
      .sort())
      try {
        const path = join(shadowRoot, name);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
          throw new Error("invalid shadow artifact");
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        const { id, ...identity } = value;
        if (
          typeof id !== "string" ||
          name !== `${id}.json` ||
          id !== `adapt_${sha256(JSON.stringify(identity))}` ||
          typeof value.eventId !== "string" ||
          typeof value.model !== "string" ||
          typeof value.createdAt !== "string" ||
          Number.isNaN(Date.parse(value.createdAt)) ||
          !Array.isArray(value.evidence) ||
          !Array.isArray(value.decisions)
        )
          throw new Error("invalid shadow artifact");
        let decisions: AdaptationDecision[];
        if (value.version === 2 && value.promptVersion === 2) {
          if (!value.catalog || typeof value.catalog !== "object")
            throw new Error("invalid shadow catalog");
          const evidence = value.evidence.map((item) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).kind === "turn-observation"
              ? parseTurnObservation(item)
              : parseRollbackEvidence(item),
          );
          decisions = parseAdaptationDecisions(
            JSON.stringify({ version: 2, decisions: value.decisions }),
            value.catalog as Catalog,
            evidence,
          );
        } else if (value.version === 1 && value.promptVersion === 1) {
          decisions = value.decisions.map(() => ({
            action: "no-op" as const,
            evidenceIds: [],
            reason: "legacy",
          }));
        } else throw new Error("invalid shadow version");
        shadows.set(id, { eventId: value.eventId, decisions });
        publishedDecisions += decisions.length;
      } catch {
        malformedAdaptationArtifacts++;
      }
  const ledgerRoot = join(cfg.data, "v2/adaptation/ledger");
  if (existsSync(ledgerRoot))
    for (const name of readdirSync(ledgerRoot)
      .filter((item) => item.endsWith(".json"))
      .sort())
      try {
        const path = join(ledgerRoot, name);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
          throw new Error("invalid adaptation ledger artifact");
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        const shadow =
          typeof value.shadowId === "string"
            ? shadows.get(value.shadowId)
            : undefined;
        if (
          Object.keys(value).sort().join(",") !== "eventId,shadowId,version" ||
          value.version !== 2 ||
          typeof value.eventId !== "string" ||
          name !== `${value.eventId}.json` ||
          !shadow ||
          shadow.eventId !== value.eventId
        )
          throw new Error("invalid adaptation ledger artifact");
      } catch {
        malformedAdaptationArtifacts++;
      }
  const terminalRoot = join(cfg.data, "v2/adaptation/production");
  if (existsSync(terminalRoot))
    for (const shadowId of readdirSync(terminalRoot).sort()) {
      const dir = join(terminalRoot, shadowId);
      try {
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
          throw new Error("invalid terminal directory");
        for (const name of readdirSync(dir)
          .filter((item) => item.endsWith(".json"))
          .sort()) {
          try {
            const path = join(dir, name);
            if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
              throw new Error("invalid terminal artifact");
            const value = JSON.parse(readFileSync(path, "utf8")) as Record<
              string,
              unknown
            >;
            const optional = [
              ...(value.historyCommit === undefined ? [] : ["historyCommit"]),
              ...(value.proposalId === undefined ? [] : ["proposalId"]),
              ...(value.error === undefined ? [] : ["error"]),
            ];
            if (
              Object.keys(value).sort().join(",") !==
                [
                  "action",
                  "decisionIndex",
                  "outcome",
                  "shadowId",
                  "version",
                  ...optional,
                ]
                  .sort()
                  .join(",") ||
              value.version !== 2 ||
              value.shadowId !== shadowId ||
              !Number.isInteger(value.decisionIndex) ||
              name !== `${Number(value.decisionIndex)}.json` ||
              ![
                "reinforce",
                "repair",
                "demote",
                "archive",
                "no-op",
                "legacy",
              ].includes(String(value.action)) ||
              !["applied", "stale", "error"].includes(String(value.outcome)) ||
              (value.error !== undefined && typeof value.error !== "string")
            )
              throw new Error("invalid adaptation terminal");
            const shadow = shadows.get(shadowId);
            const decisionIndex = Number(value.decisionIndex);
            if (
              value.action === "legacy"
                ? !shadow || decisionIndex !== 0
                : !shadow ||
                  shadow.decisions[decisionIndex]?.action !== value.action
            )
              throw new Error("adaptation terminal is not bound to shadow");
            const outcome = value.outcome as keyof typeof terminalOutcomes;
            terminalOutcomes[outcome] += 1;
            if (
              outcome === "stale" ||
              value.error === "stale adaptation target"
            )
              staleTargetRejects++;
            if (
              outcome === "error" &&
              typeof value.error === "string" &&
              /(?:recover|collision|history|regeneration)/i.test(value.error)
            )
              recoveryFailures++;
          } catch {
            malformedAdaptationArtifacts++;
          }
        }
      } catch {
        malformedAdaptationArtifacts++;
      }
    }

  const catalog = scanCatalog(cfg.root);
  let quality = new Map<string, "reinforced" | "neutral" | "demoted">();
  try {
    quality = deriveAdaptationQuality(cfg);
  } catch {
    malformedAdaptationArtifacts++;
  }
  const liveArtifactVersions = { reinforced: 0, demoted: 0 };
  for (const entry of catalog.entries) {
    const value = quality.get(
      adaptationQualityKey({
        memoryId: entry.memoryId,
        path: entry.path,
        artifactSha256: entry.sha256,
      }),
    );
    if (value === "reinforced" || value === "demoted")
      liveArtifactVersions[value] += 1;
  }
  let verifiedRollbacks = 0;
  try {
    const verification = isHistoryInitialized(cfg)
      ? verifyHistory(cfg)
      : { ok: true };
    if (!verification.ok) throw new Error("invalid rollback history");
    verifiedRollbacks = listHistoryByKind(cfg, "rollback").filter(
      (entry) =>
        entry.receipt.reviewId &&
        entry.receipt.proposalId &&
        entry.receipt.transactionId &&
        entry.receipt.provenance &&
        typeof entry.receipt.provenance === "object" &&
        (entry.receipt.provenance as Record<string, unknown>).reviewer ===
          "local-cli",
    ).length;
  } catch {
    malformedAdaptationArtifacts++;
  }
  let explicitFeedback = 0;
  try {
    explicitFeedback = activeFeedback(cfg).length;
  } catch {
    malformedAdaptationArtifacts++;
  }

  return {
    version: 1,
    receipts: {
      valid: validReceipts,
      malformedArtifacts: malformedReceiptArtifacts,
      malformedSessionArtifacts,
      nativeCheckpoints,
      coveredNativeCheckpoints,
      validReceiptCoveragePerNativeCheckpoint: ratio(
        coveredNativeCheckpoints,
        nativeCheckpoints,
      ),
      workspaces: Object.fromEntries(
        Object.entries(workspaces).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    exposures,
    rates: {
      openedThenCited: {
        numerator: openedThenCited,
        denominator: opened,
        rate: ratio(openedThenCited, opened),
      },
      citedThenExplicitPositiveFeedback: {
        numerator: citedThenExplicitPositive,
        denominator: cited,
        rate: ratio(citedThenExplicitPositive, cited),
      },
      citedWithObjectiveToolOutcomeDiagnostic: {
        numerator: citedWithObjectiveToolOutcomeDiagnostic,
        denominator: cited,
        rate: ratio(citedWithObjectiveToolOutcomeDiagnostic, cited),
      },
    },
    shadowRetrieval: {
      trustedExplicitLabels: rankDeltas.length,
      meanProductionRankImprovementOverShadow: rankDeltas.length
        ? rankDeltas.reduce((sum, delta) => sum + delta, 0) / rankDeltas.length
        : 0,
      rankDeltas,
    },
    adaptation: {
      publishedDecisions,
      terminalOutcomes,
      pendingDecisions: Math.max(
        0,
        publishedDecisions -
          terminalOutcomes.applied -
          terminalOutcomes.stale -
          terminalOutcomes.error,
      ),
      staleTargetRejects,
      malformedArtifacts: malformedAdaptationArtifacts,
      recoveryFailures,
      liveArtifactVersions,
    },
    trustedGold: {
      explicitFeedback,
      verifiedRollbacks,
      observations: 0,
      modelDecisions: 0,
    },
  };
}

function memoryMetricsImpl(
  cfg: MemoryConfig,
  clock: () => string = () => new Date().toISOString(),
): Record<string, unknown> {
  const generatedAt = clock();
  const reviews = readReviewReceipts(cfg);
  const pending = listProposals(cfg);
  const reviewed = listProposals(cfg, undefined, "reviewed");
  const catalog = scanCatalog(cfg.root);
  const ledger = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  const pipeline = durablePipelineMetrics(cfg);
  const results = pipeline.results;
  const reasonCodes = Object.fromEntries(
    [...new Set(reviews.map((review) => review.reason.code))].map((code) => [
      code,
      reviews.filter((review) => review.reason.code === code).length,
    ]),
  );
  return {
    version: 2,
    generatedAt,
    catalog: {
      entries: catalog.entries.length,
      legacy: catalog.entries.filter((entry) => entry.legacy).length,
      promptChars: existsSync(join(cfg.data, "catalog-prompt.md"))
        ? readFileSync(join(cfg.data, "catalog-prompt.md"), "utf8").length
        : 0,
    },
    pipeline: {
      runs: results.length,
      skipped: results.filter((result) => result.action === "skip").length,
      checkpointsCovered: existsSync(ledger)
        ? readdirSync(ledger).filter(
            (name) => name.endsWith(".json") && !name.startsWith("v1-"),
          ).length
        : 0,
      malformedArtifacts: pipeline.malformedArtifacts,
      modelParseFailures: pipeline.modelParseFailures,
      checkpointsPerRun:
        results.length === 0
          ? 0
          : results.reduce(
              (sum, result) => sum + result.coveredCheckpointIds.length,
              0,
            ) / results.length,
    },
    maintenance: operationalMetrics(cfg, generatedAt),
    adaptationEvaluation: adaptationEvaluationMetrics(cfg),
    proposals: {
      pending: pending.length,
      reviewed: reviewed.length,
      byLane: {
        memory: [...pending, ...reviewed].filter(
          (proposal) => proposal.lane === "memory",
        ).length,
        skill: [...pending, ...reviewed].filter(
          (proposal) => proposal.lane === "skill",
        ).length,
      },
    },
    reviews: {
      total: reviews.length,
      autonomous: reviews.filter((review) => review.reviewer !== "local-cli")
        .length,
      human: reviews.filter((review) => review.reviewer === "local-cli").length,
      accepted: reviews.filter((review) => review.decision === "accepted")
        .length,
      edited: reviews.filter((review) => review.decision === "edited").length,
      rejected: reviews.filter((review) => review.decision === "rejected")
        .length,
      rolledBack: reviews.filter((review) => review.decision === "rolled-back")
        .length,
      reasonCodes,
    },
    eval: {
      cases: buildEvalCases(cfg).length,
      paired: replayMetrics(cfg),
      retrieval: retrievalBenchmark(cfg),
    },
  };
}

export function recordMemoryFeedback(
  ...args: Parameters<typeof recordMemoryFeedbackImpl>
): ReturnType<typeof recordMemoryFeedbackImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.recordMemoryFeedback",
      correlation: {
        referenceId: safeOperationId(args[0]?.reference),
        ...(args[0]?.supersedes
          ? { feedbackId: safeOperationId(args[0].supersedes) }
          : {}),
      },
      result: (feedback) => ({
        fields: {
          feedbackId: feedback.feedbackId,
          proposalId: feedback.proposalId,
          reviewId: feedback.reviewId,
          outcome: feedback.outcome,
          artifactCount: feedback.relevant.length,
        },
      }),
    },
    () => recordMemoryFeedbackImpl(...args),
  );
}

export function exportEvalDataset(
  ...args: Parameters<typeof exportEvalDatasetImpl>
): ReturnType<typeof exportEvalDatasetImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.exportEvalDataset",
      result: (dataset) => ({
        outcome: dataset.cases ? "success" : "skipped",
        fields: { outputCount: dataset.cases },
      }),
    },
    () => exportEvalDatasetImpl(...args),
  );
}

export function replayDataset(
  ...args: Parameters<typeof replayDatasetImpl>
): ReturnType<typeof replayDatasetImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.replayDataset",
      result: (replay) => ({
        outcome: replay.outputs ? "success" : "skipped",
        fields: {
          replayId: replay.replayId,
          caseCount: replay.cases,
          outputCount: replay.outputs,
        },
      }),
    },
    () => replayDatasetImpl(...args),
  );
}

export function gradeReplay(
  ...args: Parameters<typeof gradeReplayImpl>
): ReturnType<typeof gradeReplayImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.gradeReplay",
      correlation: {
        replayId: safeOperationId(args[0]?.replayId),
        caseId: safeOperationId(args[0]?.caseId),
        mode: ["memory-off", "current", "gold"].includes(args[0]?.mode)
          ? args[0].mode
          : "invalid-mode",
      },
      result: () => ({
        fields: {
          replayId: args[0].replayId,
          caseId: args[0].caseId,
          mode: args[0].mode,
          changed: true,
        },
      }),
    },
    () => gradeReplayImpl(...args),
  );
}

export function evalReport(
  ...args: Parameters<typeof evalReportImpl>
): ReturnType<typeof evalReportImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.evalReport",
      correlation: { replayId: safeOperationId(args[1]) },
      result: (report) => ({
        fields: {
          replayId: report.replayId,
          caseCount: report.pairedCases,
          pairableCount: report.pairableCases,
          outputCount:
            Number(report.pairedCases) * 2 + Number(report.ignoredUnpaired),
        },
      }),
    },
    () => evalReportImpl(...args),
  );
}

export function retrievalBenchmark(
  ...args: Parameters<typeof retrievalBenchmarkImpl>
): ReturnType<typeof retrievalBenchmarkImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.retrievalBenchmark",
      result: (benchmark) => ({
        outcome: benchmark.labels ? "success" : "skipped",
        fields: {
          labelCount: benchmark.labels,
          negativeLabelCount: benchmark.negativeLabels,
          relevantCount: benchmark.relevant,
          k: benchmark.k,
        },
      }),
    },
    () => retrievalBenchmarkImpl(...args),
  );
}

export function adaptationEvaluationMetrics(
  ...args: Parameters<typeof adaptationEvaluationMetricsImpl>
): ReturnType<typeof adaptationEvaluationMetricsImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.adaptationEvaluationMetrics",
      result: (metrics) => {
        const receipts = metrics.receipts as Record<string, unknown>;
        return {
          fields: {
            validReceiptCount: receipts.valid,
            malformedArtifactCount:
              Number(receipts.malformedArtifacts) +
              Number(receipts.malformedSessionArtifacts),
          },
        };
      },
    },
    () => adaptationEvaluationMetricsImpl(...args),
  );
}

export function memoryMetrics(
  ...args: Parameters<typeof memoryMetricsImpl>
): ReturnType<typeof memoryMetricsImpl> {
  return observeMemoryOperation(
    {
      operation: "memory.memoryMetrics",
      result: (metrics) => {
        const catalog = metrics.catalog as Record<string, unknown>;
        const proposals = metrics.proposals as Record<string, unknown>;
        const reviews = metrics.reviews as Record<string, unknown>;
        return {
          fields: {
            artifactCount: catalog.entries,
            pendingProposalCount: proposals.pending,
            reviewedProposalCount: proposals.reviewed,
            reviewCount: reviews.total,
          },
        };
      },
    },
    () => memoryMetricsImpl(...args),
  );
}
