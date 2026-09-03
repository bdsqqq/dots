import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import { durableWrite, object, v3Data, v3State } from "./common.js";
import { readMaintenanceDemand } from "./demand.js";
import { AXIOM_DATASET_POLICY } from "./policy.js";
import { verifyQmdSource } from "./projection.js";
import { listWorkflows } from "./workflows.js";

type HealthStatus = "healthy" | "degraded" | "unknown";
type HealthDimension = { status: HealthStatus; reasons: string[] };

export type MaintainerHealth = {
  schemaVersion: 3;
  asOf: string;
  overall: HealthStatus | "blocked";
  authority: HealthDimension & {
    remoteHead: string | null;
    localCheckoutHead: string | null;
    lastVerifiedAt: string | null;
    remoteAgeMs: number | null;
    pendingMerges: number;
    nonFastForwardRetries: number;
    blockedChangedTargets: number;
    syncthingConflicts: number;
  };
  completeness: HealthDimension & {
    sourceRecords: number;
    activeSources: number;
    missingSources: number;
    quarantinedSources: number;
    invalidSourceRecords: number;
    discoveryCursors: number;
    oldestDiscoveryCursorAgeMs: number | null;
    uninspectedRoots: number;
  };
  integrity: HealthDimension & {
    blockedWorkflows: number;
    failedWorkflows: number;
    verifiedV3Commits: number;
    legacyUnverifiedCommits: number;
    closedAdmissions: number;
    invalidWorkflowStore: boolean;
  };
  activity: HealthDimension & {
    demandGeneration: number;
    satisfiedThrough: number;
    nonterminalWorkflows: number;
    completedWorkflows: number;
    retriedWorkflows: number;
    expiredWorkflows: number;
    proposals: { pending: number; reviewed: number; expired: number };
    admissions: number;
    acceptedMerges: number;
  };
  operational: HealthDimension & {
    ready: number;
    leased: number;
    waiting: number;
    retries: number;
    oldestReadyAgeMs: number | null;
    expiredLeases: number;
    queueByPriority: Record<string, number>;
    failureCodes: Record<string, number>;
    lastRunAt: string | null;
    lastRunWallMs: number | null;
    lastRunCpuMs: number | null;
    modelCalls: number | null;
  };
  retrieval: HealthDimension & {
    qmdHead: string | null;
    documents: number;
    pairedReplayReports: number;
    retrievalLabels: number;
    taskDelta: number | null;
    promptBudgetEffects: number | null;
    usefulness: "diagnostic-not-admission";
  };
  telemetry: HealthDimension & {
    dataset: string;
    retention: string;
    authority: string;
    droppedFiles: number;
    droppedBytes: number;
    localBytes: number;
    oldestEventAgeMs: number | null;
    pendingMarkers: number;
    collectorCheckpointAt: string | null;
    lastAxiomCanaryAt: string | null;
  };
  cleanup: HealthDimension & {
    lastReportAt: string | null;
    deletionActivated: boolean;
    reportOnly: boolean;
    protectedArtifacts: number;
    capsuleReachabilityBlockers: number;
    eligibleRecords: number;
    eligibleBytes: number;
    failed: number;
  };
  evidence: {
    health: string;
    historyVerification: string;
    qmdManifest: string;
    cleanupReport: string;
    telemetryGap: string;
  };
  canonicalRetention: "indefinite-git-history";
};

type HealthConfig = Pick<MemoryConfig, "data" | "state"> & {
  sessions?: string[];
  root?: string;
};

function dimension(reasons: string[], missing = false): HealthDimension {
  return {
    status: missing ? "unknown" : reasons.length ? "degraded" : "healthy",
    reasons: reasons.slice(0, 32),
  };
}

function json(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return object(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function files(root: string, suffix = ""): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
      else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
        result.push(path);
      if (result.length >= 10_000) return;
    }
  };
  visit(root);
  return result;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildMaintainerHealth(
  cfg: HealthConfig,
  options: {
    remoteHead?: string;
    remoteCheckedAt?: string;
    logDirectory?: string;
    clock?: () => Date;
  } = {},
): MaintainerHealth {
  const now = (options.clock ?? (() => new Date()))();
  const checkout = json(v3State(cfg, "checkout/current.json"));
  const localCheckoutHead =
    typeof checkout?.head === "string" ? checkout.head : null;
  const lastVerifiedAt =
    typeof checkout?.verifiedAt === "string" ? checkout.verifiedAt : null;
  const remoteHead = options.remoteHead ?? null;
  const authorityReasons: string[] = [];
  if (remoteHead && localCheckoutHead && remoteHead !== localCheckoutHead)
    authorityReasons.push("local-checkout-lags-remote");
  if (
    options.remoteCheckedAt &&
    now.getTime() - Date.parse(options.remoteCheckedAt) > 2 * 60 * 60_000
  )
    authorityReasons.push("remote-check-stale");
  let invalidWorkflowStore = false;
  let all: ReturnType<typeof listWorkflows> = [];
  try {
    all = listWorkflows(cfg);
  } catch {
    invalidWorkflowStore = true;
  }
  const blocked = all.filter((item) => item.state.type === "blocked");
  const failed = all.filter((item) => item.state.type === "failed");
  const blockedChangedTargets = blocked.filter(
    (item) =>
      item.state.type === "blocked" &&
      item.state.error.code === "basis-changed",
  ).length;
  const pendingMerges = files(
    v3Data(cfg, "history-candidates"),
    ".json",
  ).length;
  const sourcePaths = files(v3Data(cfg, "sources/records"), ".json");
  const sourceValues = sourcePaths.flatMap((path) => {
    const value = json(path);
    return value ? [value] : [];
  });
  const invalidSourceRecords = sourcePaths.length - sourceValues.length;
  const activeSources = sourceValues.filter(
    (value) => object(value.state) && value.state.type === "active",
  ).length;
  const missingSources = sourceValues.filter(
    (value) => object(value.state) && value.state.type === "missing",
  ).length;
  const quarantinedSources = sourceValues.filter(
    (value) => object(value.state) && value.state.type === "quarantined",
  ).length;
  const discoveryCursors = files(v3Data(cfg, "sources/discovery"), ".json");
  const oldestDiscoveryCursor = discoveryCursors
    .map((path) => statSync(path).mtimeMs)
    .sort((left, right) => left - right)[0];
  const historyVerification = json(v3State(cfg, "history/verified.json"));
  const historyAudit = object(historyVerification?.audit)
    ? historyVerification.audit
    : undefined;
  const verifiedV3Commits = numeric(historyAudit?.verifiedV3);
  const legacyUnverifiedCommits = numeric(historyAudit?.legacyUnverified);
  const integrityReasons = [
    ...(blocked.length ? ["blocked-workflows"] : []),
    ...(failed.length ? ["failed-workflows"] : []),
    ...(quarantinedSources ? ["quarantined-sources"] : []),
    ...(invalidSourceRecords ? ["invalid-source-records"] : []),
    ...(invalidWorkflowStore ? ["invalid-workflow-store"] : []),
    ...(remoteHead && historyVerification?.head !== remoteHead
      ? ["canonical-history-not-verified-at-remote-head"]
      : []),
  ];
  const nonterminal = all.filter(
    (item) =>
      item.state.type !== "succeeded" &&
      item.state.type !== "failed" &&
      item.state.type !== "cancelled" &&
      item.state.type !== "expired",
  );
  let demand: ReturnType<typeof readMaintenanceDemand>;
  try {
    demand = readMaintenanceDemand(cfg);
  } catch {
    integrityReasons.push("invalid-demand-record");
  }
  const admissionValues = files(v3Data(cfg, "admissions"), ".json").flatMap(
    (path) => {
      const value = json(path);
      return value ? [value] : [];
    },
  );
  const closedAdmissions = admissionValues.filter(
    (value) => object(value.result) && value.result.type === "closed",
  ).length;
  if (closedAdmissions) integrityReasons.push("closed-admissions");
  const proposalValues = files(
    v3Data(cfg, "indexes/proposals"),
    ".json",
  ).flatMap((path) => {
    const value = json(path);
    return value ? [value] : [];
  });
  const proposalCounts = {
    pending: proposalValues.filter((value) => value.state === "pending").length,
    reviewed: proposalValues.filter((value) => value.state === "reviewed")
      .length,
    expired: proposalValues.filter((value) => value.state === "expired").length,
  };
  const acceptedMerges = files(
    v3Data(cfg, "indexes/accepted-receipts"),
    ".json",
  ).length;
  let qmdHead: string | null = null;
  let documents = 0;
  const retrievalReasons: string[] = [];
  try {
    const qmd = verifyQmdSource(cfg);
    qmdHead = qmd.canonicalHead;
    documents = qmd.files.length;
    if (localCheckoutHead && qmdHead !== localCheckoutHead)
      retrievalReasons.push("qmd-source-lags-checkout");
  } catch {
    retrievalReasons.push("qmd-source-unverified");
  }
  const logDirectory =
    options.logDirectory ??
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "pi/logs",
    );
  const gap = json(join(logDirectory, "telemetry-gap.json"));
  const droppedFiles =
    typeof gap?.droppedFiles === "number" ? gap.droppedFiles : 0;
  const droppedBytes =
    typeof gap?.droppedBytes === "number" ? gap.droppedBytes : 0;
  const cleanupReport = json(v3Data(cfg, "retention/latest-report.json"));
  const lastRun = json(v3State(cfg, "runtime/last-run.json"));
  const eventFiles = existsSync(logDirectory)
    ? readdirSync(logDirectory)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(logDirectory, name))
    : [];
  const localBytes = eventFiles.reduce(
    (sum, path) => sum + statSync(path).size,
    0,
  );
  const oldestEvent = eventFiles
    .map((path) => statSync(path).mtimeMs)
    .sort((left, right) => left - right)[0];
  const pendingMarkers = files(join(logDirectory, "pending"), ".json").length;
  const collector = json(v3State(cfg, "telemetry/collector.json"));
  const canary = json(v3State(cfg, "telemetry/axiom-canary.json"));
  const collectorCheckpointAt =
    typeof collector?.checkpointAt === "string" ? collector.checkpointAt : null;
  const lastAxiomCanaryAt =
    typeof canary?.verifiedAt === "string" ? canary.verifiedAt : null;
  const oldestReady = all
    .flatMap((item) =>
      item.state.type === "ready"
        ? [Math.max(0, now.getTime() - Date.parse(item.createdAt))]
        : [],
    )
    .sort((left, right) => right - left)[0];
  const expiredLeases = all.filter(
    (item) =>
      item.state.type === "leased" &&
      item.state.lease.expiresAt <= now.toISOString(),
  ).length;
  const cleanupEligible = numeric(cleanupReport?.eligibleRecords);
  const cleanupBytes = numeric(cleanupReport?.eligibleBytes);
  const cleanupFailed = Array.isArray(cleanupReport?.failed)
    ? cleanupReport.failed.length
    : 0;
  const runtimeSlices = Array.isArray(lastRun?.slices)
    ? lastRun.slices.filter(object)
    : [];
  const replayReports = files(join(cfg.data, "v2/eval/replays"), "report.json");
  const retrievalLabels = files(join(cfg.data, "v2/feedback"), ".json").length;
  const syncthingConflicts = cfg.root
    ? files(cfg.root).filter((path) =>
        /(?:^|\.)sync-conflict-/i.test(basename(path)),
      ).length
    : 0;
  if (syncthingConflicts)
    authorityReasons.push("syncthing-canonical-conflicts");
  const uninspectedRoots =
    cfg.sessions?.filter((root) => !existsSync(root)).length ?? 0;
  const retryFailures = all.flatMap((item) =>
    item.state.type === "retry-scheduled" ? [item.state.error] : [],
  );
  const workflowFailures = all.flatMap((item) =>
    item.state.type === "retry-scheduled" ||
    item.state.type === "blocked" ||
    item.state.type === "failed"
      ? [item.state.error.code]
      : [],
  );
  const queueByPriority = countBy(nonterminal.map((item) => item.priority));
  const historyMissing =
    !historyVerification ||
    (remoteHead !== null && historyVerification.head !== remoteHead);
  const report: MaintainerHealth = {
    schemaVersion: 3,
    asOf: now.toISOString(),
    overall: "unknown",
    authority: {
      ...dimension(
        authorityReasons,
        !remoteHead || !localCheckoutHead || !options.remoteCheckedAt,
      ),
      remoteHead,
      localCheckoutHead,
      lastVerifiedAt,
      remoteAgeMs: lastVerifiedAt
        ? Math.max(0, now.getTime() - Date.parse(lastVerifiedAt))
        : null,
      pendingMerges,
      nonFastForwardRetries: retryFailures.filter((failure) =>
        /remote-race|non-fast-forward/.test(failure.reason),
      ).length,
      blockedChangedTargets,
      syncthingConflicts,
    },
    completeness: {
      ...dimension(
        [
          ...(quarantinedSources ? ["quarantined-sources"] : []),
          ...(invalidSourceRecords ? ["invalid-source-records"] : []),
          ...(uninspectedRoots ? ["uninspected-source-roots"] : []),
        ],
        !existsSync(v3Data(cfg, "migration/v2-import-report.json")),
      ),
      sourceRecords: sourceValues.length,
      activeSources,
      missingSources,
      quarantinedSources,
      invalidSourceRecords,
      discoveryCursors: discoveryCursors.length,
      oldestDiscoveryCursorAgeMs:
        oldestDiscoveryCursor === undefined
          ? null
          : Math.max(0, now.getTime() - oldestDiscoveryCursor),
      uninspectedRoots,
    },
    integrity: {
      ...dimension(integrityReasons, historyMissing),
      blockedWorkflows: blocked.length,
      failedWorkflows: failed.length,
      verifiedV3Commits,
      legacyUnverifiedCommits,
      closedAdmissions,
      invalidWorkflowStore,
    },
    activity: {
      ...dimension([], !demand),
      demandGeneration: demand?.generation ?? 0,
      satisfiedThrough: demand?.satisfiedThrough ?? 0,
      nonterminalWorkflows: nonterminal.length,
      completedWorkflows: all.filter((item) => item.state.type === "succeeded")
        .length,
      retriedWorkflows: all.filter(
        (item) => item.state.type === "retry-scheduled",
      ).length,
      expiredWorkflows: all.filter((item) => item.state.type === "expired")
        .length,
      proposals: proposalCounts,
      admissions: admissionValues.length,
      acceptedMerges,
    },
    operational: {
      ...dimension(
        all.some((item) => item.state.type === "leased")
          ? ["active-leases"]
          : [],
        !lastRun ? true : invalidWorkflowStore,
      ),
      ready: all.filter((item) => item.state.type === "ready").length,
      leased: all.filter((item) => item.state.type === "leased").length,
      waiting: all.filter((item) => item.state.type === "waiting").length,
      retries: all.filter((item) => item.state.type === "retry-scheduled")
        .length,
      oldestReadyAgeMs: oldestReady ?? null,
      expiredLeases,
      queueByPriority,
      failureCodes: countBy(workflowFailures),
      lastRunAt:
        typeof lastRun?.completedAt === "string" ? lastRun.completedAt : null,
      lastRunWallMs: lastRun
        ? runtimeSlices.reduce(
            (sum, slice) => sum + numeric(slice.elapsedMs),
            0,
          )
        : null,
      lastRunCpuMs: lastRun
        ? runtimeSlices.reduce((sum, slice) => sum + numeric(slice.cpuMs), 0)
        : null,
      modelCalls:
        typeof lastRun?.modelOutputsCompleted === "number"
          ? lastRun.modelOutputsCompleted
          : null,
    },
    retrieval: {
      ...dimension(retrievalReasons, !qmdHead),
      qmdHead,
      documents,
      pairedReplayReports: replayReports.length,
      retrievalLabels,
      taskDelta: null,
      promptBudgetEffects: null,
      usefulness: "diagnostic-not-admission",
    },
    telemetry: {
      ...dimension(
        [
          ...(droppedFiles ? ["local-hard-cap-eviction"] : []),
          ...(pendingMarkers ? ["pending-operation-markers"] : []),
          ...(!collectorCheckpointAt
            ? ["collector-checkpoint-unavailable"]
            : []),
          ...(!lastAxiomCanaryAt ? ["axiom-canary-unverified"] : []),
        ],
        !existsSync(logDirectory),
      ),
      dataset: AXIOM_DATASET_POLICY.dataset,
      retention: AXIOM_DATASET_POLICY.retention,
      authority: AXIOM_DATASET_POLICY.authority,
      droppedFiles,
      droppedBytes,
      localBytes,
      oldestEventAgeMs:
        oldestEvent === undefined
          ? null
          : Math.max(0, now.getTime() - oldestEvent),
      pendingMarkers,
      collectorCheckpointAt,
      lastAxiomCanaryAt,
    },
    cleanup: {
      ...dimension(cleanupFailed ? ["cleanup-failures"] : [], !cleanupReport),
      lastReportAt:
        typeof cleanupReport?.createdAt === "string"
          ? cleanupReport.createdAt
          : null,
      deletionActivated: cleanupReport?.activated === true,
      reportOnly: cleanupReport?.activated !== true,
      protectedArtifacts: numeric(cleanupReport?.protectedArtifactCount),
      capsuleReachabilityBlockers: numeric(
        cleanupReport?.capsuleReachabilityBlockers,
      ),
      eligibleRecords: cleanupEligible,
      eligibleBytes: cleanupBytes,
      failed: cleanupFailed,
    },
    evidence: {
      health: v3State(cfg, "health/latest.json"),
      historyVerification: v3State(cfg, "history/verified.json"),
      qmdManifest: v3Data(cfg, "projections/qmd-source-manifest.json"),
      cleanupReport: v3Data(cfg, "retention/latest-report.json"),
      telemetryGap: join(logDirectory, "telemetry-gap.json"),
    },
    canonicalRetention: "indefinite-git-history",
  };
  const dimensions = [
    report.authority,
    report.completeness,
    report.integrity,
    report.activity,
    report.operational,
    report.retrieval,
    report.telemetry,
    report.cleanup,
  ];
  report.overall = blocked.length
    ? "blocked"
    : dimensions.some((item) => item.status === "unknown")
      ? "unknown"
      : dimensions.some((item) => item.status === "degraded")
        ? "degraded"
        : "healthy";
  durableWrite(
    v3State(cfg, "health/latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  describe("maintainer health", () => {
    it("reports missing authority as unknown instead of green", () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-health-"));
      const report = buildMaintainerHealth(
        { data: join(base, "data"), state: join(base, "state") },
        { clock: () => new Date("2026-09-03T12:00:00.000Z") },
      );
      expect(report.authority.status).toBe("unknown");
      expect(report.retrieval.status).toBe("unknown");
      expect(report.activity.status).toBe("unknown");
    });

    it("keeps telemetry gaps separate from domain health", () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-health-"));
      const logs = join(base, "logs");
      mkdirSync(logs);
      writeFileSync(
        join(logs, "telemetry-gap.json"),
        JSON.stringify({ droppedFiles: 2, droppedBytes: 100 }),
      );
      const report = buildMaintainerHealth(
        { data: join(base, "data"), state: join(base, "state") },
        {
          logDirectory: logs,
          clock: () => new Date("2026-09-03T12:00:00.000Z"),
        },
      );
      expect(report.telemetry).toMatchObject({
        status: "degraded",
        droppedFiles: 2,
        retention: "inherited-account-policy",
      });
      expect(report.integrity.status).toBe("unknown");
      expect(report.overall).toBe("unknown");
      expect(report.canonicalRetention).toBe("indefinite-git-history");
    });

    it("reports corrupt workflow state instead of failing health generation", () => {
      const base = mkdtempSync(join(tmpdir(), "pi-memory-health-"));
      const cfg = {
        data: join(base, "data"),
        state: join(base, "state"),
      };
      const ready = v3Data(cfg, "workflows/ready");
      mkdirSync(ready, { recursive: true });
      writeFileSync(join(ready, "wf_corrupt.json"), "{}\n");

      const report = buildMaintainerHealth(cfg, {
        clock: () => new Date("2026-09-03T12:00:00.000Z"),
      });

      expect(report.integrity).toMatchObject({
        status: "unknown",
        invalidWorkflowStore: true,
      });
      expect(report.integrity.reasons).toContain("invalid-workflow-store");
    });
  });
}
