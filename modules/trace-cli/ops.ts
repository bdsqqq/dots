import { safeErrorCode, type createEventLogger } from "../service-events/events.ts";
import { append, parseOtlp, type Span } from "./store.ts";

export type Events = ReturnType<typeof createEventLogger>;

export interface Deps {
  store: string;
  events: Events;
  /** best-effort relay of the raw batch; absent when forwarding is off. */
  forward?: (raw: Buffer) => Promise<void>;
}

export type IngestResult =
  | { status: "ingested"; spanCount: number; forwarded: boolean }
  | { status: "rejected"; reasonCode: "PROTOBUF_UNSUPPORTED" | "INVALID_JSON" | "INVALID_SPAN" }
  | { status: "failed"; reasonCode: "STORE_WRITE_FAILED" };

/** the fields every reader (show, grep, tail, stats) dereferences. */
export const validSpan = (s: Span) =>
  typeof s.traceId === "string" && s.traceId !== "" && typeof s.spanId === "string" && s.spanId !== "" &&
  typeof s.name === "string" && Number.isFinite(s.startNs) && Number.isFinite(s.endNs) &&
  Number.isFinite(new Date(s.startNs / 1e6).getTime()); // readers format the start time as a date

/**
 * One OTLP/HTTP JSON batch into the local store. Shared by the HTTP receiver and
 * `trace-cli ingest`. Emits one event; span names and attributes stay out of it
 * because spans can carry values the event contract forbids.
 */
export async function ingest(deps: Deps, raw: Buffer, contentType = "application/json"): Promise<IngestResult> {
  const op = deps.events.begin("ingest.batch", "background", { requestBytes: raw.length });
  if (contentType.includes("protobuf")) {
    op.finish("failed", { reasonCode: "PROTOBUF_UNSUPPORTED" });
    return { status: "rejected", reasonCode: "PROTOBUF_UNSUPPORTED" };
  }
  let spans: Span[];
  try {
    spans = parseOtlp(JSON.parse(raw.toString()));
  } catch {
    op.finish("failed", { reasonCode: "INVALID_JSON" });
    return { status: "rejected", reasonCode: "INVALID_JSON" };
  }
  if (!spans.every(validSpan)) {
    op.finish("failed", { reasonCode: "INVALID_SPAN", itemCount: spans.length });
    return { status: "rejected", reasonCode: "INVALID_SPAN" };
  }
  try {
    append(deps.store, spans);
  } catch (error) {
    op.finish("failed", { errorCode: safeErrorCode(error), reasonCode: "STORE_WRITE_FAILED", itemCount: spans.length });
    return { status: "failed", reasonCode: "STORE_WRITE_FAILED" };
  }
  if (!deps.forward) {
    op.finish("succeeded", { itemCount: spans.length });
    return { status: "ingested", spanCount: spans.length, forwarded: false };
  }
  try {
    await deps.forward(raw);
    op.finish("succeeded", { itemCount: spans.length });
    return { status: "ingested", spanCount: spans.length, forwarded: true };
  } catch (error) {
    // local store is the source of truth; a failed relay degrades, it does not reject.
    op.finish("degraded", { itemCount: spans.length, errorCode: safeErrorCode(error), reasonCode: "FORWARD_FAILED" });
    return { status: "ingested", spanCount: spans.length, forwarded: false };
  }
}

export interface AxiomRow {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  "service.name"?: string;
  _time: string;
  duration?: number | string;
  "status.code"?: string;
  "attributes.custom"?: Span["attributes"];
}

/**
 * `axiom query --format json` prints one JSON object per row, or `[]` when empty
 * (axiomhq/cli internal/cmd/query/query.go). Accept a JSON array too, and indented
 * objects: scan top-level values rather than splitting on newlines.
 */
export function parseAxiomRows(out: string): AxiomRow[] {
  const text = out.trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    const all = JSON.parse(text);
    if (!Array.isArray(all) || !all.every((x) => x && typeof x === "object" && !Array.isArray(x))) throw new Error("unrecognized axiom output");
    return all;
  }
  const rows: AxiomRow[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (depth === 0) {
      // between rows only whitespace or the start of the next object is valid
      if (c === "{") { depth = 1; start = i; } else if (!/\s/.test(c)) throw new Error("unrecognized axiom output");
      continue;
    }
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) rows.push(JSON.parse(text.slice(start, i + 1)));
  }
  if (depth !== 0 || inString) throw new Error("truncated axiom output");
  return rows;
}

export function rowsToSpans(rows: AxiomRow[]): Span[] {
  return rows.map((x): Span => {
    const startNs = Date.parse(x._time) * 1e6;
    return {
      traceId: x.trace_id,
      spanId: x.span_id,
      parentSpanId: x.parent_span_id || undefined,
      name: x.name,
      service: x["service.name"],
      startNs,
      endNs: startNs + Number(x.duration ?? 0),
      status: x["status.code"] === "ERROR" ? "error" : "unset",
      attributes: x["attributes.custom"] ?? {},
    };
  }).filter(validSpan);
}

export interface PullDeps {
  store: string;
  events: Events;
  /** runs an APL query and returns rows; the CLI binds this to `axiom query`. */
  query: (apl: string) => AxiomRow[];
}

export type PullResult = { status: "pulled"; spanCount: number } | { status: "failed"; reasonCode: "QUERY_FAILED" };

export function pull(deps: PullDeps, dataset: string, since: string): PullResult {
  const op = deps.events.begin("pull.axiom", "background");
  // field names follow axiom's otel trace schema; unverified against a live dataset.
  const apl = `['${dataset}'] | where _time > ago(${since}) | project trace_id, span_id, parent_span_id, name, ['service.name'], _time, duration, ['status.code'], ['attributes.custom']`;
  try {
    const spans = rowsToSpans(deps.query(apl));
    append(deps.store, spans);
    op.finish("succeeded", { itemCount: spans.length });
    return { status: "pulled", spanCount: spans.length };
  } catch (error) {
    op.finish("failed", { errorCode: safeErrorCode(error), reasonCode: "QUERY_FAILED" });
    return { status: "failed", reasonCode: "QUERY_FAILED" };
  }
}

export interface RunDeps {
  store: string;
  events: Events;
  now?: () => number;
  id?: (bytes: number) => string;
  /** runs argv with env, inheriting stdio; returns the exit code (null when killed by a signal). */
  exec: (argv: string[], env: Record<string, string | undefined>) => number | null;
}

export type RunResult =
  | { status: "ran"; exitCode: number; traceId: string; spanId: string }
  | { status: "failed"; reasonCode: "EMPTY_COMMAND" }
  /** the command ran but its span could not be stored; exitCode is the command's. */
  | { status: "failed"; reasonCode: "STORE_WRITE_FAILED"; exitCode: number };

const traceparent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Time one command as a span. A TRACEPARENT in `env` makes it a child; the command gets its own
 * TRACEPARENT, so nested `trace-cli run` calls (or OTel-aware tools) join the same trace.
 * Argv is never recorded: commands can carry secrets. The caller supplies a name.
 */
export function run(deps: RunDeps, name: string, argv: string[], env: Record<string, string | undefined>, attributes: Span["attributes"] = {}): RunResult {
  const op = deps.events.begin("run.command", "background");
  if (!argv.length) { op.finish("failed", { reasonCode: "EMPTY_COMMAND" }); return { status: "failed", reasonCode: "EMPTY_COMMAND" }; }
  const now = deps.now ?? (() => Date.now() * 1e6);
  const id = deps.id ?? ((n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const parent = traceparent.exec(env.TRACEPARENT ?? "");
  const traceId = parent?.[1] ?? id(16);
  const spanId = id(8);
  const startNs = now();
  const code = deps.exec(argv, { ...env, TRACEPARENT: `00-${traceId}-${spanId}-01` });
  const exitCode = code ?? 128;
  try {
    append(deps.store, [{ traceId, spanId, parentSpanId: parent?.[2], name, service: "trace-cli", startNs, endNs: now(), status: exitCode === 0 ? "ok" : "error", attributes: { ...attributes, exitCode } }]);
  } catch (error) {
    op.finish("failed", { statusCode: exitCode, errorCode: safeErrorCode(error), reasonCode: "STORE_WRITE_FAILED" });
    return { status: "failed", reasonCode: "STORE_WRITE_FAILED", exitCode };
  }
  op.finish(exitCode === 0 ? "succeeded" : "failed", { statusCode: exitCode });
  return { status: "ran", exitCode, traceId, spanId };
}
