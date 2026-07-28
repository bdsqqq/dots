import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCatalog, type MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { canonicalTurnReceiptId, type TurnReceipt } from "./receipt.js";
import type { TurnObservation } from "./adaptation.js";
import { canonicalProposalId } from "./schema.js";
import {
  freezePipelineInput,
  rankRetrieval,
  parseStoredPipelineInput,
  processPipelineBatch,
  processPipelineBatches,
} from "./pipeline.js";
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
    checkpointFrontiers: { [checkpoint]: "leaf" },
    emittedEntryIds: ["leaf"],
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
    const input = freezePipelineInput(cfg, "tmp/project", [evidence()], "test");
    expect(input.catalog.entries.map((entry) => entry.memoryId)).toEqual([
      "mem_cccccccccccccccccccccccc",
    ]);
    expect(JSON.stringify(input)).not.toContain("mem_dddddddddddddddddddddddd");
    expect(
      rankRetrieval(scanCatalog(cfg.root), "scoped rule", [
        "/tmp/project",
        "/tmp/other",
      ]).map((entry) => entry.memoryId),
    ).toEqual(
      expect.arrayContaining([
        "mem_cccccccccccccccccccccccc",
        "mem_dddddddddddddddddddddddd",
      ]),
    );
  });

  it("rejects a cross-workspace forged observation during freeze and replay", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(
      join(cfg.root, "2026-project-b--source__agent.md"),
      `---
memory_version: 2
memory_id: "mem_bbbbbbbbbbbbbbbbbbbbbbbb"
status: "active"
title: "Project B"
kind: pattern
scope: "/tmp/project-b"
description: "Project B only"
triggers: ["project b"]
keywords: []
updated: "2026-07-27"
---

Project B rule.
`,
    );
    const catalog = scanCatalog(cfg.root);
    const target = catalog.entries[0]!;
    const identity: Omit<TurnReceipt, "receiptId"> = {
      version: 1,
      sessionId: "session-a",
      workspace: "/tmp/project-a",
      userEntryIds: ["u"],
      assistantEntryIds: ["a"],
      catalogSha256: "a".repeat(64),
      exposures: [
        {
          kind: "injected",
          memoryId: target.memoryId,
          artifactSha256: target.sha256,
        },
      ],
      outcomes: [],
      redactions: {},
      recordedAt: "2026-07-27T00:00:00.000Z",
    };
    const receipt = {
      ...identity,
      receiptId: canonicalTurnReceiptId(identity),
    };
    const forged: TurnObservation = {
      kind: "turn-observation",
      evidenceId: `turn:r:${receipt.receiptId}`,
      entryId: "r",
      receipt,
    };
    const projectA = evidence("cp-a");
    projectA.workspace = "/tmp/project-a";
    projectA.window.sessionId = "session-a";
    const projectB = evidence("cp-b");
    projectB.workspace = "/tmp/project-b";
    projectB.window.windowId = "window-b";
    projectB.window.sessionId = "session-b";
    expect(() =>
      freezePipelineInput(cfg, "global", [projectA, projectB], "test", [
        forged,
      ]),
    ).toThrow("outside frozen scoped catalog");

    const frozen = freezePipelineInput(
      cfg,
      "global",
      [projectA, projectB],
      "test",
    );
    if (frozen.version !== 3) throw new Error("expected v3 input");
    expect(() =>
      parseStoredPipelineInput(
        JSON.stringify({ ...frozen, observations: [forged] }),
      ),
    ).toThrow("invalid stored pipeline input");
  });

  it("writes v3 inputs while replaying strict v2 inputs", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    expect(current).toMatchObject({
      version: 3,
      promptVersion: 3,
      observations: [],
      rollbackEvidence: [],
    });
    if (current.version !== 3)
      throw new Error("expected current pipeline input");
    const {
      observations: _observations,
      rollbackEvidence: _rollbackEvidence,
      ...base
    } = current;
    const legacy = { ...base, version: 2, promptVersion: 2 };
    expect(parseStoredPipelineInput(JSON.stringify(legacy))).toMatchObject({
      version: 2,
      promptVersion: 2,
    });
    expect(() =>
      parseStoredPipelineInput(
        JSON.stringify({
          ...current,
          rollbackEvidence: [{ kind: "verified-rollback" }],
        }),
      ),
    ).toThrow("invalid stored pipeline input");
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
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: ["window"],
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
    const withFeedback = freezePipelineInput(
      cfg,
      "global",
      [evidence("cp-feedback")],
      "test",
    );
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
    second.window.windowId = "window-two";
    second.window.sessionId = "session-two";
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-memory"), second],
      model: "test",
      invoke: () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: ["window"],
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
              evidenceWindowIds: ["window", "window-two"],
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
        version: 2,
        action: "propose",
        proposals: [
          {
            lane: "memory",
            evidenceWindowIds: ["window"],
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
      model: "changed-model",
      invoke: () => {
        throw new Error("cached result must be reused");
      },
    });
    expect(recovered).toEqual(interrupted);
    expect(listProposals(cfg, undefined, "reviewed")[0]?.provenance.model).toBe(
      "test",
    );
    expect(listProposals(cfg, "memory")).toHaveLength(0);
    expect(readReviewReceipts(cfg)).toHaveLength(1);
  });

  it("analyzes concurrently and publishes in batch order", async () => {
    const cfg = config();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const options = ["cp-first", "cp-second"].map((checkpoint) => ({
      cfg,
      scope: "global",
      evidence: [evidence(checkpoint)],
      model: "test",
      autoApplyMemory: false,
      invoke: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: ["window"],
              operation: {
                type: "create",
                artifact: {
                  title: checkpoint,
                  kind: "pattern",
                  scope: "global",
                  description: `Use for ${checkpoint}`,
                  triggers: [checkpoint],
                  keywords: [checkpoint],
                  body: `Remember ${checkpoint}.`,
                },
              },
            },
          ],
        });
      },
    }));
    const pending = processPipelineBatches(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    releases[1]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listProposals(cfg)).toHaveLength(0);
    releases[0]!();
    const results = await pending;
    expect(results.map((result) => result.coveredCheckpointIds[0])).toEqual([
      "cp-first",
      "cp-second",
    ]);
    expect(
      results.map((result) => {
        const proposal = listProposals(cfg).find(
          (item) => item.id === result.proposalIds[0],
        );
        return proposal?.operation.type === "create"
          ? proposal.operation.artifact.title
          : "";
      }),
    ).toEqual(["cp-first", "cp-second"]);
  });

  it("does not publish when one concurrent analysis fails", async () => {
    const cfg = config();
    const options = ["cp-good", "cp-failed"].map((checkpoint) => ({
      cfg,
      scope: "global",
      evidence: [evidence(checkpoint)],
      model: "test",
      invoke: async () => {
        if (checkpoint === "cp-failed") throw new Error("analysis failed");
        return '{"action":"skip","reason":"nothing durable"}';
      },
    }));
    await expect(processPipelineBatches(options)).rejects.toThrow(
      "analysis failed",
    );
    expect(listProposals(cfg)).toHaveLength(0);
    expect(existsSync(join(cfg.data, "v2/ledger/session--cp-good.json"))).toBe(
      false,
    );
    expect(
      existsSync(join(cfg.data, "v2/ledger/session--cp-failed.json")),
    ).toBe(false);
    for (const name of readdirSync(join(cfg.data, "v2/runs"))) {
      expect(existsSync(join(cfg.data, "v2/runs", name, "output.json"))).toBe(
        false,
      );
      expect(existsSync(join(cfg.data, "v2/runs", name, "result.json"))).toBe(
        false,
      );
    }
  });
  it("rejects invalid evidence selections and stores only selected refs", () => {
    const cfg = config();
    const second = evidence("cp-unselected");
    second.window.windowId = "window-two";
    second.window.sessionId = "session-two";
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-selected"), second],
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
                type: "create",
                artifact: {
                  title: "Selected evidence",
                  kind: "pattern",
                  scope: "global",
                  description: "Use while testing selected evidence",
                  triggers: ["selected evidence"],
                  keywords: ["evidence"],
                  body: "Use only evidence selected by the model.",
                },
              },
            },
          ],
        }),
    });
    expect(
      listProposals(cfg)[0]?.evidence.map((item) => item.windowId),
    ).toEqual(["window"]);
    expect(result.proposalIds).toHaveLength(1);

    const invalid = (evidenceWindowIds: string[]) =>
      processPipelineBatch({
        cfg: config(),
        scope: "global",
        evidence: [evidence()],
        model: "test",
        invoke: () =>
          JSON.stringify({
            version: 2,
            action: "propose",
            proposals: [
              {
                lane: "memory",
                evidenceWindowIds,
                operation: {
                  type: "create",
                  artifact: {
                    title: "Invalid evidence",
                    kind: "pattern",
                    scope: "global",
                    description: "Use while testing invalid evidence",
                    triggers: ["invalid evidence"],
                    keywords: [],
                    body: "This proposal must be rejected.",
                  },
                },
              },
            ],
          }),
      });
    expect(() => invalid([])).toThrow("invalid evidenceWindowIds");
    expect(() => invalid(["window", "window"])).toThrow(
      "invalid evidenceWindowIds",
    );
    expect(() => invalid(["missing"])).toThrow("unavailable evidence");
  });

  it("rejects a stored autonomous proposal whose content keeps its id", () => {
    const cfg = config();
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence()],
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
                type: "create",
                artifact: {
                  title: "Untampered",
                  kind: "pattern",
                  scope: "global",
                  description: "Use while testing proposal integrity",
                  triggers: ["proposal integrity"],
                  keywords: [],
                  body: "Reject stored content changes.",
                },
              },
            },
          ],
        }),
    });
    const dir = join(cfg.data, "v2/proposals/pending");
    const path = join(dir, readdirSync(dir)[0]!);
    const proposal = JSON.parse(readFileSync(path, "utf8"));
    proposal.provenance.autonomous = false;
    const { id: _id, ...identity } = proposal;
    proposal.id = canonicalProposalId(identity);
    const tamper = [
      (value: typeof proposal) => {
        value.operation.artifact.title = "Tampered";
      },
      (value: typeof proposal) => {
        value.evidence[0].excerpt = "Tampered";
      },
      (value: typeof proposal) => {
        value.provenance.model = "tampered-model";
      },
      (value: typeof proposal) => {
        delete value.digestVersion;
      },
    ];
    for (const mutate of tamper) {
      const changed = structuredClone(proposal);
      mutate(changed);
      writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`);
      expect(() => listProposals(cfg)).toThrow(
        "stored proposal id does not match content",
      );
    }
    expect(result.proposalIds).toHaveLength(1);
  });
  it("replays pre-versioned output with all frozen evidence", () => {
    const cfg = config();
    const second = evidence("cp-legacy-two");
    second.window.windowId = "window-two";
    second.window.sessionId = "session-two";
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-legacy-one"), second],
      model: "legacy-model",
      autoApplyMemory: false,
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "memory",
              operation: {
                type: "create",
                artifact: {
                  title: "Legacy evidence",
                  kind: "pattern",
                  scope: "global",
                  description: "Use while replaying legacy output",
                  triggers: ["legacy output"],
                  keywords: [],
                  body: "Legacy output applies to every frozen window.",
                },
              },
            },
          ],
        }),
    });
    const stored = listProposals(cfg)[0]!;
    expect(stored.digestVersion).toBe(2);
    expect(stored.evidence.map((item) => item.windowId)).toEqual([
      "window",
      "window-two",
    ]);
    expect(
      JSON.parse(
        readFileSync(
          join(cfg.data, `v2/runs/${result.runId}/output.json`),
          "utf8",
        ),
      ).version,
    ).toBeUndefined();
    expect(
      processPipelineBatch({
        cfg,
        scope: "global",
        evidence: [evidence("cp-legacy-one"), second],
        model: "changed-model",
        autoApplyMemory: false,
        invoke: () => {
          throw new Error("legacy output must replay");
        },
      }),
    ).toEqual(result);
  });

  it("requires evidenceWindowIds in versioned output", () => {
    expect(() =>
      processPipelineBatch({
        cfg: config(),
        scope: "global",
        evidence: [evidence()],
        model: "test",
        invoke: () =>
          JSON.stringify({
            version: 2,
            action: "propose",
            proposals: [
              {
                lane: "memory",
                operation: {
                  type: "create",
                  artifact: {
                    title: "Missing selection",
                    kind: "pattern",
                    scope: "global",
                    description: "Use while testing versioned output",
                    triggers: ["versioned output"],
                    keywords: [],
                    body: "Versioned output must select evidence.",
                  },
                },
              },
            ],
          }),
      }),
    ).toThrow("invalid fields");
  });
  it("fails before invoke when an input-only replay changes model", () => {
    const cfg = config();
    expect(() =>
      processPipelineBatch({
        cfg,
        scope: "global",
        evidence: [evidence("cp-input-only")],
        model: "model-a",
        invoke: () => {
          throw new Error("interrupted after input publication");
        },
      }),
    ).toThrow("interrupted after input publication");

    let invoked = false;
    expect(() =>
      processPipelineBatch({
        cfg,
        scope: "global",
        evidence: [evidence("cp-input-only")],
        model: "model-a",
        reasoning: "high",
        invoke: () => {
          invoked = true;
          return '{"version":2,"action":"skip","reason":"must not run"}';
        },
      }),
    ).toThrow(
      "frozen pipeline reasoning low does not match configured reasoning high",
    );
    expect(invoked).toBe(false);

    expect(() =>
      processPipelineBatch({
        cfg,
        scope: "global",
        evidence: [evidence("cp-input-only")],
        model: "model-b",
        invoke: () => {
          invoked = true;
          return '{"version":2,"action":"skip","reason":"must not run"}';
        },
      }),
    ).toThrow(
      "frozen pipeline model model-a does not match configured model model-b",
    );
    expect(invoked).toBe(false);

    const runs = readdirSync(join(cfg.data, "v2/runs"));
    expect(runs).toHaveLength(1);
    const dir = join(cfg.data, "v2/runs", runs[0]!);
    expect(
      JSON.parse(readFileSync(join(dir, "input.json"), "utf8")),
    ).toMatchObject({ model: "model-a", reasoning: "low" });
    expect(existsSync(join(dir, "output.json"))).toBe(false);
    expect(existsSync(join(dir, "result.json"))).toBe(false);
  });
});
