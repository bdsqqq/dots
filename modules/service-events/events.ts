import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export type Traffic = "browser" | "probe" | "background" | "unknown";
export type Outcome = "succeeded" | "failed" | "degraded" | "skipped";

/** Deliberately bounded metadata: never pass bodies, URLs, paths, headers, or error messages. */
export interface EventContext {
  method?: string;
  route?: string;
  statusCode?: number;
  errorCode?: string;
  reasonCode?: string;
  ready?: boolean;
  readiness?: string;
  fromState?: string;
  toState?: string;
  trigger?: string;
  action?: string;
  attempt?: number;
  retryInMs?: number;
  itemCount?: number;
  changedCount?: number;
  missingCount?: number;
  candidateCount?: number;
  providerCount?: number;
  healthyProviderCount?: number;
  unhealthyProviderCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  sourceAvailable?: boolean;
  enrolled?: boolean;
  connected?: boolean;
  changed?: boolean;
  generation?: number;
  observationCount?: number;
  queryErrorCount?: number;
  transitionCount?: number;
  deliveryErrorCount?: number;
  pendingCount?: number;
  uncertainCount?: number;
}

export interface ServiceEvent {
  schemaVersion: 1;
  timestamp: string;
  eventId: string;
  operationId: string;
  service: string;
  host: string;
  operation: string;
  traffic: Traffic;
  outcome: Outcome;
  durationMs: number;
  context: EventContext;
}

const stringKeys = new Set([
  "method", "route", "errorCode", "reasonCode", "readiness", "fromState", "toState", "trigger", "action",
]);
const booleanKeys = new Set(["ready", "sourceAvailable", "enrolled", "connected", "changed"]);
const numberKeys = new Set([
  "statusCode", "attempt", "retryInMs", "itemCount", "changedCount", "missingCount", "candidateCount",
  "providerCount", "healthyProviderCount", "unhealthyProviderCount", "requestBytes", "responseBytes",
  "generation", "observationCount", "queryErrorCount", "transitionCount", "deliveryErrorCount",
  "pendingCount", "uncertainCount",
]);
const symbol = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;

function context(values: EventContext): EventContext {
  const result: Record<string, string | boolean | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (stringKeys.has(key) && typeof value === "string" && symbol.test(value)) result[key] = value;
    if (booleanKeys.has(key) && typeof value === "boolean") result[key] = value;
    if (numberKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

/** Browser-like traffic is a user-agent hint, NOT attribution to a human or a user session. */
export function classifyHttpTraffic(userAgent: string | null | undefined, route: string): Traffic {
  if (["health", "healthz", "manifest"].includes(route)) return "probe";
  if (/^(tailnet-registry|service-probe|cloudflare-origin-probe)\//i.test(userAgent ?? "")) return "probe";
  if (/Mozilla\//i.test(userAgent ?? "")) return "browser";
  return "unknown";
}

/** Preserve useful failure categories without leaking exception messages, paths, or credentials. */
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && new Set([
    "ENOENT", "EACCES", "EPERM", "EADDRINUSE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
    "ENOSPC", "EIO", "ABORT_ERR", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_URL",
  ]).has(code)) return code;
  if (error instanceof Error && error.name === "AbortError") return "ABORTED";
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "UNEXPECTED_ERROR";
}

export interface LoggerOptions {
  sink?: (event: ServiceEvent) => void;
  host?: string;
  now?: () => number;
  monotonic?: () => number;
  id?: () => string;
}

/**
 * One completion event per significant operation. IDs are generated locally, never taken
 * from incoming headers. The sink is orthogonal to instrumentation; stdout works with both
 * journald and launchd file collection. Packaging must retain this imported module.
 */
export function createEventLogger(service: string, options: LoggerOptions = {}) {
  if (!symbol.test(service)) throw new Error("invalid event service name");
  const sink = options.sink ?? ((event: ServiceEvent) => { process.stdout.write(`${JSON.stringify(event)}\n`); });
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const id = options.id ?? randomUUID;
  const host = options.host ?? hostname();
  return {
    begin(operation: string, traffic: Traffic = "background", initial: EventContext = {}) {
      if (!symbol.test(operation)) throw new Error("invalid event operation name");
      const operationId = id();
      const started = monotonic();
      const initialContext = context(initial);
      let completed: ServiceEvent | undefined;
      return {
        operationId,
        finish(outcome: Outcome, values: EventContext = {}): ServiceEvent {
          if (completed) return completed;
          completed = {
            schemaVersion: 1,
            timestamp: new Date(now()).toISOString(),
            eventId: id(),
            operationId,
            service,
            host,
            operation,
            traffic,
            outcome,
            durationMs: Math.max(0, Math.round((monotonic() - started) * 1000) / 1000),
            context: { ...initialContext, ...context(values) },
          };
          // An unavailable log sink must not turn an otherwise successful domain operation into a failure.
          try { sink(completed); } catch { /* best-effort transport; collector health is monitored separately */ }
          return completed;
        },
      };
    },
  };
}
