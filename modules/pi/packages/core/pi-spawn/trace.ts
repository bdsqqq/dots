import { channel } from "node:diagnostics_channel";
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";

export const SPAWN_TRACE_ENV = "PI_ACTIVITY_TRACE_BOOTSTRAP";
export const SPAWN_TRACE_CHANNEL = "bds.pi.spawn.bootstrap.v1";
export const INHERITED_FIELDS = [
  "workflowId",
  "workflowName",
  "businessContext",
  "parentSessionId",
  "parentActivityId",
  "parentRunId",
  "parentTurnId",
  "parentStep",
  "parentToolName",
  "parentSelectedProvider",
  "parentSelectedModel",
  "parentObservedProvider",
  "parentObservedModel",
] as const;
export type InheritedActivity = Partial<
  Record<(typeof INHERITED_FIELDS)[number], string>
>;
export interface SpawnTraceBootstrap {
  version: 1;
  targetSessionId: string;
  carrier: TelemetryCarrier;
  inherited: InheritedActivity;
}
export interface SpawnTraceRequest {
  parentSessionId: string;
  toolCallId: string;
  childSessionId: string;
  bootstrap?: string;
}

export function diagnosticId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:|/-]*$/.test(value) &&
    !value.includes("..")
    ? value
    : undefined;
}

/** Transport data is diagnostic only. Copy the allowlist, not arbitrary caller fields. */
export function parseSpawnTrace(
  value: string | undefined,
): SpawnTraceBootstrap | undefined {
  if (!value || value.length > 4096) return;
  try {
    const data = JSON.parse(value);
    if (
      data.version !== 1 ||
      !diagnosticId(data.targetSessionId) ||
      !data.carrier ||
      typeof data.carrier !== "object" ||
      Array.isArray(data.carrier) ||
      !data.inherited ||
      typeof data.inherited !== "object"
    )
      return;
    const keys = Object.keys(data.carrier);
    if (keys.length === 0 || keys.length > 8) return;
    const carrier: TelemetryCarrier = {};
    for (const key of keys) {
      if (
        !/^[a-zA-Z0-9_.-]{1,80}$/.test(key) ||
        !diagnosticId(data.carrier[key])
      )
        return;
      carrier[key] = data.carrier[key];
    }
    const inherited: InheritedActivity = {};
    for (const key of INHERITED_FIELDS) {
      const item = data.inherited[key];
      if (item === undefined) continue;
      if (key === "workflowName") {
        if (item !== "pi agent activity") return;
      } else if (key === "businessContext") {
        if (item !== "unavailable") return;
      } else if (!diagnosticId(item)) return;
      inherited[key] = item;
    }
    return {
      version: 1,
      targetSessionId: data.targetSessionId,
      carrier,
      inherited,
    };
  } catch {
    return;
  }
}

/** A synchronous process-local rendezvous works across separately built bundles.
 * It transmits no task or transcript, and requires an actually observed tool owner.
 */
export function spawnTraceBootstrap(
  owner: { sessionId?: string; toolCallId?: string } | undefined,
  childSessionId: string | undefined,
): string | undefined {
  if (!owner?.sessionId || !owner.toolCallId || !childSessionId) return;
  const request: SpawnTraceRequest = {
    parentSessionId: owner.sessionId,
    toolCallId: owner.toolCallId,
    childSessionId,
  };
  try {
    channel(SPAWN_TRACE_CHANNEL).publish(request);
    const parsed = parseSpawnTrace(request.bootstrap);
    return parsed?.targetSessionId === childSessionId
      ? JSON.stringify(parsed)
      : undefined;
  } catch {
    return;
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("rejects oversized or body-bearing propagation and strips unknown context", () => {
    expect(parseSpawnTrace("x".repeat(4097))).toBeUndefined();
    const valid = {
      version: 1,
      targetSessionId: "child",
      carrier: { opaque: "trace" },
      inherited: {
        workflowName: "pi agent activity",
        businessContext: "unavailable",
        prompt: "PRIVATE",
      },
    };
    expect(parseSpawnTrace(JSON.stringify(valid))?.inherited).toEqual({
      workflowName: "pi agent activity",
      businessContext: "unavailable",
    });
    expect(
      parseSpawnTrace(
        JSON.stringify({ ...valid, carrier: { opaque: "/private/path" } }),
      ),
    ).toBeUndefined();
  });
}
