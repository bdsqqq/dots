import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptationGate,
  buildAdaptationPrompt,
  collectTurnObservations,
  deduplicateTurnObservations,
  findShadowAdaptation,
  listVerifiedRollbackEvidence,
  markShadowAdaptationLedger,
  parseAdaptationDecisions,
  promoteShadowAdaptation,
  publishShadowAdaptation,
  turnObservationMatchesRefs,
  verifiedRollbackEvidence,
  type AdaptationDecision,
  type RollbackEvidence,
  type TurnObservation,
} from "./adaptation.js";
import { scanCatalog, sha256, type MemoryConfig } from "./catalog.js";
import { initHistory, listHistory, withWritableMemoryRoot } from "./history.js";
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
      condemnedRefs: [
        {
          memoryId: entry.memoryId,
          path: entry.path,
          artifactSha256: entry.sha256,
        },
      ],
      restoredRefs: [],
      targets: [
        {
          memoryId: entry.memoryId,
          path: entry.path,
          artifactSha256: entry.sha256,
        },
      ],
    };
    const valid = {
      version: 2,
      decisions: [
        {
          action: "demote",
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
    expect(buildAdaptationPrompt(cfg, catalog, [evidence])).toMatch(
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
      catalog: scanCatalog(cfg.root),
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

describe("production adaptation policy", () => {
  function setup() {
    const cfg = config();
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, "2026-test--source__agent.md"), memory()),
    );
    initHistory(cfg);
    const entry = scanCatalog(cfg.root).entries[0]!;
    return {
      cfg,
      target: {
        memoryId: entry.memoryId,
        path: entry.path,
        artifactSha256: entry.sha256,
      },
    };
  }

  function observation(options: {
    id: string;
    target: { memoryId: string; artifactSha256: string };
    session?: string;
    responseToReceiptId?: string;
    kind?: "injected" | "opened" | "cited";
    text?: string;
    outcome?: {
      toolName: string;
      result: "success" | "error";
      independent?: boolean;
    };
  }): TurnObservation {
    const exposureCall = `open-${options.id}`;
    const identity: Omit<TurnReceipt, "receiptId"> = {
      version: 1,
      sessionId: options.session ?? "session",
      workspace: "/tmp",
      userEntryIds: [`u-${options.id}`],
      assistantEntryIds: [`a-${options.id}`],
      ...(options.responseToReceiptId
        ? { responseToReceiptId: options.responseToReceiptId }
        : {}),
      catalogSha256: "a".repeat(64),
      exposures: [
        {
          kind: options.kind ?? "injected",
          memoryId: options.target.memoryId,
          artifactSha256: options.target.artifactSha256,
          ...(options.kind === "opened" || options.kind === "cited"
            ? { toolCallId: exposureCall }
            : {}),
        },
      ],
      outcomes: options.outcome
        ? [
            {
              toolCallId: options.outcome.independent
                ? `verify-${options.id}`
                : exposureCall,
              resultEntryId: `result-${options.id}`,
              toolName: options.outcome.toolName,
              result: options.outcome.result,
            },
          ]
        : [],
      redactions: {},
      recordedAt: "2026-07-27T00:00:00.000Z",
    };
    const receipt = {
      ...identity,
      receiptId: canonicalTurnReceiptId(identity),
    };
    return {
      kind: "turn-observation",
      evidenceId: `turn:${options.id}:${receipt.receiptId}`,
      entryId: options.id,
      receipt,
      ...(options.text
        ? {
            authoredUserText: [
              { entryId: `u-${options.id}`, text: options.text },
            ],
          }
        : {}),
    };
  }

  function shadow(
    cfg: MemoryConfig,
    evidence: TurnObservation[] | RollbackEvidence[],
    decisions: AdaptationDecision[],
    id = `adapt_${"a".repeat(64)}`,
  ) {
    return {
      version: 2 as const,
      id,
      eventId: `event_${"b".repeat(64)}`,
      model: "test",
      promptVersion: 2 as const,
      createdAt: "2026-07-27T00:00:00.000Z",
      catalog: scanCatalog(cfg.root),
      evidence,
      decisions,
    };
  }

  function replacementDecision(
    target: { memoryId: string; path: string; artifactSha256: string },
    prior: TurnObservation,
    correction: TurnObservation,
  ): AdaptationDecision {
    const authoredCorrection = "use the verified correction instead";
    return {
      action: "repair",
      target,
      evidenceIds: [prior.evidenceId, correction.evidenceId],
      reason: "authored correction",
      mutation: {
        type: "replace",
        oldSpan: "Verify exact evidence.",
        newSpan: authoredCorrection,
        authoredCorrection,
      },
    };
  }

  it("never promotes v1 shadows", () => {
    const { cfg } = setup();
    const baseline = listHistory(cfg).length;
    const legacyIdentity = {
      version: 1 as const,
      eventId: `event_${"2".repeat(64)}`,
      model: "old",
      promptVersion: 1 as const,
      createdAt: "2026-07-27T00:00:00.000Z",
      evidence: [],
      decisions: [],
    };
    const legacy = {
      ...legacyIdentity,
      id: `adapt_${sha256(JSON.stringify(legacyIdentity))}`,
    };
    const shadowRoot = join(cfg.data, "v2/adaptation/shadow");
    mkdirSync(shadowRoot, { recursive: true });
    writeFileSync(
      join(shadowRoot, `${legacy.id}.json`),
      JSON.stringify(legacy),
    );
    expect(findShadowAdaptation(cfg, legacy.eventId)).toBeUndefined();
    expect(buildAdaptationPrompt(cfg, scanCatalog(cfg.root), [])).toContain(
      `Return {"version":2`,
    );
    expect(promoteShadowAdaptation(cfg, legacy)[0]).toMatchObject({
      outcome: "error",
      action: "legacy",
    });
    expect(listHistory(cfg)).toHaveLength(baseline);
  });

  it("requires linked authored praise and rejects objective tool success", () => {
    const { cfg, target } = setup();
    const opened = observation({
      id: "open",
      target,
      kind: "opened",
      outcome: { toolName: "read", result: "success" },
    });
    const decision = {
      action: "reinforce" as const,
      target,
      evidenceIds: [opened.evidenceId],
      reason: "candidate",
    };
    expect(
      adaptationGate(cfg, shadow(cfg, [opened], [decision]), decision).allowed,
    ).toBe(false);
    const unboundPraise = observation({
      id: "praise",
      target,
      text: "thanks, that worked",
    });
    const unbound = { ...decision, evidenceIds: [unboundPraise.evidenceId] };
    expect(
      adaptationGate(cfg, shadow(cfg, [unboundPraise], [unbound]), unbound)
        .allowed,
    ).toBe(false);
    const linkedPraise = observation({
      id: "linked",
      target,
      responseToReceiptId: opened.receipt.receiptId,
      text: "thanks, that worked",
    });
    const linked = {
      ...decision,
      evidenceIds: [opened.evidenceId, linkedPraise.evidenceId],
    };
    expect(
      adaptationGate(cfg, shadow(cfg, [opened, linkedPraise], [linked]), linked)
        .allowed,
    ).toBe(true);
    const verified = observation({
      id: "verified",
      target,
      kind: "opened",
      outcome: { toolName: "test", result: "success", independent: true },
    });
    const objective = { ...decision, evidenceIds: [verified.evidenceId] };
    expect(
      adaptationGate(cfg, shadow(cfg, [verified], [objective]), objective)
        .allowed,
    ).toBe(false);
  });

  it("treats only the condemned rollback hash as negative authority", () => {
    const cfg = config();
    const created = proposal();
    saveProposal(cfg, created);
    const accepted = reviewProposal({
      cfg,
      id: created.id,
      decision: "accept",
      reasonCode: "correct",
      reason: "seed",
    });
    const badHash = scanCatalog(cfg.root).entries[0]!.sha256;
    const rolledBack = rollbackReview(
      cfg,
      accepted.reviewId,
      "incorrect artifact",
    );
    const evidence = verifiedRollbackEvidence(cfg, {
      historyCommit: rolledBack.historyCommit!,
      mutationId: rolledBack.mutationId!,
      reviewId: rolledBack.reviewId,
      proposalId: rolledBack.proposalId,
    });
    expect(evidence.condemnedRefs).toContainEqual(
      expect.objectContaining({ artifactSha256: badHash }),
    );
    expect(
      evidence.restoredRefs.some((ref) => ref.artifactSha256 === badHash),
    ).toBe(false);
    const restored = evidence.restoredRefs[0];
    if (restored) {
      const archive = {
        action: "archive" as const,
        target: restored,
        evidenceIds: [evidence.evidenceId],
        reason: "must not archive restored",
      };
      expect(
        adaptationGate(
          cfg,
          {
            ...shadow(cfg, [evidence], [archive]),
            catalog: scanCatalog(cfg.root),
          },
          archive,
        ).allowed,
      ).toBe(false);
    }
    const condemned = evidence.condemnedRefs[0]!;
    const demote = {
      action: "demote" as const,
      target: condemned,
      evidenceIds: [evidence.evidenceId],
      reason: "historical bad version",
    };
    const before = scanCatalog(cfg.root);
    const terminal = promoteShadowAdaptation(cfg, {
      ...shadow(cfg, [evidence], [demote]),
      catalog: {
        ...before,
        entries: [
          {
            ...before.entries[0]!,
            sha256: condemned.artifactSha256,
            path: condemned.path,
            memoryId: condemned.memoryId,
          },
        ],
      },
    })[0]!;
    expect(terminal.outcome).toBe("applied");
    expect(scanCatalog(cfg.root).entries).toEqual(before.entries);
  });

  it("replaces one exact body span and updates embedded provenance", () => {
    const { cfg, target } = setup();
    const prior = observation({ id: "prior", target });
    const correction = observation({
      id: "correction",
      target,
      responseToReceiptId: prior.receipt.receiptId,
      text: "wrong; use the verified correction instead",
    });
    const proposed = replacementDecision(target, prior, correction);
    const patch = parseAdaptationDecisions(
      JSON.stringify({ version: 2, decisions: [proposed] }),
      scanCatalog(cfg.root),
      [prior, correction],
    )[0]!;
    const before = readFileSync(join(cfg.root, target.path), "utf8");
    expect(
      promoteShadowAdaptation(cfg, shadow(cfg, [prior, correction], [patch]))[0]
        ?.outcome,
    ).toBe("applied");
    const after = readFileSync(join(cfg.root, target.path), "utf8");
    expect(after.split("\n---\n")[1]).toBe(
      before
        .split("\n---\n")[1]!
        .replace(
          "Verify exact evidence.",
          "use the verified correction instead",
        ),
    );
    expect(after).toMatch(/\nreview_id: "review_[a-f0-9]+"\n/);

    const second = setup();
    const prior2 = observation({ id: "prior2", target: second.target });
    const correction2 = observation({
      id: "correction2",
      target: second.target,
      responseToReceiptId: prior2.receipt.receiptId,
      text: "wrong; use the verified correction instead",
    });
    const bad: AdaptationDecision = {
      action: "repair",
      target: second.target,
      evidenceIds: [prior2.evidenceId, correction2.evidenceId],
      reason: "bad body",
      mutation: {
        type: "replace",
        oldSpan: "missing old body",
        newSpan: "use the verified correction instead",
        authoredCorrection: "use the verified correction instead",
      },
    };
    expect(
      promoteShadowAdaptation(
        second.cfg,
        shadow(second.cfg, [prior2, correction2], [bad]),
      )[0],
    ).toMatchObject({ outcome: "error" });
  });

  it("recovers an applied deterministic proposal before checking the stale target", () => {
    const { cfg, target } = setup();
    const prior = observation({ id: "prior", target });
    const correction = observation({
      id: "correction",
      target,
      responseToReceiptId: prior.receipt.receiptId,
      text: "wrong; use the verified correction instead",
    });
    const decision = replacementDecision(target, prior, correction);
    const value = shadow(cfg, [prior, correction], [decision]);
    const first = promoteShadowAdaptation(cfg, value)[0]!;
    rmSync(join(cfg.data, "v2/adaptation/production", value.id, "0.json"));
    expect(promoteShadowAdaptation(cfg, value)[0]).toMatchObject({
      outcome: "applied",
      proposalId: first.proposalId,
    });
  });

  it("settles later decisions after an earlier terminal error", () => {
    const { cfg, target } = setup();
    const exposure = observation({ id: "weak", target });
    const decisions: AdaptationDecision[] = [
      {
        action: "reinforce",
        target,
        evidenceIds: [exposure.evidenceId],
        reason: "unsupported",
      },
      {
        action: "no-op",
        evidenceIds: [exposure.evidenceId],
        reason: "independent no-op",
      },
    ];
    expect(
      promoteShadowAdaptation(cfg, shadow(cfg, [exposure], decisions)).map(
        (item) => item.outcome,
      ),
    ).toEqual(["error", "applied"]);
  });

  it("fails closed on artifact drift", () => {
    const { cfg, target } = setup();
    const verified = observation({
      id: "verified",
      target,
      kind: "opened",
      outcome: { toolName: "test", result: "success", independent: true },
    });
    withWritableMemoryRoot(cfg, () =>
      writeFileSync(join(cfg.root, target.path), `${memory()}\nchanged`),
    );
    const decision = {
      action: "reinforce" as const,
      target,
      evidenceIds: [verified.evidenceId],
      reason: "stale",
    };
    expect(
      promoteShadowAdaptation(
        cfg,
        shadow(cfg, [verified], [decision], `adapt_${"c".repeat(64)}`),
      )[0]?.outcome,
    ).toBe("stale");
  });
});
