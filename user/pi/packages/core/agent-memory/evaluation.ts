import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  atomicWrite,
  contained,
  scanCatalog,
  secureDir,
  sha256,
  type MemoryConfig,
} from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import {
  buildReflectionPrompt,
  freezePipelineInput,
  PRODUCTION_TARGET_LIMIT,
  rankRetrieval,
  type PipelineInput,
} from "./pipeline.js";
import {
  parseModelProposal,
  type Proposal,
  type ReviewReceipt,
} from "./schema.js";
import { findProposal, listProposals, readReviewReceipts } from "./workflow.js";
import {
  commitHistory,
  historyContainsAncestor,
  historyEntryByMutationId,
  historyReceiptAt,
  listHistoryByKind,
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

export function recordMemoryFeedback(options: {
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

export function exportEvalDataset(
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
): PipelineInput {
  const current = freezePipelineInput(
    cfg,
    item.input.scope,
    item.input.sanitizedEvidence,
    model,
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

export function replayDataset(options: {
  cfg: MemoryConfig;
  dataset: string;
  modes: Array<"memory-off" | "current" | "gold">;
  limit: number;
  model: string;
  invoke: (prompt: string) => string;
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
      const input = replayInput(options.cfg, item, mode, options.model);
      const raw = options.invoke(buildReflectionPrompt(input));
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
    `${JSON.stringify({ version: 2, replayId, dataset: resolve(options.dataset), cases: cases.length, modes: options.modes, model: options.model, outputs: manifestOutputs }, null, 2)}\n`,
  );
  return { replayId, cases: cases.length, outputs };
}

type ReplayManifest = {
  version: 2;
  replayId: string;
  cases: number;
  modes: string[];
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
      output: unknown;
      outputSha256: string;
    };
    const digest = sha256(canonical(output.output));
    if (
      output.replayId !== replayId ||
      output.caseId !== expected.caseId ||
      output.mode !== expected.mode ||
      output.outputSha256 !== digest ||
      expected.outputSha256 !== digest
    )
      throw new Error("manifest replay output digest mismatch");
  }
  return value;
}

export function gradeReplay(options: {
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

export function evalReport(
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

export function retrievalBenchmark(
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

export function memoryMetrics(cfg: MemoryConfig): Record<string, unknown> {
  const reviews = readReviewReceipts(cfg);
  const pending = listProposals(cfg);
  const reviewed = listProposals(cfg, undefined, "reviewed");
  const catalog = scanCatalog(cfg.root);
  const ledger = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  const runs = contained(cfg.data, join(cfg.data, "v2", "runs"));
  const runDirs = existsSync(runs)
    ? readdirSync(runs).filter((name) =>
        existsSync(join(runs, name, "result.json")),
      )
    : [];
  const results = runDirs.map(
    (name) =>
      JSON.parse(readFileSync(join(runs, name, "result.json"), "utf8")) as {
        action: string;
        coveredCheckpointIds: string[];
      },
  );
  const reasonCodes = Object.fromEntries(
    [...new Set(reviews.map((review) => review.reason.code))].map((code) => [
      code,
      reviews.filter((review) => review.reason.code === code).length,
    ]),
  );
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
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
      checkpointsPerRun:
        results.length === 0
          ? 0
          : results.reduce(
              (sum, result) => sum + result.coveredCheckpointIds.length,
              0,
            ) / results.length,
    },
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
    eval: { cases: buildEvalCases(cfg).length },
  };
}
