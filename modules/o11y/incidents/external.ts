import type { Axiom } from "./axiom.ts";
import type { Observation } from "./state.ts";

const MINUTE = 60_000;
export const EXTERNAL_POLICY = {
  qualifyMs: 5 * MINUTE,
  sourceMaxAgeMs: 2 * MINUTE,
  upgradeMaxAgeMs: 15 * MINUTE,
  rolloutGraceMs: 90 * MINUTE,
  requestTimeoutMs: 3_000,
  maxBodyBytes: 256 * 1024,
} as const;

/** Explicitly opt in an already monitored always-on host; never infer expectations from inventory. */
export interface ExternalExpectation {
  host: string;
  metricsHost: string;
  enabledAt: string;
  manifestUrl: string;
  services: string[];
}

type Row = Record<string, unknown>;
type RecordValue = Record<string, unknown>;
const symbol = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
function timestamp(value: unknown): number {
  // Deliberately reject JS's lenient date forms and numeric-string coercion.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return NaN;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19) ? at : NaN;
}
function logTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value / 1_000_000) : timestamp(value);
}
function fresh(at: number | undefined, now: number, maxAge = EXTERNAL_POLICY.sourceMaxAgeMs): at is number {
  return at !== undefined && Number.isSafeInteger(at) && at <= now && now - at <= maxAge;
}

export function validateExpectations(expectations: ExternalExpectation[], alwaysOnHosts: Set<string>): void {
  if (!Array.isArray(expectations) || expectations.length > 10) throw new Error("invalid external expectations");
  const hosts = new Set<string>();
  for (const expectation of expectations) {
    if (!expectation || typeof expectation.host !== "string" || !symbol.test(expectation.host) || !alwaysOnHosts.has(expectation.metricsHost)
      || expectation.host !== expectation.metricsHost.replace(/\.local$/, "") || hosts.has(expectation.host) || !Number.isFinite(timestamp(expectation.enabledAt))
      || !Array.isArray(expectation.services) || !expectation.services.length || expectation.services.length > 20
      || expectation.services.some(id => typeof id !== "string" || !symbol.test(id))
      || new Set(expectation.services).size !== expectation.services.length) throw new Error("invalid external expectation");
    const url = new URL(expectation.manifestUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== "/manifest.json") throw new Error("invalid manifest URL");
    hosts.add(expectation.host);
  }
}

function base(expectation: ExternalExpectation, kind: string, now: number, service?: string): Observation {
  return {
    key: JSON.stringify([kind, expectation.host]), kind,
    host: expectation.host, observedAt: now, status: "unknown", qualifyAfterMs: EXTERNAL_POLICY.qualifyMs,
    detail: service ? { service } : {},
  };
}

/** Latest producer timestamp AND ingestion timestamp must be fresh; delayed replay is not recovery. */
export function upgradeObservation(expectation: ExternalExpectation, rows: Row[] | undefined, hostAt: number | undefined, now: number): Observation {
  const observation = base(expectation, "hosts: upgrade convergence", now);
  if (!rows || !fresh(hostAt, now)) return observation;
  const matches = rows.filter(row => row.host === expectation.host);
  if (matches.length > 1) return observation;
  const row = matches[0];
  const event = record(row?.event);
  const at = timestamp(event?.timestamp);
  const ingestedAt = logTime(row?.sampled_at);
  // Invalid/future samples are unknown, not a fabricated absence or recovery.
  if (row && (!event || !Number.isFinite(at) || !Number.isFinite(ingestedAt) || at > now || ingestedAt > now)) return observation;
  if (!row || !fresh(at, now, EXTERNAL_POLICY.upgradeMaxAgeMs) || !fresh(ingestedAt, now, EXTERNAL_POLICY.upgradeMaxAgeMs)) {
    if (now - timestamp(expectation.enabledAt) < EXTERNAL_POLICY.rolloutGraceMs) return observation;
    return { ...observation, status: "bad", sampleAt: hostAt, detail: { reasonCode: "observation_missing" } };
  }
  const context = record(event!.context);
  if (event!.schemaVersion !== 1 || event!.service !== "tailnet-registry" || event!.operation !== "host.upgrade_health"
    || ![expectation.host, expectation.metricsHost].includes(String(event!.host))
    || typeof context?.ready !== "boolean" || typeof context.readiness !== "string" || !symbol.test(context.readiness)
    || typeof context.reasonCode !== "string" || !symbol.test(context.reasonCode)) return observation;
  const reason = context.reasonCode;
  if (reason === "state_missing" && now - timestamp(expectation.enabledAt) < EXTERNAL_POLICY.rolloutGraceMs) return observation;
  const failures = ["activation_overdue", "build_overdue", "dependency_repair_overdue", "verification_overdue", "attempt_failed", "convergence_stale", "partial_dependencies", "state_missing", "state_invalid"];
  // Building is intentionally unknown: it neither alerts within the producer's
  // 90-minute build budget nor closes an earlier failure without convergence.
  const status = reason === "healthy" && context.ready === true ? "healthy"
    : failures.includes(reason) && context.ready === false ? "bad" : "unknown";
  return { ...observation, status, sampleAt: Math.min(at, ingestedAt, hostAt), detail: { reasonCode: reason, readiness: context.readiness } };
}

export const UPGRADE_QUERY = "| where normalized_event_service == 'tailnet-registry' and normalized_event_operation == 'host.upgrade_health' | extend sampled_at = _time, event = normalized_event | summarize arg_max(sampled_at, event) by host = normalized_host | project host, sampled_at, event";

/** No redirects, credentials, response bodies or arbitrary exception text enter logs. */
export async function fetchManifest(url: string, request: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("manifest deadline")); }, EXTERNAL_POLICY.requestTimeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await request(url, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "host-incidents/1" } });
      if (!response.ok || response.status !== 200) throw new Error("manifest HTTP failure");
      if (Number(response.headers.get("content-length")) > EXTERNAL_POLICY.maxBodyBytes) throw new Error("manifest size");
      if (!response.body) throw new Error("manifest empty");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > EXTERNAL_POLICY.maxBodyBytes) throw new Error("manifest size");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new Error("invalid manifest JSON"); }
    })()]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    // Also cancel the body directly: the deadline must not rely on a fetch
    // implementation propagating AbortSignal to an already-returned stream.
    void reader?.cancel().catch(() => {});
  }
}

export async function externalObservations(
  client: Axiom, expectations: ExternalExpectation[], hostAt: (host: string) => number | undefined,
  now: number, request: typeof fetch = fetch, clock: () => number = Date.now,
): Promise<{ observations: Observation[]; errors: string[] }> {
  const result: Observation[] = [];
  const errors: string[] = [];
  if (!expectations.length) return { observations: result, errors };
  let rows: Row[] | undefined;
  try {
    rows = await client.rows(UPGRADE_QUERY, now - EXTERNAL_POLICY.upgradeMaxAgeMs, now);
    if (rows.some(row => typeof row.host !== "string" || !symbol.test(row.host))) throw new Error("invalid upgrade query row");
  } catch { rows = undefined; errors.push("external: upgrade query"); }
  for (const expectation of expectations) {
    result.push(upgradeObservation(expectation, rows, hostAt(expectation.metricsHost), now));
    let manifest: unknown;
    try { manifest = await fetchManifest(expectation.manifestUrl, request); }
    catch { /* Expected reporter failure is classified without retaining the body or error. */ }
    // HTTP can observe reports generated DURING the preceding Axiom queries.
    // Classify against completion time, not the earlier query-window boundary.
    result.push(...manifestObservations(expectation, manifest, hostAt(expectation.metricsHost), clock()));
  }
  return { observations: result, errors };
}

/** Consume the registry's explicit readiness extension, not its legacy HTTP/liveness status. */
export function manifestObservations(expectation: ExternalExpectation, value: unknown, hostAt: number | undefined, now: number): Observation[] {
  let reporter = base(expectation, "hosts: readiness reporter", now);
  const services = expectation.services.map(id => base(expectation, `hosts: service readiness (${id})`, now, id));
  if (!fresh(hostAt, now)) return [reporter, ...services];
  const manifest = record(value);
  const inventory = record(manifest?.services);
  const reportAt = timestamp(manifest?.reportedAt);
  const valid = manifest?.schemaVersion === 1 && record(manifest.host)?.name === expectation.host
    && inventory && Object.keys(inventory).length <= 100 && fresh(reportAt, now);
  let complete = !!valid;
  const samples = [hostAt, reportAt];
  for (const [index, id] of expectation.services.entries()) {
    if (!valid) continue;
    const health = record(record(inventory[id])?.health);
    const at = timestamp(health?.checkedAt);
    const ready = health?.ready;
    const reason = health?.reasonCode;
    const concrete = health && fresh(at, now) && typeof health.reachable === "boolean"
      && typeof reason === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(reason)
      // The boolean-only producer uses false for both failure and uncertainty.
      // Preserve its unknown sentinels instead of paging on missing evidence.
      && !["readiness_not_configured", "readiness_unavailable", "stale_observation"].includes(reason)
      && ((ready === true && health.readiness === "ready" && health.status === "up" && health.reachable === true)
        || (ready === false && health.readiness === "not_ready"
          && (health.status === "down"
            || ((health.status === "up" || health.status === "auth-required") && health.reachable === true))));
    if (!concrete) { complete = false; continue; }
    samples.push(at);
    services[index] = {
      ...services[index], status: ready ? "healthy" : "bad", sampleAt: Math.min(at, reportAt, hostAt),
      detail: { service: id, ready, reachable: health.reachable as boolean, reasonCode: reason as string },
    };
  }
  if (complete) reporter = { ...reporter, status: "healthy", sampleAt: Math.min(...samples), detail: { reasonCode: "observations_complete" } };
  else if (now - timestamp(expectation.enabledAt) >= EXTERNAL_POLICY.rolloutGraceMs) {
    // This is an observation-path failure, NOT evidence that any app is bad.
    // Fresh host telemetry prevents an offline mini from spawning app incidents.
    reporter = { ...reporter, status: "bad", sampleAt: hostAt, detail: { reasonCode: "observations_unavailable" } };
  }
  return [reporter, ...services];
}
