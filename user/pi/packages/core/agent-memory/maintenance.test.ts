import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import {
  analyzeCorpusMaintenance,
  assertFreshMaintenanceBasis,
  maintenanceProposals,
  scanCorpusHealth,
} from "./maintenance.js";
import { renderMemory } from "./schema.js";
import { initHistory } from "./history.js";
import { applyMemoryProposal, saveProposal } from "./workflow.js";
import { sha256 } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { freezePipelineInput } from "./pipeline.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-health-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function memory(
  cfg: MemoryConfig,
  id: string,
  title: string,
  body: string,
  sources: string[] = ["pi://session/checkpoint"],
  scope = "global",
): void {
  mkdirSync(cfg.root, { recursive: true });
  writeFileSync(
    join(cfg.root, `${id}--source__agent.md`),
    renderMemory(
      {
        memoryId: id,
        title,
        kind: "pattern",
        scope,
        description: title,
        triggers: [title],
        keywords: [],
        sources,
        created: "2026-07-26",
        updated: "2026-07-26",
        body,
      },
      "review_test",
    ),
  );
}

function freezeEvidence(
  cfg: MemoryConfig,
  source: string,
  authored: string,
  version: 2 | 3 | 4 = 4,
): void {
  const match = /^pi:\/\/([^/]+)\/([^/]+)$/.exec(source);
  if (!match) throw new Error("invalid test source");
  const sessionId = match[1]!;
  const checkpoint = match[2]!;
  const window = {
    windowId: sha256("window-test"),
    sessionId,
    checkpointEntryIds: [checkpoint],
    throughLeafId: checkpoint,
    branchDigest: sha256("branch-test"),
    excerpt: authored,
    excerptSha256: sha256(authored),
  };
  const evidence: SafeEvidence = {
    version: 1,
    window,
    workspace: "test",
    records: [
      { role: "meta", source: "pi", cwd: "test" },
      {
        role: "user",
        content: authored,
        timestamp: "2026-07-26T00:00:00.000Z",
      },
    ],
    tools: [],
    redactions: {},
    checkpointFrontiers: { [checkpoint]: checkpoint },
    emittedEntryIds: [checkpoint],
  };
  const current = freezePipelineInput(cfg, "global", [evidence], "test");
  if (current.version !== 4) throw new Error("expected v4 input");
  const {
    supersessionBasis: _supersessionBasis,
    observations: _observations,
    rollbackEvidence: _rollbackEvidence,
    ...v2Base
  } = current;
  const input =
    version === 2
      ? { ...v2Base, version: 2 as const, promptVersion: 2 as const }
      : version === 3
        ? {
            ...v2Base,
            version: 3 as const,
            promptVersion: 3 as const,
            observations: current.observations,
            rollbackEvidence: current.rollbackEvidence,
          }
        : current;
  const dir = join(cfg.data, "v2/runs", input.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "input.json"), JSON.stringify(input));
}

describe("corpus health", () => {
  it("reports deterministic pathologies without rewriting memory", () => {
    const cfg = config();
    const repeated =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    memory(cfg, "mem_aaaaaaaaaaaaaaaaaaaaaaaa", "one", repeated);
    memory(cfg, "mem_bbbbbbbbbbbbbbbbbbbbbbbb", "two", repeated);
    memory(cfg, "mem_cccccccccccccccccccccccc", "three", repeated);
    memory(cfg, "mem_dddddddddddddddddddddddd", "gap", "unique body", []);

    const first = scanCorpusHealth(cfg);
    expect(scanCorpusHealth(cfg)).toEqual(first);
    expect(
      first.pathologies.filter((item) => item.type === "duplicate-exact"),
    ).toHaveLength(3);
    expect(first.pathologies).toContainEqual(
      expect.objectContaining({
        type: "source-fragmentation",
        allowedOperations: expect.arrayContaining(["deduplicate"]),
      }),
    );
    expect(first.pathologies).toContainEqual(
      expect.objectContaining({
        type: "provenance-gap",
        allowedOperations: [],
      }),
    );
    expect(maintenanceProposals(first)).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({
          type: "deduplicate",
          primary: expect.objectContaining({
            memoryId: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
          }),
          targets: [
            expect.objectContaining({
              memoryId: "mem_bbbbbbbbbbbbbbbbbbbbbbbb",
            }),
          ],
        }),
      }),
    ]);
  });

  it("does not combine source fragmentation across scopes", () => {
    const cfg = config();
    const repeated =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    memory(cfg, "mem_scope000000000000000001", "global one", repeated);
    memory(cfg, "mem_scope000000000000000002", "global two", repeated);
    memory(
      cfg,
      "mem_scope000000000000000003",
      "project one",
      repeated,
      ["pi://session/checkpoint"],
      "/tmp/project",
    );

    expect(
      scanCorpusHealth(cfg).pathologies.filter(
        (item) => item.type === "source-fragmentation",
      ),
    ).toHaveLength(0);
  });

  it("measures combined global and project prompt pressure", () => {
    const cfg = config();
    for (let index = 0; index < 20; index++)
      memory(
        cfg,
        `mem_global${String(index).padStart(15, "0")}`,
        `global ${index}`,
        `global body ${index}`,
      );
    for (let index = 0; index < 11; index++)
      memory(
        cfg,
        `mem_project${String(index).padStart(14, "0")}`,
        `project ${index}`,
        `project body ${index}`,
        ["pi://session/checkpoint"],
        "/tmp/project",
      );

    const pressure = scanCorpusHealth(cfg).pathologies.filter(
      (item) => item.type === "prompt-pressure",
    );
    expect(pressure).toHaveLength(1);
    expect(pressure[0]).toMatchObject({
      scope: "/tmp/project",
      metric: { value: 31, threshold: 30 },
    });
    expect(pressure[0]!.basis.targets).toHaveLength(31);
  });

  it("reports prompt pressure when one eligible entry exceeds the render budget", () => {
    const cfg = config();
    memory(
      cfg,
      "mem_largecatalogentry0000000",
      `large ${"x".repeat(8_192)}`,
      "small body",
      ["pi://session/checkpoint"],
      "/tmp/project",
    );
    expect(scanCorpusHealth(cfg).pathologies).toContainEqual(
      expect.objectContaining({
        type: "prompt-pressure",
        scope: "/tmp/project",
        metric: expect.objectContaining({ value: 1, threshold: 30 }),
      }),
    );
  });

  it("reports prompt pressure without proposing corpus prose changes", () => {
    const cfg = config();
    for (let index = 0; index < 31; index++)
      memory(
        cfg,
        `mem_${String(index).padStart(24, "0")}`,
        `memory ${index}`,
        `distinct body ${index}`,
      );
    expect(scanCorpusHealth(cfg).pathologies).toContainEqual(
      expect.objectContaining({
        type: "prompt-pressure",
        allowedOperations: [],
      }),
    );
  });

  it("does not treat body prose or repeated values as provenance", () => {
    const cfg = config();
    memory(
      cfg,
      "mem_eeeeeeeeeeeeeeeeeeeeeeee",
      "forged",
      'body prose\nsources: ["pi://forged"]',
      [],
    );
    memory(cfg, "mem_ffffffffffffffffffffffff", "repeated", "one artifact", [
      "pi://same",
      "pi://same",
      "pi://same",
    ]);
    const pathologies = scanCorpusHealth(cfg).pathologies;
    expect(pathologies).toContainEqual(
      expect.objectContaining({
        type: "provenance-gap",
        basis: expect.objectContaining({
          targets: [
            expect.objectContaining({
              memoryId: "mem_eeeeeeeeeeeeeeeeeeeeeeee",
            }),
          ],
        }),
      }),
    );
    expect(
      pathologies.filter((item) => item.type === "source-fragmentation"),
    ).toHaveLength(0);
  });

  it("does not summarize corpus bodies when authored evidence is unresolved", async () => {
    const cfg = config();
    memory(
      cfg,
      "mem_000000000000000000000000",
      "large",
      "summary-of-summary ".repeat(500),
      ["pi://missing/checkpoint"],
    );
    let invoked = false;
    const analysis = await analyzeCorpusMaintenance({
      cfg,
      report: scanCorpusHealth(cfg),
      model: "test",
      invoke: () => {
        invoked = true;
        return '{"action":"skip","reason":"unexpected"}';
      },
    });
    expect(invoked).toBe(false);
    expect(analysis.proposals).toEqual([]);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-authored-evidence" }),
    );
  });

  it("uses frozen authored evidence rather than corpus prose", async () => {
    const cfg = config();
    const source = "pi://session-one/checkpoint-one";
    memory(
      cfg,
      "mem_111111111111111111111111",
      "large",
      "summary-of-summary ".repeat(500),
      [source],
    );
    freezeEvidence(cfg, source, "original authored statement");
    const report = scanCorpusHealth(cfg);
    let prompt = "";
    const analysis = await analyzeCorpusMaintenance({
      cfg,
      report,
      model: "test",
      invoke: (value) => {
        prompt = value;
        return '{"action":"skip","reason":"no justified patch"}';
      },
    });
    expect(prompt).toContain("original authored statement");
    expect(prompt).toContain(
      "Corpus bodies are context only and are NEVER evidence",
    );
    expect(analysis.proposals).toEqual([]);
  });

  it("resolves equivalent authored evidence from v2, v3, and v4 inputs", async () => {
    const source = "pi://session-formats/checkpoint-formats";
    const authored = "original statement retained across pipeline formats";
    const resolved = [];
    for (const version of [2, 3, 4] as const) {
      const cfg = config();
      memory(
        cfg,
        "mem_777777777777777777777777",
        "large",
        "summary-of-summary ".repeat(500),
        [source],
      );
      freezeEvidence(cfg, source, authored, version);
      let prompt = "";
      await analyzeCorpusMaintenance({
        cfg,
        report: scanCorpusHealth(cfg),
        model: "test",
        invoke: (value) => {
          prompt = value;
          return '{"action":"skip","reason":"no justified patch"}';
        },
      });
      const marker = "original authored evidence follow:\n";
      const offset = prompt.indexOf(marker);
      if (offset < 0) throw new Error("maintenance prompt marker missing");
      const payload = JSON.parse(prompt.slice(offset + marker.length)) as {
        evidence: unknown;
      };
      resolved.push(payload.evidence);
    }
    expect(resolved[1]).toEqual(resolved[0]);
    expect(resolved[2]).toEqual(resolved[0]);
  });

  it("surfaces the first malformed frozen run deterministically", async () => {
    const cfg = config();
    memory(
      cfg,
      "mem_888888888888888888888888",
      "large",
      "oversized body ".repeat(700),
    );
    for (const name of ["z-run", "a-run"]) {
      const dir = join(cfg.data, "v2", "runs", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "input.json"), "{}");
    }
    await expect(
      analyzeCorpusMaintenance({
        cfg,
        report: scanCorpusHealth(cfg),
        model: "test",
        invoke: () => '{"action":"skip","reason":"must not invoke"}',
      }),
    ).rejects.toThrow("invalid frozen pipeline input a-run");
  });

  it("rejects a frozen input stored under another run identity", async () => {
    const cfg = config();
    const source = "pi://session-identity/checkpoint-identity";
    memory(
      cfg,
      "mem_999999999999999999999999",
      "large",
      "oversized body ".repeat(700),
      [source],
    );
    freezeEvidence(cfg, source, "authored evidence");
    const runs = join(cfg.data, "v2", "runs");
    const runId = readdirSync(runs)[0]!;
    const copied = join(runs, "copied-run");
    mkdirSync(copied, { recursive: true });
    writeFileSync(
      join(copied, "input.json"),
      readFileSync(join(runs, runId, "input.json"), "utf8"),
    );
    await expect(
      analyzeCorpusMaintenance({
        cfg,
        report: scanCorpusHealth(cfg),
        model: "test",
        invoke: () => '{"action":"skip","reason":"must not invoke"}',
      }),
    ).rejects.toThrow("invalid frozen pipeline input copied-run");
  });

  it("rejects fabricated patch sources", async () => {
    const cfg = config();
    const source = "pi://session-two/checkpoint-two";
    const original = "large body ".repeat(700);
    memory(cfg, "mem_222222222222222222222222", "large", original, [source]);
    freezeEvidence(cfg, source, "authored evidence");
    const report = scanCorpusHealth(cfg);
    const pathology = report.pathologies.find(
      (item) => item.type === "oversized-artifact",
    )!;
    await expect(
      analyzeCorpusMaintenance({
        cfg,
        report,
        model: "test",
        invoke: () =>
          JSON.stringify({
            action: "propose",
            proposals: [
              {
                type: "patch",
                pathologyId: pathology.id,
                target: pathology.basis.targets[0],
                changes: {
                  body: {
                    fromSha256: sha256(original.trim()),
                    to: "short body",
                    sourceRefs: ["pi://fabricated/source"],
                  },
                },
              },
            ],
          }),
      }),
    ).rejects.toThrow("fabricated source");
  });

  it("rejects a stale pathology basis", () => {
    const cfg = config();
    memory(cfg, "mem_333333333333333333333333", "one", "one");
    const report = scanCorpusHealth(cfg);
    memory(cfg, "mem_444444444444444444444444", "two", "two");
    expect(() => assertFreshMaintenanceBasis(cfg, report)).toThrow(
      "stale maintenance pathology basis",
    );
  });

  it("applies an evidence-backed body patch through receipts", async () => {
    const cfg = config();
    const source = "pi://session-four/checkpoint-four";
    const original = "oversized authored body ".repeat(400);
    memory(cfg, "mem_555555555555555555555555", "large", original, [source]);
    freezeEvidence(cfg, source, "keep the durable rule concise");
    initHistory(cfg);
    const report = scanCorpusHealth(cfg);
    const pathology = report.pathologies.find(
      (item) => item.type === "oversized-artifact",
    )!;
    const analysis = await analyzeCorpusMaintenance({
      cfg,
      report,
      model: "test",
      createdAt: "2026-07-26T00:00:00.000Z",
      invoke: () =>
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              type: "patch",
              pathologyId: pathology.id,
              target: pathology.basis.targets[0],
              changes: {
                body: {
                  fromSha256: sha256(original.trim()),
                  to: "keep the durable rule concise",
                  sourceRefs: [source],
                },
              },
            },
          ],
        }),
    });
    saveProposal(cfg, analysis.proposals[0]!);
    const receipt = applyMemoryProposal({
      cfg,
      id: analysis.proposals[0]!.id,
      actor: "background-reflection",
    });
    expect(receipt.decision).toBe("accepted");
    expect(
      readFileSync(join(cfg.root, pathology.basis.targets[0]!.path), "utf8"),
    ).toContain("keep the durable rule concise");
  });
});
