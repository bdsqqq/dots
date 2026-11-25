import { readFileSync } from "node:fs";
import type { Observation, Transition } from "./state.ts";
import { externalObservations, validateExpectations, type ExternalExpectation } from "./external.ts";

const MINUTE = 60_000;
const GIB = 1024 ** 3;
const METRICS = "https://us-east-1.aws.edge.axiom.co/v1/query/_mpl?format=metrics-v2";
const API = "https://api.axiom.co/v1";
export type Rule = {
  name: string; type: string; mplQuery?: string; aplQuery?: string;
  threshold?: number; rangeMinutes: number;
};
/** what each host declares in `my.diskAlerts` (modules/o11y/disk-alerts.nix); null turns a level off. */
export type DiskLevel = { below: number; recover: number; afterMinutes: number };
export type DiskCapacity = { belowFraction: number; recoverFraction: number; afterMinutes: number };
export type MountPolicy = { critical: DiskLevel | null; low: DiskLevel | null; capacity: DiskCapacity | null };
export type HostDisks = { profile: string; mounts: Record<string, MountPolicy> };
export type Configuration = {
  disks?: Record<string, HostDisks>;
  /** the pre-declaration shape: a mount list per host, judged by the server/workstation defaults. */
  mounts?: Record<string, string[]>;
  rulesPath: string; externalExpectations?: ExternalExpectation[];
};
const GiBs = (n: number) => n * GIB;
const LEGACY_LEVELS = {
  server: { critical: { below: GiBs(2), recover: GiBs(3), afterMinutes: 0 }, low: { below: GiBs(8), recover: GiBs(10), afterMinutes: 60 } },
  workstation: { critical: { below: GiBs(2), recover: GiBs(3), afterMinutes: 30 }, low: { below: GiBs(8), recover: GiBs(10), afterMinutes: 720 } },
};
/**
 * the evaluator runs from the live checkout while its config comes from the
 * installed wrapper, and the two update independently. an older wrapper still
 * passes `mounts`; read it with the same defaults disk-alerts.nix uses, so a
 * half-updated relay keeps evaluating instead of crashing.
 */
export function hostDisks(config: Configuration): Record<string, HostDisks> {
  if (config.disks) return config.disks;
  if (!config.mounts) throw new Error("configuration has neither disks nor mounts");
  return Object.fromEntries(Object.entries(config.mounts).map(([host, mounts]) => {
    const profile = host.endsWith(".local") ? "workstation" : "server";
    return [host, { profile, mounts: Object.fromEntries(mounts.map(mount => [mount, { ...LEGACY_LEVELS[profile], capacity: null }])) }];
  }));
}
type Point = { at: number; value: number };
type Series = { tags: Record<string, string>; points: Point[] };
type Row = Record<string, unknown>;
type Credentials = { query: string; ingest: string; org: string };

export function credentials(directory = process.env.CREDENTIALS_DIRECTORY): Credentials {
  const path = directory ?? "/run/secrets/axiom";
  const get = (credential: string, secret: string) => {
    const value = readFileSync(`${path}/${directory ? credential : secret}`, "utf8").trim();
    if (!value) throw new Error(`empty credential: ${credential}`);
    return value;
  };
  return { query: get("query-token", "personal_token"), ingest: get("ingest-token", "papertrail_token"), org: get("org-id", "personal_org_id") };
}

export class Axiom {
  private readonly secrets: Credentials;
  private readonly request: typeof fetch;
  constructor(secrets: Credentials, request: typeof fetch = fetch) {
    this.secrets = secrets;
    this.request = request;
  }
  private async post(url: string, body: unknown, ingest = false): Promise<any> {
    const response = await this.request(url, {
      method: "POST", signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${ingest ? this.secrets.ingest : this.secrets.query}`, "X-Axiom-Org-Id": this.secrets.org, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Error bodies can contain source events. Neither credentials nor arbitrary
    // host log content belongs in the evaluator's own logs.
    if (!response.ok) throw new Error(`axiom HTTP ${response.status}`);
    return response.json();
  }
  async metrics(mpl: string, start: number, end: number): Promise<Series[]> {
    const result = await this.post(METRICS, { mpl, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() });
    return metricSeries(result, start, end);
  }
  async rows(query: string, start: number, end: number): Promise<Row[]> {
    // Explicit source bounds also protect against query-range alignment and
    // accidental all-history evaluation after changing an aggregation.
    const source = `['papertrail'] | where _time >= datetime(${new Date(start).toISOString()}) and _time < datetime(${new Date(end).toISOString()})`;
    const result = await this.post(`${API}/datasets/_apl?format=legacy`, {
      apl: `${source} ${query}`, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
    });
    if (result.status?.isPartial !== false || !Array.isArray(result.matches)) throw new Error("incomplete APL result");
    if (result.matches.length) return result.matches.map((match: any) => {
      if (!match.data || typeof match.data !== "object") throw new Error("invalid APL row");
      return match.data as Row;
    });
    // Scalar aggregations (including a real count of zero) use totals rather
    // than matches. A grouped empty input also has a synthetic global total;
    // without the requested group keys, that total is not a host observation.
    const groupKeys: string[] = result.request?.groupBy ?? [];
    if (!Array.isArray(groupKeys) || groupKeys.some(key => typeof key !== "string")) throw new Error("invalid APL grouping");
    return (result.buckets?.totals ?? [])
      .filter((group: any) => groupKeys.every(key => Object.hasOwn(group.group ?? {}, key)))
      .map((group: any) => {
        if (!group.group || typeof group.group !== "object" || !Array.isArray(group.aggregations)) throw new Error("invalid APL aggregate");
        const row: Row = { ...group.group };
        for (const aggregate of group.aggregations) {
          if (typeof aggregate.op !== "string" || Object.hasOwn(row, aggregate.op)) throw new Error("invalid APL aggregate alias");
          row[aggregate.op] = aggregate.value;
        }
        return row;
      });
  }
  async ingest(event: Row): Promise<void> {
    const result = await this.post(`${API}/datasets/papertrail/ingest`, [event], true);
    if (result.ingested !== 1 || result.failed !== 0) throw new Error("event ingest was not fully accepted");
  }
  async accepted(event: Transition, now: number): Promise<boolean> {
    const id = event.eventId;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid event identifier");
    const rows = await this.rows(`| where source == 'host-incidents' and eventId == '${id}' | summarize accepted = count() | project accepted`, event.observedAt - MINUTE, now);
    if (rows.length !== 1 || typeof rows[0].accepted !== "number") throw new Error("invalid reconciliation result");
    return rows[0].accepted > 0;
  }
}

/** Legacy APL totals encode datetimes as Unix nanoseconds; row projections use RFC3339. */
export function logSampleTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value / 1_000_000) : NaN;
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function metricSeries(result: any, start: number, end: number): Series[] {
  if (!Array.isArray(result.series) || result.error || result.status?.isPartial === true) throw new Error("missing or incomplete metrics result");
  return result.series.map((series: any) => {
    if (!series.tags || typeof series.tags["host.name"] !== "string" || !Number.isFinite(series.start) || !(series.resolution > 0) || !Array.isArray(series.data)) throw new Error("invalid metric series");
    const points: Point[] = [];
    series.data.forEach((value: unknown, index: number) => {
      if (value === null) return;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid metric value");
      const at = (series.start + index * series.resolution) * 1000;
      if (at >= start && at < end) points.push({ at, value });
    });
    return { tags: series.tags, points };
  });
}

// incident kinds; the names are part of each incident's key, so they stay stable
// even though the thresholds now come from the host.
export const DISK_KINDS = {
  critical: "hosts: critical disk space (below 2 GiB)",
  low: "hosts: low disk headroom (below 8 GiB)",
  capacity: "hosts: storage capacity running low",
} as const;
/** kinds no host can declare any more; their open incidents close as "no longer monitored". */
const RETIRED_DISK_KINDS = ["hosts: filesystem nearly full (below 10% free)"];
export const isDiskKind = (kind: string) => Object.values<string>(DISK_KINDS).includes(kind) || RETIRED_DISK_KINDS.includes(kind);

const FREE_BYTES = '`host-metrics`:`system.filesystem.usage` | where state == "free" and mode == "rw" | group by `host.name`, mountpoint using min | align to 30s using min';
const FREE_FRACTION = '(`host-metrics`:`system.filesystem.usage` | where state == "free" and mode == "rw" | group by `host.name`, mountpoint using min, `host-metrics`:`system.filesystem.usage` | where mode == "rw" | group by `host.name`, mountpoint, state using max | group by `host.name`, mountpoint using sum) | compute free_fraction using / | align to 30s using min';

/**
 * one host-declared level against the recent samples. the ledger holds the
 * "stayed bad for afterMinutes" part: anything unknown in between (stale samples,
 * a sleeping laptop, a value inside the hysteresis band) restarts that clock.
 * a level that waits must see every recent sample bad, so a dip and a recovery
 * inside one poll don't count as "still low". an immediate level reacts to the
 * lowest sample, as before.
 */
export function diskObservation(kind: string, level: { bad: number; healthy: number; afterMinutes: number; unit: "bytes" | "fraction" },
    host: string, mount: string, points: Point[], now: number): Observation {
  const key = JSON.stringify([kind, host, mount]);
  const immediate = level.afterMinutes === 0;
  const base = { key, kind, host, mount, observedAt: now, detail: {},
    ...(immediate ? { critical: true } : { qualifyAfterMs: level.afterMinutes * MINUTE }) };
  if (!points.length) return { ...base, status: "unknown" };
  const sampleAt = Math.max(...points.map(p => p.at));
  const lowest = Math.min(...points.map(p => p.value));
  const highest = Math.max(...points.map(p => p.value));
  if (lowest < 0 || (level.unit === "fraction" && highest > 1) || now - sampleAt > 2 * MINUTE) return { ...base, status: "unknown" };
  const value = level.afterMinutes === 0 ? lowest : highest;
  return {
    ...base, sampleAt,
    // recovery always needs every sample healthy, whichever way badness is read.
    status: value < level.bad ? "bad" : lowest >= level.healthy ? "healthy" : "unknown",
    detail: { value, threshold: level.bad, recoveredAt: level.healthy, unit: level.unit, afterMinutes: level.afterMinutes },
  };
}

export async function observations(client: Axiom, config: Configuration, now: number, request: typeof fetch = fetch, clock: () => number = Date.now): Promise<{ observations: Observation[]; errors: string[] }> {
  const rules: Rule[] = JSON.parse(readFileSync(config.rulesPath, "utf8"));
  const disks = hostDisks(config);
  const expectations = config.externalExpectations ?? [];
  validateExpectations(expectations, new Set(rules.filter(rule => rule.type === "Threshold" && rule.name.startsWith("hosts: telemetry missing"))
    .map(rule => rule.mplQuery?.match(/`host.name` == "([a-z0-9.-]+)"/)?.[1]).filter((host): host is string => !!host && Object.hasOwn(disks, host))));
  const hosts = Object.keys(disks);
  const errors: string[] = [];
  const safe = async <T>(name: string, operation: () => Promise<T>): Promise<T | undefined> => {
    try { return await operation(); } catch { errors.push(name); return undefined; }
  };
  const uptime = await safe("uptime", () => client.metrics("`host-metrics`:`system.uptime` | group by `host.name` using max | align to 30s using max", now - 15 * MINUTE, now));
  const hostPoints = (host: string) => uptime?.filter(s => s.tags["host.name"] === host).flatMap(s => s.points) ?? [];
  const freshAt = (host: string) => {
    const points = hostPoints(host).filter(p => now - p.at <= 2 * MINUTE && p.value >= 0);
    return points.length ? Math.max(...points.map(p => p.at)) : undefined;
  };
  const result: Observation[] = [];
  // Sequential queries stay within Axiom's query concurrency budget; a timer
  // cannot overlap another instance of the same systemd oneshot service.
  const declared = Object.entries(disks).flatMap(([host, disks]) => Object.entries(disks.mounts).map(([mount, policy]) => ({ host, mount, policy })));
  const pointsFor = (series: Series[] | undefined, host: string, mount: string) =>
    series?.filter(s => s.tags["host.name"] === host && s.tags.mountpoint === mount).flatMap(s => s.points) ?? [];
  if (declared.some(d => d.policy.critical || d.policy.low)) {
    const bytes = await safe("disk free bytes", () => client.metrics(FREE_BYTES, now - 2 * MINUTE, now));
    for (const { host, mount, policy } of declared) for (const name of ["critical", "low"] as const) {
      const level = policy[name];
      if (level) result.push(diskObservation(DISK_KINDS[name], { bad: level.below, healthy: level.recover, afterMinutes: level.afterMinutes, unit: "bytes" }, host, mount, pointsFor(bytes, host, mount), now));
    }
  }
  if (declared.some(d => d.policy.capacity)) {
    const fraction = await safe("disk free fraction", () => client.metrics(FREE_FRACTION, now - 2 * MINUTE, now));
    for (const { host, mount, policy } of declared) if (policy.capacity) {
      const c = policy.capacity;
      result.push(diskObservation(DISK_KINDS.capacity, { bad: c.belowFraction, healthy: c.recoverFraction, afterMinutes: c.afterMinutes, unit: "fraction" }, host, mount, pointsFor(fraction, host, mount), now));
    }
  }
  for (const rule of rules.filter(r => r.type === "Threshold")) {
    // disk rules in monitors.json only mirror the raw Axiom charts; paging follows each host's declaration above.
    if (isDiskKind(rule.name)) continue;
    if (rule.name.startsWith("hosts: telemetry missing")) {
      const host = rule.mplQuery?.match(/`host.name` == "([a-z0-9.-]+)"/)?.[1];
      if (!host || !hosts.includes(host)) throw new Error("unknown expected telemetry host");
      const at = freshAt(host);
      result.push({ key: JSON.stringify([rule.name, host]), kind: rule.name, host, observedAt: now,
        status: !uptime ? "unknown" : at !== undefined ? "healthy" : hostPoints(host).length ? "unknown" : "bad",
        // A successful empty query is evidence of expected-host absence; each
        // distinct evaluation is a new absence observation, not a stale sample.
        sampleAt: at ?? (uptime && !hostPoints(host).length ? now : undefined), critical: true, detail: { expected: true } });
    } else if (rule.name.startsWith("hosts: storage guard")) {
      const host = "htz-xfs-lab";
      const rows = await safe(rule.name, () => client.rows("| where ['resource.host.name'] == 'htz-xfs-lab' | extend record = parse_json(tostring(body)), sampled_at = _time | where tostring(record._SYSTEMD_UNIT) == 'working-storage-health.service' | extend health = parse_json(tostring(record.MESSAGE)) | summarize arg_max(sampled_at, health) by host = ['resource.host.name'] | project host, sampled_at, healthy = tobool(health.healthy)", now - 15 * MINUTE, now));
      const row = rows?.find(r => r.host === host);
      const at = row ? logSampleTime(row.sampled_at) : undefined;
      const valid = !row || (typeof row.healthy === "boolean" && Number.isFinite(at));
      if (!valid) errors.push(`${rule.name}: invalid sample`);
      result.push({ key: JSON.stringify([rule.name, host]), kind: rule.name, host, observedAt: now,
        status: !rows || !valid ? "unknown" : !row ? "bad" : row.healthy === false ? "bad" : row.healthy === true && at !== undefined && now - at < 15 * MINUTE ? "healthy" : "unknown",
        sampleAt: row && at !== undefined && now - at < 15 * MINUTE ? at : rows && !row ? now : undefined,
        critical: true, detail: { healthy: typeof row?.healthy === "boolean" ? row.healthy : null, sampleAt: at ?? null } });
    } else if (rule.name.startsWith("hosts: kernel killed")) {
      const rows = await safe(rule.name, () => client.rows("| extend record = parse_json(tostring(body)), sampled_at = _time | where tostring(record._TRANSPORT) == 'kernel' | extend message = tolower(tostring(record.MESSAGE)) | where message contains 'killed process' and message contains 'out of memory' | summarize kills = count(), sampled_at = max(sampled_at) by host = ['resource.host.name'] | project host, kills, sampled_at", now - 5 * MINUTE, now));
      const valid = rows?.every(row => typeof row.host === "string" && typeof row.kills === "number" && Number.isInteger(row.kills) && row.kills > 0 && logSampleTime(row.sampled_at) >= now - 5 * MINUTE && logSampleTime(row.sampled_at) < now);
      if (rows && !valid) errors.push(`${rule.name}: invalid sample`);
      for (const host of hosts) {
        const row = rows?.find(r => r.host === host);
        result.push({ key: JSON.stringify([rule.name, host]), kind: rule.name, host, observedAt: now,
          status: !valid ? "unknown" : row && Number(row.kills) > 0 ? "bad" : freshAt(host) !== undefined ? "healthy" : "unknown",
          sampleAt: row ? logSampleTime(row.sampled_at) : freshAt(host), critical: true, detail: { kills: Number(row?.kills ?? 0) } });
      }
    } else if (rule.name !== "hosts: incident evaluator stalled") {
      throw new Error(`unsupported host threshold rule: ${rule.name}`);
    }
  }
  const external = await externalObservations(client, expectations, freshAt, now, request, clock);
  result.push(...external.observations);
  errors.push(...external.errors);
  return { observations: result, errors };
}

/** the condition as a person reads it: a disk level names its own threshold, not the kind's legacy default. */
function describe(event: Transition): string {
  const { threshold, unit } = event.detail;
  if (!isDiskKind(event.kind) || typeof threshold !== "number") return event.kind;
  const limit = unit === "fraction" ? `${Math.round(threshold * 100)}% free` : `${Math.round(threshold / GIB * 10) / 10} GiB`;
  const name = event.kind === DISK_KINDS.capacity ? "storage capacity running low" : event.kind === DISK_KINDS.critical ? "critical disk space" : "low disk headroom";
  return `hosts: ${name} (below ${limit})`;
}

export function notification(event: Transition, test = false): Row {
  return {
    // Match monitors consume new ingestions. Queue delay must not backdate the
    // transport record outside its scan range; measurement time stays separate.
    _time: new Date().toISOString(), source: test ? "host-incidents-test" : "host-incidents",
    eventId: event.eventId, incidentId: event.incidentId, action: event.action,
    timestamp: new Date(event.observedAt).toISOString(),
    title: `${test ? "transport-test: " : ""}${event.action === "Open" ? "incident started" : event.detail.retired === true ? "no longer monitored" : "recovered"}: ${describe(event)} — ${event.host}${event.mount ? ` ${event.mount}` : ""}`,
    host: event.host, mountpoint: event.mount ?? "", condition: event.kind,
    groupKeys: ["host.name", ...(event.mount ? ["mountpoint"] : [])],
    groupValues: [event.host, ...(event.mount ? [event.mount] : [])],
    sampleAt: event.sampleAt === undefined ? null : new Date(event.sampleAt).toISOString(), evidenceJson: JSON.stringify(event.detail),
  };
}
