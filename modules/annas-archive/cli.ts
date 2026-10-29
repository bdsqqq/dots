#!/usr/bin/env node
import { isMain, privateFile } from "../tool-auth/process.ts";
import { responseJson } from "./http.ts";
import { defaultPreferencesFile, loadPreferences, renderSearch, search, SearchError } from "./search.ts";

export interface Config {
  enabled: boolean;
  apiKeyFile: string;
  baseUrl: string;
  preferencesFile?: string;
}

type Request = { action: "resolve" | "ready"; md5: string; pathIndex?: number; domainIndex?: number };
type SearchCommand = {
  action: "search"; query: string; preferencesFile?: string;
  language?: string; format?: string; pages: number; limit: number; all: boolean; json: boolean;
};
type Command = Request | SearchCommand | { action: "help" } | { action: "doctor" };
class AnnaError extends Error {}

const help = `anna — Anna’s Archive index search and member download URLs

usage:
  anna search QUERY [--json] [--all]
                    [--language 'en, pt-BR > pt > *'] [--format 'pdf > epub > * > mobi']
                    [--preferences FILE] [--pages 1..5] [--limit 1..100]
  anna doctor
  anna resolve MD5 [--path-index N] [--domain-index N]
  anna ready MD5 [--path-index N] [--domain-index N]

search signs into the configured Anna origin and reads its index HTML. results
include file MD5s; no download endpoint is called. defaults: 2 pages, 20 displayed
results. preferences are read live; secondary matches are faded.
--all exposes hidden fallback results. NO_COLOR disables ANSI; FORCE_COLOR=1 enables it.

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
  if (args[0] === "search") return parseSearch(args.slice(1));
  const [action, md5, ...flags] = args;
  if (action === "doctor" && args.length === 1) return { action };
  if ((action !== "resolve" && action !== "ready") || !md5 || !/^[a-f0-9]{32}$/i.test(md5)) {
    throw new AnnaError("anna: expected search QUERY, doctor, or resolve/ready followed by a 32-character hexadecimal MD5; use --help");
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

function parseSearch(args: string[]): SearchCommand {
  const command: SearchCommand = { action: "search", query: "", pages: 2, limit: 20, all: false, json: false };
  const words: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") { words.push(...args.slice(i + 1)); break; }
    if (!flag.startsWith("--")) { words.push(flag); continue; }
    if (seen.has(flag)) throw new AnnaError("anna: duplicate search option; use --help");
    seen.add(flag);
    if (flag === "--all") { command.all = true; continue; }
    if (flag === "--json") { command.json = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new AnnaError("anna: search option requires a value; use --help");
    if (flag === "--language") command.language = value;
    else if (flag === "--format") command.format = value;
    else if (flag === "--preferences") command.preferencesFile = value;
    else if ((flag === "--pages" || flag === "--limit") && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
      if (flag === "--pages") command.pages = Number(value);
      else command.limit = Number(value);
    } else throw new AnnaError("anna: invalid search option or value; use --help");
  }
  command.query = words.join(" ").trim();
  return command;
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
    preferencesFile: env.ANNAS_ARCHIVE_PREFERENCES_FILE ?? defaultPreferencesFile,
  };
}

export async function run(args: string[], cfg: Config, fetcher: typeof fetch = fetch): Promise<string> {
  const command = parse(args);
  if (command.action === "help") return help;
  if (command.action === "doctor") {
    credential(cfg);
    loadPreferences(cfg.preferencesFile ?? defaultPreferencesFile);
    return "anna: local configuration, preferences, and private credential file are valid; remote membership access is unverified";
  }
  if (command.action === "search") {
    const preferences = loadPreferences(command.preferencesFile ?? cfg.preferencesFile ?? defaultPreferencesFile, command);
    const result = await search({ ...command, preferences, annaBaseUrl: origin(cfg.baseUrl).href }, credential(cfg), fetcher);
    const color = process.env.NO_COLOR === undefined && (process.env.FORCE_COLOR === "1" || !!process.stdout.isTTY);
    return command.json ? JSON.stringify(result, null, 2) : renderSearch(result, color);
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
    console.error(error instanceof AnnaError || error instanceof SearchError ? error.message : "anna: operation failed; private error details suppressed");
    process.exitCode = 1;
  }
}
