import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import {
  buildEvalCases,
  exportEvalDataset,
  gradeReplay,
  memoryMetrics,
  replayDataset,
} from "./evaluation.js";
import { processPipelineBatch } from "./pipeline.js";
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
};

const proposalResponse = JSON.stringify({
  action: "propose",
  proposals: [
    {
      lane: "memory",
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
    });
    const accepted = reviewProposal({
      cfg,
      id: run.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "verified by reviewer",
    });
    const dataset = join(cfg.data, "reviewed.jsonl");
    expect(exportEvalDataset(cfg, dataset).cases).toBe(1);
    expect(readFileSync(dataset, "utf8")).not.toContain("/tmp/memory-eval-");
    const replay = replayDataset({
      cfg,
      dataset,
      modes: ["memory-off", "current", "gold"],
      limit: 1,
      model: "test",
      invoke: () => '{"action":"skip","reason":"test replay"}',
    });
    expect(replay.outputs).toBe(3);
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
    expect(memoryMetrics(cfg)).toMatchObject({
      eval: { cases: 1 },
      reviews: { accepted: 1 },
    });
    rollbackReview(cfg, accepted.reviewId, "gold was invalidated");
    expect(buildEvalCases(cfg)).toHaveLength(0);
  });

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
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "memory",
              operation: {
                type: "archive",
                targetId: memoryId,
                reason: "stale",
              },
            },
          ],
        }),
    });
    reviewProposal({
      cfg: archiveCfg,
      id: archiveRun.proposalIds[0]!,
      decision: "accept",
      reasonCode: "correct",
      reason: "confirmed stale",
    });
    const archiveCase = buildEvalCases(archiveCfg)[0]!;
    expect(
      archiveCase.gold.context.catalog.entries.some(
        (entry) => entry.memoryId === memoryId,
      ),
    ).toBe(false);
    expect(
      archiveCase.gold.context.targets.some(
        (entry) => entry.memoryId === memoryId,
      ),
    ).toBe(false);

    const skillCfg = config();
    const secondEvidence: SafeEvidence = {
      ...evidence,
      window: {
        ...evidence.window,
        windowId: "window-two",
        sessionId: "session-two",
        checkpointEntryIds: ["checkpoint-two"],
      },
    };
    const skillRun = processPipelineBatch({
      cfg: skillCfg,
      scope: "global",
      evidence: [evidence, secondEvidence],
      model: "test",
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "skill",
              operation: {
                type: "skill-draft",
                mode: "create",
                skillName: "verify-memory",
                targetPath: "verify-memory/SKILL.md",
                files: [
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
    expect(buildEvalCases(skillCfg)[0]!.gold.context.skills).toContainEqual({
      name: "verify-memory",
      description: "verify memory changes",
      sha256: expect.any(String),
    });
  });
});
