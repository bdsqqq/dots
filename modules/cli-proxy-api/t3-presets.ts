import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMain } from "../tool-auth/process.ts";

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
  if (r.status !== 0) throw new Error("native t3 auth command failed; output withheld");
  return r.stdout;
}

export async function installPreset(t3: string, base = "http://127.0.0.1:3773", home = homedir()) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("native loopback t3 endpoint required");
  const issued = JSON.parse(cli(t3, ["auth", "session", "issue", "--scope", "settings:write", "--scope", "providers:manage", "--scope", "orchestration:read", "--ttl", "5m", "--label", "personal-broker-preset-bootstrap", "--json"]));
  let ws: WebSocket | undefined;
  try {
    assert.equal(typeof issued.token, "string");
    assert.equal(typeof issued.sessionId, "string");
    const ticketOptions = { method: "POST", headers: { Authorization: `Bearer ${issued.token}` }, redirect: "error" as const, signal: AbortSignal.timeout(5000) };
    let response = await fetch(`${base}/api/auth/websocket-ticket/rpc`, ticketOptions);
    if (response.status === 404) response = await fetch(`${base}/api/auth/websocket-ticket`, ticketOptions);
    if (!response.ok) throw new Error("native t3 ticket request failed");
    const ticket = await response.json() as { ticket: string };
    const url = new URL(`${base.replace("http:", "ws:")}/ws`);
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    ws = new WebSocket(url);
    const socket = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native t3 websocket timeout")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("native t3 websocket failed")); }, { once: true });
    });
    let seq = 0;
    const rpc = (tag: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error(`native t3 ${tag} timeout`)); }, 15000);
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
    const before = await getSettings();
    const mutation = creation(before, home);
    if (mutation) await rpc("server.updateSettings", mutation);
    const after = await getSettings();
    verifyAddition(before, after, home);
    let provider: unknown = null;
    try {
      // A new instance initially has a pending placeholder, not a failed probe.
      // Refresh only this instance; never disturb the direct connections.
      await rpc("server.refreshProviders", { instanceId: INSTANCE_ID, refreshModels: true });
      const snapshot = await rpc("server.getConfig", {});
      const providers = snapshot.providers ?? snapshot.providerStatus ?? [];
      provider = Array.isArray(providers) ? providers.filter((p: any) => (p.instanceId ?? p.providerInstanceId) === INSTANCE_ID).map((p: any) => ({ instanceId: p.instanceId ?? p.providerInstanceId, status: p.status, available: p.available, models: p.models?.length, authentication: p.authStatus })) : null;
    } catch { /* Settings verification is independent of optional provider health. */ }
    return { instanceId: INSTANCE_ID, added: !!mutation, settingsVerified: true, inlineSecrets: false, provider };
  } finally {
    ws?.close();
    cli(t3, ["auth", "session", "revoke", issued.sessionId]);
  }
}

if (isMain(import.meta.url)) {
  installPreset(process.argv[2] || "t3").then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof assert.AssertionError ? error.message : "native t3 preset setup failed; credentials and private responses withheld");
    process.exitCode = 1;
  });
}
