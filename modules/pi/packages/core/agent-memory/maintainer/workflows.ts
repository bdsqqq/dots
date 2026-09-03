import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MemoryConfig } from "../catalog.js";
import {
  boundedString,
  canonicalJson,
  durableCreate,
  durableWrite,
  isJsonValue,
  object,
  safeRelativePath,
  sha256,
  timestamp,
  type JsonValue,
  v3Data,
  withDirectoryLock,
} from "./common.js";
import { RESOURCE_LIMITS } from "./policy.js";

export const WORKFLOW_KINDS = [
  "source-reconcile",
  "projection-reconcile",
  "transaction-reconcile",
  "proposal-reconcile",
  "reflection",
  "corpus-maintenance",
  "evaluation",
  "qmd-index",
  "history-sync",
  "retention",
] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];
export const WORKFLOW_PRIORITIES = [
  "background",
  "normal",
  "interactive",
  "integrity",
] as const;
export type WorkflowPriority = (typeof WORKFLOW_PRIORITIES)[number];
export const WORKFLOW_STATES = [
  "ready",
  "leased",
  "waiting",
  "retry-scheduled",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export type WorkflowStateType = (typeof WORKFLOW_STATES)[number];
export const TERMINAL_WORKFLOW_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly WorkflowStateType[];

export type ArtifactRef = {
  sha256: string;
  relativePath: string;
  bytes: number;
};

export type WorkflowFailureCode =
  | "source-missing"
  | "source-unstable"
  | "source-invalid"
  | "source-replaced"
  | "basis-changed"
  | "lock-contended"
  | "model-rate-limited"
  | "model-unavailable"
  | "model-timed-out"
  | "model-output-invalid"
  | "external-command-failed"
  | "canonical-admission-closed"
  | "unexpected";

export type WorkflowFailure = {
  code: WorkflowFailureCode;
  step: string;
  observedAt: string;
  reason: string;
  retryable: boolean;
  basisRevision: number;
  evidence: ArtifactRef[];
  retryAfter?: string;
  fingerprint?: string;
};

export type ContinuationEnvelope = {
  ownerStep: string;
  version: number;
  payload: JsonValue;
  payloadSha256: string;
};

export type WorkflowState =
  | {
      type: "ready";
      step: string;
      availableAt: string;
      continuation: ContinuationEnvelope | null;
    }
  | {
      type: "leased";
      step: string;
      lease: {
        token: string;
        owner: string;
        claimedAt: string;
        expiresAt: string;
      };
      continuation: ContinuationEnvelope | null;
    }
  | {
      type: "waiting";
      step: string;
      wait:
        | { type: "timer"; resumeAt: string }
        | {
            type: "model-output";
            invocationId: string;
            preparedArtifact: ArtifactRef;
            timeoutAt: string;
          }
        | {
            type: "external-process";
            invocationId: string;
            expectedArtifact: ArtifactRef;
            timeoutAt: string;
          };
      continuation: ContinuationEnvelope;
      expiresAt: string;
    }
  | {
      type: "retry-scheduled";
      step: string;
      nextAttemptAt: string;
      expiresAt: string;
      error: WorkflowFailure;
      continuation: ContinuationEnvelope | null;
    }
  | {
      type: "blocked";
      step: string;
      blockedAt: string;
      reviewBy: string;
      expiresAt: string;
      error: WorkflowFailure;
      continuation: ContinuationEnvelope | null;
    }
  | {
      type: "succeeded";
      completedAt: string;
      outputs: ArtifactRef[];
      retainUntil: string;
    }
  | {
      type: "failed";
      failedAt: string;
      error: WorkflowFailure;
      retainUntil: string;
    }
  | {
      type: "cancelled";
      cancelledAt: string;
      reason: string;
      retainUntil: string;
    }
  | {
      type: "expired";
      expiredAt: string;
      priorState: "waiting" | "retry-scheduled" | "blocked";
      reason: string;
      retainUntil: string;
    };

export type WorkflowRecord = {
  schemaVersion: 3;
  id: string;
  revision: number;
  kind: WorkflowKind;
  priority: WorkflowPriority;
  demandGeneration: number;
  basis: { [key: string]: JsonValue };
  createdAt: string;
  updatedAt: string;
  attempt: number;
  state: WorkflowState;
};

export type WorkflowTransition =
  | { type: "suspend"; availableAt: string; continuation: ContinuationEnvelope }
  | { type: "ready"; step: string; continuation?: ContinuationEnvelope | null }
  | {
      type: "wait";
      step: string;
      wait: Extract<WorkflowState, { type: "waiting" }>["wait"];
      continuation: ContinuationEnvelope;
      expiresAt: string;
    }
  | {
      type: "retry";
      error: WorkflowFailure;
      nextAttemptAt: string;
      expiresAt: string;
      continuation?: ContinuationEnvelope | null;
    }
  | {
      type: "block";
      error: WorkflowFailure;
      reviewBy: string;
      expiresAt: string;
      continuation?: ContinuationEnvelope | null;
    }
  | { type: "succeed"; outputs: ArtifactRef[]; retainUntil: string }
  | { type: "fail"; error: WorkflowFailure; retainUntil: string }
  | { type: "cancel"; reason: string; retainUntil: string };

type WorkflowRoot = Pick<MemoryConfig, "data">;
const lockPath = (cfg: WorkflowRoot): string => v3Data(cfg, "workflows/.lock");

function statePath(
  cfg: WorkflowRoot,
  state: WorkflowStateType,
  id: string,
): string {
  if (!/^wf_[a-z]+_[0-9]{8}t[0-9]{9}z_[a-z0-9]{6}$/.test(id))
    throw new Error("invalid workflow id");
  return v3Data(cfg, "workflows", state, `${id}.json`);
}

function artifactRef(value: unknown): ArtifactRef {
  if (
    !object(value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0
  )
    throw new Error("invalid artifact ref");
  safeRelativePath(value.relativePath);
  return value as ArtifactRef;
}

export function continuation(
  ownerStep: string,
  version: number,
  payload: JsonValue,
): ContinuationEnvelope {
  boundedString(ownerStep, "continuation owner", 100);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("invalid continuation version");
  const encoded = canonicalJson(payload);
  if (Buffer.byteLength(encoded) > RESOURCE_LIMITS.maxContinuationBytes)
    throw new Error("continuation exceeds size cap");
  return { ownerStep, version, payload, payloadSha256: sha256(encoded) };
}

function parseContinuation(value: unknown): ContinuationEnvelope {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !isJsonValue(value.payload) ||
    typeof value.payloadSha256 !== "string"
  )
    throw new Error("invalid continuation");
  boundedString(value.ownerStep, "continuation owner", 100);
  const encoded = canonicalJson(value.payload);
  if (
    Buffer.byteLength(encoded) > RESOURCE_LIMITS.maxContinuationBytes ||
    sha256(encoded) !== value.payloadSha256
  )
    throw new Error("invalid continuation digest");
  return value as ContinuationEnvelope;
}

function parseFailure(value: unknown): WorkflowFailure {
  if (
    !object(value) ||
    ![
      "source-missing",
      "source-unstable",
      "source-invalid",
      "source-replaced",
      "basis-changed",
      "lock-contended",
      "model-rate-limited",
      "model-unavailable",
      "model-timed-out",
      "model-output-invalid",
      "external-command-failed",
      "canonical-admission-closed",
      "unexpected",
    ].includes(String(value.code)) ||
    typeof value.retryable !== "boolean" ||
    !Number.isSafeInteger(value.basisRevision) ||
    Number(value.basisRevision) < 1 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 32
  )
    throw new Error("invalid workflow failure");
  boundedString(value.step, "failure step", 100);
  boundedString(value.reason, "failure reason", 500);
  timestamp(value.observedAt, "failure observedAt");
  value.evidence.forEach(artifactRef);
  if (value.retryAfter !== undefined)
    timestamp(value.retryAfter, "failure retryAfter");
  if (
    value.fingerprint !== undefined &&
    (typeof value.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint))
  )
    throw new Error("invalid failure fingerprint");
  return value as WorkflowFailure;
}

function parseState(value: unknown): WorkflowState {
  if (!object(value) || typeof value.type !== "string")
    throw new Error("invalid workflow state");
  if (value.type === "ready") {
    boundedString(value.step, "workflow step", 100);
    timestamp(value.availableAt, "workflow availableAt");
    if (value.continuation !== null) parseContinuation(value.continuation);
  } else if (value.type === "leased") {
    boundedString(value.step, "workflow step", 100);
    if (!object(value.lease)) throw new Error("invalid workflow lease");
    boundedString(value.lease.token, "lease token", 100);
    boundedString(value.lease.owner, "lease owner", 200);
    timestamp(value.lease.claimedAt, "lease claimedAt");
    timestamp(value.lease.expiresAt, "lease expiresAt");
    if (value.continuation !== null) parseContinuation(value.continuation);
  } else if (value.type === "waiting") {
    boundedString(value.step, "workflow step", 100);
    parseContinuation(value.continuation);
    timestamp(value.expiresAt, "workflow expiresAt");
    if (!object(value.wait) || typeof value.wait.type !== "string")
      throw new Error("invalid workflow wait");
    if (value.wait.type === "timer")
      timestamp(value.wait.resumeAt, "wait resumeAt");
    else if (value.wait.type === "model-output") {
      boundedString(value.wait.invocationId, "invocation id", 200);
      artifactRef(value.wait.preparedArtifact);
      timestamp(value.wait.timeoutAt, "wait timeoutAt");
    } else if (value.wait.type === "external-process") {
      boundedString(value.wait.invocationId, "invocation id", 200);
      artifactRef(value.wait.expectedArtifact);
      timestamp(value.wait.timeoutAt, "wait timeoutAt");
    } else throw new Error("invalid workflow wait");
  } else if (value.type === "retry-scheduled") {
    boundedString(value.step, "workflow step", 100);
    timestamp(value.nextAttemptAt, "workflow nextAttemptAt");
    timestamp(value.expiresAt, "workflow expiresAt");
    parseFailure(value.error);
    if (value.continuation !== null) parseContinuation(value.continuation);
  } else if (value.type === "blocked") {
    boundedString(value.step, "workflow step", 100);
    timestamp(value.blockedAt, "workflow blockedAt");
    timestamp(value.reviewBy, "workflow reviewBy");
    timestamp(value.expiresAt, "workflow expiresAt");
    parseFailure(value.error);
    if (value.continuation !== null) parseContinuation(value.continuation);
  } else if (value.type === "succeeded") {
    timestamp(value.completedAt, "workflow completedAt");
    timestamp(value.retainUntil, "workflow retainUntil");
    if (!Array.isArray(value.outputs) || value.outputs.length > 64)
      throw new Error("invalid workflow outputs");
    value.outputs.forEach(artifactRef);
  } else if (value.type === "failed") {
    timestamp(value.failedAt, "workflow failedAt");
    timestamp(value.retainUntil, "workflow retainUntil");
    parseFailure(value.error);
  } else if (value.type === "cancelled") {
    timestamp(value.cancelledAt, "workflow cancelledAt");
    timestamp(value.retainUntil, "workflow retainUntil");
    boundedString(value.reason, "cancellation reason", 500);
  } else if (value.type === "expired") {
    timestamp(value.expiredAt, "workflow expiredAt");
    timestamp(value.retainUntil, "workflow retainUntil");
    if (
      !["waiting", "retry-scheduled", "blocked"].includes(
        String(value.priorState),
      )
    )
      throw new Error("invalid expired prior state");
    boundedString(value.reason, "expiry reason", 500);
  } else throw new Error("invalid workflow state");
  return value as WorkflowState;
}

export function parseWorkflowRecord(value: unknown): WorkflowRecord {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.kind !== "string" ||
    !WORKFLOW_KINDS.includes(value.kind as WorkflowKind) ||
    typeof value.priority !== "string" ||
    !WORKFLOW_PRIORITIES.includes(value.priority as WorkflowPriority) ||
    !Number.isSafeInteger(value.demandGeneration) ||
    Number(value.demandGeneration) < 1 ||
    !object(value.basis) ||
    !isJsonValue(value.basis) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 0
  )
    throw new Error("invalid workflow record");
  statePath({ data: "/tmp" }, "ready", value.id);
  timestamp(value.createdAt, "workflow createdAt");
  timestamp(value.updatedAt, "workflow updatedAt");
  parseState(value.state);
  return value as WorkflowRecord;
}

function serialize(record: WorkflowRecord): string {
  parseWorkflowRecord(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

function workflowId(kind: WorkflowKind, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("Z", "z")
    .replace("T", "t");
  return `wf_${kind.split("-")[0]}_${stamp}_${randomBytes(4)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .padEnd(6, "0")
    .slice(0, 6)}`;
}

export function createWorkflow(
  cfg: WorkflowRoot,
  input: {
    id?: string;
    kind: WorkflowKind;
    priority: WorkflowPriority;
    demandGeneration: number;
    basis: { [key: string]: JsonValue };
    step: string;
    availableAt?: string;
  },
  clock: () => Date = () => new Date(),
): WorkflowRecord {
  const now = clock();
  const record: WorkflowRecord = {
    schemaVersion: 3,
    id: input.id ?? workflowId(input.kind, now),
    revision: 1,
    kind: input.kind,
    priority: input.priority,
    demandGeneration: input.demandGeneration,
    basis: input.basis,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempt: 0,
    state: {
      type: "ready",
      step: input.step,
      availableAt: input.availableAt ?? now.toISOString(),
      continuation: null,
    },
  };
  const path = statePath(cfg, "ready", record.id);
  if (!durableCreate(path, serialize(record))) {
    const existing = parseWorkflowRecord(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (serialize(existing) !== serialize(record))
      throw new Error("workflow id collision");
    return existing;
  }
  return record;
}

function copies(
  cfg: WorkflowRoot,
  id: string,
): Array<{ path: string; record: WorkflowRecord }> {
  return WORKFLOW_STATES.flatMap((state) => {
    const path = statePath(cfg, state, id);
    if (!existsSync(path)) return [];
    const record = parseWorkflowRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record.state.type !== state)
      throw new Error("workflow state directory mismatch");
    return [{ path, record }];
  });
}

export function loadWorkflow(cfg: WorkflowRoot, id: string): WorkflowRecord {
  const found = copies(cfg, id).sort(
    (left, right) => right.record.revision - left.record.revision,
  );
  if (found.length === 0) throw new Error("workflow not found");
  const highest = found[0]!;
  const equal = found.filter(
    (item) => item.record.revision === highest.record.revision,
  );
  if (
    equal.some((item) => serialize(item.record) !== serialize(highest.record))
  )
    throw new Error("duplicate workflow revision conflict");
  return highest.record;
}

export function listWorkflows(
  cfg: WorkflowRoot,
  states: readonly WorkflowStateType[] = WORKFLOW_STATES,
): WorkflowRecord[] {
  const ids = new Set<string>();
  for (const state of states) {
    const directory = v3Data(cfg, "workflows", state);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory))
      if (name.endsWith(".json")) ids.add(name.slice(0, -5));
  }
  return [...ids]
    .map((id) => loadWorkflow(cfg, id))
    .filter((record) => states.includes(record.state.type))
    .sort((left, right) =>
      right.priority === left.priority
        ? left.createdAt.localeCompare(right.createdAt)
        : WORKFLOW_PRIORITIES.indexOf(right.priority) -
          WORKFLOW_PRIORITIES.indexOf(left.priority),
    );
}

function replace(
  cfg: WorkflowRoot,
  prior: WorkflowRecord,
  next: WorkflowRecord,
): void {
  const source = statePath(cfg, prior.state.type, prior.id);
  const target = statePath(cfg, next.state.type, next.id);
  durableWrite(target, serialize(next));
  if (source !== target) rmSync(source, { force: true });
}

export function claimWorkflow(
  cfg: WorkflowRoot,
  options: {
    owner: string;
    kinds?: WorkflowKind[];
    leaseMs?: number;
    clock?: () => Date;
  },
): WorkflowRecord | undefined {
  boundedString(options.owner, "workflow owner", 200);
  return withDirectoryLock(lockPath(cfg), () => {
    const now = (options.clock ?? (() => new Date()))();
    const selected = listWorkflows(cfg, ["ready"]).find(
      (record) =>
        record.state.type === "ready" &&
        record.state.availableAt <= now.toISOString() &&
        (!options.kinds || options.kinds.includes(record.kind)),
    );
    if (!selected || selected.state.type !== "ready") return undefined;
    const next: WorkflowRecord = {
      ...selected,
      revision: selected.revision + 1,
      updatedAt: now.toISOString(),
      attempt: selected.attempt + 1,
      state: {
        type: "leased",
        step: selected.state.step,
        lease: {
          token: randomUUID(),
          owner: options.owner,
          claimedAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + (options.leaseMs ?? 5 * 60_000),
          ).toISOString(),
        },
        continuation: selected.state.continuation,
      },
    };
    replace(cfg, selected, next);
    return next;
  });
}

function nextState(
  current: Extract<WorkflowState, { type: "leased" }>,
  transition: WorkflowTransition,
  now: string,
): WorkflowState {
  switch (transition.type) {
    case "suspend":
      return {
        type: "ready",
        step: current.step,
        availableAt: timestamp(
          transition.availableAt,
          "suspension availableAt",
        ),
        continuation: parseContinuation(transition.continuation),
      };
    case "ready":
      return {
        type: "ready",
        step: boundedString(transition.step, "workflow step", 100),
        availableAt: now,
        continuation:
          transition.continuation === undefined
            ? current.continuation
            : transition.continuation === null
              ? null
              : parseContinuation(transition.continuation),
      };
    case "wait":
      return parseState({
        type: "waiting",
        step: transition.step,
        wait: transition.wait,
        continuation: transition.continuation,
        expiresAt: transition.expiresAt,
      });
    case "retry":
      return parseState({
        type: "retry-scheduled",
        step: current.step,
        nextAttemptAt: transition.nextAttemptAt,
        expiresAt: transition.expiresAt,
        error: transition.error,
        continuation: transition.continuation ?? current.continuation,
      });
    case "block":
      return parseState({
        type: "blocked",
        step: current.step,
        blockedAt: now,
        reviewBy: transition.reviewBy,
        expiresAt: transition.expiresAt,
        error: transition.error,
        continuation: transition.continuation ?? current.continuation,
      });
    case "succeed":
      return parseState({
        type: "succeeded",
        completedAt: now,
        outputs: transition.outputs,
        retainUntil: transition.retainUntil,
      });
    case "fail":
      return parseState({
        type: "failed",
        failedAt: now,
        error: transition.error,
        retainUntil: transition.retainUntil,
      });
    case "cancel":
      return parseState({
        type: "cancelled",
        cancelledAt: now,
        reason: transition.reason,
        retainUntil: transition.retainUntil,
      });
  }
}

export function transitionWorkflow(
  cfg: WorkflowRoot,
  id: string,
  leaseToken: string,
  transition: WorkflowTransition,
  clock: () => Date = () => new Date(),
): WorkflowRecord {
  return withDirectoryLock(lockPath(cfg), () => {
    const record = loadWorkflow(cfg, id);
    if (
      record.state.type !== "leased" ||
      record.state.lease.token !== leaseToken
    )
      throw new Error("workflow lease mismatch");
    const now = clock().toISOString();
    const next: WorkflowRecord = {
      ...record,
      revision: record.revision + 1,
      updatedAt: now,
      attempt:
        transition.type === "suspend" ? record.attempt - 1 : record.attempt,
      state: nextState(record.state, transition, now),
    };
    replace(cfg, record, next);
    return next;
  });
}

export function reconcileWorkflowStore(
  cfg: WorkflowRoot,
  clock: () => Date = () => new Date(),
): {
  recoveredLeases: number;
  releasedRetries: number;
  releasedTimers: number;
  expired: number;
} {
  return withDirectoryLock(lockPath(cfg), () => {
    const now = clock();
    const report = {
      recoveredLeases: 0,
      releasedRetries: 0,
      releasedTimers: 0,
      expired: 0,
    };
    for (const record of listWorkflows(cfg, [
      "leased",
      "waiting",
      "retry-scheduled",
      "blocked",
    ])) {
      let state: WorkflowState | undefined;
      if (
        record.state.type === "leased" &&
        record.state.lease.expiresAt <= now.toISOString()
      ) {
        report.recoveredLeases += 1;
        state = {
          type: "ready",
          step: record.state.step,
          availableAt: now.toISOString(),
          continuation: record.state.continuation,
        };
      } else if (
        record.state.type === "waiting" &&
        record.state.wait.type === "timer" &&
        record.state.wait.resumeAt <= now.toISOString() &&
        record.state.expiresAt > now.toISOString()
      ) {
        report.releasedTimers += 1;
        state = {
          type: "ready",
          step: record.state.step,
          availableAt: now.toISOString(),
          continuation: record.state.continuation,
        };
      } else if (
        record.state.type === "retry-scheduled" &&
        record.state.nextAttemptAt <= now.toISOString() &&
        record.state.expiresAt > now.toISOString()
      ) {
        report.releasedRetries += 1;
        state = {
          type: "ready",
          step: record.state.step,
          availableAt: now.toISOString(),
          continuation: record.state.continuation,
        };
      } else if (
        (record.state.type === "waiting" ||
          record.state.type === "retry-scheduled" ||
          record.state.type === "blocked") &&
        record.state.expiresAt <= now.toISOString()
      ) {
        report.expired += 1;
        state = {
          type: "expired",
          expiredAt: now.toISOString(),
          priorState: record.state.type,
          reason: "workflow lifecycle expired",
          retainUntil: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        };
      }
      if (state) {
        const next = {
          ...record,
          revision: record.revision + 1,
          updatedAt: now.toISOString(),
          state,
        };
        replace(cfg, record, next);
      }
    }
    return report;
  });
}

export function deterministicWorkflowId(
  kind: WorkflowKind,
  identity: string,
  now: Date,
): string {
  const seed = sha256(identity).slice(0, 6);
  const stamp = now
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("Z", "z")
    .replace("T", "t");
  return `wf_${kind.split("-")[0]}_${stamp}_${seed}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const cfg = (): WorkflowRoot => ({
    data: join(mkdtempSync(join(tmpdir(), "pi-memory-workflow-v3-")), "data"),
  });
  const clock = () => new Date("2026-09-03T12:00:00.000Z");
  const retainUntil = "2026-10-03T12:00:00.000Z";

  describe("v3 workflows", () => {
    it("claims once and treats a finite boundary as successful suspension", () => {
      const root = cfg();
      const created = createWorkflow(
        root,
        {
          kind: "source-reconcile",
          priority: "normal",
          demandGeneration: 1,
          basis: { sourceId: "source" },
          step: "parse",
        },
        clock,
      );
      const claimed = claimWorkflow(root, { owner: "dispatcher-a", clock })!;
      expect(claimed.id).toBe(created.id);
      expect(
        claimWorkflow(root, { owner: "dispatcher-b", clock }),
      ).toBeUndefined();
      const suspended = transitionWorkflow(
        root,
        claimed.id,
        (claimed.state as Extract<WorkflowState, { type: "leased" }>).lease
          .token,
        {
          type: "suspend",
          availableAt: clock().toISOString(),
          continuation: continuation("parse", 1, { byteCursor: 10 }),
        },
        clock,
      );
      expect(suspended).toMatchObject({
        attempt: 0,
        state: { type: "ready", continuation: { ownerStep: "parse" } },
      });
    });

    it("recovers expired leases and preserves typed delayed failures", () => {
      const root = cfg();
      createWorkflow(
        root,
        {
          kind: "history-sync",
          priority: "integrity",
          demandGeneration: 1,
          basis: { head: "a" },
          step: "fetch",
        },
        clock,
      );
      claimWorkflow(root, {
        owner: "dispatcher",
        leaseMs: 1_000,
        clock,
      });
      const later = () => new Date("2026-09-03T12:00:02.000Z");
      expect(reconcileWorkflowStore(root, later)).toMatchObject({
        recoveredLeases: 1,
      });
      const retryClaim = claimWorkflow(root, {
        owner: "dispatcher",
        clock: later,
      })!;
      const failure: WorkflowFailure = {
        code: "model-rate-limited",
        step: "invoke",
        observedAt: later().toISOString(),
        reason: "provider requested retry",
        retryable: true,
        basisRevision: retryClaim.revision,
        evidence: [],
        retryAfter: "2026-09-03T12:01:02.000Z",
      };
      const retry = transitionWorkflow(
        root,
        retryClaim.id,
        (retryClaim.state as Extract<WorkflowState, { type: "leased" }>).lease
          .token,
        {
          type: "retry",
          error: failure,
          nextAttemptAt: failure.retryAfter!,
          expiresAt: retainUntil,
        },
        later,
      );
      expect(retry.state).toEqual(
        expect.objectContaining({
          type: "retry-scheduled",
          error: expect.objectContaining({ code: "model-rate-limited" }),
        }),
      );
      expect(
        claimWorkflow(root, { owner: "other", clock: later }),
      ).toBeUndefined();
    });

    it("fails closed on conflicting duplicate revisions", () => {
      const root = cfg();
      const created = createWorkflow(
        root,
        {
          kind: "retention",
          priority: "background",
          demandGeneration: 1,
          basis: {},
          step: "report",
        },
        clock,
      );
      const corrupt = {
        ...created,
        state: { ...created.state, step: "different" },
      };
      durableWrite(
        statePath(root, "blocked", created.id),
        `${JSON.stringify({
          ...corrupt,
          state: {
            type: "blocked",
            step: "different",
            blockedAt: clock().toISOString(),
            reviewBy: retainUntil,
            expiresAt: retainUntil,
            error: {
              code: "unexpected",
              step: "load",
              observedAt: clock().toISOString(),
              reason: "conflict",
              retryable: false,
              basisRevision: 1,
              evidence: [],
              fingerprint: sha256("conflict"),
            },
            continuation: null,
          },
        })}\n`,
      );
      expect(() => loadWorkflow(root, created.id)).toThrow(
        "duplicate workflow revision conflict",
      );
    });

    it("rejects continuation corruption and oversized payloads", () => {
      expect(() =>
        parseWorkflowRecord({
          schemaVersion: 3,
          id: deterministicWorkflowId("retention", "one", clock()),
          revision: 1,
          kind: "retention",
          priority: "normal",
          demandGeneration: 1,
          basis: {},
          createdAt: clock().toISOString(),
          updatedAt: clock().toISOString(),
          attempt: 0,
          state: {
            type: "ready",
            step: "report",
            availableAt: clock().toISOString(),
            continuation: {
              ownerStep: "report",
              version: 1,
              payload: { cursor: 1 },
              payloadSha256: "0".repeat(64),
            },
          },
        }),
      ).toThrow("invalid continuation digest");
      expect(() =>
        continuation("report", 1, {
          value: "x".repeat(RESOURCE_LIMITS.maxContinuationBytes),
        }),
      ).toThrow("continuation exceeds size cap");
    });
  });
}
