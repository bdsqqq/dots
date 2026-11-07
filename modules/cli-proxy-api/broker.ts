import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isMain, privateFile } from "../tool-auth/process.ts";

export const HUB_URL = "https://mmn-m4.tail1543a7.ts.net:8317";
export const HUB_PORT = 8317;
export const defaultHubDirectory = () => join(homedir(), ".local/share/cli-proxy-api");
export const defaultClientFile = () => process.env.CLI_PROXY_API_CLIENT_FILE || join(homedir(), ".config/cli-proxy-api/client.json");
export type Client = { version: 1; name: string; baseUrl: string; apiKey: string };
export type Hub = { version: 1; baseUrl: string; port: number };

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("the broker requires an HTTPS origin without credentials or a path");
  }
  return url.origin;
}

function privateDirectory(path: string): void {
  if (!isAbsolute(path) || path === "/nix/store" || path.startsWith("/nix/store/")) throw new Error("private runtime storage must be outside the Nix store");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error("runtime storage must be an owned directory, not a symlink");
  chmodSync(path, 0o700);
}

/** Exclusive creation makes restarts preserve native GUI edits and OAuth state. */
function seed(path: string, value: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privateFile(path);
  }
}

function key(): string { return `broker-${randomBytes(32).toString("base64url")}`; }
export const hubPaths = (directory: string) => ({
  directory,
  config: join(directory, "config.yaml"),
  metadata: join(directory, "hub.json"),
  managementKey: join(directory, "management.key"),
  auth: join(directory, "auth"),
  clients: join(directory, "clients"),
});

export function readClient(path: string): Client {
  let value: Partial<Client>;
  try { value = JSON.parse(privateFile(path)); } catch { throw new Error("broker client credential is missing or unsafe; provision this machine first"); }
  if (value.version !== 1 || typeof value.name !== "string" || typeof value.baseUrl !== "string" || typeof value.apiKey !== "string" || !/^broker-[A-Za-z0-9_-]{43}$/.test(value.apiKey)) {
    throw new Error("invalid broker client credential");
  }
  return { version: 1, name: value.name, baseUrl: origin(value.baseUrl), apiKey: value.apiKey };
}

export function readHub(directory: string): Hub {
  const value = JSON.parse(privateFile(hubPaths(directory).metadata)) as Hub;
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("invalid hub metadata");
  return { ...value, baseUrl: origin(value.baseUrl) };
}

export function initializeHub(directory: string, baseUrl = HUB_URL, port = HUB_PORT): void {
  baseUrl = origin(baseUrl);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid hub port");
  const paths = hubPaths(directory);
  privateDirectory(directory);
  privateDirectory(paths.auth);
  privateDirectory(paths.clients);
  // Never generate replacement credentials over a pre-existing native config.
  if (existsSync(paths.config)) {
    privateFile(paths.config);
    privateFile(paths.managementKey);
    const existing = readHub(directory);
    if (existing.baseUrl !== baseUrl || existing.port !== port) throw new Error("existing hub endpoint differs; edit its live configuration deliberately");
    return;
  }
  seed(paths.managementKey, `${key()}\n`);
  const localClientFile = join(paths.clients, "hub.json");
  seed(localClientFile, `${JSON.stringify({ version: 1, name: "hub", baseUrl, apiKey: key() })}\n`);
  const client = readClient(localClientFile);
  seed(paths.metadata, `${JSON.stringify({ version: 1, baseUrl, port })}\n`);
  // JSON is accepted by upstream's YAML loader. Native saves may convert it to
  // block YAML, so subsequent maintenance uses its management API, not JSON.parse.
  seed(paths.config, `${JSON.stringify({
    "config-version": 8,
    server: { host: "127.0.0.1", port, "trusted-proxies": ["127.0.0.1", "::1"] },
    management: {
      "allow-remote": true,
      "secret-key": privateFile(paths.managementKey).trim(),
      "disable-control-panel": false,
      "disable-auto-update-panel": true,
    },
    access: { "api-keys": [client.apiKey] },
    oauth: { "auth-dir": paths.auth, providers: { aistudio: { "ws-auth": true } } },
    routing: { strategy: "round-robin", "session-affinity": true, "session-affinity-ttl": "1h", retry: { "request-retry": 3, "max-retry-interval": 30 } },
    observability: { logs: { "request-log": true, "logging-to-file": false, "logs-max-total-size-mb": 0, "error-logs-max-files": 0 } },
  }, null, 2)}\n`);
}

/** No redirects: neither gateway nor management credentials may follow one. */
class BrokerHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`broker HTTP ${status}; response content withheld`); this.status = status; }
}

async function request(url: string, apiKey: string, method = "GET", body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error("broker connection failed; check the service and private network"); }
  if (!response.ok) { await response.body?.cancel(); throw new BrokerHttpError(response.status); }
  try { return await response.json(); } catch { throw new Error("broker returned an invalid JSON response"); }
}

export async function issueClient(directory: string, name: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || name === "hub") throw new Error("use a lowercase machine name, not a path or hub");
  const paths = hubPaths(directory);
  const hub = readHub(directory);
  const file = join(paths.clients, `${name}.json`);
  seed(file, `${JSON.stringify({ version: 1, name, baseUrl: hub.baseUrl, apiKey: key() })}\n`);
  const client = readClient(file);
  if (client.baseUrl !== hub.baseUrl) throw new Error("client endpoint differs from this hub");
  // Upstream PATCH replaces a matching old value, or appends new when absent.
  // This avoids replacing the whole key list and losing concurrent GUI changes.
  await request(`http://127.0.0.1:${hub.port}/v0/management/api-keys`, privateFile(paths.managementKey).trim(), "PATCH", { old: client.apiKey, new: client.apiKey });
  // A successful config write precedes the native watcher's live-auth refresh.
  // Do not distribute a credential until the serving path actually accepts it.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await request(`http://127.0.0.1:${hub.port}/v1/models`, client.apiKey);
      return file;
    } catch (error) {
      if (!(error instanceof BrokerHttpError) || error.status !== 401) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error("native broker did not activate the issued client credential");
}

export function clientCommand(client: Client, program: "claude" | "codex", args: string[], env: NodeJS.ProcessEnv = process.env): { program: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (program === "claude") {
    // Credential injection is process-local; the direct CLI and its config stay intact.
    const environment: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: client.baseUrl, ANTHROPIC_AUTH_TOKEN: client.apiKey };
    delete environment.ANTHROPIC_API_KEY;
    delete environment.CLAUDE_CODE_OAUTH_TOKEN;
    return { program: env.CLAUDE_BIN || "claude", args, env: environment };
  }
  const settings = {
    name: "CLIProxyAPI", base_url: `${client.baseUrl}/v1`, wire_api: "responses",
    env_key: "CLI_PROXY_API_KEY", requires_openai_auth: false, supports_websockets: true,
  };
  // TOML inline-table string values use the same basic escaping as JSON.
  const table = `{${Object.entries(settings).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}}`;
  return {
    program: env.CODEX_BIN || "codex",
    args: ["-c", 'model_provider="cliproxyapi"', "-c", `model_providers.cliproxyapi=${table}`, ...args],
    env: { ...env, CLI_PROXY_API_KEY: client.apiKey },
  };
}

async function run(program: string, args: string[], env = process.env, cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, cwd, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", () => { cleanup(); reject(new Error("native executable unavailable; install the configured prerequisite")); });
    child.once("exit", (code) => { cleanup(); resolve(code ?? 1); });
    function cleanup() { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  });
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const directory = process.env.CLI_PROXY_API_STATE_DIR || defaultHubDirectory();
  const paths = hubPaths(directory);
  const binary = process.env.CLI_PROXY_API_BIN || "cliproxyapi";
  switch (command) {
    case "init":
      initializeHub(directory, process.env.CLI_PROXY_API_BASE_URL || HUB_URL, Number(process.env.CLI_PROXY_API_PORT || HUB_PORT));
      console.log("private hub config initialized; existing native config is preserved");
      return 0;
    case "serve":
      initializeHub(directory, process.env.CLI_PROXY_API_BASE_URL || HUB_URL, Number(process.env.CLI_PROXY_API_PORT || HUB_PORT));
      process.umask(0o077);
      return run(binary, ["-config", paths.config], process.env, directory);
    case "login": {
      const flag = rest[0] === "claude" ? "-claude-login" : rest[0] === "codex" ? "-codex-device-login" : null;
      if (!flag || rest.length !== 1) throw new Error("usage: inference-broker login claude|codex (on the hub)");
      privateFile(paths.config);
      process.umask(0o077);
      return run(binary, ["-config", paths.config, flag, "-no-browser"], process.env, directory);
    }
    case "issue-client":
      if (rest.length !== 1) throw new Error("usage: inference-broker issue-client machine-name (on the hub)");
      console.log(await issueClient(directory, rest[0]!));
      return 0;
    case "key":
      // For native credential-command consumers only; never call this in agent logs.
      process.stdout.write(readClient(defaultClientFile()).apiKey);
      return 0;
    case "run": {
      const program = rest[0];
      if (program !== "claude" && program !== "codex") throw new Error("usage: inference-broker run claude|codex [native arguments]");
      const command = clientCommand(readClient(defaultClientFile()), program, rest.slice(1));
      return run(command.program, command.args, command.env);
    }
    case "status": {
      const client = readClient(defaultClientFile());
      const response = await request(`${client.baseUrl}/v1/models`, client.apiKey) as { data?: { id?: string }[] };
      if (!Array.isArray(response.data) || response.data.some(m => typeof m.id !== "string")) throw new Error("broker returned an invalid model list");
      console.log(JSON.stringify({ endpoint: client.baseUrl, client: client.name, models: response.data.map(m => m.id), inferenceTested: false }, null, 2));
      return 0;
    }
    case "accounts": {
      const hub = readHub(directory);
      const response = await request(`http://127.0.0.1:${hub.port}/v8/management/credentials`, privateFile(paths.managementKey).trim()) as { files?: { provider?: string; disabled?: boolean; status?: string }[] };
      if (!Array.isArray(response.files)) throw new Error("broker returned an invalid account list");
      console.log(JSON.stringify({ accounts: response.files.map(f => ({ provider: f.provider, disabled: f.disabled, status: f.status })) }, null, 2));
      return 0;
    }
    default:
      console.log("inference-broker: init | serve | login claude|codex | issue-client machine | status | accounts\nclaude-broker / codex-broker preserve direct CLI settings. request logs are best-effort, not a durable archive.");
      return command ? 1 : 0;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    // Native/network errors can contain credentials; do not print arbitrary error text.
    console.error("broker operation failed; check private runtime files, service availability, and command arguments");
    process.exitCode = 1;
  });
}
