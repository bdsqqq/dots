import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "./catalog.js";
import type { Proposal } from "./schema.js";
import {
  listProposals,
  reviewProposal,
  rollbackReview,
  saveProposal,
} from "./workflow.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-workflow-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function proposal(id = "prop_one"): Proposal {
  return {
    version: 2,
    id,
    lane: "memory",
    status: "pending",
    operation: {
      type: "create",
      artifact: {
        memoryId: "mem_one",
        title: "Durable rule",
        kind: "pattern",
        scope: "global",
        description: "Use when applying the durable rule",
        triggers: ["durable work"],
        keywords: ["rule"],
        sources: ["pi://session/checkpoint"],
        created: "2026-07-25",
        updated: "2026-07-25",
        body: "Apply the durable rule.",
      },
    },
    supersedes: [],
    evidence: [],
    provenance: {
      runId: "run_one",
      promptVersion: 2,
      model: "test",
      createdAt: "2026-07-25T00:00:00.000Z",
      corpusAware: true,
    },
  };
}

describe("memory proposal review", () => {
  it("applies and rolls back an accepted proposal", () => {
    const cfg = config();
    saveProposal(cfg, proposal());
    const receipt = reviewProposal({
      cfg,
      id: "prop_one",
      decision: "accept",
      reasonCode: "correct",
      reason: "verified durable rule",
    });
    const active = readdirSync(cfg.root).find((name) => name.endsWith(".md"));
    expect(active).toBeTruthy();
    expect(readFileSync(join(cfg.root, active!), "utf8")).toContain("mem_one");
    rollbackReview(cfg, receipt.reviewId, "later shown incorrect");
    expect(existsSync(join(cfg.root, active!))).toBe(false);
  });

  it("records rejection without mutating active memory", () => {
    const cfg = config();
    saveProposal(cfg, proposal("prop_reject"));
    reviewProposal({
      cfg,
      id: "prop_reject",
      decision: "reject",
      reasonCode: "ephemeral",
      reason: "only relevant to one session",
    });
    expect(listProposals(cfg, undefined, "pending")).toHaveLength(0);
    expect(existsSync(cfg.root)).toBe(false);
  });
});
