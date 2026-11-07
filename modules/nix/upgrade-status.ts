import { readFile } from "node:fs/promises";

export type UpgradePhase = "scheduled" | "resolving" | "building" | "activating" | "repairing" | "verifying" | "succeeded" | "partial" | "failed" | "blocked";
export type ComponentState = { status: "running" | "succeeded" | "failed" | "missing"; checkedAt: string; reasonCode: string };
export type UpgradeState = {
  schemaVersion: 1; host: string; operationId: string; phase: UpgradePhase;
  desiredRevision: string | null; appliedRevision: string | null;
  startedAt: string; phaseStartedAt: string; updatedAt: string;
  lastSuccessAt: string | null; nextAttemptAt: string | null;
  consecutiveFailures: number; reasonCode: string;
  buildTimeoutMs: number; activationWarnAfterMs: number;
  components: Record<string, ComponentState>;
  bootId: string | null;
  dependencyRepairAttempts: number;
};
export type UpgradeHealth = {
  checkedAt: string; status: "healthy" | "degraded" | "unknown"; reasonCode: string;
  phase: string; appliedRevision: string | null; desiredRevision: string | null; lastSuccessAt: string | null;
};
const phases = new Set<UpgradePhase>(["scheduled", "resolving", "building", "activating", "repairing", "verifying", "succeeded", "partial", "failed", "blocked"]);
const revision = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[a-f0-9]{40}$/.test(value));
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const symbol = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(value);

export function parseUpgradeState(value: unknown): UpgradeState {
  const s = value as UpgradeState;
  if (!s || s.schemaVersion !== 1 || !symbol(s.host) || !phases.has(s.phase)
    || typeof s.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(s.operationId)
    || !revision(s.desiredRevision) || !revision(s.appliedRevision)
    || !timestamp(s.startedAt) || !timestamp(s.phaseStartedAt) || !timestamp(s.updatedAt)
    || !(s.lastSuccessAt === null || timestamp(s.lastSuccessAt)) || !(s.nextAttemptAt === null || timestamp(s.nextAttemptAt))
    || !Number.isInteger(s.consecutiveFailures) || s.consecutiveFailures < 0 || !symbol(s.reasonCode)
    || !Number.isFinite(s.buildTimeoutMs) || s.buildTimeoutMs <= 0
    || !Number.isFinite(s.activationWarnAfterMs) || s.activationWarnAfterMs <= 0
    || !(s.bootId === undefined || s.bootId === null || (typeof s.bootId === "string" && /^[a-f0-9-]{36}$/i.test(s.bootId)))
    || !(s.dependencyRepairAttempts === undefined || (Number.isInteger(s.dependencyRepairAttempts) && s.dependencyRepairAttempts >= 0 && s.dependencyRepairAttempts <= 3))
    || !s.components || typeof s.components !== "object" || Array.isArray(s.components)) throw new Error("invalid upgrade state");
  for (const [name, component] of Object.entries(s.components)) {
    if (!symbol(name) || !component || !["running", "succeeded", "failed", "missing"].includes(component.status)
      || !timestamp(component.checkedAt) || !symbol(component.reasonCode)) throw new Error("invalid upgrade component");
  }
  return { ...s, bootId: s.bootId ?? null, dependencyRepairAttempts: s.dependencyRepairAttempts ?? 0 };
}

/** Active work is not recovery. Only a fresh, verified successful attempt can clear an incident. */
export function upgradeHealth(state: UpgradeState, now = Date.now()): UpgradeHealth {
  const base = { checkedAt: new Date(now).toISOString(), phase: state.phase, appliedRevision: state.appliedRevision,
    desiredRevision: state.desiredRevision, lastSuccessAt: state.lastSuccessAt };
  const result = (status: UpgradeHealth["status"], reasonCode: string): UpgradeHealth => ({ ...base, status, reasonCode });
  const age = now - Date.parse(state.updatedAt);
  const phaseAge = now - Date.parse(state.phaseStartedAt);
  if (age < -60_000 || phaseAge < -60_000 || (state.lastSuccessAt && Date.parse(state.lastSuccessAt) > now + 60_000)) return result("unknown", "state_invalid");
  if (["resolving", "building"].includes(state.phase)) return phaseAge > state.buildTimeoutMs + 60_000
    ? result("degraded", "build_overdue") : result("unknown", "building");
  if (state.phase === "activating") return phaseAge > state.activationWarnAfterMs
    ? result("degraded", "activation_overdue") : result("unknown", "activating");
  if (state.phase === "repairing") return phaseAge > state.activationWarnAfterMs
    ? result("degraded", "dependency_repair_overdue") : result("unknown", "repairing");
  if (state.phase === "verifying") return phaseAge > 5 * 60_000 ? result("degraded", "verification_overdue") : result("unknown", "verifying");
  if (state.phase === "scheduled") return phaseAge > 90 * 60_000 ? result("degraded", "convergence_stale") : result("unknown", "awaiting_first_attempt");
  if (state.phase === "failed" || state.phase === "blocked") return result("degraded", "attempt_failed");
  if (state.phase === "partial" && state.reasonCode === "build_only") return result("unknown", "build_only");
  if (state.phase === "partial" || Object.values(state.components).some(c => c.status !== "succeeded")) return result("degraded", "partial_dependencies");
  if (!state.lastSuccessAt || now - Date.parse(state.lastSuccessAt) > 2 * 60 * 60_000 || state.desiredRevision !== state.appliedRevision || age > 2 * 60 * 60_000) return result("degraded", "convergence_stale");
  return result("healthy", "healthy");
}

export async function readUpgradeHealth(stateFile: string, now = Date.now()): Promise<UpgradeHealth> {
  try { return upgradeHealth(parseUpgradeState(JSON.parse(await readFile(stateFile, "utf8"))), now); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return { checkedAt: new Date(now).toISOString(), status: "unknown", reasonCode: missing ? "state_missing" : "state_invalid",
      phase: "unknown", appliedRevision: null, desiredRevision: null, lastSuccessAt: null };
  }
}
