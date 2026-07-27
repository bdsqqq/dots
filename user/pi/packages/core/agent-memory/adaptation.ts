import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  atomicWrite,
  contained,
  memoryScopeRank,
  scanCatalog,
  secureDir,
  writeCatalog,
  sha256,
  type Catalog,
  type MemoryConfig,
} from "./catalog.js";
import {
  commitHistory,
  historyContainsAncestor,
  historyEntryByMutationId,
  historyReceiptAt,
  isHistoryInitialized,
  listHistoryByKind,
  verifyHistory,
} from "./history.js";
import { redact } from "./evidence.js";
import { verifyPersistedRollbackLinkage } from "./workflow.js";
import {
  parseTurnReceipt,
  validateTurnReceiptBinding,
  type MemoryRef,
  type TurnReceipt,
} from "./receipt.js";
import { canonicalProposalId, type Proposal } from "./schema.js";
import { applyMemoryProposal, findProposal, saveProposal } from "./workflow.js";

export type TurnObservation = {
  kind: "turn-observation";
  evidenceId: string;
  entryId: string;
  receipt: TurnReceipt;
  authoredUserText?: Array<{ entryId: string; text: string }>;
};
export type RollbackEvidence = {
  kind: "verified-rollback";
  evidenceId: string;
  historyCommit: string;
  mutationId: string;
  reviewId: string;
  proposalId: string;
  reason: string;
  affectedRefs: MemoryRef[];
  condemnedRefs: MemoryRef[];
  restoredRefs: MemoryRef[];
  targets: MemoryRef[];
};
export type AdaptationEvidence = TurnObservation | RollbackEvidence;
type TargetedAction = "reinforce" | "repair" | "demote" | "archive";
import { deriveAdaptationQuality } from "./quality.js";
export { deriveAdaptationQuality } from "./quality.js";
export const PRODUCTION_ADAPTATION_VERSION = 2 as const;
export const ADAPTATION_PROMPT_VERSION = 2 as const;

type RepairMutation = {
  type: "replace";
  oldSpan: string;
  newSpan: string;
  authoredCorrection: string;
};
export type AdaptationDecision =
  | {
      action: "reinforce";
      target: MemoryRef;
      evidenceIds: string[];
      reason: string;
    }
  | {
      action: "demote";
      target: MemoryRef;
      evidenceIds: string[];
      reason: string;
    }
  | {
      action: "archive";
      target: MemoryRef;
      evidenceIds: string[];
      reason: string;
    }
  | {
      action: "repair";
      target: MemoryRef;
      evidenceIds: string[];
      reason: string;
      mutation: RepairMutation;
    }
  | { action: "no-op"; evidenceIds: string[]; reason: string };
export type LegacyShadowAdaptation = {
  version: 1;
  id: string;
  eventId: string;
  model: string;
  promptVersion: 1;
  createdAt: string;
  evidence: AdaptationEvidence[];
  decisions: unknown[];
};
export type ShadowAdaptation = {
  version: typeof PRODUCTION_ADAPTATION_VERSION;
  id: string;
  eventId: string;
  model: string;
  promptVersion: typeof ADAPTATION_PROMPT_VERSION;
  createdAt: string;
  catalog: Catalog;
  evidence: AdaptationEvidence[];
  decisions: AdaptationDecision[];
};

type SessionEntry = {
  type: string;
  id: string;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
};
const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function parseTurnObservation(value: unknown): TurnObservation {
  if (
    !object(value) ||
    !exactKeys(value, [
      "kind",
      "evidenceId",
      "entryId",
      "receipt",
      ...(value.authoredUserText === undefined ? [] : ["authoredUserText"]),
    ]) ||
    value.kind !== "turn-observation" ||
    typeof value.evidenceId !== "string" ||
    typeof value.entryId !== "string" ||
    !value.entryId
  )
    throw new Error("invalid turn observation");
  const receipt = parseTurnReceipt(value.receipt);
  if (
    value.authoredUserText !== undefined &&
    (!Array.isArray(value.authoredUserText) ||
      value.authoredUserText.some(
        (item) =>
          !object(item) ||
          !exactKeys(item, ["entryId", "text"]) ||
          typeof item.entryId !== "string" ||
          !receipt.userEntryIds.includes(item.entryId) ||
          typeof item.text !== "string" ||
          !item.text.trim(),
      ))
  )
    throw new Error("invalid authored user text");
  if (value.evidenceId !== `turn:${value.entryId}:${receipt.receiptId}`)
    throw new Error("turn observation id does not match content");
  return {
    kind: "turn-observation",
    evidenceId: value.evidenceId,
    entryId: value.entryId,
    receipt,
    ...(value.authoredUserText === undefined
      ? {}
      : {
          authoredUserText: value.authoredUserText as Array<{
            entryId: string;
            text: string;
          }>,
        }),
  };
}

function currentRef(
  catalog: Catalog,
  memoryId: string,
  hash: string,
): MemoryRef | undefined {
  const entry = catalog.entries.find(
    (candidate) => candidate.memoryId === memoryId && candidate.sha256 === hash,
  );
  return entry
    ? {
        memoryId: entry.memoryId,
        path: entry.path,
        artifactSha256: entry.sha256,
      }
    : undefined;
}

export function validateTurnObservationRefs(
  observation: TurnObservation,
  catalog: Catalog,
): void {
  for (const exposure of observation.receipt.exposures) {
    const entry = catalog.entries.find(
      (candidate) =>
        candidate.memoryId === exposure.memoryId &&
        candidate.sha256 === exposure.artifactSha256,
    );
    if (
      !entry ||
      memoryScopeRank(entry.scope, observation.receipt.workspace) <= 0
    )
      throw new Error("turn observation ref is outside frozen scoped catalog");
  }
}

export function deduplicateTurnObservations(
  observations: TurnObservation[],
): TurnObservation[] {
  return [
    ...new Map(observations.map((item) => [item.evidenceId, item])).values(),
  ];
}

export function turnObservationMatchesRefs(
  observation: TurnObservation,
  refs: Array<{ memoryId: string; artifactSha256: string }>,
): boolean {
  return observation.receipt.exposures.some((exposure) =>
    refs.some(
      (ref) =>
        ref.memoryId === exposure.memoryId &&
        ref.artifactSha256 === exposure.artifactSha256,
    ),
  );
}

export function collectTurnObservations(options: {
  entries: SessionEntry[];
  start: number;
  end: number;
  receiptEnd?: number;
  sessionId: string;
  workspace: string;
  catalog: Catalog;
}): TurnObservation[] {
  const receiptEnd = options.receiptEnd ?? options.end;
  if (
    !Number.isInteger(options.start) ||
    !Number.isInteger(options.end) ||
    !Number.isInteger(receiptEnd) ||
    options.start < 0 ||
    options.end < options.start ||
    options.end >= options.entries.length ||
    receiptEnd < options.end ||
    receiptEnd >= options.entries.length
  )
    throw new Error("invalid turn observation window");
  const authored = new Set(
    options.entries
      .slice(options.start, options.end + 1)
      .flatMap((entry) =>
        entry.type === "message" &&
        object(entry.message) &&
        (entry.message.role === "user" || entry.message.role === "assistant")
          ? [entry.id]
          : [],
      ),
  );
  const through = new Set(
    options.entries.slice(0, options.end + 1).map((entry) => entry.id),
  );
  const text = (entry: SessionEntry): string => {
    if (!object(entry.message)) return "";
    const content = entry.message.content;
    return typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(object)
            .filter(
              (part) => part.type === "text" && typeof part.text === "string",
            )
            .map((part) => String(part.text))
            .join("\n")
        : "";
  };
  const observations = options.entries
    .slice(0, receiptEnd + 1)
    .flatMap((entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== "@bds_pi/agent-memory/turn-receipt"
      )
        return [];
      if (!object(entry.data) || entry.data.sessionId !== options.sessionId)
        return [];
      const receipt = parseTurnReceipt(entry.data);
      const authoredIds = [
        ...receipt.userEntryIds,
        ...receipt.assistantEntryIds,
      ];
      if (
        !authoredIds.some((id) => authored.has(id)) ||
        !authoredIds.every((id) => through.has(id))
      )
        return [];
      validateTurnReceiptBinding(options.entries, entry.id, receipt, {
        sessionId: options.sessionId,
        workspace: options.workspace,
      });
      if (receipt.exposures.length === 0) return [];
      const observation = {
        kind: "turn-observation" as const,
        evidenceId: `turn:${entry.id}:${receipt.receiptId}`,
        entryId: entry.id,
        receipt,
        authoredUserText: options.entries
          .slice(0, options.end + 1)
          .filter((candidate) => receipt.userEntryIds.includes(candidate.id))
          .flatMap((candidate) => {
            const value = redact(text(candidate)).text.trim().slice(0, 12_000);
            return value ? [{ entryId: candidate.id, text: value }] : [];
          }),
      };
      try {
        validateTurnObservationRefs(observation, options.catalog);
      } catch {
        return [];
      }
      return [observation];
    });
  return [
    ...new Map(observations.map((item) => [item.evidenceId, item])).values(),
  ];
}

export function parseRollbackEvidence(
  value: unknown,
  catalog?: Catalog,
): RollbackEvidence {
  if (!object(value) || value.kind !== "verified-rollback")
    throw new Error("invalid rollback evidence");
  const legacy = "affectedRefs" in value && !("condemnedRefs" in value);
  const keys = legacy
    ? [
        "kind",
        "affectedRefs",
        "evidenceId",
        "historyCommit",
        "mutationId",
        "reviewId",
        "proposalId",
        "reason",
        "targets",
      ]
    : [
        "kind",
        "affectedRefs",
        "condemnedRefs",
        "restoredRefs",
        "evidenceId",
        "historyCommit",
        "mutationId",
        "reviewId",
        "proposalId",
        "reason",
        "targets",
      ];
  if (
    !exactKeys(value, keys) ||
    typeof value.historyCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(value.historyCommit) ||
    typeof value.mutationId !== "string" ||
    !value.mutationId ||
    typeof value.reviewId !== "string" ||
    !value.reviewId ||
    typeof value.proposalId !== "string" ||
    !value.proposalId ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    typeof value.evidenceId !== "string" ||
    value.evidenceId !==
      `rollback:${value.historyCommit}:${value.mutationId}` ||
    !Array.isArray(value.affectedRefs) ||
    (!legacy &&
      (!Array.isArray(value.condemnedRefs) ||
        !Array.isArray(value.restoredRefs))) ||
    !Array.isArray(value.targets)
  )
    throw new Error("invalid rollback evidence");
  const storedRef = (target: unknown): MemoryRef => {
    if (
      !object(target) ||
      !exactKeys(target, ["memoryId", "path", "artifactSha256"]) ||
      typeof target.memoryId !== "string" ||
      typeof target.path !== "string" ||
      typeof target.artifactSha256 !== "string" ||
      !HASH.test(target.artifactSha256)
    )
      throw new Error("invalid rollback evidence target");
    return target as MemoryRef;
  };
  const affectedRefs = value.affectedRefs.map(storedRef);
  const condemnedRefs = legacy
    ? []
    : (value.condemnedRefs as unknown[]).map(storedRef);
  const restoredRefs = legacy
    ? []
    : (value.restoredRefs as unknown[]).map(storedRef);
  if (
    catalog &&
    affectedRefs.some(
      (ref) =>
        !catalog.entries.some((entry) => entry.memoryId === ref.memoryId),
    )
  )
    throw new Error("rollback evidence is outside scoped catalog");
  const targets = value.targets.map((target) =>
    catalog ? parseRef(target, catalog) : storedRef(target),
  );
  return {
    kind: "verified-rollback",
    evidenceId: value.evidenceId,
    historyCommit: value.historyCommit,
    mutationId: value.mutationId,
    reviewId: value.reviewId,
    proposalId: value.proposalId,
    reason: value.reason,
    affectedRefs,
    condemnedRefs,
    restoredRefs,
    targets,
  };
}

export function verifiedRollbackEvidence(
  cfg: MemoryConfig,
  input: {
    historyCommit: string;
    mutationId: string;
    reviewId: string;
    proposalId: string;
  },
): RollbackEvidence {
  if (!/^[0-9a-f]{40,64}$/.test(input.historyCommit))
    throw new Error("invalid rollback history commit");
  if (!historyContainsAncestor(cfg, input.historyCommit))
    throw new Error("rollback history is not trusted ancestry");
  const verification = verifyHistory(cfg);
  if (!verification.ok)
    throw new Error(
      `rollback history verification failed: ${verification.issues.join(", ")}`,
    );
  verifyPersistedRollbackLinkage(cfg, input);
  const receipt = historyReceiptAt(cfg, input.historyCommit);
  if (
    receipt.kind !== "rollback" ||
    receipt.mutationId !== input.mutationId ||
    receipt.reviewId !== input.reviewId ||
    receipt.proposalId !== input.proposalId ||
    !object(receipt.provenance) ||
    receipt.provenance.reviewer !== "local-cli"
  )
    throw new Error("rollback evidence linkage does not match history");
  const catalog = scanCatalog(cfg.root);
  const refs = (side: "beforeSha256" | "afterSha256"): MemoryRef[] =>
    receipt.changes.flatMap((change) =>
      change.memoryId && change[side]
        ? [
            {
              memoryId: change.memoryId,
              path: change.path,
              artifactSha256: change[side],
            },
          ]
        : [],
    );
  const condemnedRefs = refs("beforeSha256");
  const restoredRefs = refs("afterSha256");
  const affectedRefs = [
    ...new Map(
      [...condemnedRefs, ...restoredRefs].map((ref) => [refKey(ref), ref]),
    ).values(),
  ];
  const targets = restoredRefs.flatMap((ref) => {
    const current = currentRef(catalog, ref.memoryId, ref.artifactSha256);
    return current && current.path === ref.path ? [current] : [];
  });
  return {
    kind: "verified-rollback",
    evidenceId: `rollback:${receipt.commit}:${receipt.mutationId}`,
    historyCommit: receipt.commit,
    mutationId: receipt.mutationId,
    reviewId: receipt.reviewId!,
    proposalId: receipt.proposalId!,
    reason: receipt.reason,
    affectedRefs,
    condemnedRefs,
    restoredRefs,
    targets,
  };
}

export function listVerifiedRollbackEvidence(
  cfg: MemoryConfig,
  catalog: Catalog = scanCatalog(cfg.root),
): RollbackEvidence[] {
  if (!isHistoryInitialized(cfg)) return [];
  const scopedIds = new Set(catalog.entries.map((entry) => entry.memoryId));
  return listHistoryByKind(cfg, "rollback")
    .slice(0, 100)
    .flatMap((entry) => {
      const receipt = entry.receipt;
      if (!receipt.reviewId || !receipt.proposalId) return [];
      try {
        const evidence = verifiedRollbackEvidence(cfg, {
          historyCommit: entry.commit,
          mutationId: receipt.mutationId,
          reviewId: receipt.reviewId,
          proposalId: receipt.proposalId,
        });
        const affectedRefs = evidence.affectedRefs.filter((ref) =>
          scopedIds.has(ref.memoryId),
        );
        const targets = evidence.targets.filter(
          (ref) =>
            currentRef(catalog, ref.memoryId, ref.artifactSha256)?.path ===
            ref.path,
        );
        return affectedRefs.length
          ? [
              {
                ...evidence,
                affectedRefs,
                condemnedRefs: evidence.condemnedRefs.filter((ref) =>
                  scopedIds.has(ref.memoryId),
                ),
                restoredRefs: evidence.restoredRefs.filter((ref) =>
                  scopedIds.has(ref.memoryId),
                ),
                targets,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
}

function storedAdaptationRef(value: unknown): MemoryRef {
  if (
    !object(value) ||
    !exactKeys(value, ["memoryId", "path", "artifactSha256"]) ||
    typeof value.memoryId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.artifactSha256 !== "string" ||
    !HASH.test(value.artifactSha256)
  )
    throw new Error("invalid adaptation target");
  return value as MemoryRef;
}

function parseRef(value: unknown, catalog: Catalog): MemoryRef {
  if (
    !object(value) ||
    !exactKeys(value, ["memoryId", "path", "artifactSha256"]) ||
    typeof value.memoryId !== "string" ||
    typeof value.path !== "string" ||
    typeof value.artifactSha256 !== "string" ||
    !HASH.test(value.artifactSha256)
  )
    throw new Error("invalid adaptation target");
  const ref = currentRef(catalog, value.memoryId, value.artifactSha256);
  if (!ref || ref.path !== value.path)
    throw new Error("stale adaptation target");
  return ref;
}

function refKey(ref: MemoryRef): string {
  return `${ref.memoryId}\0${ref.path}\0${ref.artifactSha256}`;
}

function evidenceAuthorizes(
  action: TargetedAction,
  target: MemoryRef,
  selected: AdaptationEvidence[],
): boolean {
  const exact = refKey(target);
  return selected.some((item) => {
    if (item.kind === "verified-rollback")
      return item.condemnedRefs.some((ref) => refKey(ref) === exact);
    if (action === "reinforce")
      return item.receipt.exposures.some(
        (exposure) =>
          exposure.memoryId === target.memoryId &&
          exposure.artifactSha256 === target.artifactSha256,
      );
    if (!item.receipt.responseToReceiptId) return false;
    const prior = selected.find(
      (candidate) =>
        candidate.kind === "turn-observation" &&
        candidate.receipt.receiptId === item.receipt.responseToReceiptId,
    );
    return (
      prior?.kind === "turn-observation" &&
      prior.receipt.exposures.some(
        (exposure) =>
          exposure.memoryId === target.memoryId &&
          exposure.artifactSha256 === target.artifactSha256,
      )
    );
  });
}

function parseMutation(value: unknown): RepairMutation {
  if (
    !object(value) ||
    !exactKeys(value, ["type", "oldSpan", "newSpan", "authoredCorrection"]) ||
    value.type !== "replace" ||
    typeof value.oldSpan !== "string" ||
    !value.oldSpan ||
    typeof value.newSpan !== "string" ||
    !value.newSpan ||
    value.oldSpan === value.newSpan ||
    typeof value.authoredCorrection !== "string" ||
    !value.authoredCorrection.trim()
  )
    throw new Error("invalid adaptation replacement");
  return value as RepairMutation;
}

export function parseAdaptationDecisions(
  raw: string,
  catalog: Catalog,
  evidence: AdaptationEvidence[],
): AdaptationDecision[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid adaptation decision json");
  }
  if (
    !object(value) ||
    !exactKeys(value, ["version", "decisions"]) ||
    value.version !== PRODUCTION_ADAPTATION_VERSION ||
    !Array.isArray(value.decisions) ||
    value.decisions.length < 1 ||
    value.decisions.length > 20
  )
    throw new Error("invalid adaptation decisions");
  const available = new Set(evidence.map((item) => item.evidenceId));
  return value.decisions.map((candidate) => {
    if (!object(candidate)) throw new Error("invalid adaptation decision");
    const targeted = ["reinforce", "repair", "demote", "archive"].includes(
      String(candidate.action),
    );
    const keys = targeted
      ? [
          "action",
          "target",
          "evidenceIds",
          "reason",
          ...(candidate.action === "repair" ? ["mutation"] : []),
        ]
      : ["action", "evidenceIds", "reason"];
    if (
      !exactKeys(candidate, keys) ||
      (!targeted && candidate.action !== "no-op") ||
      !Array.isArray(candidate.evidenceIds) ||
      candidate.evidenceIds.length === 0 ||
      !candidate.evidenceIds.every(
        (id) => typeof id === "string" && available.has(id),
      ) ||
      new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length ||
      typeof candidate.reason !== "string" ||
      !candidate.reason.trim() ||
      candidate.reason !== candidate.reason.trim()
    )
      throw new Error("invalid adaptation decision");
    if (!targeted)
      return {
        action: "no-op",
        evidenceIds: candidate.evidenceIds as string[],
        reason: candidate.reason,
      };
    const target = storedAdaptationRef(candidate.target);
    const evidenceIds = candidate.evidenceIds as string[];
    const selected = evidence.filter((item) =>
      evidenceIds.includes(item.evidenceId),
    );
    const current = currentRef(catalog, target.memoryId, target.artifactSha256);
    const historical = selected.some(
      (item) =>
        item.kind === "verified-rollback" &&
        item.condemnedRefs.some((ref) => refKey(ref) === refKey(target)),
    );
    if ((!current || current.path !== target.path) && !historical)
      throw new Error("stale adaptation target");
    if (
      !evidenceAuthorizes(candidate.action as TargetedAction, target, selected)
    )
      throw new Error("adaptation evidence does not authorize exact target");
    if (candidate.action === "repair")
      return {
        action: "repair",
        target,
        evidenceIds,
        reason: candidate.reason,
        mutation: parseMutation(candidate.mutation),
      };
    return {
      action: candidate.action as "reinforce" | "demote" | "archive",
      target,
      evidenceIds,
      reason: candidate.reason,
    };
  });
}

export function buildAdaptationPrompt(
  cfg: MemoryConfig,
  catalog: Catalog,
  evidence: AdaptationEvidence[],
): string {
  const artifacts = catalog.entries.map((entry) => ({
    ref: {
      memoryId: entry.memoryId,
      path: entry.path,
      artifactSha256: entry.sha256,
    },
    content: readFileSync(
      contained(cfg.root, join(cfg.root, entry.path)),
      "utf8",
    ),
  }));
  return `You are making production-gated memory adaptation decisions. Return exactly one JSON object and no markdown.

Return {"version":2,"decisions":[...]}. Every targeted decision uses an exact frozen ref and evidence IDs. Repair MUST include mutation {"type":"replace","oldSpan":"exact bytes occurring once in the frozen artifact","newSpan":"exact corrected bytes from authored user feedback","authoredCorrection":"exact user span containing newSpan"}. Production repair only replaces that exact oldSpan with newSpan; it preserves every byte outside oldSpan and rejects missing or repeated oldSpan values. no-op has evidenceIds and reason.

Reinforce requires explicit artifact-linked authored user positive feedback. Objective tool outcomes remain diagnostic shadow metadata until trusted typed verifier receipts exist; they cannot authorize production reinforcement. Turn observations are non-authoritative correlation metadata. Opening, citing, injection, search, model behavior, and tool success are not quality evidence. Do not grade your own output. Rollback condemnedRefs identify bad historical hashes; restoredRefs identify restored good hashes. Negative or destructive rollback authority applies ONLY to condemnedRefs. Never repair, demote, or archive a restored ref merely because it appears in rollback evidence. Model decisions are non-gold and policy gates may reject every decision.

Frozen artifacts:\n${JSON.stringify(artifacts, null, 2)}\n\nEvidence:\n${JSON.stringify(evidence, null, 2)}`;
}

export function publishShadowAdaptation(options: {
  cfg: MemoryConfig;
  eventId: string;
  model: string;
  createdAt: string;
  catalog: Catalog;
  evidence: AdaptationEvidence[];
  decisions: AdaptationDecision[];
}): ShadowAdaptation {
  const identity = {
    version: PRODUCTION_ADAPTATION_VERSION,
    eventId: options.eventId,
    model: options.model,
    promptVersion: ADAPTATION_PROMPT_VERSION,
    createdAt: options.createdAt,
    catalog: options.catalog,
    evidence: options.evidence,
    decisions: options.decisions,
  };
  const shadow: ShadowAdaptation = {
    ...identity,
    id: `adapt_${sha256(JSON.stringify(identity))}`,
  };
  const dir = contained(
    options.cfg.data,
    join(options.cfg.data, "v2/adaptation/shadow"),
  );
  secureDir(dir);
  const path = contained(dir, join(dir, `${shadow.id}.json`));
  const value = `${JSON.stringify(shadow, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value)
      throw new Error("shadow adaptation collision");
    return shadow;
  }
  const temporary = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  atomicWrite(temporary, value);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== value)
      throw new Error("shadow adaptation collision");
  } finally {
    rmSync(temporary, { force: true });
  }
  return shadow;
}

export function findShadowAdaptation(
  cfg: MemoryConfig,
  eventId: string,
): ShadowAdaptation | undefined {
  const dir = contained(cfg.data, join(cfg.data, "v2/adaptation/shadow"));
  if (!existsSync(dir)) return undefined;
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!object(value) || value.eventId !== eventId) return [];
      const { id, ...identity } = value;
      if (
        typeof id !== "string" ||
        id !== `adapt_${sha256(JSON.stringify(identity))}`
      )
        throw new Error("invalid stored shadow adaptation");
      if (value.version === 1 && value.promptVersion === 1) return [];
      if (
        value.version !== PRODUCTION_ADAPTATION_VERSION ||
        value.promptVersion !== ADAPTATION_PROMPT_VERSION ||
        typeof value.model !== "string" ||
        typeof value.createdAt !== "string" ||
        !object(value.catalog) ||
        !Array.isArray(value.evidence) ||
        !Array.isArray(value.decisions)
      )
        throw new Error("invalid stored shadow adaptation");
      const evidence = (value.evidence as unknown[]).map((item) =>
        object(item) && item.kind === "turn-observation"
          ? parseTurnObservation(item)
          : parseRollbackEvidence(item),
      );
      const decisions = parseAdaptationDecisions(
        JSON.stringify({ version: 2, decisions: value.decisions }),
        value.catalog as Catalog,
        evidence,
      );
      return [
        { ...(value as unknown as ShadowAdaptation), evidence, decisions },
      ];
    });
  if (matches.length > 1)
    throw new Error("multiple production shadow adaptations for event");
  return matches[0];
}

export function markShadowAdaptationLedger(
  cfg: MemoryConfig,
  eventId: string,
  shadowId: string,
): void {
  const dir = contained(cfg.data, join(cfg.data, "v2/adaptation/ledger"));
  secureDir(dir);
  const path = contained(dir, join(dir, `${eventId}.json`));
  const value = `${JSON.stringify({ version: 2, eventId, shadowId }, null, 2)}
`;
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      shadowId?: string;
    };
    if (previous.shadowId === shadowId && previous.version === 2) return;
    const oldPath = previous.shadowId
      ? contained(
          cfg.data,
          join(cfg.data, "v2/adaptation/shadow", `${previous.shadowId}.json`),
        )
      : "";
    const nextPath = contained(
      cfg.data,
      join(cfg.data, "v2/adaptation/shadow", `${shadowId}.json`),
    );
    const oldShadow =
      oldPath && existsSync(oldPath)
        ? JSON.parse(readFileSync(oldPath, "utf8"))
        : undefined;
    const nextShadow = existsSync(nextPath)
      ? JSON.parse(readFileSync(nextPath, "utf8"))
      : undefined;
    if (
      previous.version === 1 &&
      oldShadow?.version === 1 &&
      nextShadow?.version === PRODUCTION_ADAPTATION_VERSION
    )
      atomicWrite(path, value);
    else throw new Error("adaptation ledger collision");
  } else atomicWrite(path, value);
}

export type AdaptationTerminal = {
  version: 2;
  shadowId: string;
  decisionIndex: number;
  action: AdaptationDecision["action"] | "legacy";
  outcome: "applied" | "stale" | "error";
  historyCommit?: string;
  proposalId?: string;
  error?: string;
};

type QualityProvenance = {
  source: "adaptation-policy";
  action: "reinforce" | "demote";
  shadowId: string;
  decisionIndex: number;
  target: MemoryRef;
  evidenceIds: string[];
};

const positiveFeedback =
  /\b(?:thank you|thanks|that worked|works now|solved|fixed it|exactly right|helpful)\b/i;
const correctionFeedback =
  /\b(?:wrong|incorrect|actually|correction|should|instead|does not|doesn.t|do not|don.t)\b/i;

function selectedEvidence(
  shadow: ShadowAdaptation,
  decision: AdaptationDecision,
): AdaptationEvidence[] {
  const ids = new Set(decision.evidenceIds);
  return shadow.evidence.filter((item) => ids.has(item.evidenceId));
}

function exactExposure(observation: TurnObservation, target: MemoryRef) {
  return observation.receipt.exposures.filter(
    (item) =>
      item.memoryId === target.memoryId &&
      item.artifactSha256 === target.artifactSha256,
  );
}

function authored(observation: TurnObservation): string[] {
  return (observation.authoredUserText ?? []).map((item) => item.text);
}

function linkedFeedback(
  shadow: ShadowAdaptation,
  selected: AdaptationEvidence[],
  target: MemoryRef,
  pattern: RegExp,
): TurnObservation[] {
  const turns = shadow.evidence.filter(
    (item): item is TurnObservation => item.kind === "turn-observation",
  );
  const selectedIds = new Set(selected.map((item) => item.evidenceId));
  return turns.filter((candidate) => {
    if (
      !selectedIds.has(candidate.evidenceId) ||
      !candidate.receipt.responseToReceiptId
    )
      return false;
    const prior = turns.find(
      (item) =>
        item.receipt.receiptId === candidate.receipt.responseToReceiptId,
    );
    return (
      !!prior &&
      selectedIds.has(prior.evidenceId) &&
      exactExposure(prior, target).length > 0 &&
      authored(candidate).some((text) => pattern.test(text))
    );
  });
}

function condemnedRollback(
  selected: AdaptationEvidence[],
  target: MemoryRef,
): boolean {
  return selected.some(
    (item) =>
      item.kind === "verified-rollback" &&
      item.condemnedRefs.some((ref) => refKey(ref) === refKey(target)),
  );
}

function restoredRollback(
  selected: AdaptationEvidence[],
  target: MemoryRef,
): boolean {
  return selected.some(
    (item) =>
      item.kind === "verified-rollback" &&
      item.restoredRefs.some((ref) => refKey(ref) === refKey(target)),
  );
}

function validateRepairMutation(
  cfg: MemoryConfig,
  decision: Extract<AdaptationDecision, { action: "repair" }>,
  corrections: TurnObservation[],
): void {
  const { oldSpan, newSpan, authoredCorrection } = decision.mutation;
  if (
    !corrections.some((item) =>
      authored(item).some(
        (text) =>
          text.includes(authoredCorrection) &&
          authoredCorrection.includes(newSpan),
      ),
    )
  )
    throw new Error("repair replacement lacks exact authored correction");
  const text = readFileSync(
    contained(cfg.root, join(cfg.root, decision.target.path)),
    "utf8",
  );
  if (sha256(text) !== decision.target.artifactSha256)
    throw new Error("stale adaptation target");
  const first = text.indexOf(oldSpan);
  if (first < 0 || first !== text.lastIndexOf(oldSpan))
    throw new Error("repair old span must occur exactly once");
}

export function adaptationGate(
  cfg: MemoryConfig,
  shadow: ShadowAdaptation,
  decision: AdaptationDecision,
): { allowed: boolean; historicalOnly?: boolean } {
  if (decision.action === "no-op") return { allowed: true };
  const selected = selectedEvidence(shadow, decision);
  const target = decision.target;
  if (decision.action === "reinforce") {
    const explicit =
      linkedFeedback(shadow, selected, target, positiveFeedback).length > 0;
    return { allowed: explicit };
  }
  if (
    restoredRollback(selected, target) &&
    !condemnedRollback(selected, target)
  )
    return { allowed: false };
  const corrections = linkedFeedback(
    shadow,
    selected,
    target,
    correctionFeedback,
  );
  if (decision.action === "demote")
    return {
      allowed: corrections.length > 0 || condemnedRollback(selected, target),
      historicalOnly: condemnedRollback(selected, target),
    };
  if (decision.action === "archive")
    return {
      allowed:
        condemnedRollback(selected, target) ||
        new Set(corrections.map((item) => item.receipt.sessionId)).size >= 2,
    };
  if (condemnedRollback(selected, target))
    return { allowed: false, historicalOnly: true };
  validateRepairMutation(cfg, decision, corrections);
  return { allowed: corrections.length > 0 };
}

function terminalPath(
  cfg: MemoryConfig,
  shadowId: string,
  decisionIndex: number,
): string {
  const root = contained(
    cfg.data,
    join(cfg.data, "v2/adaptation/production", shadowId),
  );
  secureDir(root);
  return contained(root, join(root, `${decisionIndex}.json`));
}

function writeTerminal(
  cfg: MemoryConfig,
  terminal: AdaptationTerminal,
): AdaptationTerminal {
  const path = terminalPath(cfg, terminal.shadowId, terminal.decisionIndex);
  const value = `${JSON.stringify(terminal, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value)
      throw new Error("adaptation terminal collision");
  } else atomicWrite(path, value);
  return terminal;
}

function qualityMutationId(shadowId: string, decisionIndex: number): string {
  return `adaptq_${sha256(`${shadowId}:${decisionIndex}`).slice(0, 24)}`;
}

function adaptationProposal(
  shadow: ShadowAdaptation,
  decision: Extract<AdaptationDecision, { action: "repair" | "archive" }>,
  decisionIndex: number,
): Proposal {
  const target = {
    memoryId: decision.target.memoryId,
    path: decision.target.path,
    sha256: decision.target.artifactSha256,
  };
  const operation =
    decision.action === "archive"
      ? { type: "archive" as const, target, reason: decision.reason }
      : {
          type: "replace" as const,
          target,
          oldSpan: decision.mutation.oldSpan,
          newSpan: decision.mutation.newSpan,
        };
  const identity = {
    version: 2 as const,
    digestVersion: 2 as const,
    lane: "memory" as const,
    status: "pending" as const,
    operation,
    supersedes: [],
    evidence: [],
    provenance: {
      runId: `adaptation_${shadow.id}_${decisionIndex}`,
      promptVersion: ADAPTATION_PROMPT_VERSION,
      model: "adaptation-policy",
      createdAt: shadow.createdAt,
      corpusAware: true,
      autonomous: true,
    },
  };
  return { ...identity, id: canonicalProposalId(identity) };
}

function existingProposal(cfg: MemoryConfig, proposal: Proposal): boolean {
  try {
    return findProposal(cfg, proposal.id).proposal.id === proposal.id;
  } catch {
    return false;
  }
}

function promoteDecision(
  cfg: MemoryConfig,
  shadow: ShadowAdaptation,
  decision: AdaptationDecision,
  decisionIndex: number,
): AdaptationTerminal {
  const base = {
    version: 2 as const,
    shadowId: shadow.id,
    decisionIndex,
    action: decision.action,
  };
  if (decision.action === "no-op")
    return writeTerminal(cfg, { ...base, outcome: "applied" });
  const proposal =
    decision.action === "repair" || decision.action === "archive"
      ? adaptationProposal(shadow, decision, decisionIndex)
      : undefined;
  if (proposal && existingProposal(cfg, proposal)) {
    applyMemoryProposal({
      cfg,
      id: proposal.id,
      actor: "background-reflection",
    });
    return writeTerminal(cfg, {
      ...base,
      outcome: "applied",
      proposalId: proposal.id,
    });
  }
  const gate = adaptationGate(cfg, shadow, decision);
  const current = scanCatalog(cfg.root).entries.some(
    (entry) =>
      entry.memoryId === decision.target.memoryId &&
      entry.path === decision.target.path &&
      entry.sha256 === decision.target.artifactSha256,
  );
  if (!current && !(decision.action === "demote" && gate.historicalOnly))
    return writeTerminal(cfg, { ...base, outcome: "stale" });
  if (!gate.allowed) throw new Error("adaptation policy gate denied decision");
  if (decision.action === "reinforce" || decision.action === "demote") {
    deriveAdaptationQuality(cfg);
    const mutationId = qualityMutationId(shadow.id, decisionIndex);
    const provenance: QualityProvenance = {
      source: "adaptation-policy",
      action: decision.action,
      shadowId: shadow.id,
      decisionIndex,
      target: decision.target,
      evidenceIds: decision.evidenceIds,
    };
    const existing = historyEntryByMutationId(cfg, mutationId);
    if (
      existing &&
      (existing.receipt.kind !== "adaptation-quality" ||
        JSON.stringify(existing.receipt.provenance) !==
          JSON.stringify(provenance) ||
        existing.receipt.changes.length !== 0)
    )
      throw new Error("adaptation quality mutation collision");
    const result =
      existing ??
      commitHistory(
        cfg,
        {
          version: 2,
          mutationId,
          kind: "adaptation-quality",
          reason: decision.reason,
          changes: [],
          provenance,
        },
        { allowEmpty: true },
      );
    writeCatalog(cfg);
    return writeTerminal(cfg, {
      ...base,
      outcome: "applied",
      historyCommit: result.commit,
    });
  }
  saveProposal(cfg, proposal!);
  applyMemoryProposal({
    cfg,
    id: proposal!.id,
    actor: "background-reflection",
  });
  return writeTerminal(cfg, {
    ...base,
    outcome: "applied",
    proposalId: proposal!.id,
  });
}

export function promoteShadowAdaptation(
  cfg: MemoryConfig,
  shadow: ShadowAdaptation | LegacyShadowAdaptation,
): AdaptationTerminal[] {
  if (shadow.version !== PRODUCTION_ADAPTATION_VERSION) {
    return [
      writeTerminal(cfg, {
        version: 2,
        shadowId: shadow.id,
        decisionIndex: 0,
        action: "legacy",
        outcome: "error",
        error: "legacy shadow adaptation requires regeneration",
      }),
    ];
  }
  const terminals: AdaptationTerminal[] = [];
  for (const [decisionIndex, decision] of shadow.decisions.entries()) {
    const path = terminalPath(cfg, shadow.id, decisionIndex);
    if (existsSync(path)) {
      terminals.push(
        JSON.parse(readFileSync(path, "utf8")) as AdaptationTerminal,
      );
      continue;
    }
    try {
      terminals.push(promoteDecision(cfg, shadow, decision, decisionIndex));
    } catch (error) {
      terminals.push(
        writeTerminal(cfg, {
          version: 2,
          shadowId: shadow.id,
          decisionIndex,
          action: decision.action,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return terminals;
}
