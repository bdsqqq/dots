import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventLogger, type ServiceEvent } from "../service-events/events.ts";
import { checkOrigin } from "./origin-check.ts";

function fixture() {
  const events: ServiceEvent[] = [];
  return { events, logger: createEventLogger("cloudflare-ingress", { sink: event => events.push(event) }) };
}

test("origin operation classifies probe traffic and carries app identity, status and readiness", async () => {
  const { events, logger } = fixture();
  const healthy = await checkOrigin("html-stuff", "https://private.example/secret-path", "curl", {
    events: logger,
    run: async (file, args) => {
      assert.equal(file, "curl");
      assert.ok(args.includes("cloudflare-origin-probe/1"));
      assert.ok(!args.includes("--show-error"));
      return { stdout: "200" };
    },
  });
  assert.equal(healthy, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "origin.check");
  assert.equal(events[0].traffic, "probe");
  assert.equal(events[0].outcome, "succeeded");
  assert.deepEqual(events[0].context, { action: "html-stuff", method: "GET", ready: true, statusCode: 200 });
  assert.ok(!JSON.stringify(events).includes("private.example"));
});

test("HTTP and network failures emit one private failure event and keep connector withdrawn", async () => {
  for (const [error, expected] of [
    [Object.assign(new Error("credential and private URL"), { stdout: "502", code: 22 }), "origin_http_error"],
    [Object.assign(new Error("private URL"), { code: "ECONNREFUSED" }), "origin_unreachable"],
  ] as const) {
    const { events, logger } = fixture();
    assert.equal(await checkOrigin("photos", "https://private.example", "curl", {
      events: logger, run: async () => { throw error; },
    }), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "failed");
    assert.equal(events[0].context.ready, false);
    assert.equal(events[0].context.reasonCode, expected);
    assert.ok(!JSON.stringify(events).includes("private"));
    assert.ok(!JSON.stringify(events).includes("credential"));
  }
});

test("malformed successful probe output is not advertised as readiness", async () => {
  const { events, logger } = fixture();
  assert.equal(await checkOrigin("files", "https://private.example", "curl", {
    events: logger, run: async () => ({ stdout: "not a status" }),
  }), false);
  assert.equal(events[0].outcome, "failed");
});
