import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  type PipelineInput,
} from "./pipeline.js";
import {
  parseModelProposal,
  type Proposal,
  type ReviewReceipt,
} from "./schema.js";
import { findProposal, listProposals, readReviewReceipts } from "./workflow.js";

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

export function buildEvalCases(cfg: MemoryConfig): EvalCase[] {
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
      review.reviewer !== "local-cli" ||
      (review.decision !== "accepted" && review.decision !== "edited") ||
      (review.transactionId && rolledBackTransactions.has(review.transactionId))
    )
      continue;
    let candidate: Proposal;
    try {
      candidate = findProposal(cfg, review.proposalId).proposal;
    } catch {
      continue;
    }
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
  for (const item of cases)
    for (const mode of options.modes) {
      const input = replayInput(options.cfg, item, mode, options.model);
      const raw = options.invoke(buildReflectionPrompt(input));
      const parsed = parseModelProposal(raw);
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
          },
          null,
          2,
        )}\n`,
      );
      outputs += 1;
    }
  atomicWrite(
    join(dir, "manifest.json"),
    `${JSON.stringify({ version: 1, replayId, dataset: resolve(options.dataset), cases: cases.length, modes: options.modes, model: options.model }, null, 2)}\n`,
  );
  return { replayId, cases: cases.length, outputs };
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
  const path = evalRoot(
    options.cfg,
    "replays",
    options.replayId,
    `${options.caseId}-${options.mode}.grade.json`,
  );
  if (existsSync(path)) throw new Error("replay grade already exists");
  atomicWrite(
    path,
    `${JSON.stringify({ version: 1, ...options, cfg: undefined, gradedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
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
