import { createHash } from "node:crypto";
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
import type { MemoryConfig } from "./catalog.js";
import type { Proposal } from "./schema.js";
import {
  listProposals,
  migrateV1,
  recoverTransactions,
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
        memoryId: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
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
    expect(readFileSync(join(cfg.root, active!), "utf8")).toContain(
      "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
    );
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

  it("preserves active memory when archive destination creation fails", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    const active = join(cfg.root, "2026-07-25-rule--source__agent.md");
    const text = `---\nmemory_version: 2\nmemory_id: "mem_bbbbbbbbbbbbbbbbbbbbbbbb"\nstatus: "active"\ntitle: "Rule"\nkind: pattern\nscope: "global"\ndescription: "Use for rule"\ntriggers: []\nkeywords: []\nsources: []\ncreated: "2026-07-25"\nupdated: "2026-07-25"\nreview_id: "review_old"\n---\n\nRule.\n`;
    writeFileSync(active, text);
    writeFileSync(join(cfg.root, ".archive"), "blocks directory creation\n");
    const archive: Proposal = {
      ...proposal("prop_archive"),
      operation: {
        type: "archive",
        target: {
          memoryId: "mem_bbbbbbbbbbbbbbbbbbbbbbbb",
          path: "2026-07-25-rule--source__agent.md",
          sha256: createHash("sha256").update(text).digest("hex"),
        },
        reason: "superseded",
      },
    };
    saveProposal(cfg, archive);
    expect(() =>
      reviewProposal({
        cfg,
        id: archive.id,
        decision: "accept",
        reasonCode: "correct",
        reason: "archive stale rule",
      }),
    ).toThrow();
    expect(readFileSync(active, "utf8")).toBe(text);
  });

  it("migrates legacy candidates without rewriting them", () => {
    const cfg = config();
    mkdirSync(join(cfg.data, "candidates"), { recursive: true });
    mkdirSync(join(cfg.data, "queue/processed"), { recursive: true });
    const name = "session--checkpoint";
    const legacy = `---\nversion: 1\nstatus: candidate\ntitle: "Legacy rule"\nkind: pattern\nscope: "global"\ntriggers: ["legacy work"]\nkeywords: ["legacy"]\nsource: pi://session/checkpoint\ncreated: 2026-07-25\nupdated: 2026-07-25\n---\n\nKeep the legacy rule.\n`;
    writeFileSync(join(cfg.data, "candidates", `${name}.md`), legacy);
    writeFileSync(join(cfg.data, "queue/processed", `${name}.json`), "{}\n");
    const second = "session-two--checkpoint-two";
    writeFileSync(
      join(cfg.data, "candidates", `${second}.md`),
      "---\nversion: 1\n---\n\ninvalid\n",
    );
    writeFileSync(join(cfg.data, "queue/processed", `${second}.json`), "{}\n");
    expect(() => migrateV1(cfg)).toThrow("legacy candidate missing");
    writeFileSync(
      join(cfg.data, "candidates", `${second}.md`),
      legacy.replaceAll("session/checkpoint", "session-two/checkpoint-two"),
    );
    expect(migrateV1(cfg)).toEqual({ candidates: 2, receipts: 0 });
    expect(migrateV1(cfg)).toEqual({ candidates: 2, receipts: 0 });
    expect(
      readFileSync(join(cfg.data, "candidates", `${name}.md`), "utf8"),
    ).toBe(legacy);
    expect(listProposals(cfg)).toHaveLength(2);
  });

  it("recovers an interrupted prepared transaction", () => {
    const cfg = config();
    const target = join(cfg.root, "interrupted--source__agent.md");
    mkdirSync(cfg.root, { recursive: true });
    writeFileSync(target, "after\n");
    const txDir = join(cfg.data, "v2/transactions");
    mkdirSync(txDir, { recursive: true });
    writeFileSync(
      join(txDir, "tx_interrupted.json"),
      JSON.stringify({
        version: 1,
        id: "tx_interrupted",
        reviewId: "review_interrupted",
        state: "prepared",
        actions: [{ to: target, after: "after\n" }],
      }),
    );
    const updateTarget = join(cfg.root, "update--source__agent.md");
    writeFileSync(updateTarget, "before\n");
    writeFileSync(
      join(txDir, "tx_update.json"),
      JSON.stringify({
        version: 1,
        id: "tx_update",
        reviewId: "review_update",
        state: "prepared",
        actions: [
          {
            from: updateTarget,
            to: updateTarget,
            before: "before\n",
            after: "after\n",
          },
        ],
      }),
    );
    expect(recoverTransactions(cfg)).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(updateTarget, "utf8")).toBe("before\n");
  });

  it("approves skill drafts without modifying installed skills", () => {
    const cfg = config();
    mkdirSync(join(cfg.skillsRoot, "existing"), { recursive: true });
    const installed = join(cfg.skillsRoot, "existing/SKILL.md");
    writeFileSync(installed, "installed\n");
    const content =
      "---\nname: reusable-check\ndescription: Use for checks\n---\n\n# Check\n";
    const skill: Proposal = {
      ...proposal("prop_skill"),
      lane: "skill",
      operation: {
        type: "skill-draft",
        mode: "create",
        skillName: "reusable-check",
        targetPath: "reusable-check/SKILL.md",
        files: [
          {
            path: "reusable-check/SKILL.md",
            content,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      },
    };
    saveProposal(cfg, skill);
    const receipt = reviewProposal({
      cfg,
      id: skill.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "workflow is reusable",
    });
    expect(readFileSync(installed, "utf8")).toBe("installed\n");
    expect(receipt.finalArtifacts[0]?.status).toBe("approved-skill-draft");
  });
});
