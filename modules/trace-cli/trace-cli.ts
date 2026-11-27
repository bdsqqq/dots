#!/usr/bin/env node
import { readFileSync, watchFile } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createEventLogger } from "../service-events/events.ts";
import { ingest, parseAxiomRows, pull, run } from "./ops.ts";
import { assertSpans, defaultStorePath, durationMs, load, percentiles, summarize, tree, type Span } from "./store.ts";

const usage = `trace-cli <command>
  serve [--port 4318] [--forward-axiom <dataset>]   OTLP/HTTP JSON receiver on 127.0.0.1
  list [--json]                                     recent traces
  show <traceId>                                    indented span tree
  tail                                              follow live spans
  grep --name <span> [--attr k=v]                   find spans
  stats                                             latency percentiles per span name
  diff <a> <b>                                      compare two traces
  assert <file.json>                                declarative checks: [{name, minCount, noErrors, maxMedianMs, window, minSamples}]
  ingest <file.json>                                import a saved OTLP JSON export
  run <name> -- <cmd...>                            time a command as a span; nested runs form a tree (TRACEPARENT)
  pull --axiom <dataset> [--since 1h]               import spans from an Axiom traces dataset
env: TRACE_CLI_STORE (default ~/.local/state/trace-cli/spans.jsonl), AXIOM_TOKEN for forwarding`;

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const store = defaultStorePath();
const fmt = (s: Span) => `${new Date(s.startNs / 1e6).toISOString()} ${s.traceId.slice(0, 8)} ${s.name} ${durationMs(s).toFixed(2)}ms${s.status === "error" ? " ERROR" : ""}`;

const events = createEventLogger("trace-cli");
const stderrEvents = createEventLogger("trace-cli", { sink: (e) => { process.stderr.write(`${JSON.stringify(e)}\n`); } });

function forwarder(dataset: string | undefined) {
  if (!dataset) return undefined;
  const token = process.env.AXIOM_TOKEN;
  if (!token) { console.error("--forward-axiom needs AXIOM_TOKEN"); process.exit(2); }
  return async (raw: Buffer) => {
    const r = await fetch("https://api.axiom.co/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-axiom-dataset": dataset },
      body: new Uint8Array(raw),
    });
    if (!r.ok) throw Object.assign(new Error("relay rejected"), { code: "RELAY_REJECTED" });
  };
}

function serve() {
  const port = Number(flag("port") ?? 4318);
  const deps = { store, events, forward: forwarder(flag("forward-axiom")) };
  const status = { ingested: 200, rejected: 400 } as const;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const result = await ingest(deps, Buffer.concat(chunks), req.headers["content-type"]);
      if (result.status === "ingested") res.writeHead(status.ingested, { "content-type": "application/json" }).end("{}");
      else if (result.status === "failed") res.writeHead(500).end("store write failed");
      else if (result.reasonCode === "PROTOBUF_UNSUPPORTED") res.writeHead(415).end("send OTLP JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)");
      else res.writeHead(status.rejected).end(result.reasonCode === "INVALID_SPAN" ? "span missing traceId, spanId, name or timestamps" : "bad otlp json");
    });
  });
  server.listen(port, "127.0.0.1", () => console.error(`otlp/http receiver on 127.0.0.1:${port}, store ${store}`));
}

function tail() {
  let seen = load(store).length;
  watchFile(store, { interval: 300 }, () => {
    const all = load(store);
    for (const s of all.slice(seen)) console.log(fmt(s));
    seen = all.length;
  });
}

function pullCmd() {
  const dataset = flag("axiom");
  if (!dataset) throw new Error("pull needs --axiom <dataset>");
  const query = (apl: string) => {
    const r = spawnSync("axiom", ["query", apl, "--format", "json", ...(process.env.AXIOM_DEPLOYMENT ? ["-D", process.env.AXIOM_DEPLOYMENT] : [])], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("axiom query failed");
    return parseAxiomRows(r.stdout);
  };
  const result = pull({ store, events: stderrEvents, query }, dataset, flag("since") ?? "1h");
  console.error(result.status === "pulled" ? `pulled ${result.spanCount} spans` : `pull failed: ${result.reasonCode}`);
  process.exitCode = result.status === "pulled" ? 0 : 1;
}

async function ingestCmd() {
  const result = await ingest({ store, events: stderrEvents }, readFileSync(args[0] ?? ""));
  console.error(result.status === "ingested" ? `ingested ${result.spanCount} spans` : `${result.status}: ${result.reasonCode}`);
  process.exitCode = result.status === "ingested" ? 0 : 1;
}

async function runCmd() {
  const sep = args.indexOf("--");
  const name = args[0] ?? "";
  const exec = (argv: string[], env: Record<string, string | undefined>) =>
    spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", env }).status;
  const result = await run({ store, events: stderrEvents, exec }, name, sep < 0 ? [] : args.slice(sep + 1), process.env);
  if (result.status === "failed" && result.reasonCode === "EMPTY_COMMAND") { console.error(`run needs: <name> -- <cmd...>`); process.exit(2); }
  if (result.status === "failed") { console.error("could not record span (store write failed)"); process.exit(result.exitCode || 1); }
  console.error(`trace ${result.traceId} span ${result.spanId} exit ${result.exitCode}`);
  process.exit(result.exitCode);
}

switch (cmd) {
  case "serve": serve(); break;
  case "list": {
    const t = summarize(load(store)).slice(0, 50);
    if (args.includes("--json")) console.log(JSON.stringify(t, null, 2));
    else for (const x of t) console.log(`${x.traceId} ${x.root} ${x.spans} spans ${x.durationMs.toFixed(2)}ms${x.errors ? ` ${x.errors} errors` : ""}`);
    break;
  }
  case "show": console.log(tree(load(store), args[0] ?? "")); break;
  case "tail": tail(); break;
  case "grep": {
    const name = flag("name"); const attr = flag("attr")?.split("=");
    for (const s of load(store)) if ((!name || s.name === name) && (!attr || String(s.attributes[attr[0]!]) === attr[1])) console.log(fmt(s));
    break;
  }
  case "stats": for (const p of percentiles(load(store))) console.log(`${p.name} n=${p.count} p50=${p.p50.toFixed(2)} p95=${p.p95.toFixed(2)} p99=${p.p99.toFixed(2)} max=${p.max.toFixed(2)}`); break;
  case "diff": {
    const all = load(store);
    const names = (id: string) => { const m = new Map<string, number>(); for (const s of all.filter((x) => x.traceId.startsWith(id))) m.set(s.name, (m.get(s.name) ?? 0) + durationMs(s)); return m; };
    const a = names(args[0] ?? ""), b = names(args[1] ?? "");
    for (const n of new Set([...a.keys(), ...b.keys()])) console.log(`${n} ${a.get(n)?.toFixed(2) ?? "-"}ms -> ${b.get(n)?.toFixed(2) ?? "-"}ms`);
    break;
  }
  case "assert": {
    const { failures, skipped } = assertSpans(load(store), JSON.parse(readFileSync(args[0] ?? "", "utf8")));
    for (const s of skipped) console.error(`SKIP ${s}`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(failures.length ? 1 : 0);
    break;
  }
  case "run": await runCmd(); break;
  case "pull": pullCmd(); break;
  case "ingest": await ingestCmd(); break;
  default: console.log(usage); process.exit(cmd ? 1 : 0);
}
