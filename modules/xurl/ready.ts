import { capture, isMain, privateFile, type Command } from "../tool-auth/process.ts";
export type Runner = (command: Command, timeout?: number) => string;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid native response; check the selected integration privately");
  }
};
import { existsSync } from "node:fs";
import { join } from "node:path";
export interface Config {
  enabled: boolean;
  executable: string;
  yaml: string;
  home: string;
  app: string;
  account: string;
  credentialFile?: string;
}
function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // Ambient credentials/endpoints must never override the selected native app.
  for (const key of [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "AUTH_URL",
    "TOKEN_URL",
    "API_BASE_URL",
    "INFO_URL",
    "REDIRECT_URI",
  ])
    delete env[key];
  return env;
}
function state(cfg: Config, run: Runner): Record<string, unknown> {
  const file = join(cfg.home, ".xurl/auth.yml");
  privateFile(file);
  const value = parse(run({ executable: cfg.yaml, args: ["-o=json", ".", file] }));
  if (!record(value) || !record(value.apps))
    throw new Error("invalid native X app store; use the private native setup flow");
  return value.apps;
}
export function check(cfg: Config, local = false, run: Runner = capture): void {
  if (!cfg.enabled || !cfg.home.startsWith("/") || !cfg.app || !cfg.account)
    throw new Error(
      "configure my.xurl.integration enable, nativeHome, nativeStateFile, app and account; authorize explicitly using the selected app/account",
    );
  const apps = state(cfg, run);
  const app = apps[cfg.app];
  if (
    !record(app) ||
    typeof app.client_id !== "string" ||
    !app.client_id ||
    !record(app.oauth2_tokens)
  )
    throw new Error("selected X app is not authorized; register/authorize it privately");
  const token = app.oauth2_tokens[cfg.account];
  if (
    !record(token) ||
    token.type !== "oauth2" ||
    !record(token.oauth2) ||
    typeof token.oauth2.access_token !== "string" ||
    !token.oauth2.access_token
  )
    throw new Error(
      "selected X account has no native OAuth2 token; run xurl --app APP auth oauth2 ACCOUNT explicitly",
    );
  if (local) return;
  const value = parse(
    run({
      executable: cfg.executable,
      args: ["--app", cfg.app, "--auth", "oauth2", "--username", cfg.account, "/2/users/me"],
      env: environment(cfg.home),
    }),
  );
  if (
    !record(value) ||
    value.errors != null ||
    !record(value.data) ||
    typeof value.data.id !== "string" ||
    !value.data.id ||
    typeof value.data.username !== "string" ||
    value.data.username.toLowerCase() !== cfg.account.toLowerCase()
  )
    throw new Error(
      "X authenticated identity read failed; check selected account, app access, scopes and quota privately",
    );
}
/** Explicit registration only; AddApp refuses duplicates, and existing app state
 * is never replaced by the static credential owner. Consent remains native. */
export function bootstrap(cfg: Config, run: Runner = capture): void {
  if (!cfg.enabled || !cfg.home.startsWith("/") || !cfg.app || !cfg.account || !cfg.credentialFile)
    throw new Error(
      "configure an explicit private X app credentialFile before xurl-ready --bootstrap",
    );
  if (
    existsSync(join(cfg.home, ".xurl")) &&
    (!existsSync(join(cfg.home, ".xurl/auth.yml")) || Object.hasOwn(state(cfg, run), cfg.app))
  )
    throw new Error(
      "native X app or legacy state already exists; preserve it and use native setup deliberately",
    );
  const secret = parse(privateFile(cfg.credentialFile));
  if (
    !record(secret) ||
    typeof secret.client_id !== "string" ||
    !secret.client_id ||
    typeof secret.client_secret !== "string" ||
    !secret.client_secret
  )
    throw new Error("X static credential must be private JSON with client_id and client_secret");
  // v1.3.4 registration requires these flags; no import/stdin flag exists.
  run({
    executable: cfg.executable,
    args: [
      "auth",
      "apps",
      "add",
      cfg.app,
      "--client-id",
      secret.client_id,
      "--client-secret",
      secret.client_secret,
    ],
    env: environment(cfg.home),
  });
}
function main(args: string[]): void {
  const [
    executable = "xurl",
    yaml = "yq",
    enabled,
    home = "",
    app = "",
    account = "",
    credentialFile = "",
    mode,
  ] = args;
  const cfg = { executable, yaml, enabled: enabled === "1", home, app, account, credentialFile };
  if (mode === "--bootstrap") {
    bootstrap(cfg);
    console.log("xurl: app registered; native OAuth consent still required");
    return;
  }
  if (mode && mode !== "--local") throw new Error("usage: xurl-ready [--local|--bootstrap]");
  check(cfg, mode === "--local");
  console.log(
    mode === "--local"
      ? "xurl: local token checked; authenticated readiness unverified"
      : "xurl: authenticated identity read ready",
  );
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "readiness failed");
    process.exitCode = 1;
  }
}
