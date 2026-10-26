#!/usr/bin/env node
import { isMain, privateFile } from "../tool-auth/process.ts";

export interface Config {
  enabled: boolean;
  apiKeyFile: string;
  baseUrl: string;
}

type Request = { action: "resolve" | "ready"; md5: string; pathIndex?: number; domainIndex?: number };
type Command = Request | { action: "help" } | { action: "doctor" };
class AnnaError extends Error {}

const help = `anna — Anna's Archive member download URLs

usage:
  anna doctor
  anna resolve MD5 [--path-index N] [--domain-index N]
  anna ready MD5 [--path-index N] [--domain-index N]

resolve prints JSON containing download_url; treat the URL as private.
ready makes the same request but discards the URL. both may consume your
membership's download allowance. no retries or automatic mirror fallback.
doctor checks local provisioning only; it does not prove membership access.

configure my.annasArchive in Nix; no secret-key command-line argument is accepted.
API docs: https://annas-archive.gl/dyn/api/fast_download.json`;

function origin(baseUrl: string): URL {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new AnnaError("anna: baseUrl must be an HTTPS origin without credentials, a path, query, or fragment");
  }
}

function parse(args: string[]): Command {
  if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))) return { action: "help" };
  const [action, md5, ...flags] = args;
  if (action === "doctor" && args.length === 1) return { action };
  if ((action !== "resolve" && action !== "ready") || !md5 || !/^[a-f0-9]{32}$/i.test(md5)) {
    throw new AnnaError("anna: expected doctor, or resolve/ready followed by a 32-character hexadecimal MD5; use --help");
  }
  const request: Request = { action, md5: md5.toLowerCase() };
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const name = flag === "--path-index" ? "pathIndex" : flag === "--domain-index" ? "domainIndex" : null;
    const value = flags[i + 1];
    if (!name || request[name] !== undefined || !value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new AnnaError("anna: indices must be unique --path-index/--domain-index pairs with nonnegative safe integers; no other flags are accepted");
    }
    request[name] = Number(value);
  }
  return request;
}

function credential(cfg: Config): string {
  if (!cfg.enabled) throw new AnnaError("anna: integration disabled; enable my.annasArchive and provision its credential first");
  origin(cfg.baseUrl);
  try {
    const key = privateFile(cfg.apiKeyFile).trim();
    if (key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw new Error();
    return key;
  } catch {
    throw new AnnaError("anna: credential is missing or unsafe; provide a nonempty private runtime key file outside the Nix store");
  }
}

/** Bound response memory as well as request time; never surface remote error bodies. */
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The API puts the account secret in the query: do not log this URL or follow redirects. */
async function resolveFile(cfg: Config, request: Request, fetcher: typeof fetch): Promise<string> {
  const key = credential(cfg);
  const endpoint = new URL("/dyn/api/fast_download.json", origin(cfg.baseUrl));
  endpoint.searchParams.set("md5", request.md5);
  endpoint.searchParams.set("key", key);
  if (request.pathIndex !== undefined) endpoint.searchParams.set("path_index", String(request.pathIndex));
  if (request.domainIndex !== undefined) endpoint.searchParams.set("domain_index", String(request.domainIndex));

  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
  } catch {
    throw new AnnaError("anna: API request failed, redirected, or timed out; no retry was made");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AnnaError(`anna: API request rejected (HTTP ${response.status}); check membership, identifier, and allowance; no retry was made`);
  }
  try {
    const value = await responseJson(response);
    if (!value || typeof value !== "object" || !("download_url" in value) || typeof value.download_url !== "string") throw new Error();
    const raw = value.download_url;
    if (!raw || raw.length > 16 * 1024 || /[\x00-\x20\x7f]/.test(raw) || raw.includes(key) || decodeURIComponent(raw).includes(key)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new AnnaError("anna: API returned no safe download URL or an invalid/oversized JSON response");
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  return {
    enabled: env.ANNAS_ARCHIVE_ENABLED === "1",
    apiKeyFile: env.ANNAS_ARCHIVE_KEY_FILE ?? "",
    baseUrl: env.ANNAS_ARCHIVE_BASE_URL ?? "https://annas-archive.gl",
  };
}

export async function run(args: string[], cfg: Config, fetcher: typeof fetch = fetch): Promise<string> {
  const command = parse(args);
  if (command.action === "help") return help;
  if (command.action === "doctor") {
    credential(cfg);
    return "anna: local configuration and private credential file are valid; remote membership access is unverified";
  }
  const downloadUrl = await resolveFile(cfg, command, fetcher);
  return command.action === "ready"
    ? "anna: authenticated URL resolution succeeded; response discarded; this request may consume download allowance"
    : JSON.stringify({ download_url: downloadUrl });
}

if (isMain(import.meta.url)) {
  try {
    console.log(await run(process.argv.slice(2), configFromEnv(process.env)));
  } catch (error) {
    console.error(error instanceof AnnaError ? error.message : "anna: operation failed; private error details suppressed");
    process.exitCode = 1;
  }
}
