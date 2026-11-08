import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, readdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { clientCommand, hubPaths, initializeHub, issueClient, readClient, readHub, useLocalClient } from "./broker.ts";

const directories: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "cli-proxy-api-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const URL = "https://broker.example.test:8317";
const client = { version: 1 as const, name: "fixture", baseUrl: URL, apiKey: `broker-${"x".repeat(43)}` };

test("bootstrap is private, loopback-only, sticky, and never overwrites native YAML or grants", () => {
  const root = join(fixture(), "hub");
  initializeHub(root, URL);
  const paths = hubPaths(root);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.routing["session-affinity"], true);
  assert.equal(config.oauth["auth-dir"], paths.auth);
  assert.equal(config.observability.logs["logs-max-total-size-mb"], 0);
  assert.equal(config.observability.logs["request-log"], true);
  assert.notEqual(config.management["secret-key"], config.access["api-keys"][0]);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(paths.auth).mode & 0o777, 0o700);
  for (const file of [paths.config, paths.managementKey, paths.metadata, join(paths.clients, "hub.json")]) assert.equal(statSync(file).mode & 0o777, 0o600);
  const nativeYaml = "config-version: 8\nmanagement:\n  secret-key: native-bcrypt-hash\n";
  writeFileSync(paths.config, nativeYaml);
  const originalKey = readFileSync(paths.managementKey, "utf8");
  initializeHub(root, URL);
  assert.equal(readFileSync(paths.config, "utf8"), nativeYaml);
  assert.equal(readFileSync(paths.managementKey, "utf8"), originalKey);
  assert.deepEqual(readHub(root), { version: 1, baseUrl: URL, port: 8317 });
  assert.throws(() => initializeHub(root, "https://different.example.test"), /differs/);
});

test("unsafe runtime paths and credential files fail closed", () => {
  const dir = fixture();
  const file = join(dir, "client.json");
  writeFileSync(file, JSON.stringify(client), { mode: 0o600 });
  assert.deepEqual(readClient(file), client);
  chmodSync(file, 0o644);
  assert.throws(() => readClient(file), /unsafe/);
  chmodSync(file, 0o600);
  for (const baseUrl of ["http://broker.example.test", "https://user:pass@broker.example.test", "https://broker.example.test/path", "https://broker.example.test?token=bad"]) {
    writeFileSync(file, JSON.stringify({ ...client, baseUrl }));
    assert.throws(() => readClient(file), /HTTPS origin/);
  }
  const link = join(dir, "link");
  symlinkSync(dir, link);
  assert.throws(() => initializeHub(link, URL), /symlink/);
  assert.throws(() => initializeHub("/nix/store/unsafe", URL), /outside/);
});

test("pre-existing config without managed bootstrap state does not receive replacement keys", () => {
  const dir = fixture();
  const paths = hubPaths(dir);
  writeFileSync(paths.config, "native: config\n", { mode: 0o600 });
  assert.throws(() => initializeHub(dir, URL));
  assert.equal(readFileSync(paths.config, "utf8"), "native: config\n");
});

test("client keys are registered idempotently without replacing other native keys", async () => {
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/v1/models") {
      const issued = (received.at(-1) as { body: { new: string } }).body.new;
      assert.equal(req.headers.authorization, `Bearer ${issued}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
      return;
    }
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const dir = fixture();
    initializeHub(dir, URL, port);
    const file = await issueClient(dir, "mbp-m2");
    const credential = readClient(file);
    const second = await issueClient(dir, "mbp-m2");
    assert.equal(second, file);
    assert.equal(readClient(second).apiKey, credential.apiKey);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(received.length, 2);
    const managementKey = readFileSync(hubPaths(dir).managementKey, "utf8").trim();
    for (const record of received) assert.deepEqual(record, {
      method: "PATCH", path: "/v0/management/api-keys", authorization: `Bearer ${managementKey}`,
      body: { old: credential.apiKey, new: credential.apiKey },
    });
    for (const name of ["../escape", "hub", "", "Bad Name"]) await assert.rejects(issueClient(dir, name), /machine name/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("management redirects and error bodies never leak secrets or follow redirects", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
    res.end("private-upstream-body");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const dir = fixture();
    initializeHub(dir, URL, (server.address() as { port: number }).port);
    await assert.rejects(issueClient(dir, "fixture"), /broker connection failed/);
    assert.equal(requests, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const baseUrl of [URL, "http://127.0.0.1:18317"]) test(`native CLIProxyAPI accepts ${baseUrl}, rewrites YAML, and authenticates registered clients`, { skip: !process.env.CLI_PROXY_API_TEST_BINARY }, async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const dir = fixture();
  initializeHub(dir, baseUrl, port);
  const paths = hubPaths(dir);
  const child = spawn(process.env.CLI_PROXY_API_TEST_BINARY!, ["-config", paths.config, "-local-model"], { cwd: dir, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("native broker exited before readiness");
      try { ready = (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const file = await issueClient(dir, "native-fixture");
    const token = readClient(file).apiKey;
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(models.status, 200);
    assert.ok(Array.isArray((await models.json() as { data: unknown[] }).data));
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v8/management/credentials`)).status, 401);
    const yaml = readFileSync(paths.config, "utf8");
    assert.ok(!yaml.trimStart().startsWith("{"), "native saves should be exercised, not just JSON parsing");
    initializeHub(dir, baseUrl, port);
    assert.equal(readFileSync(paths.config, "utf8"), yaml);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref())]);
  }
});

test("Pi broker presets expose only native Codex model capabilities and no inline secret", async () => {
  const { openaiCodexProvider } = await import("../pi/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js");
  const config = JSON.parse(readFileSync(new globalThis.URL("../pi/models.json", import.meta.url), "utf8"));
  const provider = config.providers.cliproxyapi;
  assert.equal(provider.api, "openai-responses");
  assert.equal(provider.baseUrl, "https://mmn-m4.tail1543a7.ts.net:8317/v1");
  assert.ok(provider.apiKey === undefined || provider.apiKey === "!inference-broker key", "no inline secret or static route/key bundle");
  assert.ok(provider.models.length > 0);
  const native = openaiCodexProvider().getModels();
  for (const model of provider.models) {
    assert.ok(!/claude/i.test(model.id));
    const baseline = native.find(m => m.id === model.id);
    assert.ok(baseline, "broker model must exist in the pinned native Codex catalog");
    for (const field of ["reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap"] as const) assert.deepEqual(model[field], baseline[field]);
  }
});

test("only explicitly spelled numeric loopback origins permit HTTP", () => {
  const dir = fixture();
  const file = join(dir, "client.json");
  for (const baseUrl of ["http://127.0.0.1:18317", "http://[::1]:18317", URL]) {
    writeFileSync(file, JSON.stringify({ ...client, baseUrl }), { mode: 0o600 });
    assert.equal(readClient(file).baseUrl, baseUrl);
    const state = join(dir, String(Math.random()));
    initializeHub(state, baseUrl);
    assert.equal(readHub(state).baseUrl, baseUrl);
  }
  for (const baseUrl of ["http://localhost:18317", "http://127.1:18317", "http://2130706433:18317", "http://0x7f000001:18317", "http://127.0.0.2:18317", "http://example.test", "http://[::ffff:127.0.0.1]", "http://127.0.0.1/path", "http://127.0.0.1?key=x", "http://user@127.0.0.1"]) {
    writeFileSync(file, JSON.stringify({ ...client, baseUrl }));
    assert.throws(() => readClient(file));
    assert.throws(() => initializeHub(join(dir, "rejected"), baseUrl));
  }
});

test("unmanaged upstream grants require fresh gateway state, never silent adoption", () => {
  const dir = fixture();
  const auth = hubPaths(dir).auth;
  mkdirSync(auth);
  writeFileSync(join(auth, "existing-grant.json"), "fixture grant");
  assert.throws(() => initializeHub(dir, "http://127.0.0.1:18317"), /fresh gateway state/);
  assert.equal(readFileSync(join(auth, "existing-grant.json"), "utf8"), "fixture grant");
  assert.throws(() => readFileSync(hubPaths(dir).config));
});

test("metadata prevents endpoint migration even when config is missing", () => {
  const dir = fixture();
  initializeHub(dir, URL);
  const paths = hubPaths(dir);
  const original = readFileSync(paths.metadata, "utf8");
  unlinkSync(paths.config);
  assert.throws(() => initializeHub(dir, "http://127.0.0.1:18317"), /differs/);
  assert.equal(readFileSync(paths.metadata, "utf8"), original);
});

test("use-local stages native watcher and frontend readiness, backs up privately, and is idempotent", async () => {
  let registered: string | undefined;
  let unauthorized = 2;
  let failFrontend = true;
  let failManagement = false;
  const backend = createServer(async (req, res) => {
    if (req.url === "/v0/management/api-keys") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (failManagement) { res.writeHead(500); res.end("withheld"); return; }
      registered = JSON.parse(body).new;
      res.end('{"status":"ok"}');
    } else if (unauthorized-- > 0 || req.headers.authorization !== `Bearer ${registered}`) {
      res.writeHead(401); res.end("{}");
    } else { res.end('{"data":[]}'); }
  });
  const frontend = createServer((req, res) => {
    if (failFrontend || req.headers.authorization !== `Bearer ${registered}`) { res.writeHead(503); res.end("{}"); }
    else res.end('{"data":[]}');
  });
  await new Promise<void>(r => backend.listen(0, "127.0.0.1", r));
  await new Promise<void>(r => frontend.listen(0, "127.0.0.1", r));
  try {
    const dir = fixture();
    const state = join(dir, "local-state");
    const baseUrl = `http://127.0.0.1:${(frontend.address() as { port: number }).port}`;
    initializeHub(state, baseUrl, (backend.address() as { port: number }).port);
    const selected = join(dir, "selection", "client.json");
    const remote = join(dir, "remote");
    initializeHub(remote, URL);
    const before = readFileSync(hubPaths(remote).config, "utf8");
    const selectionDir = join(dir, "selection");
    // A prior remote selection is only changed by this explicit command.
    mkdirSync(selectionDir, { mode: 0o700 });
    const previous = JSON.stringify(client) + "\n";
    writeFileSync(selected, previous, { mode: 0o600 });
    await assert.rejects(useLocalClient(remote, "fixture", selected), /loopback/);
    failManagement = true;
    await assert.rejects(useLocalClient(state, "fixture", selected), /HTTP 500/);
    assert.equal(readFileSync(selected, "utf8"), previous);
    failManagement = false;
    await assert.rejects(useLocalClient(state, "fixture", selected), /HTTP 503/);
    assert.equal(readFileSync(selected, "utf8"), previous);
    assert.deepEqual(readdirSync(selectionDir), ["client.json"]);
    failFrontend = false;
    await useLocalClient(state, "fixture", selected);
    assert.equal(readClient(selected).baseUrl, baseUrl);
    assert.equal(readClient(selected).apiKey, registered);
    const backup = readdirSync(selectionDir).find(p => p.startsWith("client.json.backup-"))!;
    assert.ok(backup);
    assert.equal(readFileSync(join(selectionDir, backup), "utf8"), previous);
    assert.equal(statSync(join(selectionDir, backup)).mode & 0o777, 0o600);
    assert.equal(statSync(selected).mode & 0o777, 0o600);
    const entries = readdirSync(selectionDir);
    await useLocalClient(state, "fixture", selected);
    assert.deepEqual(readdirSync(selectionDir), entries);
    assert.equal(readFileSync(hubPaths(remote).config, "utf8"), before);
    assert.deepEqual(readdirSync(hubPaths(state).auth), [], "no upstream OAuth grants copied or created");
  } finally {
    await Promise.all([backend, frontend].map(server => new Promise<void>(r => server.close(() => r()))));
  }
});

test("connection credential command emits only a single selected route/key JSON bundle", () => {
  const file = join(fixture(), "client.json");
  const broker = new globalThis.URL("./broker.ts", import.meta.url);
  for (const baseUrl of [URL, "http://127.0.0.1:18317"]) {
    writeFileSync(file, JSON.stringify({ ...client, baseUrl }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [broker.pathname, "connection"], { encoding: "utf8", env: { ...process.env, CLI_PROXY_API_CLIENT_FILE: file } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { baseUrl, apiKey: client.apiKey });
  }
});

test("broker presets inject gateway auth without replacing direct configuration or exposing keys in arguments", () => {
  const original = { HOME: "/home/fixture", ANTHROPIC_API_KEY: "direct-api-key", CLAUDE_CODE_OAUTH_TOKEN: "direct-subscription", CODEX_HOME: "/existing/codex", OPENAI_API_KEY: "direct-openai" };
  const claude = clientCommand(client, "claude", ["-p", "fixture"], original);
  assert.equal(claude.env.ANTHROPIC_BASE_URL, URL);
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, client.apiKey);
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(claude.args, ["-p", "fixture"]);
  const codex = clientCommand(client, "codex", ["app-server"], original);
  assert.equal(codex.env.CODEX_HOME, original.CODEX_HOME);
  assert.equal(codex.env.CLI_PROXY_API_KEY, client.apiKey);
  assert.equal(codex.args.at(-1), "app-server");
  assert.match(codex.args.join(" "), /wire_api="responses"/);
  assert.match(codex.args.join(" "), /requires_openai_auth=false/);
  assert.match(codex.args.join(" "), /supports_websockets=true/);
  assert.ok(!JSON.stringify([claude.args, codex.args]).includes(client.apiKey));
  assert.equal(original.ANTHROPIC_API_KEY, "direct-api-key");
  assert.equal(original.CLAUDE_CODE_OAUTH_TOKEN, "direct-subscription");
});
