import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auth, environment, pinnedArgs, type GogConfig } from "./auth.ts";
import type { Command } from "../tool-auth/process.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gog-auth-test-"));
  const clientFile = join(root, "client.json"), passwordFile = join(root, "password"), nativeClient = join(root, "native-client.json"), token = join(root, "native-token");
  writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "fixture", client_secret: "PRIVATE_CLIENT" } }), { mode: 0o600 });
  writeFileSync(passwordFile, "PRIVATE_PASSWORD", { mode: 0o600 });
  writeFileSync(nativeClient, JSON.stringify({ client_id: "fixture" }), { mode: 0o600 });
  writeFileSync(token, "REFRESHED_NATIVE_TOKEN", { mode: 0o600 });
  const cfg: GogConfig = { enabled: true, executable: "mock-gog", account: "fixture@example.test", client: "fixture", services: ["gmail", "calendar"], backend: "file", clientFile, passwordFile };
  const calls: Command[] = [];
  let scopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"];
  let email = cfg.account, client = cfg.client, services = cfg.services, existing = false;
  const run = (command: Command) => {
    calls.push(command);
    const args = command.args.join(" ");
    if (args.includes("auth credentials list")) return JSON.stringify({ clients: existing ? [{ client, path: nativeClient }] : [] });
    if (args.includes("auth credentials set")) return JSON.stringify({ saved: true, client });
    if (args.includes("auth status")) return JSON.stringify({ account: { email, client, credentials_exists: true, credentials_path: nativeClient, auth_preferred: "oauth" }, keyring: { backend: "file" } });
    if (args.includes("auth list")) return JSON.stringify({ accounts: [{ email, client, services, scopes, auth: "oauth" }] });
    return JSON.stringify(args.includes("gmail search") ? { threads: [{ private: "PRIVATE_MAIL" }] } : { calendars: [{ private: "PRIVATE_CALENDAR" }] });
  };
  return { cfg, calls, run, token, close: () => rmSync(root, { recursive: true, force: true }), change: (kind: string) => {
    if (kind === "client-id") writeFileSync(nativeClient, JSON.stringify({ client_id: "wrong" }));
    if (kind === "scope") scopes = [];
    if (kind === "account") email = "wrong@example.test";
    if (kind === "client") client = "wrong";
    if (kind === "service") services = ["gmail"];
    if (kind === "existing") existing = true;
  } };
}
test("missing enablement/account/client/services/provisioning fail before any command", () => {
  const f = fixture();
  try {
    for (const delta of [{ enabled: false }, { account: "" }, { client: "" }, { services: [] }, { services: ["drive"] }, { clientFile: "/missing/fixture" }, { passwordFile: "relative" }]) {
      assert.throws(() => auth({ ...f.cfg, ...delta }, "ready", f.run));
      assert.equal(f.calls.length, 0);
    }
  } finally { f.close(); }
});
for (const kind of ["scope", "account", "client", "client-id", "service"]) test(`rejects wrong ${kind} before API reads`, () => {
  const f = fixture();
  try { f.change(kind); assert.throws(() => auth(f.cfg, "ready", f.run)); assert(f.calls.every(c => !c.args.includes("gmail") && !c.args.includes("calendar"))); }
  finally { f.close(); }
});
test("readiness uses private password and bounded reads; summary excludes private results", () => {
  const f = fixture();
  try {
    const output = auth(f.cfg, "ready", f.run);
    assert.match(output, /ready/); assert(!output.includes("PRIVATE"));
    assert.equal(f.calls.length, 4);
    for (const c of f.calls) { assert(c.args.includes("--no-input")); assert.equal(c.env?.GOG_KEYRING_PASSWORD, "PRIVATE_PASSWORD"); assert(!c.args.includes("--check")); }
    assert(f.calls.slice(2).every(c => c.args.includes("--max") && c.args.at(-1) === "1"));
    assert.equal(readFileSync(f.token, "utf8"), "REFRESHED_NATIVE_TOKEN");
  } finally { f.close(); }
});
test("bootstrap touches only client command and skips an existing client; token fixture preserved", () => {
  const f = fixture();
  try {
    assert.match(auth(f.cfg, "bootstrap-client", f.run), /consent still required/);
    assert(f.calls.every(c => c.args.includes("credentials")));
    assert.equal(readFileSync(f.token, "utf8"), "REFRESHED_NATIVE_TOKEN");
    f.calls.length = 0; f.change("existing");
    assert.match(auth(f.cfg, "bootstrap-client", f.run), /already present/);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});
test("malformed/help output cannot satisfy readiness and parser never exposes it", () => {
  const f = fixture();
  try { assert.throws(() => auth(f.cfg, "ready", () => "PRIVATE_RESPONSE --help"), error => error instanceof Error && !error.message.includes("PRIVATE_RESPONSE")); }
  finally { f.close(); }
});
test("inherited direct tokens are stripped", () => {
  const f = fixture(), prior = process.env.GOG_ACCESS_TOKEN;
  try { process.env.GOG_ACCESS_TOKEN = "PRIVATE_OVERRIDE"; assert.equal(environment(f.cfg).GOG_ACCESS_TOKEN, undefined); }
  finally { if (prior === undefined) delete process.env.GOG_ACCESS_TOKEN; else process.env.GOG_ACCESS_TOKEN = prior; f.close(); }
});

test("CLI capture suppresses private subprocess diagnostics and preserves isolated native state", async () => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync } = await import("node:fs");
  const f = fixture();
  try {
    const fake = join(f.cfg.clientFile, "..", "fake-gog");
    writeFileSync(fake, '#!/usr/bin/env node\nconsole.error("PRIVATE_TOKEN PRIVATE_MAIL"); process.exit(1);\n');
    chmodSync(fake, 0o700);
    const result = spawnSync(process.execPath, ["modules/gog/auth.ts", "ready"], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, HOME: join(f.cfg.clientFile, ".."), XDG_CONFIG_HOME: join(f.cfg.clientFile, ".."),
        TOOL_AUTH_GOG_ENABLED: "1", TOOL_AUTH_GOG_ACCOUNT: f.cfg.account, TOOL_AUTH_GOG_CLIENT: f.cfg.client,
        TOOL_AUTH_GOG_SERVICES: "gmail,calendar", TOOL_AUTH_GOG_BACKEND: "file",
        TOOL_AUTH_GOG_CLIENT_FILE: f.cfg.clientFile, TOOL_AUTH_GOG_PASSWORD_FILE: f.cfg.passwordFile,
        TOOL_AUTH_GOG_BINARY: fake },
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert(!result.stderr.includes("PRIVATE_TOKEN") && !result.stderr.includes("PRIVATE_MAIL"));
    assert.match(result.stderr, /not ready/);
    assert.equal(readFileSync(f.token, "utf8"), "REFRESHED_NATIVE_TOKEN");
  } finally { f.close(); }
});

test("wrapper accepts matching explicit selectors and retains native dry-run/output flags", () => {
  const f = fixture();
  try {
    assert.deepEqual(pinnedArgs(f.cfg, ["--account", f.cfg.account, "--client=fixture", "--dry-run", "--select=id"]), ["--client", "fixture", "--account", f.cfg.account, "--dry-run", "--select=id"]);
    for (const args of [["--acct", "other@example.test"], ["-aother@example.test"], ["--client=other"], ["--access-token=private"], ["--home", "/other"]]) assert.throws(() => pinnedArgs(f.cfg, args));
  } finally { f.close(); }
});
