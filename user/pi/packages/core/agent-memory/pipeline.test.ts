import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCatalog, sha256, type MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { canonicalTurnReceiptId, type TurnReceipt } from "./receipt.js";
import type { TurnObservation } from "./adaptation.js";
import { canonicalProposalId, type Proposal } from "./schema.js";
import {
  freezePipelineInput,
  rankRetrieval,
  parseStoredPipelineInput,
  processPipelineBatch as processPipelineBatchRaw,
  processPipelineBatches as processPipelineBatchesRaw,
  reflectionAutonomyState,
  type PipelineCriticInput,
  type PipelineInputV4,
} from "./pipeline.js";
import { listProposals, readReviewReceipts } from "./workflow.js";

const WINDOW_ID = "a".repeat(64);
const SECOND_WINDOW_ID = "b".repeat(64);
type PipelineInputV4WithBasis = PipelineInputV4 & {
  supersessionBasis: NonNullable<PipelineInputV4["supersessionBasis"]>;
};

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
  const excerpt = "The user established a durable verification rule.";
  return {
    version: 1,
    window: {
      windowId: WINDOW_ID,
      sessionId: "session",
      checkpointEntryIds: [checkpoint],
      throughLeafId: "leaf",
      branchDigest: sha256("branch"),
      excerpt,
      excerptSha256: sha256(excerpt),
    },
    workspace: "/tmp/project",
    records: [{ role: "meta", source: "pi", cwd: "/tmp/project" }],
    tools: [],
    redactions: {},
    checkpointFrontiers: { [checkpoint]: "leaf" },
    emittedEntryIds: ["leaf"],
  };
}

function criticOutput(
  input: PipelineCriticInput,
  decision: "allow-autonomous-apply" | "require-local-review",
  reason: string,
): string {
  return JSON.stringify({
    version: 1,
    runId: input.runId,
    criticInputSha256: sha256(JSON.stringify(input)),
    decision,
    reason,
  });
}

const allowCritic = (_prompt: string, input: PipelineCriticInput) =>
  criticOutput(input, "allow-autonomous-apply", "test approval");

function processPipelineBatch(
  options: Parameters<typeof processPipelineBatchRaw>[0],
) {
  return processPipelineBatchRaw({
    ...options,
    criticInvoke: options.criticInvoke ?? allowCritic,
  });
}

function processPipelineBatches(
  options: Parameters<typeof processPipelineBatchesRaw>[0],
  concurrency?: string,
) {
  return processPipelineBatchesRaw(
    options.map((option) => ({
      ...option,
      criticInvoke: option.criticInvoke ?? allowCritic,
    })),
    concurrency,
  );
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
    projectB.window.windowId = SECOND_WINDOW_ID;
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
    if (frozen.version !== 4) throw new Error("expected v4 input");
    expect(() =>
      parseStoredPipelineInput(
        JSON.stringify({ ...frozen, observations: [forged] }),
      ),
    ).toThrow("invalid stored pipeline input");
  });

  it("writes v4 inputs while replaying strict v2 inputs", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    expect(current).toMatchObject({
      version: 4,
      promptVersion: 4,
      observations: [],
      rollbackEvidence: [],
    });
    if (current.version !== 4)
      throw new Error("expected current pipeline input");
    const { supersessionBasis: _supersessionBasis, ...v3Base } = current;
    expect(
      parseStoredPipelineInput(
        JSON.stringify({ ...v3Base, version: 3, promptVersion: 3 }),
      ),
    ).toMatchObject({ version: 3, promptVersion: 3 });
    const {
      observations: _observations,
      rollbackEvidence: _rollbackEvidence,
      ...base
    } = v3Base;
    const legacy = { ...base, version: 2, promptVersion: 2 };
    expect(parseStoredPipelineInput(JSON.stringify(legacy))).toMatchObject({
      version: 2,
      promptVersion: 2,
    });
    const { supersessionBasis: _priorSupersessionBasis, ...priorV4 } = current;
    expect(parseStoredPipelineInput(JSON.stringify(priorV4))).toEqual(priorV4);
    expect(() =>
      parseStoredPipelineInput(
        JSON.stringify({
          ...current,
          rollbackEvidence: [{ kind: "verified-rollback" }],
        }),
      ),
    ).toThrow("invalid stored pipeline input");
  });

  it("accepts the retained 201-record evidence shape", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    current.evidence[0]!.records = [
      { role: "meta", source: "pi" },
      ...Array.from({ length: 200 }, (_, index) => ({
        role: "user",
        content: `record ${index}`,
        timestamp: new Date(index * 1_000).toISOString(),
      })),
    ];
    expect(parseStoredPipelineInput(JSON.stringify(current))).toEqual(current);
  });

  it("rejects malformed normalized evidence records", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    const timestamp = "2026-07-31T00:00:00.000Z";
    const malformedRecords: unknown[][] = [
      [{ role: "unknown", content: "x", timestamp }],
      [{ role: "user", content: "x", timestamp, extra: true }],
      [{ role: "user", content: 1, timestamp }],
      [
        {
          role: "assistant",
          content: null,
          timestamp,
          tool_calls: [{ id: "call", name: "tool", args: "[]" }],
        },
      ],
      [
        { role: "meta", source: "pi" },
        { role: "reasoning", content: "private reasoning", timestamp },
      ],
      [{ role: "user", content: "x".repeat(64_000), timestamp }],
    ];
    for (const records of malformedRecords) {
      const malformed = structuredClone(current);
      malformed.evidence[0]!.records = records;
      expect(() => parseStoredPipelineInput(JSON.stringify(malformed))).toThrow(
        "invalid stored pipeline input",
      );
    }
  });

  it("rejects non-canonical timestamps and impossible catalog dates", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    expect(() =>
      parseStoredPipelineInput(JSON.stringify({ ...current, createdAt: "0" })),
    ).toThrow("invalid stored pipeline input");
    const invalidDate = structuredClone(current);
    invalidDate.catalog.entries.push({
      memoryId: `mem_${"4".repeat(24)}`,
      path: "memory.md",
      title: "Invalid date",
      description: "Invalid date",
      kind: "pattern",
      scope: "global",
      triggers: [],
      keywords: [],
      status: "active",
      sha256: "0".repeat(64),
      updated: "2026-02-30",
      legacy: false,
    });
    expect(() => parseStoredPipelineInput(JSON.stringify(invalidDate))).toThrow(
      "invalid stored pipeline input",
    );
    for (const field of ["sessionId", "checkpointEntryIds"] as const) {
      const traversal = structuredClone(current);
      if (field === "sessionId")
        traversal.evidence[0]!.window.sessionId = "../session";
      else traversal.evidence[0]!.window.checkpointEntryIds = ["../checkpoint"];
      expect(() => parseStoredPipelineInput(JSON.stringify(traversal))).toThrow(
        "invalid stored pipeline input",
      );
    }
  });

  it("rejects every malformed v4 supersession basis shape at parse time", () => {
    const cfg = config();
    const current = freezePipelineInput(cfg, "global", [evidence()], "test");
    if (current.version !== 4) throw new Error("expected v4 input");
    const id = `prop_${"1".repeat(32)}`;
    const operation: Proposal["operation"] = {
      type: "create",
      artifact: {
        memoryId: `mem_${"2".repeat(24)}`,
        title: "Stored operation",
        kind: "pattern",
        scope: "global",
        description: "Use while validating stored operations",
        triggers: ["stored operation"],
        keywords: [],
        sources: ["pi://session/checkpoint"],
        created: "2026-07-31",
        updated: "2026-07-31",
        body: "Validate the complete stored operation.",
      },
    };
    const valid: PipelineInputV4WithBasis = {
      ...current,
      pending: [
        {
          id,
          lane: "memory",
          operation: "create",
          summary: JSON.stringify(operation),
        },
      ],
      supersessionBasis: [{ id, runId: sha256("prior-run"), operation }],
    };
    expect(parseStoredPipelineInput(JSON.stringify(valid))).toEqual(valid);

    const cases: Array<{
      name: string;
      mutate: (input: PipelineInputV4WithBasis) => void;
    }> = [
      {
        name: "missing id",
        mutate: (input) => {
          delete (
            input.supersessionBasis[0] as Partial<
              PipelineInputV4WithBasis["supersessionBasis"][number]
            >
          ).id;
        },
      },
      {
        name: "missing runId",
        mutate: (input) => {
          delete (
            input.supersessionBasis[0] as Partial<
              PipelineInputV4WithBasis["supersessionBasis"][number]
            >
          ).runId;
        },
      },
      {
        name: "missing operation",
        mutate: (input) => {
          delete (
            input.supersessionBasis[0] as Partial<
              PipelineInputV4WithBasis["supersessionBasis"][number]
            >
          ).operation;
        },
      },
      {
        name: "extra key",
        mutate: (input) => {
          (
            input.supersessionBasis[0] as unknown as Record<string, unknown>
          ).extra = true;
        },
      },
      {
        name: "wrong id type",
        mutate: (input) => {
          (
            input.supersessionBasis[0] as unknown as Record<string, unknown>
          ).id = 1;
        },
      },
      {
        name: "wrong runId type",
        mutate: (input) => {
          (
            input.supersessionBasis[0] as unknown as Record<string, unknown>
          ).runId = 1;
        },
      },
      {
        name: "wrong operation type",
        mutate: (input) => {
          (
            input.supersessionBasis[0] as unknown as Record<string, unknown>
          ).operation = null;
        },
      },
      {
        name: "duplicate id",
        mutate: (input) => {
          input.supersessionBasis.push(
            structuredClone(input.supersessionBasis[0]!),
          );
        },
      },
      {
        name: "empty id",
        mutate: (input) => {
          input.supersessionBasis[0]!.id = "";
        },
      },
      {
        name: "invalid id",
        mutate: (input) => {
          input.supersessionBasis[0]!.id = "proposal";
        },
      },
      {
        name: "empty operation",
        mutate: (input) => {
          input.supersessionBasis[0]!.operation = {} as Proposal["operation"];
        },
      },
      {
        name: "unknown operation",
        mutate: (input) => {
          input.supersessionBasis[0]!.operation = {
            type: "unknown",
          } as unknown as Proposal["operation"];
        },
      },
      {
        name: "malformed nested operation",
        mutate: (input) => {
          const nested = structuredClone(operation);
          if (!("artifact" in nested))
            throw new Error("expected artifact operation");
          delete (nested.artifact as Partial<{ body: string }>).body;
          input.supersessionBasis[0]!.operation = nested;
        },
      },
      {
        name: "malformed nested memory ref",
        mutate: (input) => {
          input.supersessionBasis[0]!.operation = {
            type: "retire",
            target: {
              memoryId: "not-a-memory-id",
              path: "memory.md",
              sha256: "0".repeat(64),
            },
            reason: "superseded",
          };
        },
      },
      {
        name: "update changes memory identity",
        mutate: (input) => {
          if (!("artifact" in operation))
            throw new Error("expected artifact operation");
          input.supersessionBasis[0]!.operation = {
            type: "update",
            target: {
              memoryId: `mem_${"5".repeat(24)}`,
              path: "memory.md",
              sha256: "0".repeat(64),
            },
            artifact: structuredClone(operation.artifact),
          };
        },
      },
      {
        name: "merge changes memory identity",
        mutate: (input) => {
          if (!("artifact" in operation))
            throw new Error("expected artifact operation");
          input.supersessionBasis[0]!.operation = {
            type: "merge",
            primary: {
              memoryId: `mem_${"5".repeat(24)}`,
              path: "memory.md",
              sha256: "0".repeat(64),
            },
            targets: [
              {
                memoryId: `mem_${"6".repeat(24)}`,
                path: "other.md",
                sha256: "1".repeat(64),
              },
            ],
            artifact: structuredClone(operation.artifact),
          };
        },
      },
      {
        name: "malformed supersededBy",
        mutate: (input) => {
          input.supersessionBasis[0]!.operation = {
            type: "retire",
            target: {
              memoryId: `mem_${"3".repeat(24)}`,
              path: "memory.md",
              sha256: "0".repeat(64),
            },
            reason: "superseded",
            supersededBy: {} as string,
          };
        },
      },
      {
        name: "missing stored skill file hash",
        mutate: (input) => {
          input.supersessionBasis[0]!.operation = {
            type: "skill-draft",
            mode: "create",
            skillName: "stored-skill",
            targetPath: "stored-skill/SKILL.md",
            files: [
              {
                path: "stored-skill/SKILL.md",
                content:
                  "---\nname: stored-skill\ndescription: stored skill\n---\n",
              },
            ],
          } as unknown as Proposal["operation"];
        },
      },
    ];
    for (const testCase of cases) {
      const malformed = structuredClone(valid);
      testCase.mutate(malformed);
      expect(
        () => parseStoredPipelineInput(JSON.stringify(malformed)),
        testCase.name,
      ).toThrow("invalid stored pipeline input");
    }
  });

  it("resumes frozen v3 analysis after the v4 upgrade", () => {
    const cfg = config();
    const frozen = freezePipelineInput(
      cfg,
      "global",
      [evidence("cp-v3")],
      "test",
    );
    if (frozen.version !== 4) throw new Error("expected v4 input");
    const runId = sha256("legacy-v3-run");
    const { supersessionBasis: _supersessionBasis, ...v3Base } = frozen;
    const input = {
      ...v3Base,
      version: 3,
      promptVersion: 3,
      runId,
      batchId: sha256(`${frozen.scope}\0${WINDOW_ID}\0v3`),
    };
    const dir = join(cfg.data, "v2", "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "input.json"),
      `${JSON.stringify(input, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "output.json"),
      `${JSON.stringify({ version: 2, action: "skip", reason: "done" }, null, 2)}\n`,
    );

    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-v3")],
      model: "test",
      invoke: () => {
        throw new Error("v3 output must be reused");
      },
    });
    expect(result).toMatchObject({ runId, action: "skip" });
  });

  it("replays retained v2, v3, and v4 inputs to identical proposals", () => {
    const runId = sha256("cross-version-replay");
    const createdAt = "2026-07-31T00:00:00.000Z";
    const output = JSON.stringify({
      version: 2,
      action: "propose",
      proposals: [
        {
          lane: "memory",
          evidenceWindowIds: [WINDOW_ID],
          operation: {
            type: "create",
            artifact: {
              title: "Cross-version replay",
              kind: "pattern",
              scope: "global",
              description: "Use while replaying frozen reflection inputs",
              triggers: ["pipeline replay"],
              keywords: ["formats"],
              body: "Supported frozen formats replay without semantic drift.",
            },
          },
        },
      ],
    });
    const results = ([2, 3, 4] as const).map((version) => {
      const cfg = config();
      const current = freezePipelineInput(
        cfg,
        "global",
        [evidence("cp-replay")],
        "test",
      );
      if (current.version !== 4) throw new Error("expected v4 input");
      const batchId =
        version === 4
          ? current.batchId
          : sha256(`${current.scope}\0${WINDOW_ID}\0v${version}`);
      const {
        supersessionBasis: _supersessionBasis,
        observations: _observations,
        rollbackEvidence: _rollbackEvidence,
        ...v2Base
      } = current;
      const input =
        version === 2
          ? {
              ...v2Base,
              version: 2 as const,
              promptVersion: 2 as const,
              runId,
              batchId,
              createdAt,
              evidence: current.evidence.map(
                ({
                  checkpointFrontiers: _checkpointFrontiers,
                  emittedEntryIds: _emittedEntryIds,
                  ...item
                }) => item,
              ),
            }
          : version === 3
            ? {
                ...v2Base,
                version: 3 as const,
                promptVersion: 3 as const,
                runId,
                batchId,
                createdAt,
                observations: current.observations,
                rollbackEvidence: current.rollbackEvidence,
              }
            : { ...current, runId, batchId, createdAt };
      const dir = join(cfg.data, "v2", "runs", runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "input.json"),
        `${JSON.stringify(input, null, 2)}\n`,
      );
      writeFileSync(join(dir, "output.json"), `${output}\n`);
      const result = processPipelineBatch({
        cfg,
        scope: "global",
        evidence: input.evidence,
        model: "test",
        autoApplyMemory: false,
        invoke: () => {
          throw new Error("retained output must be reused");
        },
      });
      return {
        result,
        proposals: listProposals(cfg),
      };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]!.result.proposalIds).toHaveLength(1);
  });

  it("batches a completed model-less v2 replay with its stored model", async () => {
    const cfg = config();
    const current = freezePipelineInput(
      cfg,
      "global",
      [evidence("cp-model-less")],
      "old-model",
    );
    if (current.version !== 4) throw new Error("expected v4 input");
    const {
      supersessionBasis: _supersessionBasis,
      observations: _observations,
      rollbackEvidence: _rollbackEvidence,
      model: _model,
      ...base
    } = current;
    const input = {
      ...base,
      version: 2 as const,
      promptVersion: 2 as const,
      runId: sha256("model-less-v2"),
      batchId: sha256(`${current.scope}\0${WINDOW_ID}\0v2`),
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    const dir = join(cfg.data, "v2", "runs", input.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "input.json"),
      `${JSON.stringify(input, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "output.json"),
      `${JSON.stringify({
        version: 2,
        action: "propose",
        proposals: [
          {
            lane: "memory",
            evidenceWindowIds: [WINDOW_ID],
            operation: {
              type: "create",
              artifact: {
                title: "Stored model replay",
                kind: "pattern",
                scope: "global",
                description: "Use while replaying model-less v2 runs",
                triggers: ["stored model"],
                keywords: [],
                body: "Completed legacy runs retain their proposal model.",
              },
            },
          },
        ],
      })}\n`,
    );
    const first = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-model-less")],
      model: "old-model",
      autoApplyMemory: false,
      invoke: () => {
        throw new Error("stored output must be reused");
      },
    });
    const replayed = await processPipelineBatches([
      {
        cfg,
        scope: "global",
        evidence: [evidence("cp-model-less")],
        model: "new-model",
        autoApplyMemory: false,
        invoke: async () => {
          throw new Error("completed run must be reused");
        },
      },
    ]);
    expect(replayed).toEqual([first]);
  });

  it("starts v4 analysis instead of relabeling incomplete v3 input", () => {
    const cfg = config();
    const frozen = freezePipelineInput(
      cfg,
      "global",
      [evidence("cp-incomplete-v3")],
      "test",
    );
    if (frozen.version !== 4) throw new Error("expected v4 input");
    const { supersessionBasis: _supersessionBasis, ...v3Base } = frozen;
    const input = {
      ...v3Base,
      version: 3,
      promptVersion: 3,
      runId: sha256("incomplete-v3-run"),
      batchId: sha256(`${frozen.scope}\0${WINDOW_ID}\0v3`),
    };
    const dir = join(cfg.data, "v2", "runs", input.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "input.json"),
      `${JSON.stringify(input, null, 2)}\n`,
    );
    let invoked = false;
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-incomplete-v3")],
      model: "test",
      invoke: () => {
        invoked = true;
        return '{"version":2,"action":"skip","reason":"v4 analysis"}';
      },
    });
    expect(invoked).toBe(true);
    expect(result.runId).toBe(frozen.runId);
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
              evidenceWindowIds: [WINDOW_ID],
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
      reason: { code: "autonomous" },
    });
    expect(
      reflectionAutonomyState(cfg, result.runId, result.proposalIds[0]!),
    ).toBe("allowed");
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

  it("leaves the whole reflection batch pending when the critic defers", () => {
    const cfg = config();
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-critic-review")],
      model: "test",
      criticInvoke: (_prompt, input) =>
        criticOutput(input, "require-local-review", "evidence is ambiguous"),
      invoke: () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation: {
                type: "create",
                artifact: {
                  title: "Ambiguous lesson",
                  kind: "pattern",
                  scope: "global",
                  description: "Needs local review",
                  triggers: ["ambiguous lesson"],
                  keywords: [],
                  body: "This candidate remains pending.",
                },
              },
            },
          ],
        }),
    });
    expect(result.action).toBe("propose");
    expect(listProposals(cfg, "memory", "pending")).toHaveLength(1);
    expect(readReviewReceipts(cfg)).toHaveLength(0);
    expect(
      reflectionAutonomyState(cfg, result.runId, result.proposalIds[0]!),
    ).toBe("local-review");
    expect(
      JSON.parse(
        readFileSync(
          join(cfg.data, "v2", "runs", result.runId, "critic-output.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ decision: "require-local-review" });

    processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-critic-review")],
      model: "test",
      criticInvoke: allowCritic,
      invoke: () => {
        throw new Error("stored reflection output must be reused");
      },
    });
    expect(listProposals(cfg, "memory", "pending")).toHaveLength(1);
    expect(readReviewReceipts(cfg)).toHaveLength(0);
    writeFileSync(
      join(cfg.data, "v2", "runs", result.runId, "critic-output.json"),
      `${JSON.stringify({
        version: 1,
        runId: result.runId,
        criticInputSha256: "0".repeat(64),
        decision: "allow-autonomous-apply",
        reason: "copied verdict",
      })}\n`,
    );
    expect(() =>
      reflectionAutonomyState(cfg, result.runId, result.proposalIds[0]!),
    ).toThrow("binding mismatch");
  });

  it("applies precise body deletions from reflection", () => {
    const cfg = config();
    const memoryId = `mem_${"e".repeat(24)}`;
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(
      join(cfg.root, "2026-verify-source__agent.md"),
      `---
memory_version: 2
memory_id: "${memoryId}"
status: "active"
title: "Verify"
kind: pattern
scope: "global"
description: "Verify work"
triggers: ["Run a build before reporting completion."]
keywords: []
updated: "2026-07-30"
---

Run a build before reporting completion.
`,
    );
    const result = processPipelineBatch({
      cfg,
      scope: "global",
      evidence: [evidence("cp-replace")],
      model: "test",
      invoke: () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation: {
                type: "replace",
                targetId: memoryId,
                oldSpan: "Run a build before reporting completion.",
                newSpan: "",
              },
            },
          ],
        }),
    });
    expect(result.action).toBe("propose");
    expect(
      listProposals(cfg, "memory", "reviewed")[0]?.operation,
    ).toMatchObject({
      type: "replace",
      target: { memoryId },
      oldSpan: "Run a build before reporting completion.",
      newSpan: "",
    });
    const updated = readFileSync(
      join(cfg.root, "2026-verify-source__agent.md"),
      "utf8",
    );
    expect(updated.split("\n---\n")[1]).not.toContain(
      "Run a build before reporting completion.",
    );
    expect(
      updated.match(/Run a build before reporting completion\./g),
    ).toHaveLength(1);
  });

  it("keeps executable skill drafts review-gated across replay", async () => {
    const cfg = config();
    const second = evidence("cp-second");
    second.window.windowId = SECOND_WINDOW_ID;
    second.window.sessionId = "session-two";
    const option = {
      cfg,
      scope: "global",
      evidence: [evidence("cp-memory"), second],
      model: "test",
      invoke: async () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
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
              evidenceWindowIds: [WINDOW_ID, SECOND_WINDOW_ID],
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
    };
    const result = (await processPipelineBatches([option]))[0]!;
    expect(result.proposalIds).toHaveLength(2);
    expect(listProposals(cfg, "memory")).toHaveLength(0);
    expect(listProposals(cfg, "skill")).toHaveLength(1);
    expect(readReviewReceipts(cfg)).toHaveLength(1);
    expect(
      await processPipelineBatches([
        {
          ...option,
          invoke: async () => {
            throw new Error("stored mixed batch must be reused");
          },
        },
      ]),
    ).toEqual([result]);
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
            evidenceWindowIds: [WINDOW_ID],
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
      deferApply: true,
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

  it("replays an applied batch without preflighting stale targets", async () => {
    const cfg = config();
    const option = {
      cfg,
      scope: "global",
      evidence: [evidence("cp-applied-batch")],
      model: "test",
      invoke: async () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation: {
                type: "create",
                artifact: {
                  title: "Applied batch",
                  kind: "pattern",
                  scope: "global",
                  description: "Must replay idempotently",
                  triggers: ["applied batch"],
                  keywords: [],
                  body: "Do not preflight an already applied create.",
                },
              },
            },
          ],
        }),
    };
    const first = await processPipelineBatches([option]);
    const replayed = await processPipelineBatches([
      {
        ...option,
        invoke: async () => {
          throw new Error("stored batch must be reused");
        },
      },
    ]);
    expect(replayed).toEqual(first);
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
              evidenceWindowIds: [WINDOW_ID],
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

  it("preflights every analyzed batch before autonomous mutation", async () => {
    const cfg = config();
    const options = ["cp-valid", "cp-invalid"].map((checkpoint) => ({
      cfg,
      scope: "global",
      evidence: [evidence(checkpoint)],
      model: "test",
      invoke: async () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation:
                checkpoint === "cp-invalid"
                  ? {
                      type: "replace",
                      targetId: "mem_missing",
                      oldSpan: "old",
                      newSpan: "new",
                    }
                  : {
                      type: "create",
                      artifact: {
                        title: "Valid batch",
                        kind: "pattern",
                        scope: "global",
                        description: "Must wait for all preflights",
                        triggers: ["batch preflight"],
                        keywords: [],
                        body: "Do not apply a partial wave.",
                      },
                    },
            },
          ],
        }),
    }));
    await expect(processPipelineBatches(options)).rejects.toThrow(
      "unavailable memory",
    );
    expect(listProposals(cfg)).toHaveLength(0);
    expect(readReviewReceipts(cfg)).toHaveLength(0);
  });

  it("groups batch preflight by resolved memory storage identity", async () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    const memoryId = `mem_${"9".repeat(24)}`;
    const path = join(cfg.root, "2026-storage-identity--source__agent.md");
    const original = `---
memory_version: 2
memory_id: "${memoryId}"
status: "active"
title: "Durable verification"
kind: pattern
scope: "global"
description: "Durable verification rule"
triggers: ["durable verification"]
keywords: []
updated: "2026-07-31"
---

Run the narrow verification before completion.
`;
    writeFileSync(path, original);
    const rootAlias = join(cfg.root, "..", "memories-alias");
    symlinkSync(cfg.root, rootAlias, "dir");
    const equivalentCfg = {
      ...cfg,
      data: join(cfg.data, "..", "other-data"),
      root: rootAlias,
    };
    const options = [cfg, equivalentCfg].map((batchCfg, index) => ({
      cfg: batchCfg,
      scope: "global",
      evidence: [evidence(`cp-storage-${index}`)],
      model: "test",
      invoke: async () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation: {
                type: "replace",
                targetId: memoryId,
                oldSpan: "Run the narrow verification before completion.",
                newSpan: `Run verification variant ${index}.`,
              },
            },
          ],
        }),
    }));
    await expect(processPipelineBatches(options)).rejects.toThrow(
      "memory proposal batch contains overlapping targets",
    );
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(listProposals(cfg)).toHaveLength(0);
  });

  it("canonicalizes symlinked parents for missing memory roots", async () => {
    const cfg = config();
    const realParent = join(cfg.root, "..", "real-parent");
    const aliasParent = join(cfg.root, "..", "parent-alias");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, aliasParent, "dir");
    const roots = [
      join(realParent, "future-memories"),
      join(aliasParent, "future-memories"),
    ];
    const configs = roots.map((root, index) => ({
      ...cfg,
      data: join(cfg.data, "..", `missing-root-data-${index}`),
      root,
    }));
    const options = configs.map((batchCfg) => ({
      cfg: batchCfg,
      scope: "global",
      evidence: [evidence("cp-missing-root")],
      model: "test",
      invoke: async () =>
        JSON.stringify({
          version: 2,
          action: "propose",
          proposals: [
            {
              lane: "memory",
              evidenceWindowIds: [WINDOW_ID],
              operation: {
                type: "create",
                artifact: {
                  title: "Missing root",
                  kind: "pattern",
                  scope: "global",
                  description: "Use while preflighting missing roots",
                  triggers: ["missing root"],
                  keywords: [],
                  body: "Canonicalize the existing parent before mutation.",
                },
              },
            },
          ],
        }),
    }));
    await expect(processPipelineBatches(options)).rejects.toThrow(
      "memory proposal batch contains overlapping paths",
    );
    expect(roots.every((root) => !existsSync(root))).toBe(true);
    expect(configs.flatMap((item) => listProposals(item))).toHaveLength(0);
  });

  it("rejects invalid evidence selections and stores only selected refs", () => {
    const cfg = config();
    const second = evidence("cp-unselected");
    second.window.windowId = SECOND_WINDOW_ID;
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
              evidenceWindowIds: [WINDOW_ID],
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
    ).toEqual([WINDOW_ID]);
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
              evidenceWindowIds: [WINDOW_ID],
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
    second.window.windowId = SECOND_WINDOW_ID;
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
      WINDOW_ID,
      SECOND_WINDOW_ID,
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
