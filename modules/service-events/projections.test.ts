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

test("upgrading existing fields keeps legacy-first registration dependencies valid", () => {
  const legacy = new Set([
    "normalized_payload", "normalized_host", "normalized_source", "normalized_service", "normalized_message",
    "normalized_systemd_unit", "normalized_operation", "normalized_severity", "normalized_severity_number",
  ]);
  const registered = [...fields.filter(field => legacy.has(field.name)), ...fields.filter(field => !legacy.has(field.name))];
  checkDependencies(registered);
  const forwardReference = registered.map(field => field.name === "normalized_service"
    ? { ...field, expression: "tostring(normalized_event.service)" } : field);
  assert.throws(() => checkDependencies(forwardReference), /normalized_service requires earlier normalized_event/);
});

const deployment = process.env.SERVICE_EVENTS_AXIOM_DEPLOYMENT;
const verifyInstalled = process.env.SERVICE_EVENTS_AXIOM_VERIFY_INSTALLED === "1";
test("installed Axiom projections resolve by name; a missing field fails verification", { skip: !deployment || !verifyInstalled }, () => {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  const query = `['papertrail'] | where isnotempty(normalized_event_id) | project ${fields.map(field => field.name).join(", ")} | take 1`;
  const args = ["-D", deployment!, "query", query, "--start-time", start, "--end-time", end, "-f", "json", "--no-spinner"];
  const result = spawnSync("axiom", args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim() && result.stdout.trim() !== "[]", "installed-field verification requires a recent completion event");
  args[3] = "['papertrail'] | project __service_events_expected_missing_projection__ | take 1";
  const missing = spawnSync("axiom", args, { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(missing.status, 0, "missing projection must fail verification");
  assert.match(missing.stderr, /field .*not found/);
});
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
    query += " | project fixture_service=coalesce(fixture_event_service, fixture_service), fixture_operation=coalesce(fixture_event_operation, fixture_operation), fixture_outcome, fixture_traffic, fixture_duration_ms, fixture_context, fixture_event_id, fixture_severity=coalesce(fixture_event_severity, fixture_severity)";
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
