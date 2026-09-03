import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  boundedString,
  canonicalJson,
  durableCreate,
  durableWrite,
  object,
  safeRelativePath,
  sha256,
  timestamp,
  type JsonValue,
  v3Data,
} from "./common.js";
import { ADMISSION_POLICY_VERSION, RESOURCE_LIMITS } from "./policy.js";
import type { ArtifactRef } from "./workflows.js";

export type EpistemicClass =
  | "user-statement"
  | "tool-observation"
  | "external-source-statement"
  | "model-inference";

export type CanonicalChange = {
  path: string;
  beforeSha256: string | null;
  afterContent: string | null;
  afterSha256: string | null;
};

export type Claim = {
  claimId: string;
  path: string;
  startByte: number;
  endByte: number;
  textSha256: string;
  epistemic: EpistemicClass;
  evidenceEntryIds: string[];
};

export type EvidenceEntry = {
  evidenceEntryId: string;
  kind: EpistemicClass;
  representation:
    | "exact-excerpt"
    | "redacted-excerpt"
    | "structured-observation";
  safeBytes: string;
  safeBytesSha256: string;
  source: {
    kind: string;
    identity: string;
    observedAt: string;
    workspace: string;
    locator: string;
  };
  safetyTransformationVersion: number;
  originalArtifactSha256?: string;
};

type AdmissionCheck = {
  result: "pass" | "closed";
  reasons: string[];
};

export type EvidenceCapsule = {
  schemaVersion: 1;
  mutationId: string;
  proposalId: string;
  proposalSha256: string;
  affectedPaths: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
  admission: {
    decisionId: string;
    evaluatedAt: string;
    expiresAt: string;
    actor: string;
    policyVersion: number;
    basis: {
      sourceEvidenceSha256: string[];
      catalogSha256: string;
      targetHead: string;
      promptPolicyVersion: number;
      modelPolicyVersion: number;
    };
    checks: Record<
      | "provenance"
      | "epistemicIntegrity"
      | "safety"
      | "structure"
      | "convergence",
      AdmissionCheck
    >;
  };
  evidence: EvidenceEntry[];
  claims: Claim[];
};

export type AdmissionDecision = {
  schemaVersion: 1;
  policyVersion: number;
  decisionId: string;
  proposalId: string;
  proposalSha256: string;
  mutationId: string;
  evaluatedAt: string;
  expiresAt: string;
  actor: string;
  basis: {
    hostLocalSourceEvidence: ArtifactRef[];
    catalogSha256: string;
    targetHead: string;
    promptPolicyVersion: number;
    modelPolicyVersion: number;
  };
  checks: EvidenceCapsule["admission"]["checks"];
  result:
    | {
        type: "merge-ready";
        evidenceCapsule: {
          relativePath: string;
          sha256: string;
          artifact: ArtifactRef;
        };
        acceptedSummary: {
          relativePath: string;
          sha256: string;
          artifact: ArtifactRef;
        };
      }
    | { type: "closed"; reasons: string[] };
};

export type AdmissionInput = {
  proposalId: string;
  proposalSha256: string;
  mutationId: string;
  actor: string;
  evaluatedAt: string;
  expiresAt: string;
  basis: AdmissionDecision["basis"];
  changes: CanonicalChange[];
  claims: Claim[];
  evidence: EvidenceEntry[];
};

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.-]+$/;
const forbiddenSecret =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9+/_.-]{12,}|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{16,})/i;
const promptInjection =
  /(?:ignore (?:all )?(?:previous|prior) instructions|system prompt|developer message|<\/?memory_catalog>)/i;
const incompleteEvidence =
  /(?:\[(?:truncated|omitted)\]|<(?:truncated|omitted)>|\.\.\.$)/i;

type AdmissionRoot = Pick<MemoryConfig, "data">;
const decisionPath = (cfg: AdmissionRoot, decisionId: string): string =>
  v3Data(cfg, "admissions", decisionId.slice(-2), `${decisionId}.json`);

function check(result: boolean, ...reasons: string[]): AdmissionCheck {
  return {
    result: result ? "pass" : "closed",
    reasons: result ? [] : reasons.slice(0, 16),
  };
}

function canonicalMemoryPath(value: string): string {
  const path = safeRelativePath(value);
  if (
    !path.endsWith(".md") ||
    path.startsWith(".pi-memory/") ||
    path.startsWith(".qmd/") ||
    path.split("/").some((part) => part === ".stversions") ||
    path.split("/").some((part) => part.includes(".sync-conflict-"))
  )
    throw new Error("invalid canonical memory path");
  return path;
}

function validateInput(input: AdmissionInput): void {
  if (
    !ID.test(input.proposalId) ||
    !HASH.test(input.proposalSha256) ||
    !ID.test(input.mutationId) ||
    !boundedString(input.actor, "admission actor", 120) ||
    !HASH.test(input.basis.catalogSha256) ||
    !/^[a-f0-9]{40,64}$/.test(input.basis.targetHead) ||
    !Number.isSafeInteger(input.basis.promptPolicyVersion) ||
    !Number.isSafeInteger(input.basis.modelPolicyVersion) ||
    input.changes.length < 1 ||
    input.changes.length > 64 ||
    input.claims.length > RESOURCE_LIMITS.maxEvidenceEntries ||
    input.evidence.length > RESOURCE_LIMITS.maxEvidenceEntries
  )
    throw new Error("invalid admission input");
  timestamp(input.evaluatedAt, "admission evaluatedAt");
  timestamp(input.expiresAt, "admission expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.evaluatedAt))
    throw new Error("expired admission input");
  const paths = new Set<string>();
  for (const change of input.changes) {
    canonicalMemoryPath(change.path);
    if (paths.has(change.path)) throw new Error("duplicate changed path");
    paths.add(change.path);
    if (change.beforeSha256 !== null && !HASH.test(change.beforeSha256))
      throw new Error("invalid before digest");
    if (
      (change.afterContent === null) !== (change.afterSha256 === null) ||
      (change.afterContent !== null &&
        sha256(change.afterContent) !== change.afterSha256) ||
      (change.afterContent !== null &&
        Buffer.byteLength(change.afterContent) >
          RESOURCE_LIMITS.maxArtifactBytes)
    )
      throw new Error("invalid after content binding");
  }
}

function validateEvidence(input: AdmissionInput): string[] {
  const reasons: string[] = [];
  const addsAssertions = input.changes.some(
    (change) => change.afterContent !== null,
  );
  if (addsAssertions && !input.claims.length) reasons.push("missing-claims");
  if (addsAssertions && !input.evidence.length)
    reasons.push("missing-claim-bearing-evidence");
  const ids = new Set<string>();
  const claimIds = new Set<string>();
  let bytes = 0;
  for (const entry of input.evidence) {
    bytes += Buffer.byteLength(entry.safeBytes);
    if (
      !ID.test(entry.evidenceEntryId) ||
      ids.has(entry.evidenceEntryId) ||
      ![
        "user-statement",
        "tool-observation",
        "external-source-statement",
        "model-inference",
      ].includes(entry.kind) ||
      !["exact-excerpt", "redacted-excerpt", "structured-observation"].includes(
        entry.representation,
      ) ||
      !entry.safeBytes.trim() ||
      incompleteEvidence.test(entry.safeBytes.trim()) ||
      Buffer.byteLength(entry.safeBytes) >
        RESOURCE_LIMITS.maxEvidenceEntryBytes ||
      sha256(entry.safeBytes) !== entry.safeBytesSha256 ||
      ![1].includes(entry.safetyTransformationVersion) ||
      !entry.source.identity.trim() ||
      !entry.source.workspace.trim() ||
      !entry.source.locator.trim() ||
      entry.source.locator.length > 512
    )
      reasons.push(`invalid-evidence:${entry.evidenceEntryId.slice(0, 40)}`);
    try {
      timestamp(entry.source.observedAt, "evidence observedAt");
    } catch {
      reasons.push(
        `invalid-evidence-time:${entry.evidenceEntryId.slice(0, 40)}`,
      );
    }
    ids.add(entry.evidenceEntryId);
  }
  if (bytes > RESOURCE_LIMITS.maxEvidenceCapsuleBytes)
    reasons.push("evidence-capsule-size-cap");
  for (const claim of input.claims) {
    let content: string | undefined;
    try {
      content =
        input.changes.find((change) => change.path === claim.path)
          ?.afterContent ?? undefined;
      canonicalMemoryPath(claim.path);
    } catch {
      reasons.push(`invalid-claim-path:${claim.claimId.slice(0, 40)}`);
    }
    if (
      !ID.test(claim.claimId) ||
      claimIds.has(claim.claimId) ||
      !content ||
      !Number.isSafeInteger(claim.startByte) ||
      !Number.isSafeInteger(claim.endByte) ||
      claim.startByte < 0 ||
      claim.endByte <= claim.startByte ||
      claim.endByte > Buffer.byteLength(content) ||
      !claim.evidenceEntryIds.length ||
      claim.evidenceEntryIds.some((id) => !ids.has(id))
    ) {
      reasons.push(`invalid-claim:${claim.claimId.slice(0, 40)}`);
      continue;
    }
    claimIds.add(claim.claimId);
    const span = Buffer.from(content).subarray(claim.startByte, claim.endByte);
    if (sha256(span) !== claim.textSha256)
      reasons.push(`claim-span-mismatch:${claim.claimId.slice(0, 40)}`);
    if (
      !claim.evidenceEntryIds.some(
        (id) =>
          input.evidence.find((entry) => entry.evidenceEntryId === id)?.kind ===
          claim.epistemic,
      )
    )
      reasons.push(
        `claim-evidence-class-mismatch:${claim.claimId.slice(0, 40)}`,
      );
  }
  for (const change of input.changes) {
    if (change.afterContent === null) continue;
    const claims = input.claims.filter((claim) => claim.path === change.path);
    let offset = 0;
    for (const line of change.afterContent.split("\n")) {
      const start = offset;
      const end = start + Buffer.byteLength(line);
      offset = end + 1;
      const trimmed = line.trim();
      if (
        !trimmed ||
        /^#{1,6}(?:\s|$)/.test(trimmed) ||
        trimmed === "---" ||
        /^[a-zA-Z][a-zA-Z0-9_-]*:\s/.test(trimmed)
      )
        continue;
      if (
        !claims.some(
          (claim) => claim.startByte <= start && claim.endByte >= end,
        )
      )
        reasons.push(`uncovered-assertion:${change.path}:${start}-${end}`);
    }
    if (input.evidence.some((entry) => entry.safeBytes === change.afterContent))
      reasons.push(`complete-memory-as-evidence:${change.path}`);
  }
  return [...new Set(reasons)].slice(0, 32);
}

function persistArtifact(cfg: AdmissionRoot, value: string): ArtifactRef {
  const digest = sha256(value);
  const path = v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
  if (!durableCreate(path, value) && readFileSync(path, "utf8") !== value)
    throw new Error("admission artifact collision");
  return {
    sha256: digest,
    relativePath: relative(v3Data(cfg), path),
    bytes: Buffer.byteLength(value),
  };
}

export function unsafeCanonicalValue(value: string): boolean {
  return forbiddenSecret.test(value) || promptInjection.test(value);
}

export function evaluateAdmission(
  cfg: AdmissionRoot,
  input: AdmissionInput,
): AdmissionDecision {
  validateInput(input);
  const proposalBinding = sha256(
    canonicalJson({
      proposalId: input.proposalId,
      mutationId: input.mutationId,
      proposalSha256: input.proposalSha256,
      basis: input.basis,
      changes: input.changes.map(({ path, beforeSha256, afterSha256 }) => ({
        path,
        beforeSha256,
        afterSha256,
      })),
      claims: input.claims,
      evidence: input.evidence,
      expiresAt: input.expiresAt,
    } as JsonValue),
  );
  const decisionId = `adm_${proposalBinding.slice(0, 32)}`;
  const existingPath = decisionPath(cfg, decisionId);
  if (existsSync(existingPath)) {
    const existing = parseAdmissionDecision(
      JSON.parse(readFileSync(existingPath, "utf8")),
    );
    if (
      existing.proposalSha256 !== input.proposalSha256 ||
      existing.mutationId !== input.mutationId
    )
      throw new Error("admission decision collision");
    return existing;
  }
  const evidenceReasons = validateEvidence(input);
  const sourceDescriptorsValid = input.evidence.every(
    (entry) =>
      entry.source.kind.trim() &&
      entry.source.identity.trim() &&
      entry.source.workspace.trim() &&
      entry.source.locator.trim(),
  );
  const checks: AdmissionDecision["checks"] = {
    provenance: check(
      evidenceReasons.length === 0 && sourceDescriptorsValid,
      ...evidenceReasons,
      "missing-source-descriptor",
    ),
    epistemicIntegrity: check(
      evidenceReasons.every((reason) => !reason.includes("class-mismatch")),
      ...evidenceReasons.filter((reason) => reason.includes("class-mismatch")),
    ),
    safety: check(
      !input.changes.some(
        (change) =>
          change.afterContent !== null &&
          unsafeCanonicalValue(change.afterContent),
      ) &&
        !input.evidence.some(
          (entry) =>
            unsafeCanonicalValue(entry.safeBytes) ||
            unsafeCanonicalValue(canonicalJson(entry.source)),
        ),
      "unsafe-content",
    ),
    structure: check(evidenceReasons.length === 0, ...evidenceReasons),
    convergence: check(
      Date.parse(input.expiresAt) > Date.parse(input.evaluatedAt),
      "proposal-expired",
    ),
  };
  const closedReasons = Object.entries(checks)
    .filter(([, outcome]) => outcome.result === "closed")
    .flatMap(([name, outcome]) =>
      outcome.reasons.map((reason) => `${name}:${reason}`),
    )
    .slice(0, 32);
  let result: AdmissionDecision["result"];
  if (closedReasons.length) result = { type: "closed", reasons: closedReasons };
  else {
    const capsule: EvidenceCapsule = {
      schemaVersion: 1,
      mutationId: input.mutationId,
      proposalId: input.proposalId,
      proposalSha256: input.proposalSha256,
      affectedPaths: input.changes.map(
        ({ path, beforeSha256, afterSha256 }) => ({
          path,
          beforeSha256,
          afterSha256,
        }),
      ),
      admission: {
        decisionId,
        evaluatedAt: input.evaluatedAt,
        expiresAt: input.expiresAt,
        actor: input.actor,
        policyVersion: ADMISSION_POLICY_VERSION,
        basis: {
          sourceEvidenceSha256: input.basis.hostLocalSourceEvidence.map(
            (artifact) => artifact.sha256,
          ),
          catalogSha256: input.basis.catalogSha256,
          targetHead: input.basis.targetHead,
          promptPolicyVersion: input.basis.promptPolicyVersion,
          modelPolicyVersion: input.basis.modelPolicyVersion,
        },
        checks,
      },
      evidence: input.evidence,
      claims: input.claims,
    };
    const capsuleBytes = `${canonicalJson(capsule as unknown as JsonValue)}\n`;
    if (
      Buffer.byteLength(capsuleBytes) > RESOURCE_LIMITS.maxEvidenceCapsuleBytes
    )
      throw new Error("evidence capsule exceeds size cap");
    const capsuleArtifact = persistArtifact(cfg, capsuleBytes);
    const capsulePath = `.pi-memory/evidence/sha256/${capsuleArtifact.sha256.slice(0, 2)}/${capsuleArtifact.sha256}.json`;
    const summary = {
      schemaVersion: 1,
      decisionId,
      proposalId: input.proposalId,
      proposalSha256: input.proposalSha256,
      mutationId: input.mutationId,
      evaluatedAt: input.evaluatedAt,
      expiresAt: input.expiresAt,
      actor: input.actor,
      policyVersion: ADMISSION_POLICY_VERSION,
      basis: capsule.admission.basis,
      checks,
      evidenceCapsule: {
        relativePath: capsulePath,
        sha256: capsuleArtifact.sha256,
      },
    };
    const summaryBytes = `${canonicalJson(summary as unknown as JsonValue)}\n`;
    const summaryArtifact = persistArtifact(cfg, summaryBytes);
    result = {
      type: "merge-ready",
      evidenceCapsule: {
        relativePath: capsulePath,
        sha256: capsuleArtifact.sha256,
        artifact: capsuleArtifact,
      },
      acceptedSummary: {
        relativePath: `.pi-memory/admissions/sha256/${summaryArtifact.sha256.slice(0, 2)}/${summaryArtifact.sha256}.json`,
        sha256: summaryArtifact.sha256,
        artifact: summaryArtifact,
      },
    };
  }
  const decision: AdmissionDecision = {
    schemaVersion: 1,
    policyVersion: ADMISSION_POLICY_VERSION,
    decisionId,
    proposalId: input.proposalId,
    proposalSha256: input.proposalSha256,
    mutationId: input.mutationId,
    evaluatedAt: input.evaluatedAt,
    expiresAt: input.expiresAt,
    actor: input.actor,
    basis: input.basis,
    checks,
    result,
  };
  durableWrite(existingPath, `${JSON.stringify(decision, null, 2)}\n`);
  return decision;
}

export function parseAdmissionDecision(value: unknown): AdmissionDecision {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.policyVersion !== ADMISSION_POLICY_VERSION ||
    typeof value.decisionId !== "string" ||
    !/^adm_[a-f0-9]{32}$/.test(value.decisionId) ||
    typeof value.proposalId !== "string" ||
    typeof value.proposalSha256 !== "string" ||
    !HASH.test(value.proposalSha256) ||
    typeof value.mutationId !== "string" ||
    typeof value.actor !== "string" ||
    !object(value.basis) ||
    !object(value.checks) ||
    !object(value.result) ||
    (value.result.type !== "merge-ready" && value.result.type !== "closed")
  )
    throw new Error("invalid admission decision");
  timestamp(value.evaluatedAt, "admission evaluatedAt");
  timestamp(value.expiresAt, "admission expiresAt");
  return value as AdmissionDecision;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const join = (...paths: string[]) => nodePath.join(...paths);

  function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
    const afterContent = "# preference\n\nuse pnpm for this repository.\n";
    const startByte = Buffer.byteLength("# preference\n\n");
    const safeBytes = "the user said to use pnpm for this repository";
    return {
      proposalId: "prop_test",
      proposalSha256: sha256("proposal"),
      mutationId: "mut_test",
      actor: "local-cli",
      evaluatedAt: "2026-09-03T12:00:00.000Z",
      expiresAt: "2026-10-03T12:00:00.000Z",
      basis: {
        hostLocalSourceEvidence: [],
        catalogSha256: sha256("catalog"),
        targetHead: "a".repeat(40),
        promptPolicyVersion: 1,
        modelPolicyVersion: 1,
      },
      changes: [
        {
          path: "preference_source__agent.md",
          beforeSha256: null,
          afterContent,
          afterSha256: sha256(afterContent),
        },
      ],
      claims: [
        {
          claimId: "claim_one",
          path: "preference_source__agent.md",
          startByte,
          endByte: Buffer.byteLength(afterContent) - 1,
          textSha256: sha256("use pnpm for this repository."),
          epistemic: "user-statement",
          evidenceEntryIds: ["evidence_one"],
        },
      ],
      evidence: [
        {
          evidenceEntryId: "evidence_one",
          kind: "user-statement",
          representation: "exact-excerpt",
          safeBytes,
          safeBytesSha256: sha256(safeBytes),
          source: {
            kind: "pi-session-jsonl",
            identity: "session-one",
            observedAt: "2026-09-03T11:59:00.000Z",
            workspace: "/workspace",
            locator: "pi://session-one/checkpoint-one",
          },
          safetyTransformationVersion: 1,
        },
      ],
      ...overrides,
    };
  }

  describe("canonical admission", () => {
    it("binds safe claim-bearing evidence into a canonical capsule", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-admission-")) };
      const decision = evaluateAdmission(cfg, input());
      expect(decision.result.type).toBe("merge-ready");
      if (decision.result.type !== "merge-ready") return;
      const capsule = readFileSync(
        v3Data(cfg, decision.result.evidenceCapsule.artifact.relativePath),
        "utf8",
      );
      expect(sha256(capsule)).toBe(decision.result.evidenceCapsule.sha256);
      expect(capsule).toContain("use pnpm");
      expect(capsule).not.toContain("# preference");
      expect(evaluateAdmission(cfg, input())).toEqual(decision);
    });

    it.each([
      ["digest-only lineage", { evidence: [] }],
      [
        "secret",
        {
          evidence: [
            {
              ...input().evidence[0]!,
              safeBytes: "api_key=abcdefghijklmnopqrstuv",
              safeBytesSha256: sha256("api_key=abcdefghijklmnopqrstuv"),
            },
          ],
        },
      ],
      [
        "unmapped claim",
        { claims: [{ ...input().claims[0]!, evidenceEntryIds: ["missing"] }] },
      ],
    ])("closes admission for %s", (_name, override) => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-admission-")) };
      const candidate = input(override as Partial<AdmissionInput>);
      expect(evaluateAdmission(cfg, candidate).result.type).toBe("closed");
    });

    it.each([
      [
        "uncovered assertion",
        {
          changes: [
            {
              ...input().changes[0]!,
              afterContent:
                "# preference\n\nuse pnpm for this repository.\nnever use npm.\n",
              afterSha256: sha256(
                "# preference\n\nuse pnpm for this repository.\nnever use npm.\n",
              ),
            },
          ],
        },
      ],
      [
        "materially truncated evidence",
        {
          evidence: [
            {
              ...input().evidence[0]!,
              safeBytes: "the user said to use pnpm...",
              safeBytesSha256: sha256("the user said to use pnpm..."),
            },
          ],
        },
      ],
      [
        "epistemic promotion",
        {
          claims: [
            {
              ...input().claims[0]!,
              epistemic: "tool-observation" as const,
            },
          ],
        },
      ],
      [
        "complete memory body as evidence",
        {
          evidence: [
            {
              ...input().evidence[0]!,
              safeBytes: input().changes[0]!.afterContent!,
              safeBytesSha256: sha256(input().changes[0]!.afterContent!),
            },
          ],
        },
      ],
    ])("closes admission for %s", (_name, overrides) => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-admission-")) };
      expect(
        evaluateAdmission(cfg, input(overrides as Partial<AdmissionInput>))
          .result.type,
      ).toBe("closed");
    });

    it("does not depend on retrieval evaluation", () => {
      const cfg = { data: mkdtempSync(join(tmpdir(), "pi-memory-admission-")) };
      expect(evaluateAdmission(cfg, input()).result.type).toBe("merge-ready");
    });
  });
}
