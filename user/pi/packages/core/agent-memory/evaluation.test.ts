import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import {
  buildEvalCases,
  evalReport,
  exportEvalDataset,
  gradeReplay,
  memoryMetrics,
  readFeedbackReceipts,
  recordMemoryFeedback,
  replayDataset,
  retrievalBenchmark,
  retrievalMetrics,
} from "./evaluation.js";
import { processPipelineBatch } from "./pipeline.js";
import {
  claimMaintenanceEvent,
  enqueueMaintenanceEvent,
  failMaintenanceEvent,
} from "./events.js";
import { reviewProposal, rollbackReview } from "./workflow.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-eval-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

const evidence: SafeEvidence = {
  version: 1,
  window: {
    windowId: "window",
    sessionId: "session",
    checkpointEntryIds: ["checkpoint"],
    throughLeafId: "leaf",
    branchDigest: "branch",
    excerpt: "durable rule",
    excerptSha256: "excerpt",
  },
  workspace: "/tmp/project",
  records: [],
  tools: [],
  redactions: {},
  checkpointFrontiers: { checkpoint: "leaf" },
  emittedEntryIds: ["leaf"],
};

const proposalResponse = JSON.stringify({
  version: 2,
  action: "propose",
  proposals: [
    {
      lane: "memory",
      evidenceWindowIds: ["window"],
      operation: {
        type: "create",
        artifact: {
          title: "Durable evaluation rule",
          kind: "pattern",
          scope: "global",
          description: "Use while evaluating memory changes",
          triggers: ["memory evaluation"],
          keywords: ["evaluation"],
          body: "Compare behavior with and without the memory.",
        },
      },
    },
  ],
});

describe("memory evaluation dataset", () => {
  it("exports reviewed cases and stores manually graded replays", () => {
    const cfg = config();
    const run = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence],
      model: "test",
      invoke: () => proposalResponse,
      autoApplyMemory: false,
    });
    const accepted = reviewProposal({
      cfg,
      id: run.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "verified by reviewer",
    });
    const dataset = join(cfg.data, "reviewed.jsonl");
    expect(exportEvalDataset(cfg, dataset).cases).toBe(0);
    expect(() =>
      recordMemoryFeedback({
        cfg,
        reference: accepted.reviewId,
        outcome: "useful",
        reasonCode: "improved-outcome",
        memoryIds: [],
      }),
    ).toThrow("requires a relevant");
    const useful = recordMemoryFeedback({
      cfg,
      reference: accepted.reviewId,
      outcome: "useful",
      reasonCode: "improved-outcome",
      query: "memory evaluation rule",
      workspace: "/tmp/project",
    });
    rmSync(join(cfg.data, "v2", "mutations", `${useful.feedbackId}.json`));
    const recovered = recordMemoryFeedback({
      cfg,
      reference: accepted.reviewId,
      outcome: "useful",
      reasonCode: "improved-outcome",
      query: "memory evaluation rule",
      workspace: "/tmp/project",
    });
    expect(recovered).toEqual(useful);
    expect(exportEvalDataset(cfg, dataset).cases).toBe(1);
    expect(() =>
      recordMemoryFeedback({
        cfg,
        reference: accepted.reviewId,
        outcome: "useful",
        reasonCode: "retrieved-relevant",
        query: "memory evaluation rule",
        workspace: "/tmp/project",
      }),
    ).toThrow("supersede it");
    expect(readFileSync(dataset, "utf8")).not.toContain("/tmp/memory-eval-");
    const replay = replayDataset({
      cfg,
      dataset,
      modes: ["memory-off", "current", "gold"],
      limit: 1,
      model: "test",
      invoke: () => '{"version":2,"action":"skip","reason":"test replay"}',
    });
    expect(replay.outputs).toBe(3);
    expect(evalReport(cfg, replay.replayId)).toMatchObject({
      pairedCases: 0,
      pairableCases: 1,
      coverage: 0,
    });
    expect(memoryMetrics(cfg)).toMatchObject({
      eval: { paired: { pairedCases: 0, pairableCases: 1, coverage: 0 } },
    });
    const caseId = JSON.parse(readFileSync(dataset, "utf8")).caseId;
    const currentOutput = join(
      cfg.data,
      "v2",
      "eval",
      "replays",
      replay.replayId,
      `${caseId}-current.json`,
    );
    const pristineOutput = readFileSync(currentOutput, "utf8");
    const goldOutput = join(
      cfg.data,
      "v2",
      "eval",
      "replays",
      replay.replayId,
      `${caseId}-gold.json`,
    );
    const pristineGold = readFileSync(goldOutput, "utf8");
    writeFileSync(
      goldOutput,
      pristineGold.replace("test replay", "tampered unrelated output"),
    );
    expect(() =>
      gradeReplay({
        cfg,
        replayId: replay.replayId,
        caseId,
        mode: "current",
        score: 0.8,
        reason: "unrelated tamper",
      }),
    ).toThrow("manifest replay output digest mismatch");
    writeFileSync(goldOutput, pristineGold);
    writeFileSync(
      currentOutput,
      pristineOutput.replace("test replay", "tampered replay"),
    );
    expect(() =>
      gradeReplay({
        cfg,
        replayId: replay.replayId,
        caseId,
        mode: "current",
        score: 0.8,
        reason: "tampered",
      }),
    ).toThrow("digest mismatch");
    writeFileSync(currentOutput, pristineOutput);
    writeFileSync(
      join(
        cfg.data,
        "v2",
        "eval",
        "replays",
        replay.replayId,
        "fake-current.grade.json",
      ),
      JSON.stringify({
        version: 2,
        replayId: replay.replayId,
        caseId: "fake",
        mode: "current",
        outputSha256: "0".repeat(64),
        score: 1,
      }),
    );
    expect(
      gradeReplay({
        cfg,
        replayId: replay.replayId,
        caseId: JSON.parse(readFileSync(dataset, "utf8")).caseId,
        mode: "current",
        score: 0.8,
        reason: "useful but verbose",
      }),
    ).toContain(".grade.json");
    gradeReplay({
      cfg,
      replayId: replay.replayId,
      caseId: JSON.parse(readFileSync(dataset, "utf8")).caseId,
      mode: "memory-off",
      score: 0.3,
      reason: "baseline",
    });
    writeFileSync(
      currentOutput,
      pristineOutput.replace("test replay", "tampered after grading"),
    );
    expect(() => evalReport(cfg, replay.replayId)).toThrow(
      "replay output digest mismatch",
    );
    writeFileSync(currentOutput, pristineOutput);
    expect(evalReport(cfg, replay.replayId)).toMatchObject({
      pairedCases: 1,
      coverage: 1,
      delta: 0.5,
    });
    const beforeCwd = retrievalBenchmark(cfg, 1);
    const originalCwd = process.cwd();
    process.chdir("/");
    try {
      expect(retrievalBenchmark(cfg, 1)).toEqual(beforeCwd);
    } finally {
      process.chdir(originalCwd);
    }
    expect(beforeCwd).toMatchObject({ labels: 1, recallAtK: 1, mrr: 1 });
    expect(memoryMetrics(cfg)).toMatchObject({
      eval: {
        cases: 1,
        paired: { pairedCases: 1, pairableCases: 1, coverage: 1, delta: 0.5 },
        retrieval: { labels: 1, recallAtK: 1, mrr: 1 },
      },
      reviews: { accepted: 1 },
    });
    const reviewPath = join(
      cfg.data,
      "v2",
      "reviews",
      `${accepted.reviewId}.json`,
    );
    const pristineReview = readFileSync(reviewPath, "utf8");
    writeFileSync(
      reviewPath,
      pristineReview.replace("verified by reviewer", "forged reviewer"),
    );
    expect(() => readFeedbackReceipts(cfg)).toThrow("review linkage");
    writeFileSync(reviewPath, pristineReview);
    expect(() =>
      recordMemoryFeedback({
        cfg,
        reference: "unknown",
        outcome: "useful",
        reasonCode: "improved-outcome",
      }),
    ).toThrow("not found");
    expect(() =>
      recordMemoryFeedback({
        cfg,
        reference: accepted.reviewId,
        outcome: "harmful",
        reasonCode: "caused-error",
        query: "different query",
        workspace: "/tmp/project",
        supersedes: useful.feedbackId,
      }),
    ).toThrow("preserve observation");
    recordMemoryFeedback({
      cfg,
      reference: accepted.reviewId,
      outcome: "harmful",
      reasonCode: "caused-error",
      query: "memory evaluation rule",
      workspace: "/tmp/project",
      supersedes: useful.feedbackId,
    });
    expect(buildEvalCases(cfg)).toHaveLength(0);
    expect(retrievalBenchmark(cfg, 1)).toMatchObject({
      labels: 0,
      negativeLabels: 1,
    });
    rollbackReview(cfg, accepted.reviewId, "gold was invalidated");
    expect(buildEvalCases(cfg)).toHaveLength(0);
    const cachePath = join(
      cfg.data,
      "v2",
      "mutations",
      `${useful.feedbackId}.json`,
    );
    writeFileSync(
      cachePath,
      readFileSync(cachePath, "utf8").replace(
        "improved-outcome",
        "stale-or-wrong",
      ),
    );
    expect(
      readFeedbackReceipts(cfg).some(
        (item) => item.reasonCode === "improved-outcome",
      ),
    ).toBe(true);
  }, 10_000);

  it("freezes truthful gold context for archive and skill operations", () => {
    const archiveCfg = config();
    mkdirSync(archiveCfg.root, { recursive: true });
    const memoryId = "mem_ffffffffffffffffffffffff";
    writeFileSync(
      join(archiveCfg.root, "2026-07-25-durable--source__agent.md"),
      `---\nmemory_version: 2\nmemory_id: "${memoryId}"\nstatus: "active"\ntitle: "Durable rule"\nkind: pattern\nscope: "global"\ndescription: "Durable rule"\ntriggers: ["durable rule"]\nkeywords: ["durable"]\nsources: []\ncreated: "2026-07-25"\nupdated: "2026-07-25"\nreview_id: "review_old"\n---\n\nOld rule.\n`,
    );
    const archiveRun = processPipelineBatch({
      cfg: archiveCfg,
      scope: "global",
      evidence: [evidence],
      model: "test",
      autoApplyMemory: false,
      invoke: () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: ["window"],
              operation: {
                type: "archive",
                targetId: memoryId,
                reason: "stale",
              },
            },
          ],
        }),
    });
    const archiveAccepted = reviewProposal({
      cfg: archiveCfg,
      id: archiveRun.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "confirmed stale",
    });
    recordMemoryFeedback({
      cfg: archiveCfg,
      reference: archiveAccepted.reviewId,
      outcome: "useful",
      reasonCode: "retrieved-relevant",
    });
    expect(buildEvalCases(archiveCfg)).toHaveLength(0);

    const skillCfg = config();
    const secondEvidence: SafeEvidence = {
      ...evidence,
      window: {
        ...evidence.window,
        windowId: "window-two",
        sessionId: "session-two",
        checkpointEntryIds: ["checkpoint-two"],
      },
      checkpointFrontiers: { "checkpoint-two": "leaf" },
    };
    const skillRun = processPipelineBatch({
      cfg: skillCfg,
      scope: "global",
      evidence: [evidence, secondEvidence],
      model: "test",
      invoke: () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "skill",
              evidenceWindowIds: ["window", "window-two"],
              operation: {
                type: "skill-draft",
                mode: "create",
                skillName: "verify-memory",
                targetPath: "verify-memory/SKILL.md",
                files: [
                  {
                    path: "verify-memory/reference/SKILL.md",
                    content:
                      '---\nname: decoy\ndescription: "wrong gold skill"\n---\n',
                  },
                  {
                    path: "verify-memory/SKILL.md",
                    content:
                      '---\nname: verify-memory\ndescription: "verify memory changes"\n---\n\n# verify memory\n',
                  },
                ],
              },
            },
          ],
        }),
    });
    reviewProposal({
      cfg: skillCfg,
      id: skillRun.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "repeated workflow",
    });
    expect(buildEvalCases(skillCfg)).toHaveLength(0);
  });
  it("computes mean per-query multi-relevant recall", () => {
    const digest = "a".repeat(64);
    const memory = (suffix: string) => ({
      memoryId: `mem_${suffix.repeat(24)}`,
      artifactSha256: digest,
    });
    expect(
      retrievalMetrics(
        [
          {
            relevant: [memory("a"), memory("b")],
            ranked: [memory("a"), memory("c"), memory("b")],
          },
          { relevant: [memory("c")], ranked: [memory("c"), memory("a")] },
        ],
        2,
      ),
    ).toEqual({ relevant: 3, recallAtK: 0.75, mrr: 1 });
    expect(() =>
      retrievalMetrics(
        [{ relevant: [memory("a")], ranked: [memory("a"), memory("a")] }],
        2,
      ),
    ).toThrow("duplicate ranked");
    expect(() =>
      retrievalMetrics([{ relevant: [memory("a")], ranked: [memory("a")] }], 9),
    ).toThrow("invalid retrieval k");

    const cfg = config();
    const run = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence],
      model: "test",
      invoke: () => proposalResponse,
      autoApplyMemory: false,
    });
    const accepted = reviewProposal({
      cfg,
      id: run.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "reviewed",
    });
    const receipt = recordMemoryFeedback({
      cfg,
      reference: accepted.reviewId,
      outcome: "useful",
      reasonCode: "improved-outcome",
    });
    expect(readFeedbackReceipts(cfg)).toContainEqual(receipt);
  });
});

describe("memory operational metrics", () => {
  it("counts durable queue and malformed pipeline artifacts without throwing", () => {
    const cfg = config();
    enqueueMaintenanceEvent(
      cfg,
      { kind: "checkpoint-ready", cause: "queued", basis: {} },
      () => "2026-01-01T00:00:00.000Z",
    );
    const failed = enqueueMaintenanceEvent(
      cfg,
      { kind: "manual", cause: "failed", basis: { reason: "model-timeout" } },
      () => "2026-01-01T00:01:00.000Z",
    );
    const claimed = claimMaintenanceEvent(cfg, {
      ids: [failed.id],
      clock: () => "2026-01-01T00:02:00.000Z",
    })!;
    failMaintenanceEvent(cfg, claimed.id, claimed.claimToken!);
    const pending = join(cfg.data, "v2", "events", "pending");
    writeFileSync(join(pending, "malformed.json"), "not json");
    const run = join(cfg.data, "v2", "runs", "malformed-run");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "input.json"), "{}");
    writeFileSync(join(run, "output.json"), "not model json");
    writeFileSync(join(run, "result.json"), "not result json");

    expect(memoryMetrics(cfg, () => "2026-01-01T00:10:00.000Z")).toMatchObject({
      pipeline: { runs: 0, malformedArtifacts: 1, modelParseFailures: 0 },
      maintenance: {
        byKind: { "checkpoint-ready": 1, manual: 1 },
        byStatus: { pending: 1, failed: 1 },
        oldestPendingAgeSeconds: 600,
        maxAttempts: 1,
        failedAgesSeconds: [540],
        failedReasons: { "model-timeout": 1 },
        malformedArtifacts: 1,
      },
    });
  });

  it("quarantines an ENOTDIR event status path", () => {
    const cfg = config();
    const events = join(cfg.data, "v2", "events");
    mkdirSync(events, { recursive: true });
    writeFileSync(join(events, "pending"), "not a directory");
    expect(memoryMetrics(cfg)).toMatchObject({
      maintenance: { malformedArtifacts: 1, byStatus: { pending: 0 } },
    });
  });

  it("rejects numeric checkpoint ids through canonical run validation", () => {
    const cfg = config();
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence],
      model: "test",
      invoke: () => '{"version":2,"action":"skip","reason":"done"}',
    });
    const dir = join(cfg.data, "v2", "runs", result.runId);
    const inputPath = join(dir, "input.json");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    input.evidence[0].window.checkpointEntryIds = [42];
    writeFileSync(inputPath, JSON.stringify(input));
    const resultPath = join(dir, "result.json");
    const stored = JSON.parse(readFileSync(resultPath, "utf8"));
    stored.coveredCheckpointIds = [42];
    writeFileSync(resultPath, JSON.stringify(stored));
    expect(memoryMetrics(cfg)).toMatchObject({
      pipeline: { runs: 0, malformedArtifacts: 1 },
    });
  });
});
