import type * as C from "./contracts.js";
import { parseReplicaChange } from "./wire.js";

export interface ReplicaLimits {
  readonly maxChanges: number;
  readonly maxBytes: number;
  readonly maxObjects: number;
  readonly maxClosureChanges: number;
  readonly maxClosureBytes: number;
  readonly timeoutMs: number;
  readonly maxRounds: number;
}
export const REPLICA_LIMITS: ReplicaLimits = {
  maxChanges: 32,
  maxBytes: 1024 * 1024,
  maxObjects: 4096,
  maxClosureChanges: 4096,
  maxClosureBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRounds: 32,
};
/** configured authority belongs to the authenticated adapter, never the request. */
export interface ReplicaPolicy {
  readonly ownerId: string;
  readonly peerOwnerId: string;
  /** all-owned is an explicit trusted-adapter grant, never a wire field. */
  readonly projects: readonly string[] | "all-owned";
  readonly personal: boolean;
}
export interface ReplicaRepository {
  forPeer(peerId: string): C.ReplicaStore;
}
export interface ExchangeRequest {
  readonly outgoing: readonly C.ReplicaChange[];
  readonly cursor: string | null;
}
export interface ExchangeResponse {
  readonly incoming: readonly C.ReplicaChange[];
  readonly acknowledged: readonly C.CommitId[];
  readonly cursor: string;
}
interface Cursor {
  version: 1;
  after: C.CommitId | null;
  received: C.CommitId | null;
  attempts: number;
  retryAt: number;
}
const initial = (): Cursor => ({
  version: 1,
  after: null,
  received: null,
  attempts: 0,
  retryAt: 0,
});
function cursor(value: string | null): Cursor {
  if (value === null) return initial();
  if (Buffer.byteLength(value) > 2048)
    throw new Error("oversized replica cursor");
  const c: unknown = JSON.parse(value);
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw new Error("invalid replica cursor");
  const r = c as Record<string, unknown>;
  if (
    Object.keys(r).sort().join() !==
      "after,attempts,received,retryAt,version" ||
    r.version !== 1 ||
    ![r.after, r.received].every(
      (v) =>
        v === null ||
        (typeof v === "string" &&
          v.length > 0 &&
          v.length <= 512 &&
          !/[\0\r\n]/.test(v)),
    ) ||
    !Number.isSafeInteger(r.attempts) ||
    Number(r.attempts) < 0 ||
    !Number.isSafeInteger(r.retryAt) ||
    Number(r.retryAt) < 0
  )
    throw new Error("invalid replica cursor");
  return c as Cursor;
}
function boundedTree(value: unknown, limits: ReplicaLimits): void {
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let objects = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (item.depth > 32) throw new Error("replica nesting limit");
    if (typeof item.value !== "object" || item.value === null) continue;
    if (++objects > limits.maxObjects) throw new Error("replica object limit");
    for (const child of Object.values(item.value))
      queue.push({ value: child, depth: item.depth + 1 });
  }
}
export function parseReplicaJSON(
  text: string,
  limits: ReplicaLimits = REPLICA_LIMITS,
): unknown {
  if (Buffer.byteLength(text) > limits.maxBytes)
    throw new Error("replica byte limit");
  const result: unknown = JSON.parse(text);
  boundedTree(result, limits);
  return result;
}
function changes(
  value: unknown,
  limits: ReplicaLimits,
): readonly C.ReplicaChange[] {
  if (!Array.isArray(value) || value.length > limits.maxChanges)
    throw new Error("replica change limit");
  return value.map(parseReplicaChange);
}
function record(value: unknown, keys: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys
  )
    throw new Error("invalid replica envelope");
  return value as Record<string, unknown>;
}
export function parseExchangeRequest(
  value: unknown,
  limits: ReplicaLimits = REPLICA_LIMITS,
): ExchangeRequest {
  boundedTree(value, limits);
  if (Buffer.byteLength(JSON.stringify(value)) > limits.maxBytes)
    throw new Error("replica byte limit");
  const r = record(value, "cursor,outgoing");
  if (r.cursor !== null && typeof r.cursor !== "string")
    throw new Error("invalid cursor");
  cursor(r.cursor);
  return { outgoing: changes(r.outgoing, limits), cursor: r.cursor };
}
export function parseExchangeResponse(
  value: unknown,
  limits: ReplicaLimits = REPLICA_LIMITS,
): ExchangeResponse {
  boundedTree(value, limits);
  if (Buffer.byteLength(JSON.stringify(value)) > limits.maxBytes)
    throw new Error("replica byte limit");
  const r = record(value, "acknowledged,cursor,incoming");
  if (typeof r.cursor !== "string") throw new Error("invalid cursor");
  cursor(r.cursor);
  if (
    !Array.isArray(r.acknowledged) ||
    r.acknowledged.length > limits.maxChanges ||
    !r.acknowledged.every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 512 &&
        !/[\0\r\n]/.test(v),
    )
  )
    throw new Error("invalid acknowledgment");
  return {
    incoming: changes(r.incoming, limits),
    acknowledged: r.acknowledged as C.CommitId[],
    cursor: r.cursor,
  };
}
function allowed(scope: C.MemoryScope, policy: ReplicaPolicy): boolean {
  return scope.kind === "personal"
    ? policy.personal && scope.ownerId === policy.ownerId
    : policy.projects === "all-owned" ||
        (Array.isArray(policy.projects) &&
          policy.projects.includes(scope.repositoryId));
}
/** parent traversal prevents an allowed note from laundering a forbidden evidence commit. */
async function authorizeClosure(
  batch: readonly C.ReplicaChange[],
  store: C.ReplicaStore,
  policy: ReplicaPolicy,
  limits: ReplicaLimits,
  signal: AbortSignal,
): Promise<void> {
  if (!policy.ownerId || policy.peerOwnerId !== policy.ownerId)
    throw new Error("replica owner denied");
  const available = new Map(batch.map((c) => [c.commitId, c]));
  const pending = batch.map((c) => c.commitId);
  const seen = new Set<C.CommitId>();
  let bytes = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > limits.maxClosureChanges)
      throw new Error("replica closure limit");
    const c = available.get(id) ?? (await store.readChanges([id]))[0];
    if (!c || c.commitId !== id) throw new Error("missing replica dependency");
    parseReplicaChange(c);
    bytes += Buffer.byteLength(JSON.stringify(c));
    if (bytes > limits.maxClosureBytes)
      throw new Error("replica closure byte limit");
    if (
      [...c.windows, ...c.revisions, ...c.suppressions].some(
        (x) => !allowed(x.scope, policy),
      )
    )
      throw new Error("replica scope denied");
    pending.push(...c.parents);
  }
}
async function page(
  store: C.ReplicaStore,
  after: C.CommitId | null,
  limits: ReplicaLimits,
): Promise<readonly C.ReplicaChange[]> {
  const candidates = await store.scan(after, limits.maxChanges);
  const result: C.ReplicaChange[] = [];
  // leave space for two bounded ids in the cursor and the opposite page's ACKs.
  const pageLimits = {
    ...limits,
    maxBytes: Math.max(1, limits.maxBytes - 4096 - limits.maxChanges * 516),
    maxObjects: Math.max(1, limits.maxObjects - 2),
  };
  for (const c of candidates) {
    try {
      parseExchangeRequest(
        { outgoing: [...result, c], cursor: null },
        pageLimits,
      );
    } catch (error) {
      if (!result.length) throw error;
      break;
    }
    result.push(c);
  }
  return result;
}
export interface ExchangeDependencies {
  readonly store: ReplicaRepository;
  readonly peerId: string;
  readonly policy: ReplicaPolicy;
  readonly signal: AbortSignal;
  readonly limits?: ReplicaLimits;
}
/** no paths, destinations, commands or authority are accepted from wire input. */
export async function exchangeReplica(
  input: ExchangeRequest,
  deps: ExchangeDependencies,
): Promise<ExchangeResponse> {
  const limits = deps.limits ?? REPLICA_LIMITS;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(limits.timeoutMs),
  ]);
  const request = parseExchangeRequest(input, limits);
  const store = deps.store.forPeer(`replica-server:${deps.peerId}`);
  const old = cursor(await store.readCursor());
  await authorizeClosure(request.outgoing, store, deps.policy, limits, signal);
  signal.throwIfAborted();
  await store.integrate(request.outgoing);
  // durable integration precedes the receiver-owned checkpoint, including replays.
  const received = request.outgoing.at(-1)?.commitId ?? old.received;
  await store.acknowledge([], JSON.stringify({ ...old, received }));
  const incoming = await page(store, cursor(request.cursor).after, limits);
  await authorizeClosure(incoming, store, deps.policy, limits, signal);
  const response: ExchangeResponse = {
    incoming,
    acknowledged: request.outgoing.map((c) => c.commitId),
    cursor: JSON.stringify({
      ...initial(),
      received,
      after: incoming.at(-1)?.commitId ?? cursor(request.cursor).after,
    }),
  };
  return parseExchangeResponse(response, limits);
}
export interface SynchronizeResult {
  readonly kind: "complete" | "bounded" | "backoff";
  readonly sent: number;
  readonly received: number;
}
/** receiver checkpoints, not historical ACKs, drive replay after a restored snapshot. */
export async function synchronizeReplica(
  deps: ExchangeDependencies & {
    readonly transport: C.ReplicaTransport;
    readonly now?: () => number;
  },
): Promise<SynchronizeResult> {
  const limits = deps.limits ?? REPLICA_LIMITS;
  const now = deps.now ?? Date.now;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(limits.timeoutMs),
  ]);
  const store = deps.store.forPeer(`replica-client:${deps.peerId}`);
  let state = cursor(await store.readCursor());
  if (state.retryAt > now()) return { kind: "backoff", sent: 0, received: 0 };
  let sent = 0,
    received = 0;
  try {
    for (let round = 0; round < limits.maxRounds; round++) {
      signal.throwIfAborted();
      // every invocation first asks what the receiver actually retained. a sender's
      // cached receipt may describe data absent from an older restored snapshot.
      const outgoing =
        round === 0 ? [] : await page(store, state.received, limits);
      await authorizeClosure(outgoing, store, deps.policy, limits, signal);
      const response = parseExchangeResponse(
        await deps.transport.exchange(
          { outgoing, cursor: JSON.stringify(state) },
          signal,
        ),
        limits,
      );
      if (
        response.acknowledged.length !== outgoing.length ||
        response.acknowledged.some((id, i) => id !== outgoing[i]?.commitId)
      )
        throw new Error("invalid peer acknowledgment");
      await authorizeClosure(
        response.incoming,
        store,
        deps.policy,
        limits,
        signal,
      );
      signal.throwIfAborted();
      await store.integrate(response.incoming);
      const remote = cursor(response.cursor);
      state = { ...remote, attempts: 0, retryAt: 0 };
      await store.acknowledge(response.acknowledged, JSON.stringify(state));
      sent += outgoing.length;
      received += response.incoming.length;
      if (
        round > 0 &&
        outgoing.length === 0 &&
        response.incoming.length === 0
      ) {
        // reset both scans at the end of each sweep: reordered/new branches before
        // a saved cursor are revisited without treating per-peer ACK as inventory.
        await store.acknowledge([], JSON.stringify(initial()));
        return { kind: "complete", sent, received };
      }
    }
    return { kind: "bounded", sent, received };
  } catch (error) {
    state = {
      ...state,
      attempts: Math.min(state.attempts + 1, 30),
      retryAt:
        now() + Math.min(60_000, 1000 * 2 ** Math.min(state.attempts, 6)),
    };
    await store.acknowledge([], JSON.stringify(state));
    throw error;
  }
}
