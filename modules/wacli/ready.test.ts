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
  data: {
    authenticated,
    connected,
    lock_held: false,
    session_revoked: false,
    fts_enabled: true,
    connection_state: connected ? "connected" : "disconnected",
    linked_jid: "123:1@s.whatsapp.net",
  },
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
    assert.deepEqual(calls[0], ["--store", dir, "--timeout", "10s", "--json", "doctor", "--connect"]);
    assert.deepEqual(calls[1], ["--store", dir, "--timeout", "10s", "--json", "groups", "info", "--jid", "123@g.us"]);
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
    for (const data of [
      { session_revoked: true },
      { session_revoked: undefined },
      { store_error: "PRIVATE_STORE_ERROR" },
      { fts_enabled: false },
      { lock_held: true },
    ]) {
      const unhealthy = report();
      Object.assign(unhealthy.data, data);
      assert.throws(() => check(cfg, true, runner([unhealthy])), /unpaired, locked, or invalid/);
    }
    const inconsistent = report();
    inconsistent.data.connection_state = "logged_out";
    assert.throws(() => check(cfg, false, runner([inconsistent])), /connection failed/);
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
