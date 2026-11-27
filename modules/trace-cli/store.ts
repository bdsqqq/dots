import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service?: string;
  startNs: number;
  endNs: number;
  status?: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean>;
}

export const defaultStorePath = () =>
  process.env.TRACE_CLI_STORE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "trace-cli", "spans.jsonl");

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
/** OTLP nanos arrive as strings or numbers; null/absent must not coerce to epoch zero. */
const nanos = (v: unknown) => ((typeof v === "string" && v.trim() !== "") || typeof v === "number" ? Number(v) : NaN);
const value = (v: AnyValue | undefined) =>
  v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : (v?.doubleValue ?? v?.boolValue));

/** flatten an OTLP/HTTP JSON export into spans. unknown shapes yield []. */
export function parseOtlp(body: any): Span[] {
  const out: Span[] = [];
  for (const rs of body?.resourceSpans ?? []) {
    const res = Object.fromEntries((rs.resource?.attributes ?? []).map((a: any) => [a.key, value(a.value)]));
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attributes: Span["attributes"] = {};
        for (const a of s.attributes ?? []) {
          const v = value(a.value);
          if (v !== undefined) attributes[a.key] = v;
        }
        const code = s.status?.code;
        out.push({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          name: s.name,
          service: typeof res["service.name"] === "string" ? res["service.name"] : undefined,
          startNs: nanos(s.startTimeUnixNano),
          endNs: nanos(s.endTimeUnixNano),
          status: code === 2 || code === "STATUS_CODE_ERROR" ? "error" : code === 1 || code === "STATUS_CODE_OK" ? "ok" : "unset",
          attributes,
        });
      }
    }
  }
  return out;
}

export function append(path: string, spans: Span[]) {
  if (!spans.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

export function load(path: string): Span[] {
  if (!existsSync(path)) return [];
  const seen = new Map<string, Span>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const s = JSON.parse(line) as Span;
    seen.set(`${s.traceId}/${s.spanId}`, s); // dedupe: pull + live tail can overlap
  }
  return [...seen.values()];
}

export const durationMs = (s: Span) => (s.endNs - s.startNs) / 1e6;

export interface TraceSummary { traceId: string; root: string; spans: number; errors: number; durationMs: number; startNs: number }

export function summarize(spans: Span[]): TraceSummary[] {
  const by = new Map<string, Span[]>();
  for (const s of spans) by.set(s.traceId, [...(by.get(s.traceId) ?? []), s]);
  return [...by].map(([traceId, ss]) => {
    const start = Math.min(...ss.map((s) => s.startNs));
    const end = Math.max(...ss.map((s) => s.endNs));
    const root = ss.find((s) => !s.parentSpanId) ?? ss.toSorted((a, b) => a.startNs - b.startNs)[0]!;
    return { traceId, root: root.name, spans: ss.length, errors: ss.filter((s) => s.status === "error").length, durationMs: (end - start) / 1e6, startNs: start };
  }).sort((a, b) => b.startNs - a.startNs);
}

export function tree(spans: Span[], traceId: string): string {
  const ss = spans.filter((s) => s.traceId.startsWith(traceId)).sort((a, b) => a.startNs - b.startNs);
  const ids = new Set(ss.map((s) => s.spanId));
  const kids = new Map<string | undefined, Span[]>();
  for (const s of ss) {
    const p = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : undefined; // orphans render as roots
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const lines: string[] = [];
  const walk = (p: string | undefined, depth: number) => {
    for (const s of kids.get(p) ?? []) {
      const attrs = Object.entries(s.attributes).map(([k, v]) => `${k}=${v}`).join(" ");
      lines.push(`${"  ".repeat(depth)}${s.name} ${durationMs(s).toFixed(2)}ms${s.status === "error" ? " ERROR" : ""}${s.service ? ` [${s.service}]` : ""}${attrs ? ` ${attrs}` : ""}`);
      walk(s.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines.join("\n");
}

export function percentiles(spans: Span[]) {
  const by = new Map<string, number[]>();
  for (const s of spans) by.set(s.name, [...(by.get(s.name) ?? []), durationMs(s)]);
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  return [...by].map(([name, xs]) => {
    xs.sort((a, b) => a - b);
    return { name, count: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), p99: q(xs, 0.99), max: xs.at(-1)! };
  }).sort((a, b) => b.p95 - a.p95);
}

export interface Assertion { name: string; minCount?: number; maxCount?: number; maxP95Ms?: number; noErrors?: boolean }

export function assertSpans(spans: Span[], checks: Assertion[]): string[] {
  const failures: string[] = [];
  for (const c of checks) {
    const m = spans.filter((s) => s.name === c.name);
    if (c.minCount !== undefined && m.length < c.minCount) failures.push(`${c.name}: ${m.length} spans, want >= ${c.minCount}`);
    if (c.maxCount !== undefined && m.length > c.maxCount) failures.push(`${c.name}: ${m.length} spans, want <= ${c.maxCount}`);
    if (c.noErrors && m.some((s) => s.status === "error")) failures.push(`${c.name}: has error spans`);
    if (c.maxP95Ms !== undefined && m.length) {
      const p = percentiles(m)[0]!.p95;
      if (p > c.maxP95Ms) failures.push(`${c.name}: p95 ${p.toFixed(2)}ms > ${c.maxP95Ms}ms`);
    }
  }
  return failures;
}
