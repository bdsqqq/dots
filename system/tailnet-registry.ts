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
const STALE_HEALTH_MS = 2 * 60 * 1_000;

type TailnetAudience = "owner" | "family" | "machines";
type CloudflareAudience = "disabled" | "owner" | "family" | "public";
type Scheme = "http" | "https";

interface ServiceAccess {
  tailnet: TailnetAudience;
  cloudflare: CloudflareAudience;
}

interface NativeServiceConfig {
  enable: boolean;
  name: string;
  port: number;
  adoptExisting?: boolean;
}

export interface ServiceConfig {
  adoptExisting?: boolean;
  access: ServiceAccess;
  description: string | null;
  healthPath: string;
  path: string;
  port: number;
  scheme: Scheme;
  tailscaleService: NativeServiceConfig;
  target: string;
  title: string;
}

interface RegistryConfig {
  schemaVersion: 1;
  host: { name: string };
  manifest: { port: number; backendPort: number };
  directory: {
    enable: boolean;
    port: number;
    backendPort: number;
    tailscaleService: NativeServiceConfig;
  };
  hostChecks: {
    syncthing: SyncthingCheckConfig;
  };
  services: Record<string, ServiceConfig>;
}

interface SyncthingCheckConfig {
  enable: boolean;
  url: string;
  configFile: string | null;
  folderIds: string[];
}

interface SyncthingReport {
  status: "caught-up" | "busy" | "error" | "unreachable";
  checkedAt: string;
  monitoredFolders: number;
  caughtUpFolders: number;
  errorFolders: number;
  backlogItems: number;
  backlogBytes: number;
  configuredPeers: number;
  connectedPeers: number;
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
  access: ServiceAccess;
  /** Kept during rolling deployment so older registry agents can read manifests. */
  audience: TailnetAudience;
  description: string | null;
  path: string;
  port: number;
  scheme: Scheme;
  tailscaleService: Omit<NativeServiceConfig, "adoptExisting" | "enable"> | null;
  title: string;
  health?: Health;
}

interface PublicManifest {
  schemaVersion: 1;
  reportedAt?: string;
  host: {
    name: string;
    checks?: { syncthing?: SyncthingReport };
  };
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
  manifestFetchedAt?: string;
  services: DirectoryService[];
}

interface DirectoryService extends PublicService {
  id: string;
  url: string;
  health: Health;
}

interface Health {
  status:
    | "up"
    | "down"
    | "offline"
    | "checking"
    | "auth-required"
    | "stale";
  checkedAt?: string;
  code?: number;
  latencyMs?: number;
}

interface Snapshot {
  updatedAt: string | null;
  machines: Machine[];
}

type SummaryStatus = "available" | "degraded" | "unavailable" | "unknown";

interface PortableServiceSummary {
  name: string;
  title: string;
  status: SummaryStatus;
  providers: Array<{ hostName: string; health: Health }>;
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

export interface NativeEndpoint {
  service: string;
  port: number;
  target: string;
  advertised?: boolean;
  adoptExisting?: boolean;
  shared?: boolean;
}

function nativeServiceConfig(): Record<string, unknown> {
  return JSON.parse(
    command(["tailscale", "serve", "get-config", "--all"]).stdout,
  );
}

export function nativeEndpointsFromConfig(
  config: Record<string, unknown>,
): Map<string, NativeEndpoint> {
  const result = new Map<string, NativeEndpoint>();
  const services = asRecord(config.services);
  if (!services) return result;

  for (const [service, rawValue] of Object.entries(services)) {
    const value = asRecord(rawValue);
    const endpoints = asRecord(value?.endpoints);
    if (!service.startsWith("svc:") || !endpoints) continue;
    const entries = Object.entries(endpoints);
    const [endpoint, target] = entries[0] ?? [];
    const match = /^tcp:(\d+)$/.exec(endpoint ?? "");
    if (!match || typeof target !== "string") continue;
    result.set(service, {
      service,
      port: Number(match[1]),
      target,
      advertised: value?.advertised !== false,
      shared: entries.length !== 1,
    });
  }
  return result;
}

function desiredNativeEndpoints(
  config: RegistryConfig,
): Map<string, NativeEndpoint> {
  const endpoints = new Map<string, NativeEndpoint>();
  const add = (definition: NativeServiceConfig, target: string): void => {
    if (!definition.enable) return;
    const service = `svc:${definition.name}`;
    endpoints.set(service, {
      service,
      port: definition.port,
      target,
      adoptExisting: definition.adoptExisting,
    });
  };
  add(
    config.directory.tailscaleService,
    `http://127.0.0.1:${config.directory.backendPort}`,
  );
  for (const service of Object.values(config.services)) {
    add(service.tailscaleService, service.target);
  }
  return endpoints;
}

function nativeEndpointMatches(
  left: NativeEndpoint,
  right: NativeEndpoint,
): boolean {
  return (
    left.service === right.service &&
    left.port === right.port &&
    left.target.replace(/\/$/, "") === right.target.replace(/\/$/, "")
  );
}

function nativeEndpointForState(endpoint: NativeEndpoint): NativeEndpoint {
  return {
    service: endpoint.service,
    port: endpoint.port,
    target: endpoint.target,
    ...(endpoint.advertised === false ? { advertised: false } : {}),
  };
}

function nativeOnCommand(endpoint: NativeEndpoint): string[] {
  return [
    "tailscale",
    "serve",
    "--yes",
    `--service=${endpoint.service}`,
    `--https=${endpoint.port}`,
    endpoint.target,
  ];
}

interface NativeReconcilerDependencies {
  status: () => Record<string, unknown>;
  execute: (args: string[]) => CommandResult;
}

export class NativeServiceReconciler {
  readonly desired: Map<string, NativeEndpoint>;
  readonly statePath: string;
  private readonly dependencies: NativeReconcilerDependencies;

  constructor(
    config: RegistryConfig,
    stateDirectory: string,
    dependencies: NativeReconcilerDependencies = {
      status: nativeServiceConfig,
      execute: command,
    },
  ) {
    this.desired = desiredNativeEndpoints(config);
    this.statePath = join(stateDirectory, "owned-native-services.json");
    this.dependencies = dependencies;
    mkdirSync(stateDirectory, { recursive: true });
  }

  private loadOwned(): Map<string, NativeEndpoint> {
    const state = readJson<{ services?: Record<string, NativeEndpoint> }>(
      this.statePath,
      {},
    );
    return new Map(
      Object.entries(state.services ?? {}).filter(
        ([service, endpoint]) =>
          endpoint &&
          service === endpoint.service &&
          service.startsWith("svc:") &&
          Number.isInteger(endpoint.port) &&
          typeof endpoint.target === "string",
      ),
    );
  }

  private saveOwned(endpoints: Map<string, NativeEndpoint>): void {
    atomicWriteJson(this.statePath, {
      schemaVersion: 1,
      services: Object.fromEntries(
        [...endpoints.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([service, endpoint]) => [
            service,
            nativeEndpointForState(endpoint),
          ]),
      ),
    });
  }

  reconcile(): void {
    if (this.desired.size === 0 && !existsSync(this.statePath)) return;
    const observed = nativeEndpointsFromConfig(this.dependencies.status());
    const owned = this.loadOwned();
    const conflicts: string[] = [];

    for (const [service, desired] of this.desired) {
      const current = observed.get(service);
      const previous = owned.get(service);
      if (!current) continue;
      if (current.shared) {
        conflicts.push(`${service} has additional endpoints`);
        continue;
      }
      if (nativeEndpointMatches(current, desired)) {
        const previouslyOwned =
          previous !== undefined && nativeEndpointMatches(previous, desired);
        if (!previouslyOwned && !desired.adoptExisting) {
          conflicts.push(
            `${service} exactly matches an existing endpoint, but explicit adoption is disabled`,
          );
        }
        continue;
      }
      if (!previous || !nativeEndpointMatches(current, previous)) {
        conflicts.push(
          `${service} wants https:${desired.port} -> ${desired.target}, ` +
            `occupied by tcp:${current.port} -> ${current.target}`,
        );
      }
    }
    if (conflicts.length) throw new Error(conflicts.join("; "));

    const nextOwned = new Map(owned);
    for (const [service, previous] of owned) {
      const desired = this.desired.get(service);
      if (desired) continue;
      const current = observed.get(service);
      if (!current || !nativeEndpointMatches(current, previous)) {
        nextOwned.delete(service);
        this.saveOwned(nextOwned);
        continue;
      }
      if (previous.advertised === false && current.advertised === false) continue;
      log("info", `draining stale native service ${service}`);
      this.dependencies.execute(["tailscale", "serve", "drain", service]);
      nextOwned.set(service, { ...previous, advertised: false });
      this.saveOwned(nextOwned);
    }

    for (const [service, desired] of this.desired) {
      const current = observed.get(service);
      if (current && nativeEndpointMatches(current, desired)) {
        if (current.advertised === false) {
          this.dependencies.execute([
            "tailscale",
            "serve",
            "advertise",
            service,
          ]);
        }
        nextOwned.set(service, desired);
        this.saveOwned(nextOwned);
        continue;
      }

      const previous = owned.get(service);
      const replacingOwned =
        current !== undefined &&
        previous !== undefined &&
        nativeEndpointMatches(current, previous);
      if (replacingOwned) {
        this.dependencies.execute(["tailscale", "serve", "drain", service]);
      }
      log(
        "info",
        `publishing native service ${service} on https:${desired.port} -> ${desired.target}`,
      );
      try {
        this.dependencies.execute(nativeOnCommand(desired));
      } catch (error) {
        if (replacingOwned && previous) {
          log("error", `native service replacement failed; restoring ${service}`);
          this.dependencies.execute(nativeOnCommand(previous));
        }
        throw error;
      }
      nextOwned.set(service, desired);
      this.saveOwned(nextOwned);
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

function sanitizedTimestamp(value: unknown, field: string): string {
  const timestamp = sanitizedText(value, field, 100);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`invalid ${field}`);
  }
  return timestamp;
}

function sanitizedAccess(service: Record<string, unknown>, id: string): ServiceAccess {
  const access = asRecord(service.access);
  const tailnet = access?.tailnet ?? service.audience;
  const cloudflare = access?.cloudflare ?? "disabled";
  if (tailnet !== "owner" && tailnet !== "family" && tailnet !== "machines") {
    throw new Error(`invalid tailnet access for ${id}`);
  }
  if (
    cloudflare !== "disabled" &&
    cloudflare !== "owner" &&
    cloudflare !== "family" &&
    cloudflare !== "public"
  ) {
    throw new Error(`invalid Cloudflare access for ${id}`);
  }
  return { tailnet, cloudflare };
}

function sanitizedNativeService(
  value: unknown,
  id: string,
): PublicService["tailscaleService"] {
  if (value === null || value === undefined) return null;
  const service = asRecord(value);
  if (
    !service ||
    typeof service.name !== "string" ||
    !SERVICE_ID.test(service.name) ||
    typeof service.port !== "number" ||
    !Number.isInteger(service.port) ||
    service.port < 1 ||
    service.port > 65535
  ) {
    throw new Error(`invalid Tailscale Service for ${id}`);
  }
  return { name: service.name, port: service.port };
}

function sanitizedHealth(value: unknown, id: string): Health | undefined {
  if (value === undefined) return undefined;
  const health = asRecord(value);
  if (
    !health ||
    (health.status !== "up" &&
      health.status !== "down" &&
      health.status !== "checking" &&
      health.status !== "auth-required") ||
    typeof health.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(health.checkedAt)) ||
    (health.code !== undefined &&
      (typeof health.code !== "number" ||
        !Number.isInteger(health.code) ||
        health.code < 100 ||
        health.code > 599)) ||
    (health.latencyMs !== undefined &&
      (typeof health.latencyMs !== "number" ||
        !Number.isInteger(health.latencyMs) ||
        health.latencyMs < 0))
  ) {
    throw new Error(`invalid health for ${id}`);
  }
  return {
    status: health.status,
    checkedAt: health.checkedAt,
    ...(health.code === undefined ? {} : { code: health.code }),
    ...(health.latencyMs === undefined
      ? {}
      : { latencyMs: health.latencyMs }),
  };
}

function sanitizedCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function sanitizedSyncthingReport(value: unknown): SyncthingReport | undefined {
  if (value === undefined) return undefined;
  const report = asRecord(value);
  if (
    !report ||
    (report.status !== "caught-up" &&
      report.status !== "busy" &&
      report.status !== "error" &&
      report.status !== "unreachable")
  ) {
    throw new Error("invalid Syncthing report");
  }
  const sanitized: SyncthingReport = {
    status: report.status,
    checkedAt: sanitizedTimestamp(report.checkedAt, "Syncthing check time"),
    monitoredFolders: sanitizedCount(
      report.monitoredFolders,
      "Syncthing monitored folder count",
    ),
    caughtUpFolders: sanitizedCount(
      report.caughtUpFolders,
      "Syncthing caught-up folder count",
    ),
    errorFolders: sanitizedCount(
      report.errorFolders,
      "Syncthing error folder count",
    ),
    backlogItems: sanitizedCount(
      report.backlogItems,
      "Syncthing backlog item count",
    ),
    backlogBytes: sanitizedCount(
      report.backlogBytes,
      "Syncthing backlog byte count",
    ),
    configuredPeers: sanitizedCount(
      report.configuredPeers,
      "Syncthing configured peer count",
    ),
    connectedPeers: sanitizedCount(
      report.connectedPeers,
      "Syncthing connected peer count",
    ),
  };
  if (
    sanitized.caughtUpFolders + sanitized.errorFolders >
      sanitized.monitoredFolders ||
    sanitized.connectedPeers > sanitized.configuredPeers
  ) {
    throw new Error("inconsistent Syncthing report");
  }
  return sanitized;
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
    const access = sanitizedAccess(service, id);
    services[id] = {
      access,
      audience: access.tailnet,
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
      tailscaleService: sanitizedNativeService(service.tailscaleService, id),
      health: sanitizedHealth(service.health, id),
    };
  }

  const rawHost = asRecord(manifest.host);
  const rawChecks = asRecord(rawHost?.checks);
  const syncthing = sanitizedSyncthingReport(rawChecks?.syncthing);
  return {
    schemaVersion: 1,
    ...(manifest.reportedAt === undefined
      ? {}
      : {
          reportedAt: sanitizedTimestamp(
            manifest.reportedAt,
            "manifest report time",
          ),
        }),
    host: {
      name:
        rawHost?.name === undefined
          ? "unknown"
          : sanitizedText(rawHost.name, "host name", 100),
      ...(syncthing ? { checks: { syncthing } } : {}),
    },
    services,
  };
}

function publicManifest(config: RegistryConfig): PublicManifest {
  const services: Record<string, PublicService> = {};
  for (const [id, service] of Object.entries(config.services)) {
    services[id] = {
      access: service.access,
      audience: service.access.tailnet,
      description: service.description,
      path: service.path,
      port: service.port,
      scheme: service.scheme,
      tailscaleService: service.tailscaleService.enable
        ? {
            name: service.tailscaleService.name,
            port: service.tailscaleService.port,
          }
        : null,
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
      access: { tailnet: "owner", cloudflare: "disabled" },
      audience: "owner",
      tailscaleService: config.directory.tailscaleService.enable
        ? {
            name: config.directory.tailscaleService.name,
            port: config.directory.tailscaleService.port,
          }
        : null,
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
    log("warn", `health probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "down" };
  }
}

class SyncthingConnectionError extends Error {}

async function syncthingRequest(
  config: SyncthingCheckConfig,
  apiKey: string,
  path: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, config.url), {
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    throw new SyncthingConnectionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel();
    throw new Error(`Syncthing API returned ${response.status}`);
  }
  return response.json();
}

function apiCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`invalid Syncthing ${field}`);
  }
  return value;
}

function failedSyncthingReport(
  status: "error" | "unreachable",
  checkedAt: string,
): SyncthingReport {
  return {
    status,
    checkedAt,
    monitoredFolders: 0,
    caughtUpFolders: 0,
    errorFolders: 0,
    backlogItems: 0,
    backlogBytes: 0,
    configuredPeers: 0,
    connectedPeers: 0,
  };
}

export async function collectSyncthingReport(
  config: SyncthingCheckConfig,
): Promise<SyncthingReport> {
  const checkedAt = new Date().toISOString();
  try {
    if (!config.configFile) throw new Error("Syncthing config file is missing");
    const xml = readFileSync(config.configFile, "utf8");
    const apiKey = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
    if (!apiKey) throw new Error("Syncthing API key is missing");

    const [folders, rawDevices, rawConnections] = await Promise.all([
      Promise.all(
        config.folderIds.map(async (folderId) => {
          const raw = asRecord(
            await syncthingRequest(
              config,
              apiKey,
              `/rest/db/status?folder=${encodeURIComponent(folderId)}`,
            ),
          );
          if (!raw) throw new Error("invalid Syncthing folder status");
          const backlogItems = apiCount(
            raw.needTotalItems,
            "backlog item count",
          );
          const backlogBytes = apiCount(raw.needBytes, "backlog byte count");
          const errorCount = apiCount(raw.errors, "folder error count");
          const pullErrorCount = apiCount(
            raw.pullErrors,
            "folder pull error count",
          );
          const hasError =
            errorCount > 0 ||
            pullErrorCount > 0 ||
            (typeof raw.error === "string" && raw.error.length > 0) ||
            (typeof raw.watchError === "string" && raw.watchError.length > 0);
          return {
            backlogItems,
            backlogBytes,
            hasError,
            caughtUp:
              !hasError &&
              raw.state === "idle" &&
              backlogItems === 0 &&
              backlogBytes === 0,
          };
        }),
      ),
      syncthingRequest(config, apiKey, "/rest/config/devices"),
      syncthingRequest(config, apiKey, "/rest/system/connections"),
    ]);
    if (!Array.isArray(rawDevices)) {
      throw new Error("invalid Syncthing device list");
    }
    const connections = asRecord(asRecord(rawConnections)?.connections);
    if (!connections) throw new Error("invalid Syncthing connection list");
    const caughtUpFolders = folders.filter((folder) => folder.caughtUp).length;
    const errorFolders = folders.filter((folder) => folder.hasError).length;
    return {
      status:
        errorFolders > 0
          ? "error"
          : caughtUpFolders === folders.length
            ? "caught-up"
            : "busy",
      checkedAt,
      monitoredFolders: folders.length,
      caughtUpFolders,
      errorFolders,
      backlogItems: folders.reduce(
        (total, folder) => total + folder.backlogItems,
        0,
      ),
      backlogBytes: folders.reduce(
        (total, folder) => total + folder.backlogBytes,
        0,
      ),
      configuredPeers: rawDevices.length,
      connectedPeers: Object.values(connections).filter(
        (connection) => asRecord(connection)?.connected === true,
      ).length,
    };
  } catch (error) {
    log(
      "warn",
      `Syncthing health check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return failedSyncthingReport(
      error instanceof SyncthingConnectionError ? "unreachable" : "error",
      checkedAt,
    );
  }
}

export async function refreshHostChecks(
  config: RegistryConfig,
  manifest: PublicManifest,
): Promise<void> {
  if (!config.hostChecks?.syncthing.enable) return;
  manifest.host.checks = {
    ...manifest.host.checks,
    syncthing: await collectSyncthingReport(config.hostChecks.syncthing),
  };
}

export async function refreshManifestHealth(
  config: RegistryConfig,
  manifest: PublicManifest,
): Promise<void> {
  await mapLimit(Object.entries(manifest.services), 8, async ([id, service]) => {
    const declared = config.services[id];
    const target = id === "service-directory"
      ? `http://127.0.0.1:${config.directory.backendPort}`
      : declared?.target;
    const healthPath = id === "service-directory"
      ? "/api/services"
      : declared?.healthPath;
    if (!target || !healthPath) return;
    service.health = {
      ...(await probe(new URL(healthPath, target).toString())),
      checkedAt: new Date().toISOString(),
    };
  });
  manifest.reportedAt = new Date().toISOString();
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
  if (service.tailscaleService) {
    const tailnetSuffix = machine.dnsName.split(".").slice(1).join(".");
    if (tailnetSuffix) {
      return new URL(
        normalizedPath(service.path),
        `https://${service.tailscaleService.name}.${tailnetSuffix}:${service.tailscaleService.port}`,
      ).toString();
    }
  }
  return new URL(
    normalizedPath(service.path),
    `${service.scheme}://${machine.dnsName}:${service.port}`,
  ).toString();
}

export function manifestHealth(
  machineOnline: boolean,
  health: Health | undefined,
  now = Date.now(),
): Health {
  if (!machineOnline) return { status: "offline", checkedAt: health?.checkedAt };
  if (!health?.checkedAt) return { status: "checking" };
  if (now - Date.parse(health.checkedAt) > STALE_HEALTH_MS) {
    return { ...health, status: "stale" };
  }
  return health;
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
      if (machine.id === selfId) {
        return {
          manifest: this.localManifest,
          fetchedAt: new Date().toISOString(),
        };
      }
      if (!machine.online || !machine.dnsName) {
        const cached = previous.get(machine.id);
        return {
          manifest: cached?.manifest,
          fetchedAt: cached?.manifestFetchedAt,
        };
      }
      try {
        return {
          manifest: await fetchManifest(
            `http://${machine.dnsName}:${this.config.manifest.port}/manifest.json`,
          ),
          fetchedAt: new Date().toISOString(),
        };
      } catch {
        const cached = previous.get(machine.id);
        return {
          manifest: cached?.manifest,
          fetchedAt: cached?.manifestFetchedAt,
        };
      }
    });

    nodes.forEach((machine, index) => {
      const { manifest, fetchedAt } = manifests[index];
      machine.manifest = manifest;
      machine.manifestFetchedAt = fetchedAt;
      if (!manifest) return;
      for (const [id, service] of Object.entries(manifest.services)) {
        const entry: DirectoryService = {
          ...service,
          id,
          url: serviceUrl(machine, service),
          health: manifestHealth(machine.online, service.health),
        };
        machine.services.push(entry);
      }
    });

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

function relativeTime(value: string | null, now = Date.now()): string {
  if (!value || value.startsWith("0001-")) return "now";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - milliseconds) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function portableServiceStatus(
  statuses: Health["status"][],
): SummaryStatus {
  if (statuses.length === 0) return "unknown";
  if (statuses.every((status) => status === "up")) return "available";
  if (statuses.every((status) => status === "down" || status === "offline")) {
    return "unavailable";
  }
  if (
    statuses.some((status) => status === "up" || status === "auth-required") &&
    statuses.some(
      (status) =>
        status === "down" ||
        status === "offline" ||
        status === "checking" ||
        status === "stale",
    )
  ) {
    return "degraded";
  }
  return "unknown";
}

export function portableServiceSummaries(
  snapshot: Snapshot,
): PortableServiceSummary[] {
  const groups = new Map<string, PortableServiceSummary>();
  for (const machine of snapshot.machines) {
    for (const service of machine.services) {
      const name = service.tailscaleService?.name;
      if (!name) continue;
      const group = groups.get(name) ?? {
        name,
        title: service.title,
        status: "unknown" as const,
        providers: [],
      };
      group.providers.push({ hostName: machine.hostName, health: service.health });
      groups.set(name, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      status: portableServiceStatus(
        group.providers.map((provider) => provider.health.status),
      ),
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function healthDetail(health: Health): string {
  if (health.status === "up") {
    return health.latencyMs === undefined ? "reachable" : `${health.latencyMs} ms`;
  }
  if (health.status === "down") return "unreachable";
  if (health.status === "offline") return "host offline";
  if (health.status === "auth-required") return "auth boundary reachable";
  if (health.status === "stale") {
    return `stale ${relativeTime(health.checkedAt ?? null)}`;
  }
  return "checking";
}

function timestampIsStale(value: string | null | undefined, now: number): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || now - timestamp > STALE_HEALTH_MS;
}

function syncthingDetail(report: SyncthingReport, now: number): string {
  if (timestampIsStale(report.checkedAt, now)) {
    return `stale ${relativeTime(report.checkedAt, now)}`;
  }
  if (report.status === "caught-up") {
    return `caught up to known cluster state · ${report.connectedPeers}/${report.configuredPeers} peers connected`;
  }
  if (report.status === "busy") {
    return `${report.backlogItems} items / ${report.backlogBytes} bytes pending · ${report.connectedPeers}/${report.configuredPeers} peers connected`;
  }
  if (report.status === "error") {
    return `${report.errorFolders}/${report.monitoredFolders} monitored folders report errors`;
  }
  return "local Syncthing API unreachable";
}

export function renderHealth(snapshot: Snapshot, now = Date.now()): string {
  const summaries = portableServiceSummaries(snapshot);
  const snapshotStale = timestampIsStale(snapshot.updatedAt, now);
  const portable = summaries.length
    ? summaries
        .map(
          (service) => `<article class="summary-card">
            <header><strong>${escapeHtml(service.title)}</strong><span class="state ${service.status}">${service.status}</span></header>
            <p><code>svc:${escapeHtml(service.name)}</code> · ${service.providers.length} known provider${service.providers.length === 1 ? "" : "s"}</p>
            <ul>${service.providers
              .map(
                (provider) => `<li><span>${escapeHtml(provider.hostName)}</span><span class="probe health-${escapeHtml(provider.health.status)}"><i></i>${escapeHtml(healthDetail(provider.health))}</span></li>`,
              )
              .join("")}</ul>
          </article>`,
        )
        .join("")
    : '<p class="empty">no portable services observed</p>';
  const machines = snapshot.machines
    .map((machine) => {
      const report = machine.manifest?.reportedAt;
      const reportStale = timestampIsStale(report, now);
      const manifestState = !machine.manifest
        ? "manifest not yet observed"
        : `${reportStale ? "stale report" : "reported"} ${relativeTime(report ?? null, now)} · fetched ${relativeTime(machine.manifestFetchedAt ?? null, now)}`;
      const services = machine.services.length
        ? machine.services
            .map(
              (service) => `<li><span>${escapeHtml(service.title)}</span><span class="probe health-${escapeHtml(service.health.status)}"><i></i>${escapeHtml(healthDetail(service.health))}</span></li>`,
            )
            .join("")
        : '<li class="empty">no service manifest observed</li>';
      const syncthing = machine.manifest?.host.checks?.syncthing;
      const checks = syncthing
        ? `<div class="host-check"><strong>syncthing</strong><span class="state syncthing-${escapeHtml(syncthing.status)}">${escapeHtml(syncthingDetail(syncthing, now))}</span></div>`
        : "";
      return `<article class="machine-card ${machine.online ? "" : "offline"}">
        <header><strong>${escapeHtml(machine.hostName)}</strong><span>${machine.online ? "online" : `offline ${escapeHtml(relativeTime(machine.lastSeen, now))}`}</span></header>
        <p class="${reportStale ? "stale-copy" : ""}">${escapeHtml(manifestState)}</p>
        ${checks}
        <ul>${services}</ul>
      </article>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>tailnet health</title>
  <style>
    :root{color-scheme:dark;--bg:#0c0d0f;--panel:#14161a;--line:#292d34;--muted:#8f98a6;--text:#f4f5f7;--green:#65d68b;--red:#f17b7b;--amber:#e3b868}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}main{width:min(1040px,calc(100% - 32px));margin:auto;padding:56px 0}h1{font:600 clamp(28px,5vw,48px)/1.05 system-ui,sans-serif;letter-spacing:-.04em;margin:0 0 10px}h2{font:600 20px/1.2 system-ui,sans-serif;margin:36px 0 14px}.lede,.summary-card p,.machine-card p{color:var(--muted)}.banner{padding:12px 14px;border:1px solid color-mix(in srgb,var(--amber),transparent 45%);border-radius:10px;color:var(--amber);margin:20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.summary-card,.machine-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:16px}.machine-card.offline{opacity:.65}header,li,.host-check{display:flex;align-items:center;justify-content:space-between;gap:16px}.summary-card header strong,.machine-card header strong{font:600 15px/1 system-ui,sans-serif}.summary-card p,.machine-card p{font-size:11px;margin:9px 0 13px}.stale-copy{color:var(--amber)!important}.host-check{border-top:1px solid var(--line);padding:11px 0}.host-check strong{font-size:12px}.syncthing-caught-up{color:var(--green)}.syncthing-busy{color:var(--amber)}.syncthing-error,.syncthing-unreachable{color:var(--red)}ul{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}li{padding:10px 0;border-bottom:1px solid var(--line)}li:last-child{border:0}.state{font-size:10px;text-transform:uppercase;letter-spacing:.06em}.available{color:var(--green)}.degraded,.unknown{color:var(--amber)}.unavailable{color:var(--red)}.probe{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:11px;white-space:nowrap}.probe i{width:7px;height:7px;border-radius:50%;background:var(--muted)}.health-up i{background:var(--green)}.health-down i{background:var(--red)}.health-checking i,.health-auth-required i,.health-stale i{background:var(--amber)}.empty{color:var(--muted)}@media(max-width:640px){main{padding:32px 0}li,.host-check{align-items:start;flex-direction:column;gap:5px}}
  </style>
</head>
<body><main>
  <h1>tailnet health</h1>
  <p class="lede">host-specific observations and explicitly declared portable services</p>
  ${snapshotStale ? '<p class="banner">collector data is stale or waiting for its first scan</p>' : ""}
  <h2>portable services</h2><section class="grid">${portable}</section>
  <h2>hosts and instances</h2><section class="grid">${machines}</section>
</main></body>
</html>`;
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
                        : service.health.status === "stale"
                          ? `stale ${relativeTime(service.health.checkedAt ?? null)}`
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
    .health-checking i,.health-auth-required i,.health-stale i { background:var(--amber); }
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
          if (path === "/health") {
            return new Response(renderHealth(snapshot), {
              headers: {
                "cache-control": "no-store",
                "content-security-policy":
                  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                "content-type": "text/html; charset=utf-8",
              },
            });
          }
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
  const nativeServiceReconciler = new NativeServiceReconciler(
    config,
    args.stateDirectory,
  );
  let lastHealthRefresh = 0;
  let lastHostChecksRefresh = 0;
  let lastDirectoryRefresh = 0;
  while (true) {
    try {
      reconciler.reconcile();
    } catch (error) {
      log("error", `serve reconciliation failed: ${String(error)}`);
    }
    try {
      nativeServiceReconciler.reconcile();
    } catch (error) {
      log("error", `native service reconciliation failed: ${String(error)}`);
    }
    if (Date.now() - lastHealthRefresh >= 15_000) {
      try {
        await refreshManifestHealth(config, manifest);
      } catch (error) {
        log("error", `local health refresh failed: ${String(error)}`);
      }
      lastHealthRefresh = Date.now();
    }
    if (Date.now() - lastHostChecksRefresh >= 60_000) {
      try {
        await refreshHostChecks(config, manifest);
      } catch (error) {
        log("error", `host checks refresh failed: ${String(error)}`);
      }
      lastHostChecksRefresh = Date.now();
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
