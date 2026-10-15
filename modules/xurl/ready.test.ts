import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, check, type Runner } from "./ready.ts";
import { capture } from "../tool-auth/process.ts";
const fixture = () => mkdtempSync(join(tmpdir(), "native-ready-"));
const runner =
  (values: unknown[]): Runner =>
  () =>
    JSON.stringify(values.shift());
const appState = {
  apps: {
    chosen: {
      client_id: "fixture-id",
      client_secret: "fixture-secret",
      oauth2_tokens: { alice: { type: "oauth2", oauth2: { access_token: "fixture-token" } } },
    },
  },
};
test("exact app/account request clears ambient auth and preserves native bytes", () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, ".xurl"));
    const file = join(dir, ".xurl/auth.yml");
    writeFileSync(file, "native fixture bytes", { mode: 0o600 });
    const before = readFileSync(file);
    const cfg = {
      enabled: true,
      executable: "fixture",
      yaml: "yaml",
      home: dir,
      app: "chosen",
      account: "alice",
    };
    const calls: Parameters<Runner>[0][] = [];
    const run: Runner = (c) => {
      calls.push(c);
      return JSON.stringify(
        c.executable === "yaml" ? appState : { data: { id: "123", username: "alice" } },
      );
    };
    check(cfg, false, run);
    assert.deepEqual(calls[1].args, [
      "--app",
      "chosen",
      "--auth",
      "oauth2",
      "--username",
      "alice",
      "/2/users/me",
    ]);
    assert.equal(calls[1].env?.HOME, dir);
    assert.equal(calls[1].env?.CLIENT_ID, undefined);
    assert.deepEqual(readFileSync(file), before);
    for (const value of [
      {},
      { errors: [] },
      { data: { id: "123", username: "bob" } },
      { data: { id: 123, username: "alice" } },
    ])
      assert.throws(() => check(cfg, false, runner([appState, value])), /identity read/);
    assert.throws(
      () => check({ ...cfg, account: "missing" }, false, runner([appState])),
      /no native OAuth2/,
    );
    assert.throws(() => check(cfg, false, runner([{}])), /invalid native/);
    assert.throws(
      () => bootstrap({ ...cfg, credentialFile: join(dir, "static.json") }, run),
      /already exists/,
    );
    assert.deepEqual(readFileSync(file), before);
    check(cfg, true, runner([appState]));
    chmodSync(file, 0o644);
    assert.throws(() => check(cfg, true, run), /private file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit bootstrap uses pinned register flags and never consent", () => {
  const dir = fixture();
  try {
    const secret = join(dir, "static.json");
    writeFileSync(secret, JSON.stringify({ client_id: "id", client_secret: "secret" }), {
      mode: 0o600,
    });
    const calls: Parameters<Runner>[0][] = [];
    bootstrap(
      {
        enabled: true,
        executable: "fixture",
        yaml: "yaml",
        home: dir,
        app: "chosen",
        account: "alice",
        credentialFile: secret,
      },
      (c) => {
        calls.push(c);
        return "";
      },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "auth",
      "apps",
      "add",
      "chosen",
      "--client-id",
      "id",
      "--client-secret",
      "secret",
    ]);
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
