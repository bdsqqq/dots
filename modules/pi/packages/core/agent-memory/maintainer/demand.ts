import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  boundedString,
  durableCreate,
  durableWrite,
  object,
  timestamp,
  v3State,
  withDirectoryLock,
} from "./common.js";
import { RESOURCE_LIMITS } from "./policy.js";

export const DEMAND_PRIORITIES = [
  "background",
  "normal",
  "interactive",
  "integrity",
] as const;
export type DemandPriority = (typeof DEMAND_PRIORITIES)[number];

export type MaintenanceDemand = {
  schemaVersion: 3;
  generation: number;
  satisfiedThrough: number;
  reasons: string[];
  scopes: string[];
  sourceHints: string[];
  rootScanNeeded: boolean;
  priority: DemandPriority;
  notBefore: string;
  updatedAt: string;
};

export type MaintenanceRequest = {
  reason: string;
  scopes: string[];
  sourceHints?: string[];
  priority?: DemandPriority;
  notBefore?: string;
};

type DemandRoot = Pick<MemoryConfig, "state">;

const demandPath = (cfg: DemandRoot): string =>
  v3State(cfg, "demand/current.json");
const wakePath = (cfg: DemandRoot): string => v3State(cfg, "demand/wake");
const lockPath = (cfg: DemandRoot): string => v3State(cfg, "demand/.lock");

function sortedUnique(values: string[], name: string): string[] {
  return [
    ...new Set(values.map((value) => boundedString(value, name, 500))),
  ].sort();
}

export function parseMaintenanceDemand(value: unknown): MaintenanceDemand {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !Number.isSafeInteger(value.satisfiedThrough) ||
    Number(value.satisfiedThrough) < 0 ||
    Number(value.satisfiedThrough) > Number(value.generation) ||
    !Array.isArray(value.reasons) ||
    !Array.isArray(value.scopes) ||
    !Array.isArray(value.sourceHints) ||
    value.reasons.length > 64 ||
    value.scopes.length > 64 ||
    value.sourceHints.length > RESOURCE_LIMITS.maxSourceHints ||
    typeof value.rootScanNeeded !== "boolean" ||
    typeof value.priority !== "string" ||
    !DEMAND_PRIORITIES.includes(value.priority as DemandPriority)
  )
    throw new Error("invalid maintenance demand");
  sortedUnique(value.reasons as string[], "demand reason");
  sortedUnique(value.scopes as string[], "demand scope");
  sortedUnique(value.sourceHints as string[], "source hint");
  timestamp(value.notBefore, "demand notBefore");
  timestamp(value.updatedAt, "demand updatedAt");
  return value as MaintenanceDemand;
}

export function readMaintenanceDemand(
  cfg: DemandRoot,
): MaintenanceDemand | undefined {
  if (!existsSync(demandPath(cfg))) return undefined;
  return parseMaintenanceDemand(
    JSON.parse(readFileSync(demandPath(cfg), "utf8")),
  );
}

export function requestMaintenance(
  cfg: DemandRoot,
  request: MaintenanceRequest,
  clock: () => Date = () => new Date(),
): MaintenanceDemand {
  const reason = boundedString(request.reason, "demand reason", 500);
  const scopes = sortedUnique(request.scopes, "demand scope");
  if (scopes.length === 0) throw new Error("maintenance demand needs a scope");
  const hints = sortedUnique(request.sourceHints ?? [], "source hint");
  const priority = request.priority ?? "normal";
  if (!DEMAND_PRIORITIES.includes(priority))
    throw new Error("invalid demand priority");
  const now = clock().toISOString();
  const notBefore = request.notBefore ?? now;
  timestamp(notBefore, "demand notBefore");
  return withDirectoryLock(lockPath(cfg), () => {
    const current = readMaintenanceDemand(cfg);
    const combinedHints = sortedUnique(
      [...(current?.sourceHints ?? []), ...hints],
      "source hint",
    );
    const record: MaintenanceDemand = {
      schemaVersion: 3,
      generation: (current?.generation ?? 0) + 1,
      satisfiedThrough: current?.satisfiedThrough ?? 0,
      reasons: sortedUnique(
        [...(current?.reasons ?? []), reason].slice(-64),
        "demand reason",
      ),
      scopes: sortedUnique(
        [...(current?.scopes ?? []), ...scopes].slice(-64),
        "demand scope",
      ),
      sourceHints: combinedHints.slice(0, RESOURCE_LIMITS.maxSourceHints),
      rootScanNeeded:
        (current?.rootScanNeeded ?? false) ||
        combinedHints.length > RESOURCE_LIMITS.maxSourceHints,
      priority:
        DEMAND_PRIORITIES[
          Math.max(
            DEMAND_PRIORITIES.indexOf(current?.priority ?? "background"),
            DEMAND_PRIORITIES.indexOf(priority),
          )
        ]!,
      notBefore:
        current && current.satisfiedThrough < current.generation
          ? current.notBefore < notBefore
            ? current.notBefore
            : notBefore
          : notBefore,
      updatedAt: now,
    };
    durableWrite(demandPath(cfg), `${JSON.stringify(record, null, 2)}\n`);
    durableCreate(wakePath(cfg), `${record.generation}\n`);
    return record;
  });
}

export function satisfyMaintenanceDemand(
  cfg: DemandRoot,
  generation: number,
  options: { eligibleWorkRemains: boolean; suspended: boolean },
): boolean {
  return withDirectoryLock(lockPath(cfg), () => {
    const current = readMaintenanceDemand(cfg);
    if (
      !current ||
      current.generation !== generation ||
      options.eligibleWorkRemains ||
      options.suspended
    )
      return false;
    const next = { ...current, satisfiedThrough: generation };
    durableWrite(demandPath(cfg), `${JSON.stringify(next, null, 2)}\n`);
    rmSync(wakePath(cfg), { force: true });
    return true;
  });
}

export function maintenanceWakePending(cfg: DemandRoot): boolean {
  const demand = readMaintenanceDemand(cfg);
  return (
    existsSync(wakePath(cfg)) ||
    (!!demand && demand.satisfiedThrough < demand.generation)
  );
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const cfg = (): DemandRoot => ({
    state: join(mkdtempSync(join(tmpdir(), "pi-memory-demand-")), "state"),
  });
  const clock = () => new Date("2026-09-03T12:00:00.000Z");

  describe("v3 maintenance demand", () => {
    it("coalesces a trigger storm without losing later generations", () => {
      const root = cfg();
      for (let index = 0; index < 1_000; index++)
        requestMaintenance(
          root,
          {
            reason: `reason-${index % 4}`,
            scopes: [index % 2 ? "sources" : "history"],
            sourceHints: [`source-${index}`],
            priority: index === 999 ? "integrity" : "normal",
          },
          clock,
        );
      const demand = readMaintenanceDemand(root)!;
      expect(demand).toMatchObject({
        generation: 1_000,
        priority: "integrity",
        rootScanNeeded: true,
        scopes: ["history", "sources"],
      });
      expect(demand.sourceHints).toHaveLength(RESOURCE_LIMITS.maxSourceHints);
      expect(
        satisfyMaintenanceDemand(root, 999, {
          eligibleWorkRemains: false,
          suspended: false,
        }),
      ).toBe(false);
      expect(maintenanceWakePending(root)).toBe(true);
      expect(
        satisfyMaintenanceDemand(root, 1_000, {
          eligibleWorkRemains: false,
          suspended: false,
        }),
      ).toBe(true);
      expect(maintenanceWakePending(root)).toBe(false);
    });

    it("keeps wake truthful across a suspended slice", () => {
      const root = cfg();
      const demand = requestMaintenance(
        root,
        { reason: "append", scopes: ["sources"] },
        clock,
      );
      expect(
        satisfyMaintenanceDemand(root, demand.generation, {
          eligibleWorkRemains: false,
          suspended: true,
        }),
      ).toBe(false);
      expect(maintenanceWakePending(root)).toBe(true);
    });
  });
}
