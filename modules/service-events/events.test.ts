import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHttpTraffic, createEventLogger, safeErrorCode, type ServiceEvent } from "./events.ts";

test("completion is self-contained, timed, correlated, and emitted only once", () => {
  const events: ServiceEvent[] = [];
  let time = 10;
  let sequence = 0;
  const logger = createEventLogger("fixture", {
    sink: event => events.push(event), host: "test-host", now: () => 0,
    monotonic: () => time, id: () => `id-${++sequence}`,
  });
  const operation = logger.begin("request.complete", "browser", { method: "GET", route: "artifact" });
  time = 16.25;
  const result = operation.finish("succeeded", { statusCode: 200 });
  assert.equal(operation.finish("failed"), result);
  assert.deepEqual(events, [{
    schemaVersion: 1, timestamp: "1970-01-01T00:00:00.000Z", eventId: "id-2", operationId: "id-1",
    service: "fixture", host: "test-host", operation: "request.complete", traffic: "browser",
    outcome: "succeeded", durationMs: 6.25, context: { method: "GET", route: "artifact", statusCode: 200 },
  }]);
});

test("metadata allowlist rejects bodies, paths, tokens, messages, and non-finite values", () => {
  const logger = createEventLogger("fixture", { sink: () => {} });
  const event = logger.begin("request.complete").finish("failed", {
    route: "/private-file.html?secret=token", errorCode: "error contains /private/path", itemCount: NaN,
    requestBytes: -1, ready: false, reasonCode: "source_unavailable", statusCode: 503,
    // Exercise the runtime boundary, not just TypeScript's excess-property check.
    ...{ body: "secret payload", authorization: "Bearer secret", path: "/private/path", error: "secret" },
  });
  assert.deepEqual(event.context, { ready: false, reasonCode: "source_unavailable", statusCode: 503 });
  assert.ok(!JSON.stringify(event).includes("secret"));
});

test("version and timing fields accept versions and durations, not paths or text", () => {
  const logger = createEventLogger("fixture", { sink: () => {} });
  const event = logger.begin("app.publish").finish("succeeded", {
    fromVersion: "0.1.0 (2071)", toVersion: "0.1.11-nightly.20261118.4877", fetchMs: 1864, feedMs: 98, pushMs: 0,
    networkSkipped: true,
  });
  assert.deepEqual(event.context, { fromVersion: "0.1.0 (2071)", toVersion: "0.1.11-nightly.20261118.4877",
    fetchMs: 1864, feedMs: 98, pushMs: 0, networkSkipped: true });
  const rejected = logger.begin("app.publish").finish("failed", {
    fromVersion: "/Applications/Rex.app", toVersion: "latest; rm -rf", fetchMs: -1, networkSkipped: "yes" as unknown as boolean,
  });
  assert.deepEqual(rejected.context, {});
});

test("upgrade revisions accept only full commit hashes", () => {
  const logger = createEventLogger("fixture", { sink: () => {} });
  const safe = logger.begin("upgrade.attempt").finish("succeeded", { revision: "a".repeat(40), appliedRevision: "1".repeat(40) });
  assert.deepEqual(safe.context, { revision: "a".repeat(40), appliedRevision: "1".repeat(40) });
  const unsafe = logger.begin("upgrade.attempt").finish("failed", { revision: "https://example.com/secret", appliedRevision: "/private/file" });
  assert.deepEqual(unsafe.context, {});
});

test("probe classification is separate from browser-like and unknown clients", () => {
  assert.equal(classifyHttpTraffic("Mozilla/5.0", "artifact"), "browser");
  assert.equal(classifyHttpTraffic("tailnet-registry/1", "index"), "probe");
  assert.equal(classifyHttpTraffic("cloudflare-origin-probe/1", "index"), "probe");
  assert.equal(classifyHttpTraffic("Mozilla/5.0", "health"), "probe");
  assert.equal(classifyHttpTraffic("curl/8", "artifact"), "unknown");
  assert.equal(classifyHttpTraffic(undefined, "artifact"), "unknown");
});

test("failure classification never serializes exception text", () => {
  assert.equal(safeErrorCode(Object.assign(new Error("secret"), { code: "ENOENT" })), "ENOENT");
  assert.equal(safeErrorCode(new DOMException("secret", "AbortError")), "ABORTED");
  assert.equal(safeErrorCode({ code: "SECRET_CREDENTIAL" }), "UNEXPECTED_ERROR");
  assert.equal(safeErrorCode("private payload"), "UNEXPECTED_ERROR");
});

test("logging sink failure cannot change application behavior", () => {
  const logger = createEventLogger("fixture", { sink: () => { throw new Error("offline sink"); } });
  assert.equal(logger.begin("request.complete").finish("succeeded").outcome, "succeeded");
});
