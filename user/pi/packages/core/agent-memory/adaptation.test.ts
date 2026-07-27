import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdaptationPrompt,
  collectTurnObservations,
  deduplicateTurnObservations,
  listVerifiedRollbackEvidence,
  markShadowAdaptationLedger,
  parseAdaptationDecisions,
  publishShadowAdaptation,
  turnObservationMatchesRefs,
  verifiedRollbackEvidence,
  type RollbackEvidence,
  type TurnObservation,
} from "./adaptation.js";
import { scanCatalog, type MemoryConfig } from "./catalog.js";
import { withWritableMemoryRoot } from "./history.js";
import { canonicalTurnReceiptId, type TurnReceipt } from "./receipt.js";
import { canonicalProposalId, renderMemory, type Proposal } from "./schema.js";
import { reviewProposal, rollbackReview, saveProposal } from "./workflow.js";

function config(): MemoryConfig {
  const base = mkdtempSync(join(tmpdir(), "memory-adaptation-"));
  return {
    state: join(base, "state"),
    data: join(base, "data"),
    root: join(base, "memories"),
    skillsRoot: join(base, "skills"),
  };
}

function memory(id = "mem_aaaaaaaaaaaaaaaaaaaaaaaa") {
  return renderMemory(
    {
      memoryId: id,
      title: "Exact memory",
      kind: "pattern",
      scope: "global",
      description: "Use for exact adaptation tests",
      triggers: ["adaptation"],
      keywords: [],
      sources: ["pi://session/checkpoint"],
      created: "2026-07-27",
      updated: "2026-07-27",
      body: "Verify exact evidence.",
    },
    "review_test",
  );
}

function proposal(): Proposal {
  const value: Omit<Proposal, "id"> = {
    version: 2,
    digestVersion: 2,
    lane: "memory",
    status: "pending",
    operation: {
      type: "create",
      artifact: {
        memoryId: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Rollback target",
        kind: "pattern",
        scope: "global",
        description: "Use for rollback evidence tests",
        triggers: ["rollback"],
        keywords: [],
        sources: ["pi://session/checkpoint"],
        created: "2026-07-27",
        updated: "2026-07-27",
        body: "This version is later rolled back.",
      },
    },
    supersedes: [],
    evidence: [],
    provenance: {
      runId: "run_adaptation",
      promptVersion: 3,
      model: "test",
      createdAt: "2026-07-27T00:00:00.000Z",
      corpusAware: true,
    },
  };
  return { ...value, id: canonicalProposalId(value) };
}

describe("adaptation evidence and shadow decisions", () => {
  it("selects only strict, current, ancestry-bound turn observations", () => {
    const cfg = config();
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "2026-test--source__agent.md"), memory()),
    );
    const catalog = scanCatalog(cfg.root);
    const entry = catalog.entries[0]!;
    const identity: Omit<TurnReceipt, "receiptId"> = {
      version: 1,
      sessionId: "session",
      workspace: "/tmp/project",
      userEntryIds: ["u"],
      assistantEntryIds: ["a"],
      catalogSha256: "a".repeat(64),
      exposures: [
        {
          kind: "injected",
          memoryId: entry.memoryId,
          artifactSha256: entry.sha256,
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
    const foreignIdentity = { ...identity, sessionId: "foreign" };
    const foreignReceipt = {
      ...foreignIdentity,
      receiptId: canonicalTurnReceiptId(foreignIdentity),
    };
    const entries = [
      {
        type: "custom",
        id: "foreign",
        customType: "@bds_pi/agent-memory/turn-receipt",
        data: foreignReceipt,
      },
      { type: "message", id: "u", message: { role: "user" } },
      { type: "message", id: "a", message: { role: "assistant" } },
      {
        type: "custom",
        id: "r",
        customType: "@bds_pi/agent-memory/turn-receipt",
        data: receipt,
      },
    ];
    expect(
      collectTurnObservations({
        entries,
        start: 1,
        end: 2,
        receiptEnd: 3,
        sessionId: "session",
        workspace: "/tmp/project",
        catalog,
      }),
    ).toHaveLength(1);
    expect(
      collectTurnObservations({
        entries,
        start: 1,
        end: 2,
        receiptEnd: 3,
        sessionId: "session",
        workspace: "/tmp/project",
        catalog: {
          ...catalog,
          entries: [{ ...entry, scope: "/tmp/other-project" }],
        },
      }),
    ).toEqual([]);
    const staleIdentity = {
      ...identity,
      exposures: [
        { ...identity.exposures[0]!, artifactSha256: "b".repeat(64) },
      ],
    };
    entries[3]!.data = {
      ...staleIdentity,
      receiptId: canonicalTurnReceiptId(staleIdentity),
    };
    expect(
      collectTurnObservations({
        entries,
        start: 1,
        end: 2,
        receiptEnd: 3,
        sessionId: "session",
        workspace: "/tmp/project",
        catalog,
      }),
    ).toEqual([]);
    entries[3]!.data = { ...receipt, receiptId: "turn_" + "0".repeat(32) };
    expect(() =>
      collectTurnObservations({
        entries,
        start: 1,
        end: 2,
        receiptEnd: 3,
        sessionId: "session",
        workspace: "/tmp/project",
        catalog,
      }),
    ).toThrow("id does not match content");
  });

  it("accepts only exact current refs and exact nonempty evidence ids", () => {
    const cfg = config();
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "2026-test--source__agent.md"), memory()),
    );
    const catalog = scanCatalog(cfg.root);
    const entry = catalog.entries[0]!;
    const evidence: RollbackEvidence = {
      kind: "verified-rollback",
      evidenceId: `rollback:${"a".repeat(40)}:mut_x`,
      historyCommit: "a".repeat(40),
      mutationId: "mut_x",
      reviewId: "review_x",
      proposalId: "prop_x",
      reason: "authored correction",
      affectedRefs: [
        {
          memoryId: entry.memoryId,
          path: entry.path,
          artifactSha256: entry.sha256,
        },
      ],
      targets: [
        {
          memoryId: entry.memoryId,
          path: entry.path,
          artifactSha256: entry.sha256,
        },
      ],
    };
    const valid = {
      version: 1,
      decisions: [
        {
          action: "repair",
          target: evidence.targets[0],
          evidenceIds: [evidence.evidenceId],
          reason: "rollback is stronger evidence",
        },
      ],
    };
    expect(
      parseAdaptationDecisions(JSON.stringify(valid), catalog, [evidence]),
    ).toHaveLength(1);
    const turnIdentity: Omit<TurnReceipt, "receiptId"> = {
      version: 1,
      sessionId: "session",
      workspace: "/tmp",
      userEntryIds: ["u"],
      assistantEntryIds: ["a"],
      catalogSha256: "a".repeat(64),
      exposures: [
        {
          kind: "injected",
          memoryId: entry.memoryId,
          artifactSha256: entry.sha256,
        },
      ],
      outcomes: [],
      redactions: {},
      recordedAt: "2026-07-27T00:00:00.000Z",
    };
    const turnReceipt = {
      ...turnIdentity,
      receiptId: canonicalTurnReceiptId(turnIdentity),
    };
    const turn: TurnObservation = {
      kind: "turn-observation",
      evidenceId: `turn:r:${turnReceipt.receiptId}`,
      entryId: "r",
      receipt: turnReceipt,
    };
    expect(() =>
      parseAdaptationDecisions(
        JSON.stringify({
          ...valid,
          decisions: [
            { ...valid.decisions[0], evidenceIds: [turn.evidenceId] },
          ],
        }),
        catalog,
        [turn],
      ),
    ).toThrow("does not authorize exact target");
    expect(
      parseAdaptationDecisions(
        JSON.stringify({
          ...valid,
          decisions: [
            {
              ...valid.decisions[0],
              action: "reinforce",
              evidenceIds: [turn.evidenceId],
            },
          ],
        }),
        catalog,
        [turn],
      ),
    ).toHaveLength(1);
    expect(turnObservationMatchesRefs(turn, evidence.affectedRefs)).toBe(true);
    expect(
      turnObservationMatchesRefs(turn, [
        { memoryId: entry.memoryId, artifactSha256: "b".repeat(64) },
      ]),
    ).toBe(false);
    expect(deduplicateTurnObservations([turn, turn])).toEqual([turn]);
    expect(() =>
      parseAdaptationDecisions(
        JSON.stringify({
          ...valid,
          decisions: [{ ...valid.decisions[0], evidenceIds: ["fabricated"] }],
        }),
        catalog,
        [evidence],
      ),
    ).toThrow();
    expect(() =>
      parseAdaptationDecisions(
        JSON.stringify({
          ...valid,
          decisions: [
            {
              ...valid.decisions[0],
              target: {
                ...evidence.targets[0],
                artifactSha256: "b".repeat(64),
              },
            },
          ],
        }),
        catalog,
        [evidence],
      ),
    ).toThrow("stale adaptation target");
    expect(buildAdaptationPrompt(catalog, [evidence])).toMatch(
      /non-authoritative|Do not grade your own/,
    );
  });

  it("verifies rollback linkage and publishes shadow before its ledger idempotently", () => {
    const cfg = config();
    const created = proposal();
    saveProposal(cfg, created);
    const accepted = reviewProposal({
      cfg,
      id: created.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "seed rollback target",
    });
    const frozenCatalog = scanCatalog(cfg.root);
    const rolledBack = rollbackReview(
      cfg,
      accepted.reviewId,
      "user correction",
    );
    const evidence = verifiedRollbackEvidence(cfg, {
      historyCommit: rolledBack.historyCommit!,
      mutationId: rolledBack.mutationId!,
      reviewId: rolledBack.reviewId,
      proposalId: rolledBack.proposalId,
    });
    expect(evidence.affectedRefs).toEqual([
      expect.objectContaining({
        memoryId: "mem_aaaaaaaaaaaaaaaaaaaaaaaa",
        artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(listVerifiedRollbackEvidence(cfg, frozenCatalog)).toHaveLength(1);
    expect(
      listVerifiedRollbackEvidence(cfg, { ...frozenCatalog, entries: [] }),
    ).toEqual([]);
    expect(() =>
      verifiedRollbackEvidence(cfg, {
        historyCommit: rolledBack.historyCommit!,
        mutationId: rolledBack.mutationId!,
        reviewId: "fabricated",
        proposalId: rolledBack.proposalId,
      }),
    ).toThrow("rollback review receipt is missing");
    const decision = {
      action: "no-op" as const,
      evidenceIds: [evidence.evidenceId],
      reason: "shadow only",
    };
    const options = {
      cfg,
      eventId: "event_" + "a".repeat(64),
      model: "test",
      createdAt: "2026-07-27T00:00:00.000Z",
      evidence: [evidence],
      decisions: [decision],
    };
    const first = publishShadowAdaptation(options);
    expect(publishShadowAdaptation(options)).toEqual(first);
    const ledger = join(
      cfg.data,
      "v2/adaptation/ledger",
      `${options.eventId}.json`,
    );
    expect(existsSync(ledger)).toBe(false);
    markShadowAdaptationLedger(cfg, options.eventId, first.id);
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({
      shadowId: first.id,
    });
  });
});
