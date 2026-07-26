import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { freezePipelineInput, processPipelineBatch } from "./pipeline.js";
import { listProposals, readReviewReceipts } from "./workflow.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-pipeline-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function evidence(checkpoint = "checkpoint"): SafeEvidence {
  return {
    version: 1,
    window: {
      windowId: "window",
      sessionId: "session",
      checkpointEntryIds: [checkpoint],
      throughLeafId: "leaf",
      branchDigest: "branch",
      excerpt: "The user established a durable verification rule.",
      excerptSha256: "excerpt",
    },
    workspace: "/tmp/project",
    records: [],
    tools: [],
    redactions: {},
  };
}

describe("memory reflection pipeline", () => {
  it("excludes memories from unrelated scopes", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    const note = (id: string, scope: string) =>
      `---\nmemory_version: 2\nmemory_id: "${id}"\nstatus: "active"\ntitle: "Scoped"\nkind: pattern\nscope: ${JSON.stringify(scope)}\ndescription: "Scoped rule"\ntriggers: ["rule"]\nkeywords: []\nupdated: "2026-07-25"\n---\n\nRule.\n`;
    writeFileSync(
      join(cfg.root, "2026-global--source__agent.md"),
      note("mem_cccccccccccccccccccccccc", "global"),
    );
    writeFileSync(
      join(cfg.root, "2026-other--source__agent.md"),
      note("mem_dddddddddddddddddddddddd", "/tmp/other"),
    );
    const input = freezePipelineInput(cfg, "tmp/project", [evidence()]);
    expect(input.catalog.entries.map((entry) => entry.memoryId)).toEqual([
      "mem_cccccccccccccccccccccccc",
    ]);
    expect(JSON.stringify(input)).not.toContain("mem_dddddddddddddddddddddddd");
  });

  it("freezes inputs and covers checkpoints only after a valid skip", () => {
    const cfg = config();
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence()],
      model: "test",
      invoke: () => {
        throw new Error("must not invoke");
      },
      skipExternal: true,
    });
    expect(result.action).toBe("skip");
    expect(
      existsSync(join(cfg.data, "v2/ledger/session--checkpoint.json")),
    ).toBe(true);
    expect(
      readFileSync(
        join(cfg.data, `v2/runs/${result.runId}/input.json`),
        "utf8",
      ),
    ).not.toContain("raw private output");
  });

  it("autonomously commits a strict memory proposal", () => {
    const cfg = config();
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-create")],
      model: "test",
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "memory",
              operation: {
                type: "create",
                artifact: {
                  title: "Always verify builds",
                  kind: "pattern",
                  scope: "global",
                  description: "Use before reporting implementation completion",
                  triggers: ["implementation complete"],
                  keywords: ["verification"],
                  body: "Run the relevant build before reporting completion.",
                },
              },
            },
          ],
        }),
    });
    expect(result.proposalIds).toHaveLength(1);
    expect(listProposals(cfg)).toHaveLength(0);
    expect(listProposals(cfg, undefined, "reviewed")[0]).toMatchObject({
      lane: "memory",
      operation: { type: "create" },
    });
    expect(readReviewReceipts(cfg)[0]).toMatchObject({
      decision: "accepted",
      reviewer: "background-reflection",
    });
    const withFeedback = freezePipelineInput(cfg, "global", [
      evidence("cp-feedback"),
    ]);
    expect(withFeedback.reviewSignals).toEqual([]);
    const retried = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-create")],
      model: "test",
      invoke: () => {
        throw new Error("frozen output must be reused");
      },
    });
    expect(retried.runId).toBe(result.runId);
    expect(listProposals(cfg, undefined, "pending")).toHaveLength(0);
    expect(listProposals(cfg, undefined, "reviewed")).toHaveLength(1);
    expect(readReviewReceipts(cfg)).toHaveLength(1);
  });

  it("keeps executable skill drafts review-gated", () => {
    const cfg = config();
    const second = evidence("cp-second");
    second.window.sessionId = "session-two";
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-memory"), second],
      model: "test",
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "memory",
              operation: {
                type: "create",
                artifact: {
                  title: "Autonomous memory",
                  kind: "pattern",
                  scope: "global",
                  description: "Use when testing autonomous memory",
                  triggers: ["autonomous memory"],
                  keywords: ["memory"],
                  body: "Commit durable memory without human review.",
                },
              },
            },
            {
              lane: "skill",
              operation: {
                type: "skill-draft",
                mode: "create",
                skillName: "memory-check",
                targetPath: "memory-check/SKILL.md",
                files: [
                  {
                    path: "memory-check/SKILL.md",
                    content:
                      '---\nname: memory-check\ndescription: "check memory"\n---\n',
                  },
                ],
              },
            },
          ],
        }),
    });
    expect(result.proposalIds).toHaveLength(2);
    expect(listProposals(cfg, "memory")).toHaveLength(0);
    expect(listProposals(cfg, "skill")).toHaveLength(1);
    expect(readReviewReceipts(cfg)).toHaveLength(1);
  });

  it("recovers after result publication but before memory application", () => {
    const cfg = config();
    const invoke = () =>
      JSON.stringify({
        action: "propose",
        proposals: [
          {
            lane: "memory",
            operation: {
              type: "create",
              artifact: {
                title: "Recover autonomous memory",
                kind: "gotcha",
                scope: "global",
                description: "Use when retrying interrupted reflection",
                triggers: ["reflection retry"],
                keywords: ["recovery"],
                body: "Published results must remain safely replayable.",
              },
            },
          },
        ],
      });
    const interrupted = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-interrupted")],
      model: "test",
      invoke,
      autoApplyMemory: false,
    });
    expect(listProposals(cfg, "memory")).toHaveLength(1);
    const recovered = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-interrupted")],
      model: "test",
      invoke: () => {
        throw new Error("cached result must be reused");
      },
    });
    expect(recovered).toEqual(interrupted);
    expect(listProposals(cfg, "memory")).toHaveLength(0);
    expect(readReviewReceipts(cfg)).toHaveLength(1);
  });
});
