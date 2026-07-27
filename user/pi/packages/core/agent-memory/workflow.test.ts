import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCatalog, sha256, type MemoryConfig } from "./catalog.js";
import { canonicalProposalId, type Proposal } from "./schema.js";
import {
  applyMemoryProposal,
  listProposals,
  migrateV1,
  parseStoredProposal,
  recoverTransactions,
  readReviewReceipts,
  reconcileRollbackAdaptationEvents,
  reviewProposal,
  rollbackReview,
  saveProposal,
  submitManualProposal,
} from "./workflow.js";
import { listMaintenanceEvents } from "./events.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-workflow-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function proposal(_id = "prop_one"): Proposal {
  const value: Omit<Proposal, "id"> = {
    version: 2,
    digestVersion: 2,
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
  return { ...value, id: canonicalProposalId(value) };
}

function seal(proposal: Proposal): Proposal {
  const { id: _id, ...value } = proposal;
  proposal.id = canonicalProposalId(value);
  return proposal;
}

describe("memory proposal review", () => {
  it("applies and rolls back an accepted proposal", () => {
    const cfg = config();
    const created = proposal();
    saveProposal(cfg, created);
    const receipt = reviewProposal({
      cfg,
      id: created.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "verified durable rule",
    });
    expect(receipt.historyCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(receipt.mutationId).toMatch(/^mut_/);
    const active = readdirSync(cfg.root).find((name) => name.endsWith(".md"));
    expect(active).toBeTruthy();
    expect(readFileSync(join(cfg.root, active!), "utf8")).toContain(
      "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const rollback = rollbackReview(
      cfg,
      receipt.reviewId,
      "later shown incorrect",
    );
    expect(existsSync(join(cfg.root, active!))).toBe(false);
    const event = listMaintenanceEvents(cfg, ["pending"]).find(
      ({ event }) => event.kind === "adaptation-ready",
    );
    expect(event?.event.basis).toMatchObject({
      historyCommit: rollback.historyCommit,
      mutationId: rollback.mutationId,
      reviewId: rollback.reviewId,
      proposalId: rollback.proposalId,
    });
    rmSync(join(cfg.data, "v2/events/pending", `${event!.event.id}.json`));
    expect(reconcileRollbackAdaptationEvents(cfg)).toBe(1);
    expect(listMaintenanceEvents(cfg, ["pending"])).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ id: event!.event.id }),
      }),
    ]);
  });

  it("applies hash-guarded patches and rolls them back", () => {
    const cfg = config();
    const seed = proposal("prop_seed_patch");
    saveProposal(cfg, seed);
    reviewProposal({
      cfg,
      id: seed.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "seed patch target",
    });
    const target = scanCatalog(cfg.root).entries[0]!;
    const patch: Proposal = {
      ...proposal("prop_apply_patch"),
      evidence: [
        {
          windowId: "window_patch",
          sessionId: "session",
          checkpointEntryIds: ["checkpoint"],
          throughLeafId: "leaf",
          branchDigest: "branch",
          excerpt: "patch evidence",
          excerptSha256: sha256("patch evidence"),
        },
      ],
      operation: {
        type: "patch",
        target: {
          memoryId: target.memoryId,
          path: target.path,
          sha256: target.sha256,
        },
        changes: {
          description: {
            from: "Use when applying the durable rule",
            to: "Use when applying the patched durable rule",
          },
          body: {
            fromSha256: sha256("Apply the durable rule."),
            to: "Apply the patched durable rule.",
            sourceRefs: ["pi://session/checkpoint"],
          },
        },
      },
    };
    saveProposal(cfg, seal(patch));
    const receipt = applyMemoryProposal({
      cfg,
      id: patch.id,
      actor: "background-reflection",
    });
    const active = scanCatalog(cfg.root).entries[0]!;
    const text = readFileSync(join(cfg.root, active.path), "utf8");
    expect(text).toContain("Apply the patched durable rule.");
    expect(text).toContain("pi://session/checkpoint");
    rollbackReview(cfg, receipt.reviewId, "patch was invalid");
    expect(readFileSync(join(cfg.root, target.path), "utf8")).toContain(
      "Apply the durable rule.",
    );
  });

  it("deduplicates without rewriting the primary body", () => {
    const cfg = config();
    const primary = proposal("prop_primary_seed");
    const duplicate = proposal("prop_duplicate_seed");
    if (duplicate.operation.type !== "create") throw new Error("invalid test");
    duplicate.operation.artifact = {
      ...duplicate.operation.artifact,
      memoryId: "mem_bbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Duplicate durable rule",
      sources: ["pi://session/duplicate"],
    };
    saveProposal(cfg, seal(primary));
    saveProposal(cfg, seal(duplicate));
    for (const item of [primary, duplicate])
      reviewProposal({
        cfg,
        id: item.id,
        decision: "accept",
        reasonCode: "correct",
        reason: "seed deduplicate target",
      });
    const entries = scanCatalog(cfg.root).entries;
    const primaryEntry = entries.find(
      (entry) => entry.memoryId === "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
    )!;
    const duplicateEntry = entries.find(
      (entry) => entry.memoryId === "mem_bbbbbbbbbbbbbbbbbbbbbbbb",
    )!;
    const primaryBody = readFileSync(
      join(cfg.root, primaryEntry.path),
      "utf8",
    ).split("---\n\n")[1];
    const deduplicate: Proposal = {
      ...proposal("prop_apply_deduplicate"),
      operation: {
        type: "deduplicate",
        primary: {
          memoryId: primaryEntry.memoryId,
          path: primaryEntry.path,
          sha256: primaryEntry.sha256,
        },
        targets: [
          {
            memoryId: duplicateEntry.memoryId,
            path: duplicateEntry.path,
            sha256: duplicateEntry.sha256,
          },
        ],
      },
    };
    saveProposal(cfg, seal(deduplicate));
    applyMemoryProposal({
      cfg,
      id: deduplicate.id,
      actor: "background-reflection",
    });
    const after = readFileSync(join(cfg.root, primaryEntry.path), "utf8");
    expect(after.split("---\n\n")[1]).toBe(primaryBody);
    expect(after).toContain("pi://session/duplicate");
    expect(existsSync(join(cfg.root, duplicateEntry.path))).toBe(false);
  });

  it("applies manual memory proposals idempotently", () => {
    const cfg = config();
    const raw = JSON.stringify({
      action: "propose",
      proposals: [
        {
          lane: "memory",
          operation: {
            type: "create",
            artifact: {
              title: "Manual rule",
              kind: "pattern",
              scope: "global",
              description: "Use when manually preserving a rule",
              triggers: ["manual memory"],
              keywords: ["manual"],
              body: "Preserve this through review.",
            },
          },
        },
        {
          lane: "memory",
          operation: {
            type: "create",
            artifact: {
              title: "Second manual rule",
              kind: "gotcha",
              scope: "global",
              description: "Use when preserving the second manual rule",
              triggers: ["second manual memory"],
              keywords: ["manual", "second"],
              body: "Preserve the second rule through review.",
            },
          },
        },
      ],
    });
    const submitted = submitManualProposal(cfg, raw, "pi://manual/session");
    expect(submitManualProposal(cfg, raw, "pi://manual/session")).toEqual(
      submitted,
    );
    expect(
      submitManualProposal(
        cfg,
        JSON.stringify(JSON.parse(raw), null, 2),
        "pi://manual/session",
      ),
    ).toEqual(submitted);

    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.provenance).toMatchObject({
      model: "manual-cli",
      corpusAware: false,
    });
    expect(
      submitted[0]?.lane === "memory" && "artifact" in submitted[0].operation
        ? submitted[0].operation.artifact.sources
        : [],
    ).toEqual(["pi://manual/session"]);
    expect(existsSync(cfg.root)).toBe(false);
    const receipts = submitted.map((item) =>
      applyMemoryProposal({
        cfg,
        id: item.id,
        actor: "remember-skill",
      }),
    );
    expect(
      receipts.every((receipt) => receipt.reviewer === "remember-skill"),
    ).toBe(true);
    expect(
      submitted.map((item) =>
        applyMemoryProposal({
          cfg,
          id: item.id,
          actor: "remember-skill",
        }),
      ),
    ).toEqual(receipts);
    expect(readReviewReceipts(cfg)).toHaveLength(2);
    expect(
      readdirSync(cfg.root).filter((name) => name.endsWith(".md")),
    ).toHaveLength(2);
  });

  it("rejects a conflicting manual batch before saving proposals", () => {
    const cfg = config();
    const artifact = {
      title: "Conflicting rule",
      kind: "pattern",
      scope: "global",
      description: "Use while testing conflicts",
      triggers: ["conflict"],
      keywords: ["conflict"],
      body: "Only one memory may own a destination.",
    };
    const created = submitManualProposal(
      cfg,
      JSON.stringify({
        action: "propose",
        proposals: [
          { lane: "memory", operation: { type: "create", artifact } },
        ],
      }),
      "pi://manual/conflict-seed",
    )[0]!;
    applyMemoryProposal({
      cfg,
      id: created.id,
      actor: "remember-skill",
    });
    const memoryId =
      created.operation.type === "create"
        ? created.operation.artifact.memoryId
        : "";
    expect(() =>
      submitManualProposal(
        cfg,
        JSON.stringify({
          action: "propose",
          proposals: [
            {
              lane: "memory",
              operation: { type: "update", targetId: memoryId, artifact },
            },
            {
              lane: "memory",
              operation: { type: "update", targetId: memoryId, artifact },
            },
          ],
        }),
        "pi://manual/conflict",
      ),
    ).toThrow("overlapping targets");
    expect(listProposals(cfg)).toHaveLength(0);
  });

  it("aborts an interrupted rollback before its history commit", () => {
    const cfg = config();
    const interrupted = proposal("prop_interrupted_rollback");
    saveProposal(cfg, interrupted);
    const accepted = reviewProposal({
      cfg,
      id: interrupted.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "initially accepted",
    });
    const txPath = join(
      cfg.data,
      "v2/transactions",
      `${accepted.transactionId}.json`,
    );
    const transaction = JSON.parse(readFileSync(txPath, "utf8"));
    writeFileSync(
      join(cfg.data, "v2/reviews", `${accepted.reviewId}.json`),
      "{",
    );
    transaction.state = "rollback-prepared";
    transaction.rollback = {
      reviewId: "review_interrupted_rollback",
      reason: "later invalidated",
      startedAt: "2026-07-25T01:00:00.000Z",
    };
    writeFileSync(txPath, JSON.stringify(transaction));
    expect(recoverTransactions(cfg)).toBe(1);
    expect(
      existsSync(join(cfg.data, "v2/reviews/review_interrupted_rollback.json")),
    ).toBe(false);
    expect(() =>
      JSON.parse(
        readFileSync(
          join(cfg.data, "v2/reviews", `${accepted.reviewId}.json`),
          "utf8",
        ),
      ),
    ).not.toThrow();
    expect(
      readdirSync(cfg.root).filter((name) => name.endsWith(".md")),
    ).toHaveLength(1);
  });

  it("records rejection without mutating active memory", () => {
    const cfg = config();
    const rejected = proposal("prop_reject");
    saveProposal(cfg, rejected);
    reviewProposal({
      cfg,
      id: rejected.id,
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
    const archived = join(
      cfg.root,
      ".archive/archived/2026-07-25-rule--source__agent.md",
    );
    mkdirSync(join(cfg.root, ".archive/archived"), { recursive: true });
    writeFileSync(archived, "older archive\n");
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
    saveProposal(cfg, seal(archive));
    expect(() =>
      reviewProposal({
        cfg,
        id: archive.id,
        decision: "accept",
        reasonCode: "correct",
        reason: "archive stale rule",
      }),
    ).toThrow("archive destination exists");
    expect(readFileSync(active, "utf8")).toBe(text);
    expect(readFileSync(archived, "utf8")).toBe("older archive\n");
  });

  it("refuses rollback over a recreated archive source", () => {
    const cfg = config();
    mkdirSync(cfg.root, { recursive: true });
    const active = join(cfg.root, "2026-07-25-moved--source__agent.md");
    const text = `---\nmemory_version: 2\nmemory_id: "mem_eeeeeeeeeeeeeeeeeeeeeeee"\nstatus: "active"\ntitle: "Moved"\nkind: pattern\nscope: "global"\ndescription: "Moved rule"\ntriggers: []\nkeywords: []\nsources: []\ncreated: "2026-07-25"\nupdated: "2026-07-25"\nreview_id: "review_old"\n---\n\nMoved.\n`;
    writeFileSync(active, text);
    const archive: Proposal = {
      ...proposal("prop_moved"),
      operation: {
        type: "archive",
        target: {
          memoryId: "mem_eeeeeeeeeeeeeeeeeeeeeeee",
          path: "2026-07-25-moved--source__agent.md",
          sha256: createHash("sha256").update(text).digest("hex"),
        },
        reason: "stale",
      },
    };
    saveProposal(cfg, seal(archive));
    const accepted = reviewProposal({
      cfg,
      id: archive.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "archive stale rule",
    });
    chmodSync(cfg.root, 0o700);
    writeFileSync(active, "new unrelated memory\n");
    expect(() =>
      rollbackReview(cfg, accepted.reviewId, "restore old rule"),
    ).toThrow("dirty memory worktree");
    expect(readFileSync(active, "utf8")).toBe("new unrelated memory\n");
    expect(
      existsSync(
        join(cfg.root, ".archive/archived/2026-07-25-moved--source__agent.md"),
      ),
    ).toBe(true);
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

  it("rejects transaction journals outside the configured memory root", () => {
    const cfg = config();
    const outside = join(dirname(cfg.root), "outside.md");
    writeFileSync(outside, "keep\n");
    const txDir = join(cfg.data, "v2/transactions");
    mkdirSync(txDir, { recursive: true });
    writeFileSync(
      join(txDir, "tx_escape.json"),
      JSON.stringify({
        version: 1,
        id: "tx_escape",
        reviewId: "review_escape",
        state: "prepared",
        actions: [{ to: outside, after: "overwrite\n" }],
      }),
    );

    expect(() => recoverTransactions(cfg)).toThrow(
      "memory transaction path escapes configured root",
    );
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
  });

  it("rejects transaction paths through symlink ancestors", () => {
    const cfg = config();
    const outside = join(dirname(cfg.root), "outside");
    mkdirSync(cfg.root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "keep.md");
    writeFileSync(target, "keep\n");
    symlinkSync(outside, join(cfg.root, ".archive"));
    const txDir = join(cfg.data, "v2/transactions");
    mkdirSync(txDir, { recursive: true });
    writeFileSync(
      join(txDir, "tx_symlink.json"),
      JSON.stringify({
        version: 1,
        id: "tx_symlink",
        reviewId: "review_symlink",
        state: "prepared",
        actions: [
          {
            to: join(cfg.root, ".archive", "keep.md"),
            after: "overwrite\n",
          },
        ],
      }),
    );

    expect(() => recoverTransactions(cfg)).toThrow(
      "memory transaction path escapes configured root",
    );
    expect(readFileSync(target, "utf8")).toBe("keep\n");
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
    saveProposal(cfg, seal(skill));
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
  it("reads and verifies legacy manual proposal digests", () => {
    const current = proposal();
    const { digestVersion: _digestVersion, id: _id, ...legacy } = current;
    const operation = legacy.operation;
    if (!("artifact" in operation)) throw new Error("invalid test");
    legacy.provenance = {
      ...legacy.provenance,
      model: "manual-cli",
      source: "pi://manual/legacy",
    };
    operation.artifact.sources = ["pi://manual/legacy"];
    const digestOperation = {
      ...operation,
      artifact: { ...operation.artifact, sources: [] },
    };
    const id = `prop_${sha256(
      JSON.stringify({
        operation: digestOperation,
        evidence: legacy.evidence,
        runId: legacy.provenance.runId,
      }),
    ).slice(0, 32)}`;
    const raw = JSON.stringify({ ...legacy, id });
    expect(parseStoredProposal(raw).id).toBe(id);
    expect(() =>
      parseStoredProposal(
        JSON.stringify({
          ...legacy,
          id,
          operation: {
            ...operation,
            artifact: { ...operation.artifact, title: "Tampered" },
          },
        }),
      ),
    ).toThrow("stored proposal id does not match content");
  });
});
