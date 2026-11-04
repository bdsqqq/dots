import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

type Projection = { name: string; expression: string };
const fields: Projection[] = JSON.parse(readFileSync(new URL("../o11y/papertrail-virtual-fields.json", import.meta.url), "utf8"));

function checkDependencies(projections: Projection[]): void {
  const known = new Set<string>();
  for (const field of projections) {
    assert.ok(!known.has(field.name), `duplicate projection ${field.name}`);
    for (const dependency of field.expression.match(/\bnormalized_[a-z_]+\b/g) ?? []) {
      assert.ok(known.has(dependency), `${field.name} requires earlier ${dependency}`);
    }
    known.add(field.name);
  }
}

test("projection dependencies are complete and ordered; missing shared envelope is detected", () => {
  checkDependencies(fields);
  assert.throws(() => checkDependencies(fields.filter(field => field.name !== "normalized_event")), /requires earlier normalized_event/);
});

const deployment = process.env.SERVICE_EVENTS_AXIOM_DEPLOYMENT;
test("Axiom evaluates direct, journal, legacy and non-event envelopes without publishing fields", { skip: !deployment }, () => {
  const event = {
    schemaVersion: 1, eventId: "fixture-event", operationId: "fixture-operation", service: "fixture-service",
    operation: "http.request", traffic: "browser", outcome: "degraded", durationMs: 12.5,
    context: { ready: false, route: "health" },
  };
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  for (const [name, body, expected] of [
    ["direct", event, "fixture-service"],
    ["journal", { MESSAGE: JSON.stringify(event), SYSLOG_IDENTIFIER: "fixture-unit" }, "fixture-service"],
    ["legacy", { MESSAGE: "plain legacy message", SYSLOG_IDENTIFIER: "legacy-unit" }, "legacy-unit"],
    ["non-event", { ...event, operationId: "", SYSLOG_IDENTIFIER: "not-an-event" }, "not-an-event"],
  ] as const) {
    const literal = JSON.stringify(body).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    let query = `['papertrail'] | take 1 | extend body = parse_json('${literal}')`;
    for (const field of fields) {
      query += ` | extend ${field.name.replace("normalized_", "fixture_")} = ${field.expression.replaceAll(/\bnormalized_/g, "fixture_")}`;
    }
    query += " | project fixture_service, fixture_operation, fixture_outcome, fixture_traffic, fixture_duration_ms, fixture_context, fixture_event_id, fixture_severity";
    const result = spawnSync("axiom", ["-D", deployment!, "query", query, "--start-time", start, "--end-time", end, "-f", "json", "--no-spinner"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.ok(result.stdout.trim() && result.stdout.trim() !== "[]", "fixture evaluation requires one existing source row in the last hour");
    const row = JSON.parse(result.stdout.trim().split("\n")[0]);
    assert.equal(row.fixture_service, expected, name);
    if (name === "direct" || name === "journal") {
      assert.equal(row.fixture_outcome, "degraded");
      assert.equal(row.fixture_severity, "warn");
      assert.equal(row.fixture_context.ready, false);
      assert.equal(row.fixture_duration_ms, 12.5);
    } else assert.ok(!row.fixture_event_id, name);
  }
});
