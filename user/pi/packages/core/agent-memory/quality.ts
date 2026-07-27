import type { MemoryConfig } from "./catalog.js";
import {
  isHistoryInitialized,
  listHistoryByKind,
  verifyHistory,
} from "./history.js";

export type AdaptationQuality = "reinforced" | "neutral" | "demoted";

type QualityTarget = { memoryId: string; path: string; artifactSha256: string };
type QualityProvenance = {
  source: "adaptation-policy";
  action: "reinforce" | "demote";
  shadowId: string;
  decisionIndex: number;
  target: QualityTarget;
  evidenceIds: string[];
};

const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function adaptationQualityKey(target: QualityTarget): string {
  return `${target.memoryId}\0${target.path}\0${target.artifactSha256}`;
}

function parseQualityProvenance(value: unknown): QualityProvenance {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !==
      "action,decisionIndex,evidenceIds,shadowId,source,target" ||
    value.source !== "adaptation-policy" ||
    (value.action !== "reinforce" && value.action !== "demote") ||
    typeof value.shadowId !== "string" ||
    !Number.isInteger(value.decisionIndex) ||
    !object(value.target) ||
    Object.keys(value.target).sort().join(",") !==
      "artifactSha256,memoryId,path" ||
    typeof value.target.memoryId !== "string" ||
    typeof value.target.path !== "string" ||
    !HASH.test(String(value.target.artifactSha256)) ||
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length === 0 ||
    !value.evidenceIds.every((id) => typeof id === "string")
  )
    throw new Error("invalid adaptation quality receipt");
  return value as QualityProvenance;
}

export function deriveAdaptationQuality(
  cfg: MemoryConfig,
): Map<string, AdaptationQuality> {
  if (!isHistoryInitialized(cfg)) return new Map();
  const verification = verifyHistory(cfg);
  if (!verification.ok)
    throw new Error(
      `adaptation quality history verification failed: ${verification.issues.join(", ")}`,
    );
  const quality = new Map<string, AdaptationQuality>();
  for (const entry of listHistoryByKind(cfg, "adaptation-quality").reverse()) {
    if (entry.receipt.changes.length !== 0)
      throw new Error("adaptation quality commit changed an artifact");
    const provenance = parseQualityProvenance(entry.receipt.provenance);
    quality.set(
      adaptationQualityKey(provenance.target),
      provenance.action === "reinforce" ? "reinforced" : "demoted",
    );
  }
  return quality;
}
