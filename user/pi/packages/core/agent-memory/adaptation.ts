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
  sha256,
  type Catalog,
  type MemoryConfig,
} from "./catalog.js";
import {
  historyContainsAncestor,
  historyReceiptAt,
  isHistoryInitialized,
  listHistoryByKind,
  verifyHistory,
} from "./history.js";
import { verifyPersistedRollbackLinkage } from "./workflow.js";
import {
  parseTurnReceipt,
  validateTurnReceiptBinding,
  type MemoryRef,
  type TurnReceipt,
} from "./receipt.js";

export type TurnObservation = {
  kind: "turn-observation";
  evidenceId: string;
  entryId: string;
  receipt: TurnReceipt;
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
  targets: MemoryRef[];
};
export type AdaptationEvidence = TurnObservation | RollbackEvidence;
type TargetedAction = "reinforce" | "repair" | "demote" | "archive";
export type AdaptationDecision =
  | {
      action: TargetedAction;
      target: MemoryRef;
      evidenceIds: string[];
      reason: string;
    }
  | { action: "no-op"; evidenceIds: string[]; reason: string };
export type ShadowAdaptation = {
  version: 1;
  id: string;
  eventId: string;
  model: string;
  promptVersion: 1;
  createdAt: string;
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
    !exactKeys(value, ["kind", "evidenceId", "entryId", "receipt"]) ||
    value.kind !== "turn-observation" ||
    typeof value.evidenceId !== "string" ||
    typeof value.entryId !== "string" ||
    !value.entryId
  )
    throw new Error("invalid turn observation");
  const receipt = parseTurnReceipt(value.receipt);
  if (value.evidenceId !== `turn:${value.entryId}:${receipt.receiptId}`)
    throw new Error("turn observation id does not match content");
  return {
    kind: "turn-observation",
    evidenceId: value.evidenceId,
    entryId: value.entryId,
    receipt,
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
  if (
    !object(value) ||
    !exactKeys(value, [
      "kind",
      "affectedRefs",
      "evidenceId",
      "historyCommit",
      "mutationId",
      "reviewId",
      "proposalId",
      "reason",
      "targets",
    ]) ||
    value.kind !== "verified-rollback" ||
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
  return { ...value, affectedRefs, targets } as RollbackEvidence;
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
  const affectedRefs = receipt.changes.flatMap((change) =>
    change.memoryId
      ? [
          ...new Set(
            [change.beforeSha256, change.afterSha256].filter(
              (hash): hash is string => !!hash,
            ),
          ),
        ].map((artifactSha256) => ({
          memoryId: change.memoryId!,
          path: change.path,
          artifactSha256,
        }))
      : [],
  );
  const targets = affectedRefs.flatMap((ref) => {
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
          ? [{ ...evidence, affectedRefs, targets }]
          : [];
      } catch {
        return [];
      }
    });
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
      return item.affectedRefs.some((ref) => refKey(ref) === exact);
    if (action !== "reinforce") return false;
    return item.receipt.exposures.some(
      (exposure) =>
        exposure.memoryId === target.memoryId &&
        exposure.artifactSha256 === target.artifactSha256,
    );
  });
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
    value.version !== 1 ||
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
    if (
      !exactKeys(
        candidate,
        targeted
          ? ["action", "target", "evidenceIds", "reason"]
          : ["action", "evidenceIds", "reason"],
      ) ||
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
    if (targeted) {
      const target = parseRef(candidate.target, catalog);
      const evidenceIds = candidate.evidenceIds as string[];
      const selected = evidence.filter((item) =>
        evidenceIds.includes(item.evidenceId),
      );
      if (
        !evidenceAuthorizes(
          candidate.action as TargetedAction,
          target,
          selected,
        )
      )
        throw new Error("adaptation evidence does not authorize exact target");
      return {
        action: candidate.action,
        target,
        evidenceIds: candidate.evidenceIds,
        reason: candidate.reason,
      } as AdaptationDecision;
    }
    return {
      action: "no-op",
      evidenceIds: candidate.evidenceIds,
      reason: candidate.reason,
    } as AdaptationDecision;
  });
}

export function buildAdaptationPrompt(
  catalog: Catalog,
  evidence: AdaptationEvidence[],
): string {
  const refs = catalog.entries.map((entry) => ({
    memoryId: entry.memoryId,
    path: entry.path,
    artifactSha256: entry.sha256,
  }));
  return `You are making shadow-only memory adaptation decisions. Return exactly one JSON object and no markdown.

Return {"version":1,"decisions":[...]}. Each decision is exactly reinforce|repair|demote|archive with target {memoryId,path,artifactSha256}, nonempty unique evidenceIds, and a reason; or no-op with nonempty unique evidenceIds and a reason. Use only the exact current refs and evidence IDs supplied.

Turn observations are non-authoritative correlation metadata. Tool success and exposure do not prove a memory was useful, correct, or causal. Repair, demote, and archive require selected verified rollback evidence containing the exact target ref and hash. Reinforce remains shadow-only and requires a selected turn exposure or verified rollback containing the exact target ref and hash. Explicit authored user corrections and cryptographically verified local rollback history are stronger evidence. Do not grade your own earlier response and do not infer quality from model behavior alone. These decisions are shadow analysis: never propose or perform corpus or ranking mutations.

Current refs:
${JSON.stringify(refs, null, 2)}

Evidence:
${JSON.stringify(evidence, null, 2)}`;
}

export function publishShadowAdaptation(options: {
  cfg: MemoryConfig;
  eventId: string;
  model: string;
  createdAt: string;
  evidence: AdaptationEvidence[];
  decisions: AdaptationDecision[];
}): ShadowAdaptation {
  const identity = {
    version: 1 as const,
    eventId: options.eventId,
    model: options.model,
    promptVersion: 1 as const,
    createdAt: options.createdAt,
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
  const value = `${JSON.stringify(shadow, null, 2)}
`;
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
        value.version !== 1 ||
        typeof id !== "string" ||
        id !== `adapt_${sha256(JSON.stringify(identity))}` ||
        typeof value.model !== "string" ||
        value.promptVersion !== 1 ||
        typeof value.createdAt !== "string" ||
        !Array.isArray(value.evidence) ||
        !Array.isArray(value.decisions)
      )
        throw new Error("invalid stored shadow adaptation");
      return [value as ShadowAdaptation];
    });
  if (matches.length > 1)
    throw new Error("multiple shadow adaptations for event");
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
  const value = `${JSON.stringify({ version: 1, eventId, shadowId }, null, 2)}
`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== value)
      throw new Error("adaptation ledger collision");
  } else atomicWrite(path, value);
}
