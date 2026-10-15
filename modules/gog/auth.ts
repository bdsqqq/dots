#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { capture, isMain, privateFile, type Command } from "../tool-auth/process.ts";

export interface GogConfig {
  enabled: boolean;
  executable: string;
  account: string;
  client: string;
  services: string[];
  backend: string;
  clientFile: string;
  passwordFile: string;
}
type Runner = (command: Command, timeout?: number) => string;
const setup = "gog auth is not ready; enable my.gog, choose account/client/services, provision its SOPS owner, run gog-auth bootstrap-client, then explicitly authorize Gmail/Calendar with gog auth add";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* Never expose private parser input. */ }
  throw new Error(setup);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function expectedClientId(cfg: GogConfig): string {
  const client = json(privateFile(cfg.clientFile)).installed;
  if (!object(client) || typeof client.client_id !== "string" || !client.client_id.trim()
    || typeof client.client_secret !== "string" || !client.client_secret.trim()) throw new Error(setup);
  return client.client_id;
}
function verifyNativeClient(cfg: GogConfig, path: unknown): void {
  if (typeof path !== "string" || json(privateFile(path)).client_id !== expectedClientId(cfg)) throw new Error(setup);
}
export function environment(cfg: GogConfig): NodeJS.ProcessEnv {
  if (!cfg.enabled || !/^[^\s@]+@[^\s@]+$/.test(cfg.account) || !/^[a-z0-9_-]+$/.test(cfg.client)
    || cfg.services.length === 0 || cfg.services.some(s => !["gmail", "calendar"].includes(s))
    || !["file", "keychain"].includes(cfg.backend) || (process.platform === "linux" && cfg.backend !== "file")) throw new Error(setup);
  expectedClientId(cfg);
  // Prevent inherited direct tokens, dry-run settings, account aliases or home
  // overrides from turning the declared identity check into a different check.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GOG_")));
  // Retain native command restrictions; auth environment cleanup must not
  // silently disable an operator's existing send/command policy.
  for (const key of ["GOG_GMAIL_NO_SEND", "GOG_ENABLE_COMMANDS", "GOG_ENABLE_COMMANDS_EXACT", "GOG_DISABLE_COMMANDS"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GOG_KEYRING_BACKEND = cfg.backend;
  if (cfg.backend === "file") env.GOG_KEYRING_PASSWORD = privateFile(cfg.passwordFile).trimEnd();
  return env;
}
export function auth(cfg: GogConfig, action: string, run: Runner = capture): string {
  if (!["ready", "bootstrap-client"].includes(action)) throw new Error("usage: gog-auth ready | bootstrap-client | run <gog arguments>");
  const env = environment(cfg);
  const base = ["--no-input", "--json", "--client", cfg.client, "--account", cfg.account];
  const invoke = (args: string[]) => json(run({ executable: cfg.executable, args: [...base, ...args], env }));
  if (action === "bootstrap-client") {
    const clients = invoke(["auth", "credentials", "list"]).clients;
    if (!Array.isArray(clients)) throw new Error(setup);
    const existing = clients.find(c => object(c) && c.client === cfg.client && typeof c.path === "string" && c.path.length > 0);
    if (object(existing)) {
      verifyNativeClient(cfg, existing.path);
      return "gog: static client already present; native tokens preserved; authentication untested";
    }
    const saved = invoke(["auth", "credentials", "set", cfg.clientFile]);
    if (saved.saved !== true || saved.client !== cfg.client) throw new Error(setup);
    return "gog: static client bootstrapped; native tokens preserved; browser consent still required";
  }
  const status = invoke(["auth", "status"]);
  if (!object(status.account) || status.account.email !== cfg.account || status.account.client !== cfg.client
    || status.account.credentials_exists !== true || status.account.auth_preferred !== "oauth"
    || !object(status.keyring) || status.keyring.backend !== cfg.backend) throw new Error(setup);
  verifyNativeClient(cfg, status.account.credentials_path);
  const accounts = invoke(["auth", "list"]).accounts;
  if (!Array.isArray(accounts)) throw new Error(setup);
  const account = accounts.find(a => object(a) && a.email === cfg.account && a.client === cfg.client);
  if (!object(account) || account.auth !== "oauth" || account.error || !strings(account.services) || !strings(account.scopes)) throw new Error(setup);
  const grantedScopes = account.scopes;
  const scopes: Record<string, string[]> = {
    gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"],
    calendar: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar"],
  };
  for (const service of cfg.services) {
    if (!account.services.includes(service) || !scopes[service]?.some(s => grantedScopes.includes(s))) throw new Error(setup);
  }
  // Discard captured private responses. Each command has a hard 15s timeout,
  // max=1 and no all-pages flag; successful local state alone is never ready.
  for (const service of [...new Set(cfg.services)]) {
    const response = invoke(service === "gmail"
      ? ["gmail", "search", "newer_than:1d", "--max", "1"]
      : ["calendar", "calendars", "--max", "1"]);
    const field = service === "gmail" ? "threads" : "calendars";
    if (!(field in response) || !(response[field] === null || Array.isArray(response[field]))) throw new Error(setup);
  }
  return "gog: ready; expected OAuth client/account/scopes and bounded service reads verified";
}
/** Accept explicit matching selectors used by native CLI workflows, while
 * preventing a wrapper invocation from silently switching identities. */
export function pinnedArgs(cfg: GogConfig, args: string[]): string[] {
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const selector = /^(--account|--acct|--client|-a)(?:=(.*))?$/.exec(arg);
    if (selector) {
      const expected = selector[1] === "--client" ? cfg.client : cfg.account;
      const value = selector[2] ?? args[++i];
      if (value !== expected) throw new Error(setup);
    } else if (arg.startsWith("-a") && !arg.startsWith("--") && arg.length > 2) {
      if (arg.slice(2) !== cfg.account) throw new Error(setup);
    } else {
      if (/^--(access-token|home)(=|$)/.test(arg)) throw new Error(setup);
      forwarded.push(arg);
    }
  }
  return ["--client", cfg.client, "--account", cfg.account, ...forwarded];
}
function config(): GogConfig {
  return {
    enabled: process.env.TOOL_AUTH_GOG_ENABLED === "1", executable: process.env.TOOL_AUTH_GOG_BINARY ?? "gog",
    account: process.env.TOOL_AUTH_GOG_ACCOUNT ?? "", client: process.env.TOOL_AUTH_GOG_CLIENT ?? "",
    services: (process.env.TOOL_AUTH_GOG_SERVICES ?? "").split(",").filter(Boolean),
    backend: process.env.TOOL_AUTH_GOG_BACKEND ?? "", clientFile: process.env.TOOL_AUTH_GOG_CLIENT_FILE ?? "",
    passwordFile: process.env.TOOL_AUTH_GOG_PASSWORD_FILE ?? "",
  };
}
if (isMain(import.meta.url)) {
  try {
    const cfg = config();
    const [action, ...args] = process.argv.slice(2);
    if (action === "run") {
      const env = environment(cfg);
      const result = spawnSync(cfg.executable, pinnedArgs(cfg, args), { env, stdio: "inherit" });
      process.exitCode = result.status ?? 1;
    } else {
      if (args.length) throw new Error("usage: gog-auth ready | bootstrap-client");
      console.log(auth(cfg, action ?? ""));
    }
  } catch { console.error(setup); process.exitCode = 1; }
}
