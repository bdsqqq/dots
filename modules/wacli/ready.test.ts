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
const report = (authenticated = true, connected = true) => ({
  success: true,
  error: null,
  data: { authenticated, connected, lock_held: false },
});
test("paired state plus selected authenticated read; no sync and no helper DB replacement", () => {
  const dir = fixture();
  try {
    const files = ["session.db", "wacli.db"].map((n) => join(dir, n));
    files.forEach((p) => writeFileSync(p, "PRIVATE_DATABASE"));
    const before = files.map((p) => readFileSync(p));
    const cfg = {
      enabled: true,
      executable: "fixture",
      account: "chosen",
      store: dir,
      probeGroup: "123@g.us",
    };
    const calls: string[][] = [];
    const run: Runner = (c) => {
      calls.push(c.args);
      return JSON.stringify(
        c.args.includes("doctor")
          ? report()
          : { success: true, error: null, data: { JID: "123@g.us", Participants: [] } },
      );
    };
    check(cfg, false, run);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--connect"));
    assert.ok(calls.every((c) => !c.includes("sync") && !c.includes("auth")));
    files.forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
    check(cfg, true, runner([report(true, false)]));
    for (const value of [
      report(false),
      report(true, false),
      {},
      { success: false },
      { success: true, data: { authenticated: "true" } },
    ])
      assert.throws(() => check(cfg, false, runner([value])), /unpaired|connection/);
    assert.throws(
      () =>
        check(
          cfg,
          false,
          runner([report(), { success: true, data: { JID: "wrong@g.us", Participants: [] } }]),
        ),
      /group read/,
    );
    assert.throws(() => check(cfg, false, () => "not json PRIVATE"), /invalid native response/);
    assert.throws(() => check({ ...cfg, enabled: false }, false, run), /configure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("missing store never creates native databases", () => {
  const dir = fixture();
  try {
    assert.throws(
      () =>
        check({
          enabled: true,
          executable: "fixture",
          account: "chosen",
          store: dir,
          probeGroup: "123@g.us",
        }),
      /missing/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
