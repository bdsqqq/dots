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
test("selected bridge native config and real resource shape required", () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, "openhue"));
    const file = join(dir, "openhue/config.yaml");
    writeFileSync(file, "native fixture", { mode: 0o600 });
    const before = readFileSync(file);
    const cfg = {
      enabled: true,
      executable: "fixture",
      yaml: "yaml",
      configHome: dir,
      bridge: "192.0.2.1",
    };
    const config = { bridge: cfg.bridge, key: "fixture-key" };
    check(cfg, false, runner([config, [{ id: "bridge-id", type: "bridge" }]]));
    assert.deepEqual(readFileSync(file), before);
    for (const response of [[], null, {}, [{ id: "x", type: "light" }], [{ type: "bridge" }]])
      assert.throws(() => check(cfg, false, runner([config, response])), /resource data/);
    assert.throws(
      () => check(cfg, false, runner([{ bridge: "other", key: "secret" }])),
      /mismatched/,
    );
    assert.throws(
      () => check(cfg, false, () => "openhue-cli not configured yet"),
      /invalid native response/,
    );
    check(cfg, true, runner([config]));
    assert.throws(() => check({ ...cfg, enabled: false }), /configure/);
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
