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
  schemaVersion: 1;
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
  };
  retrieval: { targetIds: string[]; catalogSha256: string };
};

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
  for (const review of readReviewReceipts(cfg)) {
    if (review.decision === "rolled-back") continue;
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
      schemaVersion: 1,
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
    .map((line) => JSON.parse(line) as EvalCase);
}

function replayInput(
  cfg: MemoryConfig,
  item: EvalCase,
  mode: "memory-off" | "current" | "gold",
): PipelineInput {
  const current = freezePipelineInput(
    cfg,
    item.input.scope,
    item.input.sanitizedEvidence,
  );
  if (mode === "current") return current;
  if (mode === "memory-off")
    return {
      ...current,
      catalog: { ...current.catalog, entries: [] },
      targets: [],
      pending: [],
      recentReviews: [],
      skills: [],
    };
  const operation = item.gold.operation;
  if (!("artifact" in operation)) return current;
  const artifact = operation.artifact;
  return {
    ...current,
    targets: [
      {
        memoryId: artifact.memoryId,
        path: item.gold.artifactPath || "gold.md",
        title: artifact.title,
        description: artifact.description,
        kind: artifact.kind,
        scope: artifact.scope,
        triggers: artifact.triggers,
        keywords: artifact.keywords,
        status: "active",
        sha256: item.gold.artifactSha256 || sha256(artifact.body),
        updated: artifact.updated,
        legacy: false,
        body: artifact.body,
      },
    ],
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
      const input = replayInput(options.cfg, item, mode);
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
