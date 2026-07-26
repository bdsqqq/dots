import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import { processPipelineBatch } from "./pipeline.js";
import { listProposals } from "./workflow.js";

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
    expect(existsSync(join(cfg.data, "v2/ledger/checkpoint.json"))).toBe(true);
    expect(
      readFileSync(
        join(cfg.data, `v2/runs/${result.runId}/input.json`),
        "utf8",
      ),
    ).not.toContain("raw private output");
  });

  it("materializes a strict reviewable proposal", () => {
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
    expect(listProposals(cfg)[0]).toMatchObject({
      lane: "memory",
      operation: { type: "create" },
    });
  });
});
