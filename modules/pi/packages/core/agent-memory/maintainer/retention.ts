import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  durableWrite,
  object,
  safeRelativePath,
  sha256,
  v3Data,
  v3State,
} from "./common.js";
import { listWorkflows, type ArtifactRef } from "./workflows.js";

type RetentionConfig = Pick<MemoryConfig, "data" | "state">;

type CleanupClass =
  | "terminal-workflow"
  | "terminal-proposal"
  | "model"
  | "replay"
  | "projection"
  | "index"
  | "artifact";

export type RetentionReport = {
  schemaVersion: 3;
  createdAt: string;
  activated: boolean;
  truncated: boolean;
  protectedArtifactCount: number;
  capsuleReachabilityBlockers: number;
  terminalWorkflowCandidates: string[];
  artifactCandidates: string[];
  candidatesByClass: Record<CleanupClass, string[]>;
  eligibleRecords: number;
  eligibleBytes: number;
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
  policies: {
    terminalLocalDays: number;
    reportOnly: boolean;
    localTelemetry: "hard-cap-owned-by-logger";
    canonicalHistory: "never-eligible";
  };
  invariant: "canonical-history-never-local-cleanup-eligible";
};

const MAX_RECORDS_PER_PASS = 10_000;

function collectRefs(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, result));
    return;
  }
  if (!object(value)) return;
  if (
    typeof value.relativePath === "string" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    try {
      result.add(safeRelativePath(value.relativePath));
    } catch {}
  }
  if (typeof value.stablePath === "string")
    try {
      result.add(safeRelativePath(value.stablePath));
    } catch {}
  Object.values(value).forEach((item) => collectRefs(item, result));
}

function jsonFiles(
  root: string,
  limit: number,
  result: string[] = [],
): string[] {
  if (!existsSync(root) || result.length >= limit) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (result.length >= limit) break;
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      jsonFiles(path, limit, result);
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

function terminalExpired(
  workflow: ReturnType<typeof listWorkflows>[number],
  now: string,
): boolean {
  const state = workflow.state;
  return (
    (state.type === "succeeded" ||
      state.type === "failed" ||
      state.type === "cancelled" ||
      state.type === "expired") &&
    state.retainUntil <= now
  );
}

function activeReferences(
  cfg: RetentionConfig,
  now: string,
): {
  refs: Set<string>;
  truncated: boolean;
} {
  const refs = new Set<string>();
  for (const workflow of listWorkflows(cfg))
    if (!terminalExpired(workflow, now)) collectRefs(workflow, refs);
  const roots = [
    "history-candidates",
    "indexes/transactions/nonterminal",
    "sources/records",
  ];
  let count = 0;
  for (const root of roots)
    for (const path of jsonFiles(
      v3Data(cfg, root),
      MAX_RECORDS_PER_PASS - count,
    )) {
      count += 1;
      try {
        collectRefs(JSON.parse(readFileSync(path, "utf8")), refs);
      } catch {}
    }
  for (const path of jsonFiles(
    v3Data(cfg, "indexes/proposals"),
    MAX_RECORDS_PER_PASS - count,
  )) {
    count += 1;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        object(value) &&
        (value.state === "pending" ||
          (typeof value.expiresAt === "string" && value.expiresAt > now))
      )
        collectRefs(value, refs);
    } catch {}
  }
  const queue = [...refs];
  const expanded = new Set<string>();
  while (queue.length && count < MAX_RECORDS_PER_PASS) {
    const relativePath = queue.shift()!;
    if (expanded.has(relativePath)) continue;
    expanded.add(relativePath);
    count += 1;
    try {
      const value: unknown = JSON.parse(
        readFileSync(v3Data(cfg, relativePath), "utf8"),
      );
      const before = refs.size;
      collectRefs(value, refs);
      if (refs.size !== before)
        for (const discovered of refs)
          if (!expanded.has(discovered)) queue.push(discovered);
    } catch {}
  }
  return { refs, truncated: count >= MAX_RECORDS_PER_PASS };
}

function acceptedAuditDigests(cfg: RetentionConfig): Set<string> {
  const result = new Set<string>();
  if (!existsSync(v3State(cfg, "history/verified.json"))) return result;
  for (const path of jsonFiles(
    v3Data(cfg, "indexes/accepted-receipts"),
    MAX_RECORDS_PER_PASS,
  ))
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        receipt?: {
          admissionSummary?: { sha256?: string };
          evidenceCapsule?: { sha256?: string };
        };
      };
      for (const digest of [
        value.receipt?.admissionSummary?.sha256,
        value.receipt?.evidenceCapsule?.sha256,
      ])
        if (digest && /^[a-f0-9]{64}$/.test(digest)) result.add(digest);
    } catch {}
  return result;
}

type Candidate = { class: CleanupClass; path: string; absolutePath: string };

function expiredAt(value: unknown, field: string, now: Date): boolean {
  return (
    object(value) &&
    typeof value[field] === "string" &&
    Date.parse(String(value[field])) + 30 * 86_400_000 <= now.getTime()
  );
}

function addCandidate(
  result: Candidate[],
  cfg: RetentionConfig,
  className: CleanupClass,
  absolutePath: string,
): void {
  const v3Root = v3Data(cfg);
  result.push({
    class: className,
    path: relative(
      absolutePath.startsWith(`${v3Root}/`) ? v3Root : cfg.data,
      absolutePath,
    ).replaceAll("\\", "/"),
    absolutePath,
  });
}

function canonicalAuditArtifact(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (
      object(value) &&
      value.schemaVersion === 1 &&
      typeof value.mutationId === "string" &&
      typeof value.proposalSha256 === "string" &&
      (object(value.admission) || typeof value.decisionId === "string")
    );
  } catch {
    return false;
  }
}

function artifacts(cfg: RetentionConfig, limit: number): string[] {
  const root = v3Data(cfg, "artifacts/sha256");
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const shard of readdirSync(root).sort()) {
    if (result.length >= limit) break;
    const directory = join(root, shard);
    for (const name of readdirSync(directory).sort()) {
      if (result.length >= limit) break;
      if (/^[a-f0-9]{64}$/.test(name)) result.push(join(directory, name));
    }
  }
  return result;
}

export function reconcileRetention(
  cfg: RetentionConfig,
  options: { activate?: boolean; clock?: () => Date } = {},
): RetentionReport {
  const now = (options.clock ?? (() => new Date()))();
  const references = activeReferences(cfg, now.toISOString());
  const acceptedDigests = acceptedAuditDigests(cfg);
  const terminalWorkflowCandidates = listWorkflows(cfg, [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ])
    .filter((workflow) => {
      return terminalExpired(workflow, now.toISOString());
    })
    .slice(0, MAX_RECORDS_PER_PASS)
    .map((workflow) =>
      relative(
        v3Data(cfg),
        v3Data(cfg, "workflows", workflow.state.type, `${workflow.id}.json`),
      ),
    );
  const localArtifacts = artifacts(cfg, MAX_RECORDS_PER_PASS);
  const capsuleReachabilityBlockers = localArtifacts.filter(
    (path) =>
      canonicalAuditArtifact(path) &&
      !acceptedDigests.has(sha256(readFileSync(path))),
  ).length;
  const artifactCandidates = localArtifacts
    .filter((path) => {
      const relativePath = relative(v3Data(cfg), path);
      if (references.refs.has(relativePath)) return false;
      return (
        !canonicalAuditArtifact(path) ||
        acceptedDigests.has(sha256(readFileSync(path)))
      );
    })
    .map((path) => relative(v3Data(cfg), path));
  const candidates: Candidate[] = [];
  for (const path of terminalWorkflowCandidates)
    addCandidate(candidates, cfg, "terminal-workflow", v3Data(cfg, path));
  for (const path of artifactCandidates)
    addCandidate(candidates, cfg, "artifact", v3Data(cfg, path));

  for (const path of jsonFiles(
    v3Data(cfg, "indexes/proposals"),
    MAX_RECORDS_PER_PASS,
  ))
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !object(value) ||
        value.state === "pending" ||
        typeof value.proposalId !== "string" ||
        typeof value.expiresAt !== "string" ||
        value.expiresAt > now.toISOString()
      )
        continue;
      addCandidate(candidates, cfg, "index", path);
      const proposal = v3Data(
        cfg,
        `proposals/${String(value.state)}`,
        sha256(value.proposalId).slice(0, 2),
        `${value.proposalId}.json`,
      );
      if (existsSync(proposal))
        addCandidate(candidates, cfg, "terminal-proposal", proposal);
    } catch {}

  const activeInvocations = new Set(
    listWorkflows(cfg).flatMap((workflow) => {
      if (
        workflow.state.type === "waiting" &&
        (workflow.state.wait.type === "model-output" ||
          workflow.state.wait.type === "external-process")
      )
        return [workflow.state.wait.invocationId];
      return [];
    }),
  );
  for (const root of ["reflections/prepared", "reflections/outputs"])
    for (const path of jsonFiles(v3Data(cfg, root), MAX_RECORDS_PER_PASS))
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          object(value) &&
          typeof value.invocationId === "string" &&
          !activeInvocations.has(value.invocationId) &&
          (expiredAt(value, "preparedAt", now) ||
            expiredAt(value, "completedAt", now))
        )
          addCandidate(candidates, cfg, "model", path);
      } catch {}

  for (const path of jsonFiles(
    join(cfg.data, "v2/eval/replays"),
    MAX_RECORDS_PER_PASS,
  ))
    if (statSync(path).mtimeMs + 30 * 86_400_000 <= now.getTime())
      addCandidate(candidates, cfg, "replay", path);

  const projections = v3Data(cfg, "projections/sessions");
  if (existsSync(projections))
    for (const name of readdirSync(projections)) {
      const path = join(projections, name);
      const relativePath = relative(v3Data(cfg), path);
      if (
        name.endsWith(".md") &&
        !references.refs.has(relativePath) &&
        statSync(path).mtimeMs + 30 * 86_400_000 <= now.getTime()
      )
        addCandidate(candidates, cfg, "projection", path);
    }

  for (const path of jsonFiles(
    v3Data(cfg, "indexes/transactions/terminal"),
    MAX_RECORDS_PER_PASS,
  ))
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (expiredAt(value, "importedAt", now))
        addCandidate(candidates, cfg, "index", path);
    } catch {}

  const uniqueCandidates = [
    ...new Map(candidates.map((item) => [item.absolutePath, item])).values(),
  ];
  const eligibleBytes = uniqueCandidates.reduce(
    (sum, candidate) => sum + statSync(candidate.absolutePath).size,
    0,
  );
  const removed: string[] = [];
  const failed: RetentionReport["failed"] = [];
  if (options.activate && !references.truncated) {
    for (const candidate of uniqueCandidates) {
      try {
        rmSync(candidate.absolutePath, { force: true });
        removed.push(candidate.path);
      } catch (error) {
        failed.push({
          path: candidate.path,
          reason:
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
      }
    }
  }
  const candidatesByClass = Object.fromEntries(
    [
      "terminal-workflow",
      "terminal-proposal",
      "model",
      "replay",
      "projection",
      "index",
      "artifact",
    ].map((className) => [
      className,
      uniqueCandidates
        .filter((item) => item.class === className)
        .map((item) => item.path),
    ]),
  ) as Record<CleanupClass, string[]>;
  const report: RetentionReport = {
    schemaVersion: 3,
    createdAt: now.toISOString(),
    activated: options.activate === true && !references.truncated,
    truncated: references.truncated,
    protectedArtifactCount: references.refs.size,
    capsuleReachabilityBlockers,
    terminalWorkflowCandidates,
    artifactCandidates,
    candidatesByClass,
    eligibleRecords: uniqueCandidates.length,
    eligibleBytes,
    removed,
    failed,
    policies: {
      terminalLocalDays: 30,
      reportOnly: options.activate !== true,
      localTelemetry: "hard-cap-owned-by-logger",
      canonicalHistory: "never-eligible",
    },
    invariant: "canonical-history-never-local-cleanup-eligible",
  };
  durableWrite(
    v3Data(cfg, "retention/latest-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const {
    claimWorkflow,
    createWorkflow,
    deterministicWorkflowId,
    transitionWorkflow,
  } = await import("./workflows.js");

  function makeArtifact(cfg: RetentionConfig, value: string): ArtifactRef {
    const digest = sha256(value);
    const path = v3Data(cfg, "artifacts/sha256", digest.slice(0, 2), digest);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, value);
    return {
      relativePath: relative(v3Data(cfg), path),
      sha256: digest,
      bytes: Buffer.byteLength(value),
    };
  }

  describe("local retention", () => {
    it("requires activation and preserves every active-reference edge", () => {
      const cfg = {
        data: mkdtempSync(join(tmpdir(), "pi-memory-retention-")),
        state: mkdtempSync(join(tmpdir(), "pi-memory-retention-state-")),
      };
      const clock = () => new Date("2026-09-03T12:00:00.000Z");
      const expired = makeArtifact(cfg, "expired");
      const protectedArtifact = makeArtifact(cfg, "protected");
      const retainedTerminalArtifact = makeArtifact(cfg, "retained-terminal");
      const unreachableCapsule = makeArtifact(
        cfg,
        JSON.stringify({
          schemaVersion: 1,
          mutationId: "mut_unreachable",
          proposalSha256: sha256("proposal"),
          admission: {},
        }),
      );
      const terminal = createWorkflow(
        cfg,
        {
          id: deterministicWorkflowId("retention", "terminal", clock()),
          kind: "retention",
          priority: "background",
          demandGeneration: 1,
          basis: {},
          step: "cleanup",
        },
        clock,
      );
      const terminalClaim = claimWorkflow(cfg, { owner: "test", clock })!;
      transitionWorkflow(
        cfg,
        terminal.id,
        terminalClaim.state.type === "leased"
          ? terminalClaim.state.lease.token
          : "invalid",
        {
          type: "succeed",
          outputs: [expired],
          retainUntil: "2026-09-03T11:00:00.000Z",
        },
        clock,
      );
      const retained = createWorkflow(
        cfg,
        {
          id: deterministicWorkflowId("retention", "retained", clock()),
          kind: "retention",
          priority: "background",
          demandGeneration: 1,
          basis: {},
          step: "cleanup",
        },
        clock,
      );
      const retainedClaim = claimWorkflow(cfg, { owner: "test", clock })!;
      transitionWorkflow(
        cfg,
        retained.id,
        retainedClaim.state.type === "leased"
          ? retainedClaim.state.lease.token
          : "invalid",
        {
          type: "succeed",
          outputs: [retainedTerminalArtifact],
          retainUntil: "2026-10-03T12:00:00.000Z",
        },
        clock,
      );
      const blocked = createWorkflow(
        cfg,
        {
          id: deterministicWorkflowId("reflection", "blocked", clock()),
          kind: "reflection",
          priority: "normal",
          demandGeneration: 1,
          basis: {},
          step: "invoke",
        },
        clock,
      );
      const blockedClaim = claimWorkflow(cfg, { owner: "test", clock })!;
      transitionWorkflow(
        cfg,
        blocked.id,
        blockedClaim.state.type === "leased"
          ? blockedClaim.state.lease.token
          : "invalid",
        {
          type: "block",
          error: {
            code: "model-output-invalid",
            step: "invoke",
            observedAt: clock().toISOString(),
            reason: "invalid fixture output",
            retryable: false,
            basisRevision: 1,
            evidence: [protectedArtifact],
          },
          reviewBy: "2026-10-03T12:00:00.000Z",
          expiresAt: "2026-11-03T12:00:00.000Z",
        },
        clock,
      );
      const dry = reconcileRetention(cfg, { clock });
      expect(dry.activated).toBe(false);
      expect(dry.artifactCandidates).toContain(expired.relativePath);
      expect(dry.artifactCandidates).not.toContain(
        protectedArtifact.relativePath,
      );
      expect(dry.artifactCandidates).not.toContain(
        retainedTerminalArtifact.relativePath,
      );
      expect(dry.artifactCandidates).not.toContain(
        unreachableCapsule.relativePath,
      );
      expect(dry.capsuleReachabilityBlockers).toBe(1);
      expect(existsSync(v3Data(cfg, expired.relativePath))).toBe(true);
      const active = reconcileRetention(cfg, { activate: true, clock });
      expect(active.removed).toContain(expired.relativePath);
      expect(existsSync(v3Data(cfg, expired.relativePath))).toBe(false);
      expect(existsSync(v3Data(cfg, protectedArtifact.relativePath))).toBe(
        true,
      );
      expect(
        existsSync(v3Data(cfg, retainedTerminalArtifact.relativePath)),
      ).toBe(true);
      expect(existsSync(v3Data(cfg, unreachableCapsule.relativePath))).toBe(
        true,
      );
      expect(active.removed.some((path) => path.includes("history.git"))).toBe(
        false,
      );
    });
  });
}
