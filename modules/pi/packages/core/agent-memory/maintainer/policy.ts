import { basename } from "node:path";
import { object } from "./common.js";

export const V3_POLICY_VERSION = 1;
export const ADMISSION_POLICY_VERSION = 1;

type ResourceLimits = Readonly<{
  version: number;
  maxTurnWallMs: number;
  maxTurnCpuMs: number;
  maxReadBytes: number;
  maxRecordBytes: number;
  maxArtifactBytes: number;
  maxBufferedBytes: number;
  maxContinuationBytes: number;
  maxSourceHints: number;
  maxDiscoveryEntries: number;
  maxWorkflowsPerSlice: number;
  maxProposalBacklog: number;
  maxLocalTelemetryBytes: number;
  maxEvidenceEntries: number;
  maxEvidenceEntryBytes: number;
  maxEvidenceCapsuleBytes: number;
  maxLocatorBytes: number;
  checkoutLockTargetMs: number;
}>;

export const RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  version: 1,
  maxTurnWallMs: 2_000,
  maxTurnCpuMs: 1_500,
  maxReadBytes: 16 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxArtifactBytes: 2 * 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxContinuationBytes: 256 * 1024,
  maxSourceHints: 256,
  maxDiscoveryEntries: 512,
  maxWorkflowsPerSlice: 32,
  maxProposalBacklog: 1_000,
  maxLocalTelemetryBytes: 128 * 1024 * 1024,
  maxEvidenceEntries: 64,
  maxEvidenceEntryBytes: 16 * 1024,
  maxEvidenceCapsuleBytes: 256 * 1024,
  maxLocatorBytes: 500,
  checkoutLockTargetMs: 1_000,
});

export type SourceKind =
  | "pi-session-jsonl"
  | "amp-session-jsonl"
  | "memory-markdown"
  | "skill-artifact";

export type SourcePolicy = {
  version: number;
  rootId: string;
  root: string;
  kind: SourceKind;
  trustedAppendOnly: boolean;
  enabled: boolean;
};

export function sourcePathRejected(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/");
  return (
    segments.includes(".stversions") ||
    segments.includes(".pi-memory") ||
    segments.some((part) => part === ".qmd") ||
    /(?:^|\.)sync-conflict-[^/]*$/i.test(basename(relativePath))
  );
}

export function parseSourcePolicy(value: unknown): SourcePolicy {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof value.rootId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.rootId) ||
    typeof value.root !== "string" ||
    !value.root ||
    ![
      "pi-session-jsonl",
      "amp-session-jsonl",
      "memory-markdown",
      "skill-artifact",
    ].includes(String(value.kind)) ||
    typeof value.trustedAppendOnly !== "boolean" ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("invalid source policy");
  if (
    value.trustedAppendOnly &&
    value.kind !== "pi-session-jsonl" &&
    value.kind !== "amp-session-jsonl"
  )
    throw new Error("only session producers may be trusted append-only");
  return value as SourcePolicy;
}

type RetentionClasses = Readonly<{
  canonical: string;
  nonterminal: string;
  producerSource: string;
  terminalLocal: string;
  derived: string;
  telemetry: string;
}>;

export const RETENTION_CLASSES: RetentionClasses = Object.freeze({
  canonical: "indefinite",
  nonterminal: "until-safe-terminal",
  producerSource: "producer-owned",
  terminalLocal: "report-only-until-reference-proof",
  derived: "rebuildable-after-basis-verification",
  telemetry: "bounded-best-effort",
});

type AxiomDatasetPolicy = Readonly<{
  dataset: string;
  retention: string;
  authority: string;
}>;

export const AXIOM_DATASET_POLICY: AxiomDatasetPolicy = Object.freeze({
  dataset: "papertrail",
  retention: "inherited-account-policy",
  authority: "cost-and-privacy-only",
});

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("v3 policy", () => {
    it.each([
      ".stversions/session.jsonl",
      "nested/.stversions/session.jsonl",
      "session.sync-conflict-20260903-a.jsonl",
      ".pi-memory/evidence.json",
      ".qmd/cache.md",
    ])("rejects reserved input %s", (path) => {
      expect(sourcePathRejected(path)).toBe(true);
    });

    it("keeps every resource control finite", () => {
      for (const [name, value] of Object.entries(RESOURCE_LIMITS))
        if (name !== "version") {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
        }
    });

    it("limits append trust to configured session producers", () => {
      expect(() =>
        parseSourcePolicy({
          version: 1,
          rootId: "memory",
          root: "/tmp/memory",
          kind: "memory-markdown",
          trustedAppendOnly: true,
          enabled: true,
        }),
      ).toThrow("only session producers");
    });
  });
}
