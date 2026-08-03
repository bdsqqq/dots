import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  atomicWrite,
  contained,
  scanCatalog,
  sha256,
  type Catalog,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import {
  commitHistory,
  headHistoryReceipt,
  historyEntryByMutationId,
  isHistoryInitialized,
  listHistoryByKind,
  verifyHistory,
} from "./history.js";
import { observeMemoryOperation } from "./observability.js";

export const MEMORY_TIERS = ["system", "external"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];
export const TIER_ROLLOUTS = ["shadow", "canary", "active"] as const;
export type TierRollout = (typeof TIER_ROLLOUTS)[number];
export const TIER_HIERARCHY_ROOTS = [
  "personal",
  "workspace",
  "tools",
  "workflow",
  "constraints",
  "uncategorized",
] as const;
export type TierHierarchyRoot = (typeof TIER_HIERARCHY_ROOTS)[number];
export type TierHierarchy = `${TierHierarchyRoot}${string}`;

export const SYSTEM_PROMPT_MAX_MEMORIES = 8;
export const SYSTEM_PROMPT_MAX_BODY_CHARS = 1_500;
export const SYSTEM_PROMPT_MAX_TOTAL_CHARS = 6_000;
export const TIER_INCUMBENT_BONUS = 0.05;
export const TIER_REPLACEMENT_IMPROVEMENT = 0.1;
export const TIER_REPLACEMENT_COOLDOWN_MS: number = 7 * 24 * 60 * 60 * 1_000;

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIER_DECISION_KIND = "tier-decision";

export function compareTierCodePoints(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftPoint = left.codePointAt(leftOffset)!;
    const rightPoint = right.codePointAt(rightOffset)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftOffset += leftPoint > 0xffff ? 2 : 1;
    rightOffset += rightPoint > 0xffff ? 2 : 1;
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort(compareTierCodePoints).join(",") ===
  [...keys].sort(compareTierCodePoints).join(",");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareTierCodePoints)
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function exactIso(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`invalid ${name}`);
  return value;
}

export function normalizeTierHierarchy(value: string): TierHierarchy {
  if (typeof value !== "string" || value !== value.normalize("NFC"))
    throw new Error("invalid tier hierarchy");
  const segments = value.split("/");
  if (
    segments.length < 1 ||
    segments.length > 4 ||
    !TIER_HIERARCHY_ROOTS.includes(segments[0] as TierHierarchyRoot) ||
    segments.some((segment) => !SEGMENT.test(segment))
  )
    throw new Error("invalid tier hierarchy");
  return segments.join("/") as TierHierarchy;
}

export type TierTarget = {
  memoryId: string;
  path: string;
  artifactSha256: string;
};

export type TierPlacement = {
  tier: MemoryTier;
  hierarchy: TierHierarchy;
  rollout: TierRollout;
  quarantined: boolean;
  redaction: "clear" | "required";
  promptIntegrity: "trusted" | "rejected";
};

export type TierAssignment = TierTarget & TierPlacement;

export type TierDecisionChange = {
  target: TierTarget;
  from: TierPlacement;
  to: TierPlacement;
};

export type TierReplacement = {
  kind: "safety" | "non-safety";
  promoted: TierTarget;
  demoted: TierTarget;
};

export type TierDecision = {
  version: 1;
  source: "tier-governor";
  decisionId: string;
  decidedAt: string;
  actor: "tier-governor";
  reason: string;
  expectedHistoryHead: string;
  expectedStateSha256: string;
  replacements: TierReplacement[];
  changes: TierDecisionChange[];
};

function parseTarget(value: unknown): TierTarget {
  if (
    !object(value) ||
    !keysAre(value, ["artifactSha256", "memoryId", "path"]) ||
    typeof value.memoryId !== "string" ||
    !ID.test(value.memoryId) ||
    typeof value.path !== "string" ||
    isAbsolute(value.path) ||
    value.path.startsWith("/") ||
    !value.path.endsWith(".md") ||
    value.path.split("/").includes("..") ||
    /[\\\0\r\n]/.test(value.path) ||
    !HASH.test(String(value.artifactSha256))
  )
    throw new Error("invalid tier target");
  return value as TierTarget;
}

function parsePlacement(value: unknown): TierPlacement {
  if (
    !object(value) ||
    !keysAre(value, [
      "hierarchy",
      "promptIntegrity",
      "quarantined",
      "redaction",
      "rollout",
      "tier",
    ]) ||
    !MEMORY_TIERS.includes(value.tier as MemoryTier) ||
    !TIER_ROLLOUTS.includes(value.rollout as TierRollout) ||
    typeof value.quarantined !== "boolean" ||
    (value.redaction !== "clear" && value.redaction !== "required") ||
    (value.promptIntegrity !== "trusted" &&
      value.promptIntegrity !== "rejected") ||
    (value.tier === "system" &&
      (value.quarantined === true ||
        value.redaction !== "clear" ||
        value.promptIntegrity !== "trusted")) ||
    (value.tier === "external" && value.rollout !== "shadow")
  )
    throw new Error("invalid tier placement");
  return {
    tier: value.tier as MemoryTier,
    hierarchy: normalizeTierHierarchy(String(value.hierarchy)),
    rollout: value.rollout as TierRollout,
    quarantined: value.quarantined,
    redaction: value.redaction as "clear" | "required",
    promptIntegrity: value.promptIntegrity as "trusted" | "rejected",
  };
}

export function canonicalTierDecisionId(
  value: Omit<TierDecision, "decisionId">,
): string {
  return `tierdec_${sha256(canonical(value)).slice(0, 32)}`;
}

export function parseTierDecision(value: unknown): TierDecision {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !object(parsed) ||
    !keysAre(parsed, [
      "actor",
      "changes",
      "decidedAt",
      "decisionId",
      "expectedHistoryHead",
      "expectedStateSha256",
      "reason",
      "replacements",
      "source",
      "version",
    ]) ||
    parsed.version !== 1 ||
    parsed.source !== "tier-governor" ||
    parsed.actor !== "tier-governor" ||
    typeof parsed.reason !== "string" ||
    !parsed.reason.trim() ||
    parsed.reason.length > 500 ||
    !/^[a-f0-9]{40,64}$/.test(String(parsed.expectedHistoryHead)) ||
    !HASH.test(String(parsed.expectedStateSha256)) ||
    !Array.isArray(parsed.replacements) ||
    parsed.replacements.length > 16 ||
    !Array.isArray(parsed.changes) ||
    parsed.changes.length < 1 ||
    parsed.changes.length > 16
  )
    throw new Error("invalid tier decision");
  const changes = parsed.changes.map((change): TierDecisionChange => {
    if (!object(change) || !keysAre(change, ["from", "target", "to"]))
      throw new Error("invalid tier decision change");
    return {
      target: parseTarget(change.target),
      from: parsePlacement(change.from),
      to: parsePlacement(change.to),
    };
  });
  const targetKeys = changes.map(({ target }) => tierTargetKey(target));
  if (new Set(targetKeys).size !== targetKeys.length)
    throw new Error("duplicate tier decision target");
  if (
    targetKeys.join("\0") !==
    [...targetKeys].sort(compareTierCodePoints).join("\0")
  )
    throw new Error("tier decision targets are not normalized");
  const replacements = parsed.replacements.map(
    (replacement): TierReplacement => {
      if (
        !object(replacement) ||
        !keysAre(replacement, ["demoted", "kind", "promoted"]) ||
        (replacement.kind !== "safety" && replacement.kind !== "non-safety")
      )
        throw new Error("invalid tier replacement");
      return {
        kind: replacement.kind,
        promoted: parseTarget(replacement.promoted),
        demoted: parseTarget(replacement.demoted),
      };
    },
  );
  const replacementKeys = replacements.map(
    (replacement) =>
      `${tierTargetKey(replacement.demoted)}\0${tierTargetKey(replacement.promoted)}`,
  );
  if (
    new Set(replacementKeys).size !== replacementKeys.length ||
    replacementKeys.join("\0") !==
      [...replacementKeys].sort(compareTierCodePoints).join("\0") ||
    replacements.filter((replacement) => replacement.kind === "non-safety")
      .length > 1
  )
    throw new Error("invalid tier replacements");
  const decision: TierDecision = {
    version: 1,
    source: "tier-governor",
    decisionId: String(parsed.decisionId),
    decidedAt: exactIso(parsed.decidedAt, "tier decision time"),
    actor: "tier-governor",
    reason: parsed.reason.trim(),
    expectedHistoryHead: String(parsed.expectedHistoryHead),
    expectedStateSha256: String(parsed.expectedStateSha256),
    replacements,
    changes,
  };
  const { decisionId: _, ...basis } = decision;
  if (decision.decisionId !== canonicalTierDecisionId(basis))
    throw new Error("tier decision id does not match content");
  return decision;
}

export function tierTargetKey(target: TierTarget): string {
  return `${target.memoryId}\0${target.path}\0${target.artifactSha256}`;
}

function defaultAssignment(entry: CatalogEntry): TierAssignment {
  return {
    memoryId: entry.memoryId,
    path: entry.path,
    artifactSha256: entry.sha256,
    tier: "external",
    hierarchy: "uncategorized",
    rollout: "shadow",
    quarantined: false,
    redaction: "required",
    promptIntegrity: "rejected",
  };
}

function samePlacement(left: TierPlacement, right: TierPlacement): boolean {
  return (
    left.tier === right.tier &&
    left.hierarchy === right.hierarchy &&
    left.rollout === right.rollout &&
    left.quarantined === right.quarantined &&
    left.redaction === right.redaction &&
    left.promptIntegrity === right.promptIntegrity
  );
}

/**
 * Tier state is a projection of verified append-only memory history. A changed
 * artifact has a new key and therefore falls back to external/uncategorized;
 * no migration write can accidentally preserve system authority across bytes.
 */
export function deriveTierState(
  cfg: MemoryConfig,
  catalog: Catalog = scanCatalog(cfg.root),
): Map<string, TierAssignment> {
  const current = new Map(
    catalog.entries.map((entry) => [
      tierTargetKey(defaultAssignment(entry)),
      defaultAssignment(entry),
    ]),
  );
  if (!isHistoryInitialized(cfg)) return current;
  const verification = verifyHistory(cfg);
  if (!verification.ok)
    throw new Error(
      `tier history verification failed: ${verification.issues.join(", ")}`,
    );
  const replay = new Map<string, TierAssignment>();
  for (const entry of listHistoryByKind(cfg, TIER_DECISION_KIND).reverse()) {
    if (entry.receipt.changes.length !== 0)
      throw new Error("tier decision commit changed an artifact");
    const decision = parseTierDecision(entry.receipt.provenance);
    for (const change of decision.changes) {
      const key = tierTargetKey(change.target);
      const before = replay.get(key) ?? {
        ...change.target,
        tier: "external" as const,
        hierarchy: "uncategorized" as const,
        rollout: "shadow" as const,
        quarantined: false,
        redaction: "required" as const,
        promptIntegrity: "rejected" as const,
      };
      if (!samePlacement(before, change.from))
        throw new Error("tier decision history has a broken state transition");
      replay.set(key, { ...change.target, ...change.to });
    }
  }
  for (const [key, assignment] of replay)
    if (current.has(key)) current.set(key, assignment);
  return current;
}

export const TIER_ELIGIBILITY_REASON_CODES = [
  "artifact-missing",
  "stale-artifact-hash",
  "artifact-body-mismatch",
  "malformed-hierarchy",
  "invalid-score",
  "body-too-large",
  "secret-redaction-required",
  "prompt-integrity-rejected",
  "quarantined",
  "prompt-budget-count",
  "prompt-budget-total",
  "replacement-threshold",
  "replacement-cooldown",
] as const;
export type TierEligibilityReasonCode =
  (typeof TIER_ELIGIBILITY_REASON_CODES)[number];

export type TierCandidate = {
  target: TierTarget;
  hierarchy: string;
  body: string;
  score: number;
  rollout?: TierRollout;
  quarantined?: boolean;
  redaction: "clear" | "required";
  promptIntegrity: "trusted" | "rejected";
  safetyCritical?: boolean;
};

export type TierCandidateValidation = {
  eligible: boolean;
  reasons: TierEligibilityReasonCode[];
  candidate?: TierCandidate & { hierarchy: TierHierarchy };
};

const SECRET =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]{8,}|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{16,})/i;
const PROMPT_ATTACK =
  /(?:ignore (?:all |any )?(?:previous|prior|system) instructions|(?:reveal|print|repeat) (?:the )?system prompt|<\/?(?:system|assistant|tool)(?:>|\s)|\bSYSTEM\s*:|\b(?:bypass|disable) (?:safety|policy|approval)|\bexfiltrat|\bconceal (?:the )?action|(?:send|upload|publish|delete|deploy|purchase|email|message)\b.{0,40}\bwithout (?:asking|approval))/i;
const COMPACT_PROMPT_ATTACK =
  /(?:ignore(?:all|any)?(?:previous|prior|system)instructions|(?:reveal|print|repeat)(?:the)?systemprompt|system:|(?:bypass|disable)(?:safety|policy|approval)|exfiltrat|conceal(?:the)?action|(?:send|upload|publish|delete|deploy|purchase|email|message).{0,40}without(?:asking|approval))/i;

function promptIntegrityAttack(body: string): boolean {
  const compact = body.normalize("NFKC").replace(/[\s\p{Cf}\p{Z}]+/gu, "");
  return PROMPT_ATTACK.test(body) || COMPACT_PROMPT_ATTACK.test(compact);
}

export function validateTierCandidate(
  candidate: TierCandidate,
  catalog?: Catalog,
): TierCandidateValidation {
  const reasons: TierEligibilityReasonCode[] = [];
  let hierarchy: TierHierarchy | undefined;
  try {
    hierarchy = normalizeTierHierarchy(candidate.hierarchy);
  } catch {
    reasons.push("malformed-hierarchy");
  }
  if (
    !Number.isFinite(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 1
  )
    reasons.push("invalid-score");
  if (candidate.body.length > SYSTEM_PROMPT_MAX_BODY_CHARS)
    reasons.push("body-too-large");
  if (candidate.redaction !== "clear" || SECRET.test(candidate.body))
    reasons.push("secret-redaction-required");
  if (
    candidate.promptIntegrity !== "trusted" ||
    promptIntegrityAttack(candidate.body)
  )
    reasons.push("prompt-integrity-rejected");
  if (candidate.quarantined) reasons.push("quarantined");
  if (catalog) {
    const sameIdentity = catalog.entries.find(
      (entry) =>
        entry.memoryId === candidate.target.memoryId &&
        entry.path === candidate.target.path,
    );
    if (!sameIdentity) reasons.push("artifact-missing");
    else if (sameIdentity.sha256 !== candidate.target.artifactSha256)
      reasons.push("stale-artifact-hash");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    ...(reasons.length === 0 && hierarchy
      ? { candidate: { ...candidate, hierarchy } }
      : {}),
  };
}

export function tierAffinity(
  candidate: Pick<TierCandidate, "hierarchy" | "score">,
  context: { hierarchy?: string; incumbent?: boolean } = {},
): number {
  const hierarchy = normalizeTierHierarchy(candidate.hierarchy);
  let contextual = 0;
  if (context.hierarchy) {
    const desired = normalizeTierHierarchy(context.hierarchy);
    const left = hierarchy.split("/");
    const right = desired.split("/");
    let common = 0;
    while (left[common] && left[common] === right[common]) common += 1;
    contextual = common * 0.01;
  }
  return (
    candidate.score +
    contextual +
    (context.incumbent ? TIER_INCUMBENT_BONUS : 0)
  );
}

type SelectedTierCandidate = TierCandidate & {
  hierarchy: TierHierarchy;
  incumbent: boolean;
};

export type SystemSelection = {
  expectedHistoryHead: string;
  expectedStateSha256: string;
  selected: SelectedTierCandidate[];
  rejected: Array<{ target: TierTarget; reasons: TierEligibilityReasonCode[] }>;
  replacements: Array<{
    promoted: TierTarget;
    demoted: TierTarget;
    safety: boolean;
  }>;
  totalChars: number;
};

function artifactBody(
  cfg: MemoryConfig,
  catalog: Catalog,
  target: TierTarget,
): string {
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.memoryId === target.memoryId &&
      candidate.path === target.path &&
      candidate.sha256 === target.artifactSha256,
  );
  if (!entry) throw new Error("tier target does not match current catalog");
  const path = contained(cfg.root, join(cfg.root, entry.path));
  const bytes = readFileSync(path);
  if (sha256(bytes) !== entry.sha256)
    throw new Error("catalog artifact changed during tier operation");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error("memory artifact is not valid utf8");
  const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  if (!frontmatter) throw new Error("memory artifact has no frontmatter");
  return text.slice(frontmatter[0].length);
}

export function tierStateDigest(state: Map<string, TierAssignment>): string {
  return sha256(
    canonical(
      [...state.entries()].sort(([left], [right]) =>
        compareTierCodePoints(left, right),
      ),
    ),
  );
}

function verifiedBasis(
  cfg: MemoryConfig,
  catalog: Catalog,
): {
  state: Map<string, TierAssignment>;
  historyHead: string;
  stateSha256: string;
} {
  const state = deriveTierState(cfg, catalog);
  const historyHead = headHistoryReceipt(cfg)?.commit;
  if (!historyHead) throw new Error("tier history is not initialized");
  return { state, historyHead, stateSha256: tierStateDigest(state) };
}

function lastNonSafetyReplacementAt(cfg: MemoryConfig): string | undefined {
  return listHistoryByKind(cfg, TIER_DECISION_KIND)
    .map((entry) => parseTierDecision(entry.receipt.provenance))
    .filter((decision) =>
      decision.replacements.some(
        (replacement) => replacement.kind === "non-safety",
      ),
    )
    .map((decision) => decision.decidedAt)
    .sort(compareTierCodePoints)
    .at(-1);
}

function candidateOrder(
  left: SelectedTierCandidate,
  right: SelectedTierCandidate,
): number {
  return (
    tierAffinity(right, { incumbent: right.incumbent }) -
      tierAffinity(left, { incumbent: left.incumbent }) ||
    compareTierCodePoints(
      tierTargetKey(left.target),
      tierTargetKey(right.target),
    )
  );
}

export function selectSystemSet(options: {
  cfg: MemoryConfig;
  candidates: TierCandidate[];
  now: string;
}): SystemSelection {
  const catalog = scanCatalog(options.cfg.root);
  const basis = verifiedBasis(options.cfg, catalog);
  const candidateKeys = options.candidates.map(({ target }) =>
    tierTargetKey(target),
  );
  if (new Set(candidateKeys).size !== candidateKeys.length)
    throw new Error("duplicate tier candidate");
  const rejected: SystemSelection["rejected"] = [];
  const eligible = options.candidates.flatMap((candidate) => {
    const validation = validateTierCandidate(candidate, catalog);
    const reasons = [...validation.reasons];
    if (validation.eligible) {
      try {
        if (
          artifactBody(options.cfg, catalog, candidate.target) !==
          candidate.body
        )
          reasons.push("artifact-body-mismatch");
      } catch {
        reasons.push("artifact-body-mismatch");
      }
    }
    if (reasons.length || !validation.candidate) {
      rejected.push({ target: candidate.target, reasons });
      return [];
    }
    return [
      {
        ...validation.candidate,
        incumbent:
          basis.state.get(tierTargetKey(candidate.target))?.tier === "system",
      },
    ];
  });
  const incumbents = eligible
    .filter((candidate) => candidate.incumbent)
    .sort(candidateOrder);
  const challengers = eligible
    .filter((candidate) => !candidate.incumbent)
    .sort(candidateOrder);
  const selected = incumbents.slice(0, SYSTEM_PROMPT_MAX_MEMORIES);
  let totalChars = selected.reduce(
    (sum, candidate) => sum + candidate.body.length,
    0,
  );
  if (totalChars > SYSTEM_PROMPT_MAX_TOTAL_CHARS)
    throw new Error("incumbent system set exceeds prompt budget");
  const replacements: SystemSelection["replacements"] = [];
  const now = Date.parse(exactIso(options.now, "tier selection time"));
  const previousReplacement = lastNonSafetyReplacementAt(options.cfg);
  const last = previousReplacement
    ? Date.parse(previousReplacement)
    : Number.NEGATIVE_INFINITY;
  let nonSafetyReplacementUsed = now - last < TIER_REPLACEMENT_COOLDOWN_MS;

  for (const challenger of challengers) {
    if (selected.length < SYSTEM_PROMPT_MAX_MEMORIES) {
      if (
        totalChars + challenger.body.length <=
        SYSTEM_PROMPT_MAX_TOTAL_CHARS
      ) {
        selected.push(challenger);
        totalChars += challenger.body.length;
      } else
        rejected.push({
          target: challenger.target,
          reasons: ["prompt-budget-total"],
        });
      continue;
    }
    const weakest = selected.slice().sort(candidateOrder).at(-1)!;
    if (!weakest.incumbent) {
      rejected.push({
        target: challenger.target,
        reasons: ["prompt-budget-count"],
      });
      continue;
    }
    const safety = !!challenger.safetyCritical;
    if (
      !safety &&
      challenger.score < weakest.score + TIER_REPLACEMENT_IMPROVEMENT
    ) {
      rejected.push({
        target: challenger.target,
        reasons: ["replacement-threshold"],
      });
      continue;
    }
    if (!safety && nonSafetyReplacementUsed) {
      rejected.push({
        target: challenger.target,
        reasons: ["replacement-cooldown"],
      });
      continue;
    }
    const nextChars = totalChars - weakest.body.length + challenger.body.length;
    if (nextChars > SYSTEM_PROMPT_MAX_TOTAL_CHARS) {
      rejected.push({
        target: challenger.target,
        reasons: ["prompt-budget-total"],
      });
      continue;
    }
    selected.splice(selected.indexOf(weakest), 1, challenger);
    totalChars = nextChars;
    replacements.push({
      promoted: challenger.target,
      demoted: weakest.target,
      safety,
    });
    if (!safety) nonSafetyReplacementUsed = true;
  }
  const selectedKeys = new Set(
    selected.map(({ target }) => tierTargetKey(target)),
  );
  for (const candidate of eligible)
    if (
      !selectedKeys.has(tierTargetKey(candidate.target)) &&
      !rejected.some(
        ({ target }) =>
          tierTargetKey(target) === tierTargetKey(candidate.target),
      )
    )
      rejected.push({
        target: candidate.target,
        reasons: ["prompt-budget-count"],
      });
  return {
    expectedHistoryHead: basis.historyHead,
    expectedStateSha256: basis.stateSha256,
    selected: selected.sort(candidateOrder),
    rejected,
    replacements,
    totalChars,
  };
}

export type TierTransitionPlan = {
  version: 1;
  decision: TierDecision;
};

export function planTierTransition(options: {
  cfg: MemoryConfig;
  selection: SystemSelection;
  decidedAt: string;
  reason: string;
  rollout?: TierRollout;
}): TierTransitionPlan {
  const catalog = scanCatalog(options.cfg.root);
  const basis = verifiedBasis(options.cfg, catalog);
  if (
    options.selection.expectedHistoryHead !== basis.historyHead ||
    options.selection.expectedStateSha256 !== basis.stateSha256
  )
    throw new Error("tier selection basis is stale");
  if (
    options.selection.selected.length > SYSTEM_PROMPT_MAX_MEMORIES ||
    options.selection.selected.reduce(
      (sum, candidate) => sum + candidate.body.length,
      0,
    ) > SYSTEM_PROMPT_MAX_TOTAL_CHARS
  )
    throw new Error("tier selection exceeds prompt budget");
  for (const candidate of options.selection.selected) {
    const validation = validateTierCandidate(candidate, catalog);
    if (
      !validation.eligible ||
      artifactBody(options.cfg, catalog, candidate.target) !== candidate.body
    )
      throw new Error(
        `ineligible selected tier candidate: ${validation.reasons.join(", ")}`,
      );
  }
  const selected = new Map(
    options.selection.selected.map((candidate) => [
      tierTargetKey(candidate.target),
      candidate,
    ]),
  );
  if (selected.size !== options.selection.selected.length)
    throw new Error("duplicate selected tier candidate");
  const stateKeys = new Set(basis.state.keys());
  if ([...selected.keys()].some((key) => !stateKeys.has(key)))
    throw new Error("selected tier candidate is outside current state");
  const changes: TierDecisionChange[] = [];
  for (const [key, assignment] of basis.state) {
    const candidate = selected.get(key);
    const to: TierPlacement = candidate
      ? {
          tier: "system",
          hierarchy: candidate.hierarchy,
          rollout: candidate.rollout ?? options.rollout ?? "active",
          quarantined: false,
          redaction: candidate.redaction,
          promptIntegrity: candidate.promptIntegrity,
        }
      : assignment.tier === "system"
        ? {
            tier: "external",
            hierarchy: assignment.hierarchy,
            rollout: "shadow",
            quarantined: assignment.quarantined,
            redaction: assignment.redaction,
            promptIntegrity: assignment.promptIntegrity,
          }
        : assignment;
    if (!samePlacement(assignment, to))
      changes.push({
        target: {
          memoryId: assignment.memoryId,
          path: assignment.path,
          artifactSha256: assignment.artifactSha256,
        },
        from: {
          tier: assignment.tier,
          hierarchy: assignment.hierarchy,
          rollout: assignment.rollout,
          quarantined: assignment.quarantined,
          redaction: assignment.redaction,
          promptIntegrity: assignment.promptIntegrity,
        },
        to,
      });
  }
  if (changes.length === 0) throw new Error("tier transition has no changes");
  changes.sort((left, right) =>
    compareTierCodePoints(
      tierTargetKey(left.target),
      tierTargetKey(right.target),
    ),
  );
  const replacements: TierReplacement[] = options.selection.replacements
    .map((replacement) => ({
      kind: replacement.safety ? ("safety" as const) : ("non-safety" as const),
      promoted: replacement.promoted,
      demoted: replacement.demoted,
    }))
    .sort((left, right) =>
      compareTierCodePoints(
        `${tierTargetKey(left.demoted)}\0${tierTargetKey(left.promoted)}`,
        `${tierTargetKey(right.demoted)}\0${tierTargetKey(right.promoted)}`,
      ),
    );
  const decisionBasis: Omit<TierDecision, "decisionId"> = {
    version: 1,
    source: "tier-governor",
    decidedAt: exactIso(options.decidedAt, "tier decision time"),
    actor: "tier-governor",
    reason: options.reason.trim(),
    expectedHistoryHead: basis.historyHead,
    expectedStateSha256: basis.stateSha256,
    replacements,
    changes,
  };
  if (!decisionBasis.reason || decisionBasis.reason.length > 500)
    throw new Error("invalid tier transition reason");
  return {
    version: 1,
    decision: {
      ...decisionBasis,
      decisionId: canonicalTierDecisionId(decisionBasis),
    },
  };
}

function assertReplacementBindings(decision: TierDecision): void {
  const demotions = decision.changes.filter(
    (change) => change.from.tier === "system" && change.to.tier === "external",
  );
  const promotions = decision.changes.filter(
    (change) => change.from.tier === "external" && change.to.tier === "system",
  );
  const replacementPromotions = new Set(
    decision.replacements.map((replacement) =>
      tierTargetKey(replacement.promoted),
    ),
  );
  const replacementDemotions = new Set(
    decision.replacements.map((replacement) =>
      tierTargetKey(replacement.demoted),
    ),
  );
  if (
    replacementPromotions.size !== decision.replacements.length ||
    replacementDemotions.size !== decision.replacements.length ||
    (demotions.length > 0 &&
      (promotions.length !== decision.replacements.length ||
        promotions.some(
          (change) => !replacementPromotions.has(tierTargetKey(change.target)),
        ))) ||
    (demotions.length === 0 && decision.replacements.length > 0)
  )
    throw new Error("tier replacement metadata is incomplete");
  for (const replacement of decision.replacements) {
    const demotion = decision.changes.find(
      (change) =>
        tierTargetKey(change.target) === tierTargetKey(replacement.demoted) &&
        change.from.tier === "system" &&
        change.to.tier === "external",
    );
    const promotion = decision.changes.find(
      (change) =>
        tierTargetKey(change.target) === tierTargetKey(replacement.promoted) &&
        change.from.tier === "external" &&
        change.to.tier === "system",
    );
    if (!demotion || !promotion)
      throw new Error("tier replacement does not match transition changes");
  }
}

function assertSystemPolicy(
  cfg: MemoryConfig,
  catalog: Catalog,
  state: Map<string, TierAssignment>,
): void {
  const system = [...state.values()].filter(
    (assignment) => assignment.tier === "system",
  );
  if (system.length > SYSTEM_PROMPT_MAX_MEMORIES)
    throw new Error("post-transition system set exceeds count budget");
  let totalChars = 0;
  for (const assignment of system) {
    const body = artifactBody(cfg, catalog, assignment);
    const validation = validateTierCandidate(
      {
        target: assignment,
        hierarchy: assignment.hierarchy,
        body,
        score: 1,
        quarantined: assignment.quarantined,
        redaction: assignment.redaction,
        promptIntegrity: assignment.promptIntegrity,
      },
      catalog,
    );
    if (!validation.eligible)
      throw new Error(
        `post-transition system candidate is ineligible: ${validation.reasons.join(", ")}`,
      );
    totalChars += body.length;
  }
  if (totalChars > SYSTEM_PROMPT_MAX_TOTAL_CHARS)
    throw new Error("post-transition system set exceeds character budget");
}

export function commitTierTransition(options: {
  cfg: MemoryConfig;
  plan: TierTransitionPlan;
}): { commit: string; mutationId: string; decision: TierDecision } {
  return observeMemoryOperation(
    {
      operation: "memory.tiering.commit-transition",
      correlation: { decisionId: options.plan.decision.decisionId },
      fields: { changeCount: options.plan.decision.changes.length },
      result: (result) => ({
        fields: { mutationId: result.mutationId, hasCommit: true },
      }),
    },
    () => {
      if (options.plan.version !== 1)
        throw new Error("invalid tier transition plan");
      const decision = parseTierDecision(options.plan.decision);
      const mutationId = `tier_${decision.decisionId.slice("tierdec_".length)}`;
      const existing = historyEntryByMutationId(options.cfg, mutationId);
      if (existing) {
        if (
          existing.receipt.kind !== TIER_DECISION_KIND ||
          canonical(existing.receipt.provenance) !== canonical(decision) ||
          existing.receipt.changes.length !== 0
        )
          throw new Error("tier transition mutation collision");
        return { commit: existing.commit, mutationId, decision };
      }
      const catalog = scanCatalog(options.cfg.root);
      const basis = verifiedBasis(options.cfg, catalog);
      if (
        decision.expectedHistoryHead !== basis.historyHead ||
        decision.expectedStateSha256 !== basis.stateSha256
      )
        throw new Error("tier transition basis is stale");
      assertReplacementBindings(decision);
      const previousReplacement = lastNonSafetyReplacementAt(options.cfg);
      if (
        decision.replacements.some(
          (replacement) => replacement.kind === "non-safety",
        ) &&
        previousReplacement &&
        Date.parse(decision.decidedAt) - Date.parse(previousReplacement) <
          TIER_REPLACEMENT_COOLDOWN_MS
      )
        throw new Error("non-safety tier replacement is cooling down");
      const next = new Map(basis.state);
      for (const change of decision.changes) {
        const key = tierTargetKey(change.target);
        const current = next.get(key);
        if (!current || !samePlacement(current, change.from))
          throw new Error("tier transition basis is stale");
        next.set(key, { ...change.target, ...change.to });
      }
      assertSystemPolicy(options.cfg, catalog, next);
      const result = commitHistory(
        options.cfg,
        {
          version: 2,
          mutationId,
          kind: TIER_DECISION_KIND,
          reason: decision.reason,
          changes: [],
          provenance: decision,
        },
        { allowEmpty: true },
      );
      return { ...result, decision };
    },
  );
}

export type TierClassifierOutput = {
  version: 1;
  target: TierTarget;
  action: "promote" | "demote" | "quarantine" | "abstain";
  hierarchy: TierHierarchy;
  proposedScope: "project" | "global";
  durability: "durable" | "situational";
  risk: "clear" | "secret" | "prompt-integrity" | "harmful";
  evidenceIds: string[];
  evidenceSessionIds: string[];
};

export type TierCriticOutput = {
  version: 1;
  target: TierTarget;
  agrees: boolean;
  entailed: boolean;
  scopeValid: boolean;
  riskClear: boolean;
  evidenceIds: string[];
};

function boundedIds(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some(
      (item) =>
        typeof item !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(item),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error(`invalid ${name}`);
  return value as string[];
}

export function parseTierClassifierOutput(
  value: unknown,
): TierClassifierOutput {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !object(parsed) ||
    !keysAre(parsed, [
      "action",
      "durability",
      "evidenceIds",
      "evidenceSessionIds",
      "hierarchy",
      "proposedScope",
      "risk",
      "target",
      "version",
    ]) ||
    parsed.version !== 1 ||
    !["promote", "demote", "quarantine", "abstain"].includes(
      String(parsed.action),
    ) ||
    !["project", "global"].includes(String(parsed.proposedScope)) ||
    !["durable", "situational"].includes(String(parsed.durability)) ||
    !["clear", "secret", "prompt-integrity", "harmful"].includes(
      String(parsed.risk),
    )
  )
    throw new Error("invalid tier classifier output");
  return {
    version: 1,
    target: parseTarget(parsed.target),
    action: parsed.action as TierClassifierOutput["action"],
    hierarchy: normalizeTierHierarchy(String(parsed.hierarchy)),
    proposedScope:
      parsed.proposedScope as TierClassifierOutput["proposedScope"],
    durability: parsed.durability as TierClassifierOutput["durability"],
    risk: parsed.risk as TierClassifierOutput["risk"],
    evidenceIds: boundedIds(parsed.evidenceIds, "classifier evidence"),
    evidenceSessionIds: boundedIds(
      parsed.evidenceSessionIds,
      "classifier evidence sessions",
    ),
  };
}

export function parseTierCriticOutput(value: unknown): TierCriticOutput {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !object(parsed) ||
    !keysAre(parsed, [
      "agrees",
      "entailed",
      "evidenceIds",
      "riskClear",
      "scopeValid",
      "target",
      "version",
    ]) ||
    parsed.version !== 1 ||
    typeof parsed.agrees !== "boolean" ||
    typeof parsed.entailed !== "boolean" ||
    typeof parsed.scopeValid !== "boolean" ||
    typeof parsed.riskClear !== "boolean"
  )
    throw new Error("invalid tier critic output");
  return {
    version: 1,
    target: parseTarget(parsed.target),
    agrees: parsed.agrees,
    entailed: parsed.entailed,
    scopeValid: parsed.scopeValid,
    riskClear: parsed.riskClear,
    evidenceIds: boundedIds(parsed.evidenceIds, "critic evidence"),
  };
}

export type TierGovernorSignals = {
  artifactScope: "project" | "global";
  confidenceLowerBound: number;
  utilityLowerBound?: number;
  relevantOpportunities?: number;
  explicitDurableUserStatement: boolean;
  verifiedCorrection: boolean;
  condemnedRollback: boolean;
  evaluationPassed: boolean;
  availableEvidenceSessionIds: string[];
};

export type TierGovernorDecision = {
  action: "transition" | "quarantine" | "abstain";
  reasonCode:
    | "qualified-shadow"
    | "qualified-canary"
    | "qualified-active"
    | "classifier-abstained"
    | "classifier-critic-disagreement"
    | "scope-broadening"
    | "insufficient-confidence"
    | "insufficient-evidence"
    | "evaluation-pending"
    | "verified-correction"
    | "condemned-rollback"
    | "low-confidence"
    | "low-utility"
    | "unverified-evidence-session"
    | "risk-quarantine";
  placement?: TierPlacement;
};

/**
 * Models propose labels and evidence; calibrated signals and hard policy own
 * placement. An abstention stays external and never creates manual work.
 */
export function decideAutonomousTierTransition(options: {
  current: TierAssignment;
  classifier: TierClassifierOutput;
  critic: TierCriticOutput;
  signals: TierGovernorSignals;
}): TierGovernorDecision {
  const { current, classifier, critic, signals } = options;
  if (
    tierTargetKey(current) !== tierTargetKey(classifier.target) ||
    tierTargetKey(current) !== tierTargetKey(critic.target)
  )
    throw new Error("tier governor target mismatch");
  const availableEvidence = new Set(
    boundedIds(
      signals.availableEvidenceSessionIds,
      "available evidence sessions",
    ),
  );
  if (
    classifier.evidenceSessionIds.some(
      (sessionId) => !availableEvidence.has(sessionId),
    )
  )
    return { action: "abstain", reasonCode: "unverified-evidence-session" };
  const confidence = signals.confidenceLowerBound;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error("invalid calibrated tier confidence");
  if (
    classifier.action === "quarantine" ||
    classifier.risk !== "clear" ||
    !critic.riskClear
  )
    return {
      action: "quarantine",
      reasonCode: "risk-quarantine",
      placement: {
        tier: "external",
        hierarchy: classifier.hierarchy,
        rollout: "shadow",
        quarantined: true,
        redaction:
          classifier.risk === "secret" ? "required" : current.redaction,
        promptIntegrity:
          classifier.risk === "prompt-integrity"
            ? "rejected"
            : current.promptIntegrity,
      },
    };
  if (signals.verifiedCorrection)
    return {
      action: "transition",
      reasonCode: "verified-correction",
      placement: {
        ...current,
        tier: "external",
        rollout: "shadow",
      },
    };
  if (signals.condemnedRollback)
    return {
      action: "transition",
      reasonCode: "condemned-rollback",
      placement: {
        ...current,
        tier: "external",
        rollout: "shadow",
      },
    };
  if (current.tier === "system" && confidence < 0.85)
    return {
      action: "transition",
      reasonCode: "low-confidence",
      placement: { ...current, tier: "external", rollout: "shadow" },
    };
  if (
    current.tier === "system" &&
    (signals.relevantOpportunities ?? 0) >= 20 &&
    (signals.utilityLowerBound ?? 1) < 0.35
  )
    return {
      action: "transition",
      reasonCode: "low-utility",
      placement: { ...current, tier: "external", rollout: "shadow" },
    };
  if (classifier.action === "abstain")
    return { action: "abstain", reasonCode: "classifier-abstained" };
  if (
    !critic.agrees ||
    !critic.entailed ||
    !critic.scopeValid ||
    classifier.action === "demote"
  )
    return {
      action: "abstain",
      reasonCode: "classifier-critic-disagreement",
    };
  if (
    signals.artifactScope === "project" &&
    classifier.proposedScope === "global"
  )
    return { action: "abstain", reasonCode: "scope-broadening" };
  if (classifier.durability !== "durable")
    return { action: "abstain", reasonCode: "insufficient-evidence" };
  if (current.tier === "external") {
    const shadowQualified = confidence >= 0.9;
    if (!shadowQualified)
      return { action: "abstain", reasonCode: "insufficient-confidence" };
    const shadowed =
      current.hierarchy !== "uncategorized" &&
      current.redaction === "clear" &&
      current.promptIntegrity === "trusted";
    if (!shadowed)
      return {
        action: "transition",
        reasonCode: "qualified-shadow",
        placement: {
          ...current,
          hierarchy: classifier.hierarchy,
          redaction: "clear",
          promptIntegrity: "trusted",
        },
      };
    if (!signals.evaluationPassed)
      return { action: "abstain", reasonCode: "evaluation-pending" };
    const sessionEvidence =
      new Set(classifier.evidenceSessionIds).size >= 2 ||
      signals.explicitDurableUserStatement;
    if (confidence < (signals.artifactScope === "global" ? 0.98 : 0.95))
      return { action: "abstain", reasonCode: "insufficient-confidence" };
    if (!sessionEvidence)
      return { action: "abstain", reasonCode: "insufficient-evidence" };
    return {
      action: "transition",
      reasonCode: "qualified-canary",
      placement: {
        ...current,
        tier: "system",
        hierarchy: classifier.hierarchy,
        rollout: "canary",
        quarantined: false,
        redaction: "clear",
        promptIntegrity: "trusted",
      },
    };
  }
  if (current.rollout === "canary") {
    if (!signals.evaluationPassed || (signals.utilityLowerBound ?? 0) < 0.6)
      return { action: "abstain", reasonCode: "evaluation-pending" };
    return {
      action: "transition",
      reasonCode: "qualified-active",
      placement: { ...current, rollout: "active" },
    };
  }
  return { action: "abstain", reasonCode: "evaluation-pending" };
}

export function commitAutonomousTierDecision(options: {
  cfg: MemoryConfig;
  classifier: TierClassifierOutput;
  critic: TierCriticOutput;
  signals: TierGovernorSignals;
  decidedAt: string;
}):
  | { status: "abstained"; reasonCode: TierGovernorDecision["reasonCode"] }
  | {
      status: "committed";
      reasonCode: TierGovernorDecision["reasonCode"];
      commit: string;
      mutationId: string;
      decision: TierDecision;
    } {
  const catalog = scanCatalog(options.cfg.root);
  const basis = verifiedBasis(options.cfg, catalog);
  const key = tierTargetKey(options.classifier.target);
  const current = basis.state.get(key);
  if (!current) throw new Error("tier governor target is not current");
  const governed = decideAutonomousTierTransition({
    current,
    classifier: options.classifier,
    critic: options.critic,
    signals: options.signals,
  });
  if (governed.action === "abstain" || !governed.placement)
    return { status: "abstained", reasonCode: governed.reasonCode };
  if (samePlacement(current, governed.placement))
    return { status: "abstained", reasonCode: governed.reasonCode };
  const decisionBasis: Omit<TierDecision, "decisionId"> = {
    version: 1,
    source: "tier-governor",
    decidedAt: exactIso(options.decidedAt, "tier governor decision time"),
    actor: "tier-governor",
    reason: governed.reasonCode,
    expectedHistoryHead: basis.historyHead,
    expectedStateSha256: basis.stateSha256,
    replacements: [],
    changes: [
      {
        target: options.classifier.target,
        from: {
          tier: current.tier,
          hierarchy: current.hierarchy,
          rollout: current.rollout,
          quarantined: current.quarantined,
          redaction: current.redaction,
          promptIntegrity: current.promptIntegrity,
        },
        to: governed.placement,
      },
    ],
  };
  const decision = {
    ...decisionBasis,
    decisionId: canonicalTierDecisionId(decisionBasis),
  };
  const committed = commitTierTransition({
    cfg: options.cfg,
    plan: { version: 1, decision },
  });
  return {
    status: "committed",
    reasonCode: governed.reasonCode,
    ...committed,
  };
}

export type TierManifestEntry = TierAssignment & {
  body: string;
  bodySha256: string;
};
export type TierManifest = {
  version: 1;
  manifestId: string;
  createdAt: string;
  entries: TierManifestEntry[];
};

type TierManifestPointer = {
  version: 1;
  manifestId: string;
  previousManifestId?: string;
  publishedAt: string;
};

function manifestRoot(cfg: Pick<MemoryConfig, "data">): string {
  return join(cfg.data, "v2/tiers/manifests");
}

const TIER_POINTER_LOCK_STALE_MS = 5 * 60_000;

function withTierPointerLock<T>(cfg: MemoryConfig, operation: () => T): T {
  const root = join(cfg.data, "v2/tiers");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".pointer-lock");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > TIER_POINTER_LOCK_STALE_MS) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (attempt >= 100) throw new Error("tier manifest pointer is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
function manifestPath(cfg: Pick<MemoryConfig, "data">, id: string): string {
  if (!/^tiermanifest_[a-f0-9]{64}$/.test(id))
    throw new Error("invalid tier manifest id");
  return contained(manifestRoot(cfg), join(manifestRoot(cfg), `${id}.json`));
}
function pointerPath(cfg: Pick<MemoryConfig, "data">): string {
  return join(cfg.data, "v2/tiers/current.json");
}

function autonomyDisabledPath(cfg: Pick<MemoryConfig, "data">): string {
  return join(cfg.data, "v2/tiers/autonomy-disabled");
}

function canaryPercentPath(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
): string {
  return join(
    cfg.data,
    "v2/tiers/canary",
    `${sha256(tierTargetKey(target))}.json`,
  );
}

export function tierCanaryPercent(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
): 5 | 25 | 100 {
  return tierCanaryRollout(cfg, target).percent;
}

export function tierCanaryBaseline(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
): number {
  return tierCanaryRollout(cfg, target).baselineRelevantTurns;
}

function tierCanaryRollout(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
): { percent: 5 | 25 | 100; baselineRelevantTurns: number } {
  const path = canaryPercentPath(cfg, target);
  if (!existsSync(path)) return { percent: 5, baselineRelevantTurns: 0 };
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(value) ||
    !keysAre(value, [
      "baselineRelevantTurns",
      "percent",
      "target",
      "version",
    ]) ||
    value.version !== 1 ||
    ![5, 25, 100].includes(Number(value.percent)) ||
    !Number.isSafeInteger(value.baselineRelevantTurns) ||
    Number(value.baselineRelevantTurns) < 0 ||
    tierTargetKey(parseTarget(value.target)) !== tierTargetKey(target)
  )
    throw new Error("invalid tier canary rollout");
  return {
    percent: value.percent as 5 | 25 | 100,
    baselineRelevantTurns: Number(value.baselineRelevantTurns),
  };
}

export function advanceTierCanaryPercent(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
  baselineRelevantTurns: number,
): 25 | 100 {
  return observeMemoryOperation(
    {
      operation: "memory.tiering.advance-canary",
      correlation: { memoryIdSha256: sha256(String(target.memoryId)) },
      result: (percent) => ({ fields: { percent, baselineRelevantTurns } }),
    },
    () => {
      if (
        !Number.isSafeInteger(baselineRelevantTurns) ||
        baselineRelevantTurns < 0
      )
        throw new Error("invalid tier canary baseline");
      const current = tierCanaryPercent(cfg, target);
      const percent = current === 5 ? 25 : 100;
      atomicWrite(
        canaryPercentPath(cfg, target),
        `${canonical({ version: 1, target, percent, baselineRelevantTurns })}\n`,
      );
      return percent;
    },
  );
}

export function resetTierCanaryPercent(
  cfg: Pick<MemoryConfig, "data">,
  target: TierTarget,
): void {
  observeMemoryOperation(
    {
      operation: "memory.tiering.reset-canary",
      correlation: { memoryIdSha256: sha256(String(target.memoryId)) },
    },
    () => {
      const path = canaryPercentPath(cfg, target);
      if (existsSync(path)) unlinkSync(path);
    },
  );
}

export function tierAutonomyEnabled(cfg: Pick<MemoryConfig, "data">): boolean {
  return (
    process.env.PI_MEMORY_TIER_AUTONOMY !== "0" &&
    !existsSync(autonomyDisabledPath(cfg))
  );
}

export function setTierAutonomy(
  cfg: Pick<MemoryConfig, "data">,
  enabled: boolean,
): void {
  observeMemoryOperation(
    {
      operation: "memory.tiering.set-autonomy",
      fields: { enabled },
    },
    () => {
      const path = autonomyDisabledPath(cfg);
      if (enabled) {
        if (existsSync(path)) unlinkSync(path);
      } else atomicWrite(path, "disabled\n");
    },
  );
}
function manifestIdFor(value: Omit<TierManifest, "manifestId">): string {
  return `tiermanifest_${sha256(canonical(value))}`;
}
function parseManifest(value: unknown): TierManifest {
  if (
    !object(value) ||
    !keysAre(value, ["createdAt", "entries", "manifestId", "version"]) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > SYSTEM_PROMPT_MAX_MEMORIES
  )
    throw new Error("invalid tier manifest");
  const entries = value.entries.map((entry): TierManifestEntry => {
    if (
      !object(entry) ||
      !keysAre(entry, [
        "artifactSha256",
        "body",
        "bodySha256",
        "hierarchy",
        "memoryId",
        "path",
        "promptIntegrity",
        "quarantined",
        "redaction",
        "rollout",
        "tier",
      ]) ||
      typeof entry.body !== "string" ||
      !HASH.test(String(entry.bodySha256)) ||
      sha256(entry.body) !== entry.bodySha256
    )
      throw new Error("invalid tier manifest entry");
    const target = parseTarget({
      memoryId: entry.memoryId,
      path: entry.path,
      artifactSha256: entry.artifactSha256,
    });
    const placement = parsePlacement({
      tier: entry.tier,
      hierarchy: entry.hierarchy,
      rollout: entry.rollout,
      quarantined: entry.quarantined,
      redaction: entry.redaction,
      promptIntegrity: entry.promptIntegrity,
    });
    if (placement.tier !== "system" || placement.quarantined)
      throw new Error("invalid tier manifest placement");
    return {
      ...target,
      ...placement,
      body: entry.body,
      bodySha256: entry.bodySha256 as string,
    };
  });
  const targetKeys = entries.map(tierTargetKey);
  if (
    new Set(targetKeys).size !== targetKeys.length ||
    targetKeys.join("\0") !==
      [...targetKeys].sort(compareTierCodePoints).join("\0") ||
    entries.some((entry) => entry.body.length > SYSTEM_PROMPT_MAX_BODY_CHARS) ||
    entries.reduce((sum, entry) => sum + entry.body.length, 0) >
      SYSTEM_PROMPT_MAX_TOTAL_CHARS
  )
    throw new Error("invalid tier manifest budget or ordering");
  const manifest: TierManifest = {
    version: 1,
    manifestId: String(value.manifestId),
    createdAt: exactIso(value.createdAt, "tier manifest time"),
    entries,
  };
  const { manifestId: _, ...basis } = manifest;
  if (manifest.manifestId !== manifestIdFor(basis))
    throw new Error("tier manifest id does not match content");
  return manifest;
}

function loadPointer(
  cfg: Pick<MemoryConfig, "data">,
): TierManifestPointer | undefined {
  if (!existsSync(pointerPath(cfg))) return undefined;
  const value: unknown = JSON.parse(readFileSync(pointerPath(cfg), "utf8"));
  if (
    !object(value) ||
    !keysAre(value, [
      "manifestId",
      "publishedAt",
      ...(value.previousManifestId === undefined ? [] : ["previousManifestId"]),
      "version",
    ]) ||
    value.version !== 1 ||
    !/^tiermanifest_[a-f0-9]{64}$/.test(String(value.manifestId)) ||
    (value.previousManifestId !== undefined &&
      (typeof value.previousManifestId !== "string" ||
        !/^tiermanifest_[a-f0-9]{64}$/.test(value.previousManifestId)))
  )
    throw new Error("invalid tier manifest pointer");
  exactIso(value.publishedAt, "tier manifest publish time");
  return value as TierManifestPointer;
}

function loadManifest(
  cfg: Pick<MemoryConfig, "data">,
  id: string,
): TierManifest {
  return parseManifest(JSON.parse(readFileSync(manifestPath(cfg, id), "utf8")));
}

export function currentTierManifest(
  cfg: MemoryConfig,
): TierManifest | undefined {
  const pointer = loadPointer(cfg);
  if (!pointer) return undefined;
  const manifest = loadManifest(cfg, pointer.manifestId);
  assertManifestAuthorized(cfg, manifest);
  return manifest;
}

function assertManifestAuthorized(
  cfg: MemoryConfig,
  manifest: TierManifest,
): void {
  const authorized = listHistoryByKind(cfg, TIER_DECISION_KIND)
    .map((entry) => parseTierDecision(entry.receipt.provenance))
    .flatMap((decision) => decision.changes);
  for (const entry of manifest.entries)
    if (
      !authorized.some(
        (change) =>
          tierTargetKey(change.target) === tierTargetKey(entry) &&
          samePlacement(change.to, entry) &&
          change.to.tier === "system",
      )
    )
      throw new Error("tier manifest entry lacks trusted history authority");
}

export function tierStatus(cfg: MemoryConfig): {
  autonomyEnabled: boolean;
  system: number;
  external: number;
  quarantined: number;
  manifestId?: string;
} {
  const state = deriveTierState(cfg);
  const manifest = currentTierManifest(cfg);
  const assignments = [...state.values()];
  return {
    autonomyEnabled: tierAutonomyEnabled(cfg),
    system: assignments.filter((item) => item.tier === "system").length,
    external: assignments.filter((item) => item.tier === "external").length,
    quarantined: assignments.filter((item) => item.quarantined).length,
    ...(manifest ? { manifestId: manifest.manifestId } : {}),
  };
}

type PublishTierManifestOptions = {
  cfg: MemoryConfig;
  createdAt: string;
};

function publishTierManifestObserved(
  options: PublishTierManifestOptions,
): TierManifest {
  return observeMemoryOperation(
    {
      operation: "memory.tiering.publish-manifest",
      result: (manifest) => ({
        fields: {
          manifestId: manifest.manifestId,
          entryCount: manifest.entries.length,
        },
      }),
    },
    () => {
      if (
        !keysAre(options as unknown as Record<string, unknown>, [
          "cfg",
          "createdAt",
        ])
      )
        throw new Error("invalid tier manifest publication fields");
      const catalog = scanCatalog(options.cfg.root);
      const { state } = verifiedBasis(options.cfg, catalog);
      assertSystemPolicy(options.cfg, catalog, state);
      const entries = [...state.values()]
        .filter((assignment) => assignment.tier === "system")
        .map((assignment): TierManifestEntry => {
          const body = artifactBody(options.cfg, catalog, assignment);
          const validation = validateTierCandidate(
            {
              target: assignment,
              hierarchy: assignment.hierarchy,
              body,
              score: 1,
              quarantined: assignment.quarantined,
              redaction: assignment.redaction,
              promptIntegrity: assignment.promptIntegrity,
            },
            catalog,
          );
          if (!validation.eligible)
            throw new Error(
              `tier manifest candidate is ineligible: ${validation.reasons.join(", ")}`,
            );
          return { ...assignment, body, bodySha256: sha256(body) };
        })
        .sort((left, right) =>
          compareTierCodePoints(tierTargetKey(left), tierTargetKey(right)),
        );
      const basis: Omit<TierManifest, "manifestId"> = {
        version: 1,
        createdAt: exactIso(options.createdAt, "tier manifest time"),
        entries,
      };
      const manifest = parseManifest({
        ...basis,
        manifestId: manifestIdFor(basis),
      });
      const path = manifestPath(options.cfg, manifest.manifestId);
      if (existsSync(path)) {
        if (
          canonical(loadManifest(options.cfg, manifest.manifestId)) !==
          canonical(manifest)
        )
          throw new Error("tier manifest content collision");
      } else atomicWrite(path, `${canonical(manifest)}\n`);
      const current = loadPointer(options.cfg);
      if (current?.manifestId === manifest.manifestId) return manifest;
      const pointer: TierManifestPointer = {
        version: 1,
        manifestId: manifest.manifestId,
        ...(current ? { previousManifestId: current.manifestId } : {}),
        publishedAt: options.createdAt,
      };
      atomicWrite(pointerPath(options.cfg), `${canonical(pointer)}\n`);
      return manifest;
    },
  );
}

export function publishTierManifest(
  options: PublishTierManifestOptions,
): TierManifest {
  return withTierPointerLock(options.cfg, () =>
    publishTierManifestObserved(options),
  );
}

type TierManifestRollback = {
  version: 1;
  rollbackId: string;
  fromManifestId: string;
  targetManifestId: string;
  rolledBackAt: string;
};

function rollbackPath(
  cfg: Pick<MemoryConfig, "data">,
  rollbackId: string,
): string {
  if (!/^rollback_[a-f0-9]{32}$/.test(rollbackId))
    throw new Error("invalid tier manifest rollback id");
  const root = join(cfg.data, "v2/tiers/rollbacks");
  return contained(root, join(root, `${rollbackId}.json`));
}

function parseRollback(value: unknown): TierManifestRollback {
  if (
    !object(value) ||
    !keysAre(value, [
      "fromManifestId",
      "rollbackId",
      "rolledBackAt",
      "targetManifestId",
      "version",
    ]) ||
    value.version !== 1 ||
    !/^rollback_[a-f0-9]{32}$/.test(String(value.rollbackId)) ||
    !/^tiermanifest_[a-f0-9]{64}$/.test(String(value.fromManifestId)) ||
    !/^tiermanifest_[a-f0-9]{64}$/.test(String(value.targetManifestId))
  )
    throw new Error("invalid tier manifest rollback");
  return {
    version: 1,
    rollbackId: value.rollbackId as string,
    fromManifestId: value.fromManifestId as string,
    targetManifestId: value.targetManifestId as string,
    rolledBackAt: exactIso(value.rolledBackAt, "tier manifest rollback time"),
  };
}

type RollbackTierManifestOptions = {
  cfg: MemoryConfig;
  rollbackId: string;
  targetManifestId: string;
  rolledBackAt: string;
  expectedCurrentManifestId?: string;
};

function rollbackTierManifestObserved(
  options: RollbackTierManifestOptions,
): TierManifest {
  return observeMemoryOperation(
    {
      operation: "memory.tiering.rollback-manifest",
      correlation: { rollbackId: options.rollbackId },
      fields: { hasExplicitTarget: true },
      result: (manifest) => ({
        fields: {
          manifestId: manifest.manifestId,
          entryCount: manifest.entries.length,
        },
      }),
    },
    () => {
      const fields = [
        "cfg",
        "rollbackId",
        "rolledBackAt",
        "targetManifestId",
        ...(options.expectedCurrentManifestId === undefined
          ? []
          : ["expectedCurrentManifestId"]),
      ];
      if (!keysAre(options as unknown as Record<string, unknown>, fields))
        throw new Error("invalid tier manifest rollback fields");
      const target = loadManifest(options.cfg, options.targetManifestId);
      assertManifestAuthorized(options.cfg, target);
      const path = rollbackPath(options.cfg, options.rollbackId);
      const current = loadPointer(options.cfg);
      if (!current) throw new Error("tier manifest pointer is missing");
      if (
        options.expectedCurrentManifestId !== undefined &&
        current.manifestId !== options.expectedCurrentManifestId
      )
        throw new Error("tier manifest rollback basis is stale");
      let rollback: TierManifestRollback;
      if (existsSync(path)) {
        rollback = parseRollback(JSON.parse(readFileSync(path, "utf8")));
        if (
          rollback.targetManifestId !== options.targetManifestId ||
          rollback.rolledBackAt !== options.rolledBackAt
        )
          throw new Error("tier manifest rollback id collision");
      } else {
        rollback = {
          version: 1,
          rollbackId: options.rollbackId,
          fromManifestId: current.manifestId,
          targetManifestId: options.targetManifestId,
          rolledBackAt: exactIso(
            options.rolledBackAt,
            "tier manifest rollback time",
          ),
        };
        atomicWrite(path, `${canonical(rollback)}\n`);
      }
      if (current.manifestId === rollback.targetManifestId) return target;
      if (current.manifestId !== rollback.fromManifestId)
        throw new Error("tier manifest rollback has been superseded");
      const pointer: TierManifestPointer = {
        version: 1,
        manifestId: rollback.targetManifestId,
        previousManifestId: rollback.fromManifestId,
        publishedAt: rollback.rolledBackAt,
      };
      atomicWrite(pointerPath(options.cfg), `${canonical(pointer)}\n`);
      return target;
    },
  );
}

export function rollbackTierManifest(
  options: RollbackTierManifestOptions,
): TierManifest {
  return withTierPointerLock(options.cfg, () =>
    rollbackTierManifestObserved(options),
  );
}

export function rollbackToPreviousTierManifest(options: {
  cfg: MemoryConfig;
  incidentId: string;
  rolledBackAt: string;
}): TierManifest | undefined {
  const current = loadPointer(options.cfg);
  if (!current?.previousManifestId) return undefined;
  const active = loadManifest(options.cfg, current.manifestId);
  const previous = loadManifest(options.cfg, current.previousManifestId);
  if (Date.parse(previous.createdAt) >= Date.parse(active.createdAt))
    return undefined;
  const rollbackId = `rollback_${sha256(`incident:${options.incidentId}:${current.manifestId}:${current.previousManifestId}`).slice(0, 32)}`;
  return rollbackTierManifest({
    cfg: options.cfg,
    rollbackId,
    targetManifestId: current.previousManifestId,
    rolledBackAt: options.rolledBackAt,
    expectedCurrentManifestId: current.manifestId,
  });
}
