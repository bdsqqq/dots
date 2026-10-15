import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, type Runner } from "./ready.ts";
import { capture } from "../tool-auth/process.ts";
const fixture = () => mkdtempSync(join(tmpdir(), "native-ready-"));
const runner =
  (values: unknown[]): Runner =>
  () =>
    JSON.stringify(values.shift());
test("TCC must already allow read; exact list and JSON shape required", () => {
  const cfg = {
    enabled: true,
    executable: "fixture",
    account: "chosen",
    listId: "list-id",
    platform: "darwin",
  };
  const status = { authorized: true, status: "full-access" };
  const list = [{ id: "list-id", title: "private", reminderCount: 0, overdueCount: 0 }];
  const calls: string[][] = [];
  check(cfg, false, (c) => {
    calls.push(c.args);
    return JSON.stringify(c.args[0] === "status" ? status : list);
  });
  assert.deepEqual(calls, [
    ["status", "--json"],
    ["list", "--json"],
  ]);
  assert.ok(!calls.flat().includes("authorize"));
  for (const value of [
    { authorized: false, status: "denied" },
    { authorized: true, status: "write-only" },
    { authorized: "true", status: "full-access" },
    {},
  ])
    assert.throws(() => check(cfg, false, runner([value])), /TCC/);
  for (const value of [
    [],
    {},
    [{ id: "other", title: "private", reminderCount: 0, overdueCount: 0 }],
    [{ id: "list-id", title: "private" }],
  ])
    assert.throws(() => check(cfg, false, runner([status, value])), /list read/);
  check(cfg, true, runner([status]));
  assert.throws(() => check({ ...cfg, platform: "linux" }), /macOS/);
  assert.throws(() => check({ ...cfg, enabled: false }), /configure/);
});

test("subprocess failures/timeouts suppress private stdout and stderr", () => {
  const dir = fixture();
  try {
    const script = join(dir, "fail.mjs");
    writeFileSync(
      script,
      'console.log("PRIVATE_TOKEN"); console.error("PRIVATE_RESPONSE"); process.exit(1)',
    );
    assert.throws(
      () => capture({ executable: process.execPath, args: [script] }),
      (e) => e instanceof Error && !e.message.includes("PRIVATE") && e.message.includes("failed"),
    );
    writeFileSync(script, 'console.log("PRIVATE_TOKEN"); setTimeout(() => {}, 2000)');
    assert.throws(
      () => capture({ executable: process.execPath, args: [script] }, 25),
      (e) =>
        e instanceof Error && !e.message.includes("PRIVATE") && e.message.includes("timed out"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
