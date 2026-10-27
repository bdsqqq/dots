import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDepot } from "./auth.ts";

function fixture(t: { after: (callback: () => void) => void }, token = "test-organization-token\n") {
  const directory = mkdtempSync(join(tmpdir(), "depot-auth-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "credential");
  writeFileSync(credentialFile, token, { mode: 0o600 });
  return { binary: "/native/bin/depot", credentialFile, organizationId: "personal123", configHome: join(directory, ".config"), args: ["jobs", "--repo", "owner/repo", "--output", "json"] };
}

test("org token is process-local, overrides stale auth, and never becomes an argument", t => {
  const options = fixture(t);
  const env = { HOME: "/test/home", DEPOT_TOKEN: "old", DEPOT_API_TOKEN: "old-viper", DEPOT_ORG_ID: "work" };
  const nativeConfig = join(options.configHome, "../native-login.yaml");
  writeFileSync(nativeConfig, "user-owned login state");
  let calls = 0;
  assert.equal(runDepot({ ...options, env, execute: (binary, args, execution) => {
    calls++;
    assert.equal(binary, options.binary);
    assert.deepEqual(args, options.args);
    assert.ok(!args.some(arg => arg.includes("test-organization-token")));
    assert.equal(execution.env.DEPOT_TOKEN, "test-organization-token");
    assert.equal(execution.env.DEPOT_API_TOKEN, "test-organization-token");
    assert.equal(execution.env.DEPOT_ORG_ID, "personal123");
    assert.equal(execution.env.XDG_CONFIG_HOME, options.configHome);
    assert.equal(execution.stdio, "inherit");
    return { status: 7 };
  } }), 7);
  assert.equal(calls, 1);
  assert.equal(env.DEPOT_TOKEN, "old");
  assert.equal(env.DEPOT_API_TOKEN, "old-viper");
  assert.equal(env.DEPOT_ORG_ID, "work");
  assert.equal(readFileSync(nativeConfig, "utf8"), "user-owned login state");
});

test("explicit XDG config home is respected", t => {
  const options = fixture(t);
  runDepot({ ...options, env: { XDG_CONFIG_HOME: "/native/custom-config" }, execute: (_binary, _args, execution) => {
    assert.equal(execution.env.XDG_CONFIG_HOME, "/native/custom-config");
    return { status: 0 };
  } });
});

test("empty and malformed drafts fail before any native command executes", t => {
  for (const token of ["", " \n", "test-token\nsecond-line"]) {
    const options = fixture(t, token);
    assert.throws(() => runDepot({ ...options, execute: () => assert.fail("must not invoke CLI") }), /empty or malformed/);
  }
});

test("missing credential/configuration fails closed, without native-login fallback", t => {
  const options = fixture(t);
  rmSync(options.credentialFile);
  assert.throws(() => runDepot({ ...options, execute: () => assert.fail("must not invoke CLI") }), /unreadable/);
  assert.throws(() => runDepot({ ...options, organizationId: "", execute: () => assert.fail("must not invoke CLI") }), /explicit organization/);
});

test("entrypoint works in a shell without inherited XDG/auth exports", t => {
  const options = fixture(t);
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_DEPOT_CREDENTIAL: options.credentialFile };
  for (const key of ["XDG_CONFIG_HOME", "DEPOT_TOKEN", "DEPOT_API_TOKEN", "DEPOT_ORG_ID"]) delete env[key];
  const result = spawnSync(process.execPath, [new URL("./auth.ts", import.meta.url).pathname,
    process.execPath, options.credentialFile, options.organizationId, options.configHome, "-e", `
      const assert = require('node:assert/strict');
      const token = require('node:fs').readFileSync(process.env.TEST_DEPOT_CREDENTIAL, 'utf8').trim();
      assert.equal(process.env.DEPOT_TOKEN, token);
      assert.equal(process.env.DEPOT_API_TOKEN, token);
      assert.equal(process.env.DEPOT_ORG_ID, 'personal123');
      assert.ok(process.env.XDG_CONFIG_HOME.endsWith('/.config'));
    `], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("test-organization-token"));
});
