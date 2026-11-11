import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMain } from "../tool-auth/process.ts";
import { operation, failure, type EventSink } from "./events.ts";

export const INSTANCE_ID = "codex_personal_broker";
export function brokerInstance(home: string) {
  if (!isAbsolute(home)) throw new Error("absolute native home required");
  return { driver: "codex", displayName: "personal · CLIProxyAPI", enabled: true,
    config: { setupMode: "existing", binaryPath: join(home, ".local/bin/codex-broker") } };
}

// Never replace a whole instance map: native settings can change concurrently.
export function creation(settings: any, home: string) {
  const instance = brokerInstance(home);
  const existing = settings.providerInstances?.[INSTANCE_ID];
  if (existing) {
    for (const [key, value] of Object.entries(instance.config)) assert.equal(existing.config?.[key], value, "named instance collision");
    assert.equal(existing.driver, instance.driver, "named instance collision");
    assert.equal(existing.displayName, instance.displayName, "named instance collision");
    assert.equal(existing.enabled, true, "named instance disabled");
    return undefined;
  }
  return { patch: {}, providerInstanceMutation: { operation: "create", instanceId: INSTANCE_ID, instance } };
}

export function verifyAddition(before: any, after: any, home: string) {
  creation(after, home);
  assert.ok(after.providerInstances?.[INSTANCE_ID], "server did not add the named instance");
  const withoutNew = (settings: any) => {
    const copy = structuredClone(settings);
    delete copy.providerInstances[INSTANCE_ID];
    return copy;
  };
  assert.ok(isDeepStrictEqual(withoutNew(before), withoutNew(after)), "unrelated native settings changed; inspect without reverting concurrent work");
  const selected = after.providerInstances[INSTANCE_ID];
  assert.ok(!selected.environment?.length, "broker instance must not contain inline credentials");
  assert.ok(!selected.config?.shadowHomePath && !selected.config?.homePath && !selected.config?.launchArgs, "broker route must use the existing CLI without auth-home or argument overrides");
}

function cli(t3: string, args: string[]) {
  const r = spawnSync(t3, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error("native t3 auth command failed; output withheld", { cause: r.error });
  return r.stdout;
}

export async function installPreset(t3: string, base = "http://127.0.0.1:3773", home = homedir(), eventSink?: EventSink) {
  const completion = operation("inference.preset.install", { command: "install", clientId: INSTANCE_ID }, eventSink);
  let stage = "validate";
  try {
    const result = await execute();
    completion.finish({ outcome: "success", stage: "verified", counts: { added: Number(result.added) } });
    return result;
  } catch (error) {
    completion.finish({ outcome: stage === "validate" || stage === "settings-preflight" ? "rejected" : "failure", stage, ...failure(error, stage === "session-issue" || stage === "session-revoke" ? "process" : stage === "ticket" || stage === "websocket" ? "transport" : "configuration") });
    throw error;
  }
  async function execute() {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("native loopback t3 endpoint required");
  stage = "session-issue";
  const issued = JSON.parse(cli(t3, ["auth", "session", "issue", "--scope", "settings:write", "--scope", "providers:manage", "--scope", "orchestration:read", "--ttl", "5m", "--label", "personal-broker-preset-bootstrap", "--json"]));
  let ws: WebSocket | undefined;
  try {
    assert.equal(typeof issued.token, "string");
    assert.equal(typeof issued.sessionId, "string");
    stage = "ticket";
    const ticketOptions = { method: "POST", headers: { Authorization: `Bearer ${issued.token}` }, redirect: "error" as const, signal: AbortSignal.timeout(5000) };
    let response = await fetch(`${base}/api/auth/websocket-ticket/rpc`, ticketOptions);
    if (response.status === 404) response = await fetch(`${base}/api/auth/websocket-ticket`, ticketOptions);
    if (!response.ok) throw Object.assign(new Error("native t3 ticket request failed"), { status: response.status });
    const ticket = await response.json() as { ticket: string };
    const url = new URL(`${base.replace("http:", "ws:")}/ws`);
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    stage = "websocket";
    ws = new WebSocket(url);
    const socket = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("native t3 websocket timeout"), { name: "TimeoutError" })), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("native t3 websocket failed")); }, { once: true });
    });
    let seq = 0;
    const rpc = (tag: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(Object.assign(new Error(`native t3 ${tag} timeout`), { name: "TimeoutError" })); }, 15000);
      function receive(event: MessageEvent) {
        let messages: any;
        try { messages = JSON.parse(String(event.data)); } catch { return; }
        for (const message of Array.isArray(messages) ? messages : [messages]) {
          if (String(message.requestId) !== id || message._tag !== "Exit") continue;
          clearTimeout(timer); socket.removeEventListener("message", receive);
          if (message.exit?._tag === "Success") resolve(message.exit.value);
          else {
            const tags: string[] = [];
            const walk = (v: any) => { if (!v || typeof v !== "object") return; if (typeof v._tag === "string") tags.push(v._tag); if (typeof v.requiredScope === "string") tags.push(v.requiredScope); for (const child of Object.values(v)) walk(child); };
            walk(message.exit);
            reject(new Error(`native t3 ${tag} rejected (${tags.join(",")}); private response withheld`));
          }
        }
      }
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
    // Protocol 2 folds getSettings into the native server config snapshot.
    const getSettings = async () => (await rpc("server.getConfig", {})).settings;
    stage = "settings-read";
    const before = await getSettings();
    stage = "settings-preflight";
    const mutation = creation(before, home);
    stage = "settings-update";
    if (mutation) await rpc("server.updateSettings", mutation);
    stage = "settings-verify";
    const after = await getSettings();
    verifyAddition(before, after, home);
    let provider: unknown = null;
    const health = operation("inference.preset.discovery", { command: "refresh-provider", clientId: INSTANCE_ID, parentOperationId: completion.operationId, stage: "provider-refresh" }, eventSink);
    try {
      // A new instance initially has a pending placeholder, not a failed probe.
      // Refresh only this instance; never disturb the direct connections.
      await rpc("server.refreshProviders", { instanceId: INSTANCE_ID, refreshModels: true });
      const snapshot = await rpc("server.getConfig", {});
      const providers = snapshot.providers ?? snapshot.providerStatus ?? [];
      provider = Array.isArray(providers) ? providers.filter((p: any) => (p.instanceId ?? p.providerInstanceId) === INSTANCE_ID).map((p: any) => ({ instanceId: p.instanceId ?? p.providerInstanceId, status: p.status, available: p.available, models: p.models?.length, authentication: p.authStatus })) : null;
      health.finish({ outcome: "success" });
    } catch (error) {
      health.finish({ outcome: "failure", ...failure(error, "transport") });
      // Settings verification is independent of optional provider health.
    }
    return { instanceId: INSTANCE_ID, added: !!mutation, settingsVerified: true, inlineSecrets: false, provider };
  } finally {
    ws?.close();
    const previousStage = stage;
    stage = "session-revoke";
    cli(t3, ["auth", "session", "revoke", issued.sessionId]);
    stage = previousStage;
  }
  }
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  test("preset validation emits a redacted rejection without starting auth", async () => {
    const events: import("./events.ts").OperationEvent[] = [];
    await expect(installPreset("SENTINEL_BINARY", "https://user:SENTINEL_KEY@example.com/?key=SENTINEL_KEY", "/private/SENTINEL_HOME", event => events.push(event))).rejects.toThrow("loopback");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "rejected", stage: "validate", errorCategory: "configuration", command: "install" });
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });
  test("preset completion and optional discovery failures preserve result, cleanup and observer noninterference", async () => {
    const directory = mkdtempSync(join(tmpdir(), "preset-events-"));
    const executable = join(directory, "t3.ts");
    const revoked = join(directory, "revoked");
    const secret = "SENTINEL_NATIVE_KEY";
    writeFileSync(executable, `#!/usr/bin/env -S node --experimental-strip-types\nimport { writeFileSync } from "node:fs";\nconst mode: string | undefined = process.argv[4];\nif (mode === "issue") process.stdout.write(JSON.stringify({ token: "${secret}", sessionId: "${secret}" }));\nelse if (mode === "revoke") writeFileSync(${JSON.stringify(revoked)}, "revoked");\nelse process.exitCode = 1;\n`, { mode: 0o700 });
    let failHealth = false;
    let settings: any = { providerInstances: {} };
    class Socket extends EventTarget {
      constructor(_url: URL) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { /* No real connection in this fixture. */ }
      send(value: string) {
        const request = JSON.parse(value);
        if (request.tag === "server.updateSettings") settings.providerInstances[INSTANCE_ID] = request.payload.providerInstanceMutation.instance;
        const failed = failHealth && request.tag === "server.refreshProviders";
        const result = request.tag === "server.getConfig" ? { settings, providers: [{ instanceId: INSTANCE_ID, available: true, models: [] }] } : {};
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Exit", requestId: request.id,
          exit: failed ? { _tag: "Failure", secret, reason: `https://user:${secret}@example.com/?key=${secret}` } : { _tag: "Success", value: structuredClone(result) } }) })));
      }
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ticket: secret }), { status: 200 }));
    vi.stubGlobal("WebSocket", Socket);
    try {
      for (const unavailable of [false, true]) {
        settings = { providerInstances: {} }; failHealth = unavailable;
        const events: import("./events.ts").OperationEvent[] = [];
        const result = await installPreset(executable, "http://127.0.0.1:3773", directory, event => { events.push(event); throw new Error(secret); });
        expect(result).toMatchObject({ instanceId: INSTANCE_ID, added: true, settingsVerified: true, inlineSecrets: false });
        expect(readFileSync(revoked, "utf8")).toBe("revoked");
        expect(events).toHaveLength(2);
        const completion = events.find(event => event.event === "inference.preset.install")!;
        expect(completion).toMatchObject({ outcome: "success", stage: "verified", counts: { added: 1 } });
        expect(events[0]).toMatchObject({ event: "inference.preset.discovery", parentOperationId: completion.operationId, outcome: unavailable ? "failure" : "success" });
        expect(completion.durationMs).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(events)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain(directory);
      }
    } finally { fetchMock.mockRestore(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); }
  });
}

if (isMain(import.meta.url)) {
  installPreset(process.argv[2] || "t3").then(result => console.log(JSON.stringify(result))).catch(() => {
    process.exitCode = 1;
  });
}
