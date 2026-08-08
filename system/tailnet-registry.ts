import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_MANIFEST_BYTES = 256 * 1024;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Audience = "owner" | "family" | "machines";
type Scheme = "http" | "https";

export interface ServiceConfig {
  adoptExisting?: boolean;
  audience: Audience;
  description: string | null;
  healthPath: string;
  path: string;
  port: number;
  scheme: Scheme;
  target: string;
  title: string;
}

interface RegistryConfig {
  schemaVersion: 1;
  host: { name: string };
  manifest: { port: number; backendPort: number };
  directory: { enable: boolean; port: number; backendPort: number };
  services: Record<string, ServiceConfig>;
}

export interface Route {
  key: string;
  scheme: Scheme;
  port: number;
  target: string;
  adoptExisting?: boolean;
  sharedPort?: boolean;
}

interface PublicService {
  audience: Audience;
  description: string | null;
  healthPath: string;
  path: string;
  port: number;
  scheme: Scheme;
  title: string;
}

interface PublicManifest {
  schemaVersion: 1;
  host: { name: string };
  services: Record<string, PublicService>;
}

interface Machine {
  id: string;
  hostName: string;
  dnsName: string;
  online: boolean;
  lastSeen: string | null;
  os: string | null;
  manifest?: PublicManifest;
  services: DirectoryService[];
}

interface DirectoryService extends PublicService {
  id: string;
  url: string;
  health: Health;
}

interface Health {
  status: "up" | "down" | "offline" | "checking" | "auth-required";
  code?: number;
  latencyMs?: number;
  error?: string;
}

interface Snapshot {
  updatedAt: string | null;
  machines: Machine[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function log(level: "info" | "warn" | "error", message: string): void {
  const output = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
  (level === "info" ? process.stdout : process.stderr).write(output);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function command(args: string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: args,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  if (output.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${output.exitCode}): ${output.stderr.trim()}`,
    );
  }
  return output;
}

function tailscaleStatus(): Record<string, unknown> {
  return JSON.parse(command(["tailscale", "status", "--json"]).stdout);
}

function serveStatus(): Record<string, unknown> {
  return JSON.parse(
    command(["tailscale", "serve", "status", "--json"]).stdout,
  );
}

export function routesFromStatus(
  status: Record<string, unknown>,
): Map<number, Route> {
  const routes = new Map<number, Route>();
  const tcp = asRecord(status.TCP);
  const web = asRecord(status.Web);
  if (!tcp || !web) return routes;

  for (const [rawPort, rawTransport] of Object.entries(tcp)) {
    const transport = asRecord(rawTransport);
    const port = Number(rawPort);
    if (!transport || !Number.isInteger(port)) continue;
    const scheme: Scheme | null = transport.HTTPS
      ? "https"
      : transport.HTTP
        ? "http"
        : null;
    if (!scheme) {
      routes.set(port, {
        key: `observed:${port}`,
        scheme: "https",
        port,
        target: "<unsupported-handler>",
        sharedPort: true,
      });
      continue;
    }

    let found = false;
    for (const [hostPort, rawWebsite] of Object.entries(web)) {
      if (!hostPort.endsWith(`:${port}`)) continue;
      found = true;
      const website = asRecord(rawWebsite);
      const handlers = asRecord(website?.Handlers);
      const root = asRecord(handlers?.["/"]);
      if (!handlers || typeof root?.Proxy !== "string") {
        routes.set(port, {
          key: `observed:${port}`,
          scheme,
          port,
          target: "<unsupported-handler>",
          sharedPort: true,
        });
        break;
      }
      routes.set(port, {
        key: `observed:${port}`,
        scheme,
        port,
        target: root.Proxy,
        sharedPort: Object.keys(handlers).some((path) => path !== "/"),
      });
      break;
    }
    if (!found) {
      routes.set(port, {
        key: `observed:${port}`,
        scheme,
        port,
        target: "<unsupported-handler>",
        sharedPort: true,
      });
    }
  }
  return routes;
}

function desiredRoutes(config: RegistryConfig): Map<string, Route> {
  const routes = new Map<string, Route>([
    [
      "__manifest",
      {
        key: "__manifest",
        scheme: "http",
        port: config.manifest.port,
        target: `http://127.0.0.1:${config.manifest.backendPort}`,
      },
    ],
  ]);
  if (config.directory.enable) {
    routes.set("__directory", {
      key: "__directory",
      scheme: "https",
      port: config.directory.port,
      target: `http://127.0.0.1:${config.directory.backendPort}`,
    });
  }
  for (const [key, service] of Object.entries(config.services)) {
    routes.set(key, {
      key,
      scheme: service.scheme,
      port: service.port,
      target: service.target,
      adoptExisting: service.adoptExisting,
    });
  }
  return routes;
}

function routeMatches(left: Route, right: Route): boolean {
  return (
    left.scheme === right.scheme &&
    left.port === right.port &&
    left.target.replace(/\/$/, "") === right.target.replace(/\/$/, "")
  );
}

function routeForState(route: Route): Route {
  return {
    key: route.key,
    scheme: route.scheme,
    port: route.port,
    target: route.target,
  };
}

function onCommand(route: Route): string[] {
  return [
    "tailscale",
    "serve",
    "--bg",
    "--yes",
    `--${route.scheme}=${route.port}`,
    route.target,
  ];
}

function offCommand(route: Route): string[] {
  return [
    "tailscale",
    "serve",
    `--${route.scheme}=${route.port}`,
    "off",
  ];
}

interface ReconcilerDependencies {
  status: () => Record<string, unknown>;
  execute: (args: string[]) => CommandResult;
}

export class ServeReconciler {
  readonly desired: Map<string, Route>;
  readonly statePath: string;
  private readonly dependencies: ReconcilerDependencies;

  constructor(
    config: RegistryConfig,
    stateDirectory: string,
    dependencies: ReconcilerDependencies = {
      status: serveStatus,
      execute: command,
    },
  ) {
    this.desired = desiredRoutes(config);
    this.statePath = join(stateDirectory, "owned-routes.json");
    this.dependencies = dependencies;
    mkdirSync(stateDirectory, { recursive: true });
  }

  private loadOwned(): Map<string, Route> {
    const state = readJson<{ routes?: Record<string, Route> }>(
      this.statePath,
      {},
    );
    return new Map(
      Object.entries(state.routes ?? {}).filter(
        ([, route]) =>
          route &&
          (route.scheme === "http" || route.scheme === "https") &&
          Number.isInteger(route.port) &&
          typeof route.target === "string",
      ),
    );
  }

  private saveOwned(routes: Map<string, Route>): void {
    atomicWriteJson(this.statePath, {
      schemaVersion: 1,
      routes: Object.fromEntries(
        [...routes.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, route]) => [key, routeForState(route)]),
      ),
    });
  }

  reconcile(): void {
    const observed = routesFromStatus(this.dependencies.status());
    const owned = this.loadOwned();
    const conflicts: string[] = [];

    for (const [key, desired] of this.desired) {
      const current = observed.get(desired.port);
      const previous = owned.get(key);
      if (!current) continue;
      if (current.sharedPort) {
        conflicts.push(
          `${key} wants port ${desired.port}, which has additional handlers`,
        );
        continue;
      }
      if (routeMatches(current, desired)) {
        const previouslyOwned =
          previous !== undefined && routeMatches(previous, desired);
        if (!previouslyOwned && !desired.adoptExisting) {
          conflicts.push(
            `${key} exactly matches an existing route on ${desired.port}, ` +
              "but explicit adoption is disabled",
          );
        }
        continue;
      }
      if (!previous || !routeMatches(current, previous)) {
        conflicts.push(
          `${key} wants ${desired.scheme}:${desired.port} -> ${desired.target}, ` +
            `occupied by ${current.scheme}:${current.port} -> ${current.target}`,
        );
      }
    }
    if (conflicts.length) throw new Error(conflicts.join("; "));

    const nextOwned = new Map(owned);
    for (const [key, previous] of owned) {
      const desired = this.desired.get(key);
      if (desired && routeMatches(previous, desired)) continue;
      const current = observed.get(previous.port);
      if (!current) {
        nextOwned.delete(key);
        this.saveOwned(nextOwned);
        continue;
      }
      if (current.sharedPort || !routeMatches(current, previous)) {
        log(
          "warn",
          `not removing changed route on ${previous.port}; it is no longer ours`,
        );
        nextOwned.delete(key);
        this.saveOwned(nextOwned);
        continue;
      }
      log("info", `removing stale route ${key} on ${previous.port}`);
      this.dependencies.execute(offCommand(previous));
      observed.delete(previous.port);
      nextOwned.delete(key);
      this.saveOwned(nextOwned);
    }

    for (const [key, desired] of this.desired) {
      const current = observed.get(desired.port);
      if (current && routeMatches(current, desired)) {
        nextOwned.set(key, desired);
        this.saveOwned(nextOwned);
        continue;
      }

      const previous = owned.get(key);
      if (current && previous && routeMatches(current, previous)) {
        log("info", `replacing route ${key} on ${desired.port}`);
        this.dependencies.execute(offCommand(previous));
        observed.delete(previous.port);
        nextOwned.delete(key);
        this.saveOwned(nextOwned);
      }

      log(
        "info",
        `publishing ${key} on ${desired.scheme}:${desired.port} -> ${desired.target}`,
      );
      nextOwned.set(key, desired);
      this.saveOwned(nextOwned);
      try {
        this.dependencies.execute(onCommand(desired));
      } catch (error) {
        if (previous) {
          log("error", `replacement failed; restoring ${key}`);
          this.dependencies.execute(onCommand(previous));
          nextOwned.set(key, previous);
        } else {
          nextOwned.delete(key);
        }
        this.saveOwned(nextOwned);
        throw error;
      }
      observed.set(desired.port, desired);
    }
  }
}

function normalizedPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("invalid URL path");
  }
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("invalid URL path");
  }
  const parsed = new URL(value, "http://registry.invalid");
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("invalid URL path");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function sanitizedText(
  value: unknown,
  field: string,
  limit: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function sanitizeManifest(value: unknown): PublicManifest {
  const manifest = asRecord(value);
  const rawServices = asRecord(manifest?.services);
  if (manifest?.schemaVersion !== 1 || !rawServices) {
    throw new Error("unsupported manifest");
  }
  if (Object.keys(rawServices).length > 100) {
    throw new Error("too many services");
  }

  const services: Record<string, PublicService> = {};
  for (const [id, rawValue] of Object.entries(rawServices)) {
    const service = asRecord(rawValue);
    if (!SERVICE_ID.test(id) || !service) throw new Error("invalid service");
    if (service.scheme !== "http" && service.scheme !== "https") {
      throw new Error(`invalid scheme for ${id}`);
    }
    if (
      typeof service.port !== "number" ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535
    ) {
      throw new Error(`invalid port for ${id}`);
    }
    if (
      service.audience !== "owner" &&
      service.audience !== "family" &&
      service.audience !== "machines"
    ) {
      throw new Error(`invalid audience for ${id}`);
    }
    services[id] = {
      title: sanitizedText(service.title ?? id, `title for ${id}`, 100),
      description:
        service.description === null || service.description === undefined
          ? null
          : sanitizedText(
              service.description,
              `description for ${id}`,
              500,
            ),
      scheme: service.scheme,
      port: service.port,
      path: normalizedPath(service.path ?? "/"),
      healthPath: normalizedPath(
        service.healthPath ?? service.path ?? "/",
      ),
      audience: service.audience,
    };
  }

  const rawHost = asRecord(manifest.host);
  return {
    schemaVersion: 1,
    host: {
      name:
        rawHost?.name === undefined
          ? "unknown"
          : sanitizedText(rawHost.name, "host name", 100),
    },
    services,
  };
}

function publicManifest(config: RegistryConfig): PublicManifest {
  const services: Record<string, PublicService> = {};
  for (const [id, service] of Object.entries(config.services)) {
    services[id] = {
      audience: service.audience,
      description: service.description,
      healthPath: service.healthPath,
      path: service.path,
      port: service.port,
      scheme: service.scheme,
      title: service.title,
    };
  }
  if (config.directory.enable) {
    services["service-directory"] = {
      title: "service directory",
      description: "machines and services available on this tailnet",
      scheme: "https",
      port: config.directory.port,
      path: "/",
      healthPath: "/api/services",
      audience: "owner",
    };
  }
  return sanitizeManifest({
    schemaVersion: 1,
    host: config.host,
    services,
  });
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_MANIFEST_BYTES) {
    throw new Error("manifest exceeds size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw new Error("manifest exceeds size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchManifest(url: string): Promise<PublicManifest> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "tailnet-registry/1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok || response.status >= 300) {
    throw new Error(`manifest returned ${response.status}`);
  }
  const body = await boundedBody(response);
  return sanitizeManifest(JSON.parse(new TextDecoder().decode(body)));
}

export async function probe(url: string): Promise<Health> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "tailnet-registry/1" },
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    const result = {
      code: response.status,
      latencyMs: Math.round(performance.now() - started),
    };
    if (response.status === 401 || response.status === 403) {
      return { status: "auth-required", ...result };
    }
    return {
      status: response.status >= 200 && response.status < 300 ? "up" : "down",
      ...result,
    };
  } catch (error) {
    return {
      status: "down",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function machineFromStatus(value: unknown): Machine | null {
  const node = asRecord(value);
  if (!node || typeof node.ID !== "string") return null;
  return {
    id: node.ID,
    hostName: typeof node.HostName === "string" ? node.HostName : "unknown",
    dnsName:
      typeof node.DNSName === "string" ? node.DNSName.replace(/\.$/, "") : "",
    online: Boolean(node.Online),
    lastSeen: typeof node.LastSeen === "string" ? node.LastSeen : null,
    os: typeof node.OS === "string" ? node.OS : null,
    services: [],
  };
}

function serviceUrl(machine: Machine, service: PublicService): string {
  return new URL(
    normalizedPath(service.path),
    `${service.scheme}://${machine.dnsName}:${service.port}`,
  ).toString();
}

function healthUrl(machine: Machine, service: PublicService): string {
  return new URL(
    normalizedPath(service.healthPath),
    `${service.scheme}://${machine.dnsName}:${service.port}`,
  ).toString();
}

class Directory {
  private snapshot: Snapshot;
  private readonly cachePath: string;

  constructor(
    private readonly config: RegistryConfig,
    private readonly localManifest: PublicManifest,
    stateDirectory: string,
  ) {
    this.cachePath = join(stateDirectory, "directory-cache.json");
    this.snapshot = readJson<Snapshot>(this.cachePath, {
      updatedAt: null,
      machines: [],
    });
  }

  getSnapshot(): Snapshot {
    return structuredClone(this.snapshot);
  }

  async refresh(): Promise<void> {
    const status = tailscaleStatus();
    const self = asRecord(status.Self);
    const peers = asRecord(status.Peer) ?? {};
    const nodes = [self, ...Object.values(peers)]
      .map(machineFromStatus)
      .filter((machine): machine is Machine => machine !== null);
    const previous = new Map(
      this.snapshot.machines.map((machine) => [machine.id, machine]),
    );
    const selfId = typeof self?.ID === "string" ? self.ID : null;

    const manifests = await mapLimit(nodes, 8, async (machine) => {
      if (machine.id === selfId) return this.localManifest;
      if (!machine.online || !machine.dnsName) {
        return previous.get(machine.id)?.manifest;
      }
      try {
        return await fetchManifest(
          `http://${machine.dnsName}:${this.config.manifest.port}/manifest.json`,
        );
      } catch {
        return previous.get(machine.id)?.manifest;
      }
    });

    const probeJobs: Array<{
      machine: Machine;
      service: DirectoryService;
      url: string;
    }> = [];
    nodes.forEach((machine, index) => {
      const manifest = manifests[index];
      machine.manifest = manifest;
      if (!manifest) return;
      for (const [id, service] of Object.entries(manifest.services)) {
        const entry: DirectoryService = {
          ...service,
          id,
          url: serviceUrl(machine, service),
          health: {
            status: machine.online ? "checking" : "offline",
          },
        };
        machine.services.push(entry);
        if (machine.online) {
          probeJobs.push({
            machine,
            service: entry,
            url: healthUrl(machine, service),
          });
        }
      }
    });

    const health = await mapLimit(probeJobs, 8, async (job) => ({
      job,
      result: await probe(job.url),
    }));
    for (const { job, result } of health) job.service.health = result;

    this.snapshot = {
      updatedAt: new Date().toISOString(),
      machines: nodes.sort(
        (left, right) =>
          Number(right.online) - Number(left.online) ||
          left.hostName.localeCompare(right.hostName),
      ),
    };
    atomicWriteJson(this.cachePath, this.snapshot);
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeTime(value: string | null): string {
  if (!value || value.startsWith("0001-")) return "now";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function renderDirectory(snapshot: Snapshot): string {
  const serviceCount = snapshot.machines.reduce(
    (count, machine) => count + machine.services.length,
    0,
  );
  const onlineCount = snapshot.machines.filter(
    (machine) => machine.online,
  ).length;
  const cards = snapshot.machines
    .map((machine) => {
      const services = machine.services.length
        ? machine.services
            .map((service) => {
              const detail =
                service.health.status === "up"
                  ? service.health.latencyMs === undefined
                    ? "reachable"
                    : `${service.health.latencyMs} ms`
                  : service.health.status === "down"
                    ? "unreachable"
                    : service.health.status === "offline"
                      ? "machine offline"
                      : service.health.status === "auth-required"
                        ? "sign-in required"
                        : "checking";
              return `<a class="service" href="${escapeHtml(service.url)}">
                <span class="service-copy">
                  <strong>${escapeHtml(service.title)}</strong>
                  <small>${escapeHtml(service.description ?? service.url)}</small>
                </span>
                <span class="health health-${escapeHtml(service.health.status)}">
                  <i></i>${escapeHtml(detail)}
                </span>
              </a>`;
            })
            .join("")
        : '<p class="empty">no registry manifest announced</p>';
      const state = machine.online ? "online" : "offline";
      return `<section class="machine ${machine.online ? "" : "is-offline"}">
        <header>
          <span>
            <span class="machine-status ${state}"></span>
            <h2>${escapeHtml(machine.hostName)}</h2>
          </span>
          <small>${machine.online ? "online" : escapeHtml(relativeTime(machine.lastSeen))}</small>
        </header>
        <div class="services">${services}</div>
      </section>`;
    })
    .join("");

  const updated = snapshot.updatedAt
    ? relativeTime(snapshot.updatedAt)
    : "waiting for first scan";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>tailnet services</title>
  <style>
    :root { color-scheme: dark; --bg:#0c0d0f; --panel:#14161a; --panel-hover:#191c21; --line:#292d34; --muted:#8f98a6; --text:#f4f5f7; --green:#65d68b; --red:#f17b7b; --amber:#e3b868; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-font-smoothing:antialiased; }
    main { width:min(1040px,calc(100% - 32px)); margin:0 auto; padding:64px 0; }
    .masthead { display:flex; justify-content:space-between; align-items:end; gap:24px; margin-bottom:32px; }
    h1 { font:600 clamp(28px,5vw,48px)/1.05 system-ui,sans-serif; letter-spacing:-.04em; margin:0 0 10px; }
    .summary,.updated { color:var(--muted); margin:0; }
    .updated { text-align:right; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
    .machine { border:1px solid var(--line); border-radius:14px; background:var(--panel); overflow:hidden; }
    .machine.is-offline { opacity:.62; }
    .machine>header { display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line); }
    .machine>header>span { display:flex; align-items:center; gap:10px; }
    .machine h2 { font:600 15px/1 system-ui,sans-serif; margin:0; }
    .machine header small { color:var(--muted); }
    .machine-status,.health i { width:7px; height:7px; border-radius:50%; background:var(--muted); flex:none; }
    .machine-status.online,.health-up i { background:var(--green); box-shadow:0 0 0 3px color-mix(in srgb,var(--green),transparent 85%); }
    .machine-status.offline,.health-down i { background:var(--red); }
    .health-offline i { background:var(--muted); }
    .health-checking i,.health-auth-required i { background:var(--amber); }
    .services { padding:6px; }
    .service { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:13px 12px; border-radius:9px; color:inherit; text-decoration:none; transition:background 140ms ease,transform 140ms cubic-bezier(.23,1,.32,1); }
    .service:hover { background:var(--panel-hover); }
    .service:active { transform:scale(.985); }
    .service-copy { min-width:0; display:grid; gap:3px; }
    .service-copy strong { font:560 14px/1.25 system-ui,sans-serif; }
    .service-copy small { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .health { color:var(--muted); display:inline-flex; align-items:center; gap:7px; font-size:11px; white-space:nowrap; }
    .empty { color:var(--muted); margin:0; padding:16px 12px; font-size:12px; }
    @media(max-width:640px) { main{padding:32px 0}.masthead{align-items:start;flex-direction:column}.updated{text-align:left}.service{align-items:start;flex-direction:column;gap:8px} }
    @media(prefers-reduced-motion:reduce) { .service{transition:none} }
  </style>
</head>
<body>
  <main>
    <div class="masthead">
      <div>
        <h1>tailnet services</h1>
        <p class="summary">${serviceCount} services across ${onlineCount}/${snapshot.machines.length} online machines</p>
      </div>
      <p class="updated">updated ${escapeHtml(updated)}<br>refreshes every 30 seconds</p>
    </div>
    <div class="grid">${cards}</div>
  </main>
</body>
</html>`;
}

function jsonResponse(value: unknown): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parseArguments(args: string[]): { config: string; stateDirectory: string } {
  const configIndex = args.indexOf("--config");
  const stateIndex = args.indexOf("--state-dir");
  if (configIndex < 0 || stateIndex < 0) {
    throw new Error("--config and --state-dir are required");
  }
  return {
    config: args[configIndex + 1],
    stateDirectory: args[stateIndex + 1],
  };
}

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2));
  const config = JSON.parse(readFileSync(args.config, "utf8")) as RegistryConfig;
  const manifest = publicManifest(config);
  mkdirSync(args.stateDirectory, { recursive: true });

  const lockPath = join(args.stateDirectory, "agent.lock");
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(`tailnet registry is already running as pid ${pid}`);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already running")
        ) {
          throw error;
        }
      }
    }
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, "wx");
  writeFileSync(lock, String(process.pid));
  closeSync(lock);

  const manifestServer = Bun.serve({
    hostname: "127.0.0.1",
    port: config.manifest.backendPort,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return path === "/" || path === "/manifest.json"
        ? jsonResponse(manifest)
        : new Response("not found\n", { status: 404 });
    },
  });

  const directory = config.directory.enable
    ? new Directory(config, manifest, args.stateDirectory)
    : null;
  const directoryServer = directory
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: config.directory.backendPort,
        fetch(request) {
          const path = new URL(request.url).pathname;
          const snapshot = directory.getSnapshot();
          if (path === "/api/services") return jsonResponse(snapshot);
          if (path !== "/" && path !== "/index.html") {
            return new Response("not found\n", { status: 404 });
          }
          return new Response(renderDirectory(snapshot), {
            headers: {
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
              "content-type": "text/html; charset=utf-8",
            },
          });
        },
      })
    : null;

  const shutdown = (): void => {
    manifestServer.stop(true);
    directoryServer?.stop(true);
    try {
      unlinkSync(lockPath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const reconciler = new ServeReconciler(config, args.stateDirectory);
  let lastDirectoryRefresh = 0;
  while (true) {
    try {
      reconciler.reconcile();
    } catch (error) {
      log("error", `serve reconciliation failed: ${String(error)}`);
    }
    if (directory && Date.now() - lastDirectoryRefresh >= 30_000) {
      try {
        await directory.refresh();
      } catch (error) {
        log("error", `directory refresh failed: ${String(error)}`);
      }
      lastDirectoryRefresh = Date.now();
    }
    await Bun.sleep(15_000);
  }
}

if (import.meta.main) {
  await main();
}
