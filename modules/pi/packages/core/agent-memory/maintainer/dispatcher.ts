import type { MemoryConfig } from "../catalog.js";
import { sha256, v3Data, withAsyncDirectoryLock } from "./common.js";
import {
  maintenanceWakePending,
  readMaintenanceDemand,
  satisfyMaintenanceDemand,
  type MaintenanceDemand,
} from "./demand.js";
import { RESOURCE_LIMITS } from "./policy.js";
import {
  claimWorkflow,
  createWorkflow,
  deterministicWorkflowId,
  listWorkflows,
  loadWorkflow,
  reconcileWorkflowStore,
  transitionWorkflow,
  type WorkflowFailure,
  type WorkflowKind,
  type WorkflowRecord,
  type WorkflowTransition,
} from "./workflows.js";

type DispatcherConfig = Pick<MemoryConfig, "data" | "state">;

export type WorkflowHandler = (
  workflow: WorkflowRecord,
) => Promise<WorkflowTransition> | WorkflowTransition;

export type DispatcherHandlers = Partial<Record<WorkflowKind, WorkflowHandler>>;

export type DispatchReport = {
  generation: number | null;
  workflowsCreated: number;
  workflowsClaimed: number;
  workflowsCompleted: number;
  workflowsSuspended: number;
  workflowsWaiting: number;
  workflowsFailed: number;
  demandSatisfied: boolean;
  workBoundaryReached: boolean;
  elapsedMs: number;
  cpuMs: number;
};

const scopeKind = (scope: string): WorkflowKind => {
  if (scope === "history" || scope === "checkout") return "history-sync";
  if (scope === "qmd") return "qmd-index";
  if (scope === "reflection") return "reflection";
  if (scope === "evaluation") return "evaluation";
  if (scope === "retention") return "retention";
  if (scope === "transactions") return "transaction-reconcile";
  if (scope === "proposals") return "proposal-reconcile";
  if (scope === "corpus") return "corpus-maintenance";
  return "source-reconcile";
};

function ensureDemandWorkflows(
  cfg: DispatcherConfig,
  demand: MaintenanceDemand,
): number {
  let created = 0;
  for (const scope of demand.scopes) {
    const kind = scopeKind(scope);
    const id = deterministicWorkflowId(
      kind,
      `${demand.generation}:${scope}`,
      new Date(demand.updatedAt),
    );
    try {
      loadWorkflow(cfg, id);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "workflow not found")
        throw error;
    }
    createWorkflow(
      cfg,
      {
        id,
        kind,
        priority: demand.priority,
        demandGeneration: demand.generation,
        basis: {
          scope,
          reasons: demand.reasons,
          sourceHints: demand.sourceHints,
          rootScanNeeded: demand.rootScanNeeded,
        },
        step: "reconcile",
        availableAt: demand.notBefore,
      },
      () => new Date(demand.updatedAt),
    );
    created += 1;
  }
  return created;
}

function unexpectedFailure(
  workflow: WorkflowRecord,
  error: unknown,
  now: Date,
): WorkflowFailure {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: "unexpected",
    step: workflow.state.type === "leased" ? workflow.state.step : "dispatcher",
    observedAt: now.toISOString(),
    reason: reason.slice(0, 500) || "unknown dispatcher failure",
    retryable: false,
    basisRevision: workflow.revision,
    evidence: [],
    fingerprint: sha256(reason),
  };
}

export async function dispatchSlice(
  cfg: DispatcherConfig,
  handlers: DispatcherHandlers,
  options: {
    owner?: string;
    clock?: () => Date;
    maxWorkflows?: number;
    maxWallMs?: number;
    maxCpuMs?: number;
  } = {},
): Promise<DispatchReport> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  const startedCpu = process.cpuUsage();
  reconcileWorkflowStore(cfg, clock);
  const demand = readMaintenanceDemand(cfg);
  const report: DispatchReport = {
    generation: demand?.generation ?? null,
    workflowsCreated: 0,
    workflowsClaimed: 0,
    workflowsCompleted: 0,
    workflowsSuspended: 0,
    workflowsWaiting: 0,
    workflowsFailed: 0,
    demandSatisfied: false,
    workBoundaryReached: false,
    elapsedMs: 0,
    cpuMs: 0,
  };
  if (demand && demand.satisfiedThrough < demand.generation)
    report.workflowsCreated = ensureDemandWorkflows(cfg, demand);
  const maxWorkflows = Math.min(
    options.maxWorkflows ?? RESOURCE_LIMITS.maxWorkflowsPerSlice,
    RESOURCE_LIMITS.maxWorkflowsPerSlice,
  );
  const maxWallMs = Math.min(
    options.maxWallMs ?? RESOURCE_LIMITS.maxTurnWallMs,
    RESOURCE_LIMITS.maxTurnWallMs,
  );
  const maxCpuMs = Math.min(
    options.maxCpuMs ?? RESOURCE_LIMITS.maxTurnCpuMs,
    RESOURCE_LIMITS.maxTurnCpuMs,
  );
  const owner = options.owner ?? `dispatcher-${process.pid}`;
  for (let index = 0; index < maxWorkflows; index += 1) {
    const cpu = process.cpuUsage(startedCpu);
    if (
      clock().getTime() - startedAt.getTime() >= maxWallMs ||
      (cpu.user + cpu.system) / 1_000 >= maxCpuMs
    ) {
      report.workBoundaryReached = true;
      break;
    }
    let claimed: WorkflowRecord | undefined;
    try {
      claimed = claimWorkflow(cfg, { owner, clock });
    } catch (error) {
      if (error instanceof Error && error.message === "lock-contended") {
        report.workBoundaryReached = true;
        break;
      }
      throw error;
    }
    if (!claimed || claimed.state.type !== "leased") break;
    report.workflowsClaimed += 1;
    const token = claimed.state.lease.token;
    let transition: WorkflowTransition;
    try {
      const handler = handlers[claimed.kind];
      if (!handler) throw new Error(`no handler for ${claimed.kind}`);
      transition = await handler(claimed);
    } catch (error) {
      report.workflowsFailed += 1;
      transition = {
        type: "fail",
        error: unexpectedFailure(claimed, error, clock()),
        retainUntil: new Date(
          clock().getTime() + 30 * 86_400_000,
        ).toISOString(),
      };
    }
    transitionWorkflow(cfg, claimed.id, token, transition, clock);
    if (transition.type === "suspend") {
      report.workflowsSuspended += 1;
      report.workBoundaryReached = true;
    } else if (transition.type === "wait" || transition.type === "retry")
      report.workflowsWaiting += 1;
    else if (
      transition.type === "succeed" ||
      transition.type === "fail" ||
      transition.type === "cancel" ||
      transition.type === "block"
    )
      report.workflowsCompleted += 1;
    if (transition.type === "suspend") break;
  }
  const now = clock();
  const eligible = listWorkflows(cfg, ["ready", "leased"]).some(
    (record) =>
      record.state.type === "leased" ||
      (record.state.type === "ready" &&
        record.state.availableAt <= now.toISOString()),
  );
  report.demandSatisfied = demand
    ? satisfyMaintenanceDemand(cfg, demand.generation, {
        eligibleWorkRemains: eligible,
        suspended: report.workflowsSuspended > 0,
      })
    : false;
  report.elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
  const cpu = process.cpuUsage(startedCpu);
  report.cpuMs = (cpu.user + cpu.system) / 1_000;
  return report;
}

export async function invokeModelSingleton<T>(
  cfg: Pick<MemoryConfig, "data">,
  invocation: () => Promise<T>,
): Promise<{ type: "completed"; value: T } | { type: "busy" }> {
  try {
    const value = await withAsyncDirectoryLock(
      v3Data(cfg, "invocations/model.lock"),
      invocation,
      { staleMs: 10 * 60_000 },
    );
    return { type: "completed", value };
  } catch (error) {
    if (error instanceof Error && error.message === "lock-contended")
      return { type: "busy" };
    throw error;
  }
}

export function dispatcherPending(cfg: DispatcherConfig): boolean {
  return maintenanceWakePending(cfg);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const join = (...paths: string[]) => nodePath.join(...paths);
  const { requestMaintenance } = await import("./demand.js");

  const fixed = "2026-09-03T12:00:00.000Z";
  const later = "2026-09-03T12:00:01.000Z";
  const cfg = (): DispatcherConfig => {
    const base = mkdtempSync(join(tmpdir(), "pi-memory-dispatcher-"));
    return { data: join(base, "data"), state: join(base, "state") };
  };

  describe("v3 dispatcher", () => {
    it("turns duplicate dispatchers into one durable claim", async () => {
      const root = cfg();
      requestMaintenance(
        root,
        { reason: "test", scopes: ["sources"] },
        () => new Date(fixed),
      );
      let calls = 0;
      const handler: WorkflowHandler = async () => {
        calls += 1;
        await Promise.resolve();
        return {
          type: "succeed",
          outputs: [],
          retainUntil: "2026-10-03T12:00:00.000Z",
        };
      };
      const reports = await Promise.all([
        dispatchSlice(
          root,
          { "source-reconcile": handler },
          {
            owner: "one",
            clock: () => new Date(later),
          },
        ),
        dispatchSlice(
          root,
          { "source-reconcile": handler },
          {
            owner: "two",
            clock: () => new Date(later),
          },
        ),
      ]);
      expect(calls).toBe(1);
      expect(
        reports.reduce((sum, item) => sum + item.workflowsClaimed, 0),
      ).toBe(1);
      expect(listWorkflows(root, ["succeeded"])).toHaveLength(1);
    });

    it("persists waiting without occupying a worker", async () => {
      const root = cfg();
      requestMaintenance(
        root,
        { reason: "remote unavailable", scopes: ["history"] },
        () => new Date(fixed),
      );
      const report = await dispatchSlice(
        root,
        {
          "history-sync": () => ({
            type: "wait",
            step: "merge",
            wait: {
              type: "timer",
              resumeAt: "2026-09-03T12:05:00.000Z",
            },
            continuation: {
              ownerStep: "reconcile",
              version: 1,
              payload: { proposalId: "prop_wait" },
              payloadSha256: sha256('{"proposalId":"prop_wait"}'),
            },
            expiresAt: "2026-10-03T12:00:00.000Z",
          }),
        },
        { clock: () => new Date(later) },
      );
      expect(report.workflowsWaiting).toBe(1);
      expect(listWorkflows(root, ["leased"])).toHaveLength(0);
      expect(listWorkflows(root, ["waiting"])).toHaveLength(1);
    });

    it("suspends successfully at the finite cpu boundary", async () => {
      const root = cfg();
      requestMaintenance(
        root,
        { reason: "cpu boundary", scopes: ["sources"] },
        () => new Date(fixed),
      );
      const report = await dispatchSlice(
        root,
        {
          "source-reconcile": () => ({
            type: "succeed",
            outputs: [],
            retainUntil: "2026-10-03T12:00:00.000Z",
          }),
        },
        { clock: () => new Date(later), maxCpuMs: 0 },
      );
      expect(report).toMatchObject({
        workflowsClaimed: 0,
        workBoundaryReached: true,
        demandSatisfied: false,
      });
      expect(report.cpuMs).toBeGreaterThanOrEqual(0);
      expect(listWorkflows(root, ["ready"])).toHaveLength(1);
    });

    it("enforces one asynchronous model invocation per host", async () => {
      const root = cfg();
      let release!: () => void;
      let active = 0;
      let maximum = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = invokeModelSingleton(root, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return "first";
      });
      await Promise.resolve();
      const second = await invokeModelSingleton(root, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        active -= 1;
        return "second";
      });
      release();
      expect(second).toEqual({ type: "busy" });
      expect(await first).toEqual({ type: "completed", value: "first" });
      expect(maximum).toBe(1);
    });

    it("keeps later demand after an active slice", async () => {
      const root = cfg();
      requestMaintenance(
        root,
        { reason: "first", scopes: ["sources"] },
        () => new Date(fixed),
      );
      const report = await dispatchSlice(
        root,
        {
          "source-reconcile": () => {
            requestMaintenance(
              root,
              { reason: "later", scopes: ["qmd"] },
              () => new Date(later),
            );
            return {
              type: "succeed",
              outputs: [],
              retainUntil: "2026-10-03T12:00:00.000Z",
            };
          },
        },
        { clock: () => new Date(later) },
      );
      expect(report.demandSatisfied).toBe(false);
      expect(dispatcherPending(root)).toBe(true);
      expect(readMaintenanceDemand(root)?.generation).toBe(2);
    });
  });
}
