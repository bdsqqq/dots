import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ServiceEvent } from "../service-events/events.ts";

test("startup failure emits a real JSON line, not raw configuration or exception text", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./hue-control-main.ts", import.meta.url)),
    "--port", "private-invalid-port", "--state", "/private/device-state-path",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]) as ServiceEvent;
  assert.equal(event.operation, "service.start");
  assert.equal(event.outcome, "failed");
  assert.equal(event.context.ready, false);
  assert.equal(event.context.errorCode, "UNEXPECTED_ERROR");
  assert.match(event.operationId, /^[0-9a-f-]{36}$/);
  assert.match(event.timestamp, /Z$/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-invalid-port|device-state-path|Error:|port must/);
});
