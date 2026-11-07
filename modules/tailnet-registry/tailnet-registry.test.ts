import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLogger, type ServiceEvent } from "../service-events/events.ts";
import {
  collectSyncthingReport,
  createDirectoryHandler,
  createManifestHandler,
  Directory,
  manifestHealth,
  nativeEndpointsFromConfig,
  NativeServiceReconciler,
  portableServiceStatus,
  probe,
  probeServiceHealth,
  refreshHostChecks,
  refreshManifestHealth,
  portableServiceSummaries,
  renderDirectory,
  renderHealth,
  routesFromStatus,
  sanitizeManifest,
  ServeReconciler,
  type Route,
} from "./tailnet-registry";

const temporaryDirectories: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tailnet-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(
  services: Record<string, Record<string, unknown>> = {},
): ConstructorParameters<typeof ServeReconciler>[0] {
  const normalized = Object.fromEntries(
    Object.entries(services).map(([id, service]) => [
      id,
      {
        access: { tailnet: "owner", cloudflare: "disabled" },
        tailscaleService: {
          enable: false,
          name: id,
          port: 443,
          ...((service.tailscaleService as Record<string, unknown>) ?? {}),
        },
        ...service,
      },
    ]),
  );
  return {
    schemaVersion: 1,
    host: { name: "test-host" },
    manifest: { port: 5252, backendPort: 15252 },
    directory: {
      enable: false,
      port: 5253,
      backendPort: 15253,
      tailscaleService: {
        enable: false,
        name: "apps",
        port: 443,
      },
    },
    hostChecks: {
      syncthing: {
        enable: false,
        url: "http://127.0.0.1:8384",
        configFile: null,
        folderIds: [],
      },
    },
    services: normalized,
  } as ConstructorParameters<typeof ServeReconciler>[0];
}

function status(
  ...routes: Array<[scheme: "http" | "https", port: number, target: string]>
): Record<string, unknown> {
  const TCP: Record<string, unknown> = {};
  const Web: Record<string, unknown> = {};
  for (const [scheme, port, target] of routes) {
    TCP[String(port)] = { [scheme.toUpperCase()]: true };
    Web[`test.tail.ts.net:${port}`] = {
      Handlers: { "/": { Proxy: target } },
    };
  }
  return { TCP, Web };
}

function stateRoute(route: Route): Route {
  return {
    key: route.key,
    scheme: route.scheme,
    port: route.port,
    target: route.target,
  };
}

function seedState(
  reconciler: ServeReconciler,
  routes: Record<string, Route>,
): void {
  writeFileSync(
    reconciler.statePath,
    JSON.stringify({
      schemaVersion: 1,
      routes: Object.fromEntries(
        Object.entries(routes).map(([key, route]) => [key, stateRoute(route)]),
      ),
    }),
  );
}

function dependencies(current: Record<string, unknown>) {
  const commands: string[][] = [];
  return {
    commands,
    value: {
      status: () => current,
      execute: (args: string[]) => {
        commands.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function capturedEvents() {
  const lines: string[] = [];
  const logger = createEventLogger("tailnet-registry", {
    sink: (event) => lines.push(JSON.stringify(event)),
    host: "test-host",
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as ServiceEvent) };
}

function eventManifest() {
  return sanitizeManifest({ schemaVersion: 1, host: { name: "private-host" }, services: {} });
}

describe("operation events", () => {
  test("real HTTP handlers separate inventory/probes from browser hints without recording input", async () => {
    const capture = capturedEvents();
    const manifest = eventManifest();
    const snapshot = { updatedAt: new Date().toISOString(), machines: [] };
    const dashboard = createDirectoryHandler({ getSnapshot: () => snapshot }, capture.logger);
    const manifestHandler = createManifestHandler(manifest, capture.logger);
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new URL(request.url).pathname.startsWith("/manifest")
        ? manifestHandler(request) : dashboard(request),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    for (const [path, ua, expectedStatus] of [
      ["/?auth=secret-query", "Mozilla/5.0 secret-ua", 200],
      ["/health", "Mozilla/5.0", 200],
      ["/api/services", "tailnet-registry/1", 200],
      ["/manifest.json?secret-query", "Mozilla/5.0", 200],
      ["/", "cloudflare-origin-probe/1", 200],
      ["/private-user/path?secret-query", "custom secret-ua", 404],
    ] as const) {
      const response = await fetch(base + path, { headers: { "user-agent": ua, authorization: "Bearer secret-auth", "x-request-id": "private-request-id" } });
      expect(response.status).toBe(expectedStatus);
      await response.body?.cancel();
    }
    const records = capture.records();
    expect(records.map((record) => [record.context.route, record.traffic, record.outcome])).toEqual([
      ["dashboard", "browser", "succeeded"],
      ["health_dashboard", "browser", "succeeded"],
      ["inventory", "probe", "succeeded"],
      ["manifest", "probe", "succeeded"],
      ["dashboard", "probe", "succeeded"],
      ["not_found", "unknown", "failed"],
    ]);
    expect(new Set(records.map((record) => record.operationId)).size).toBe(6);
    for (const record of records) {
      expect(record.service).toBe("tailnet-registry");
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.timestamp).toMatch(/Z$/);
    }
    expect(capture.lines.join("\n")).not.toMatch(/secret-|private-|Bearer|127\.0\.0\.1|Mozilla/);
  });

  test("request failure emits one sanitized completion and keeps the 500 response", () => {
    const capture = capturedEvents();
    const handler = createDirectoryHandler({
      getSnapshot() { throw Object.assign(new Error("private-path secret-token"), { code: "EIO" }); },
    }, capture.logger);
    expect(handler(new Request("http://example.test/")).status).toBe(500);
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ outcome: "failed", context: { errorCode: "EIO", statusCode: 500 } });
    expect(capture.lines.join("")).not.toMatch(/private-path|secret-token/);
  });

  test("Serve reconciliation records actual mutations, noop and safe failures", () => {
    const capture = capturedEvents();
    const deps = dependencies({});
    const reconciler = new ServeReconciler(config(), temporaryDirectory(), { ...deps.value, logger: capture.logger });
    reconciler.reconcile();
    expect(deps.commands).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ operation: "serve.reconcile", outcome: "succeeded", context: { changedCount: 1, itemCount: 1, ready: true } });

    const noop = new ServeReconciler(config(), temporaryDirectory(), {
      ...dependencies(status(["http", 5252, "http://127.0.0.1:15252"])).value,
      logger: capture.logger,
    });
    seedState(noop, { __manifest: noop.desired.get("__manifest")! });
    noop.reconcile();
    expect(capture.records()[1]).toMatchObject({ outcome: "skipped", context: { changedCount: 0, ready: true } });

    const failed = new ServeReconciler(config(), temporaryDirectory(), {
      status() { throw Object.assign(new Error("secret-config /private/path"), { code: "ENOENT" }); },
      execute: deps.value.execute,
      logger: capture.logger,
    });
    expect(() => failed.reconcile()).toThrow();
    expect(capture.records()[2]).toMatchObject({ outcome: "failed", context: { ready: false, errorCode: "ENOENT" } });
    expect(capture.lines.join("")).not.toMatch(/secret-config|private\/path|127\.0\.0\.1/);
    expect(capture.records()).toHaveLength(3);
  });

  test("explicit adoption is a successful ownership change even without Serve commands", () => {
    const capture = capturedEvents();
    const desired = config();
    const deps = dependencies(status(["http", 5252, "http://127.0.0.1:15252"]));
    const reconciler = new ServeReconciler(desired, temporaryDirectory(), { ...deps.value, logger: capture.logger });
    reconciler.desired.get("__manifest")!.adoptExisting = true;
    reconciler.reconcile();
    expect(deps.commands).toEqual([]);
    expect(capture.records()[0]).toMatchObject({ outcome: "succeeded", context: { changed: true, changedCount: 0, reasonCode: "existing_route_adopted" } });
    expect(JSON.parse(readFileSync(reconciler.statePath, "utf8")).routes.__manifest.port).toBe(5252);
  });

  test("ownership conflict is summarized before any command and never leaks backend targets", () => {
    const capture = capturedEvents();
    const deps = dependencies(status(["http", 5252, "http://secret-backend/private?token=secret"]));
    const reconciler = new ServeReconciler(config(), temporaryDirectory(), { ...deps.value, logger: capture.logger });
    expect(() => reconciler.reconcile()).toThrow();
    expect(deps.commands).toEqual([]);
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ outcome: "failed", context: { reasonCode: "ownership_conflict", missingCount: 1, changedCount: 0 } });
    expect(capture.lines.join("")).not.toMatch(/secret-backend|token|private/);
  });

  test("Serve rollback preserves state and emits one failed operation", () => {
    const capture = capturedEvents();
    const previous = { key: "__manifest", scheme: "http" as const, port: 5252, target: "http://127.0.0.1:9999" };
    const commands: string[][] = [];
    const reconciler = new ServeReconciler(config(), temporaryDirectory(), {
      logger: capture.logger,
      status: () => status(["http", 5252, previous.target]),
      execute(args) {
        commands.push(args);
        if (args.at(-1) === "http://127.0.0.1:15252") throw new Error("secret publish failure");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    seedState(reconciler, { __manifest: previous });
    expect(() => reconciler.reconcile()).toThrow("secret publish failure");
    expect(commands.at(-1)?.at(-1)).toBe(previous.target);
    expect(JSON.parse(readFileSync(reconciler.statePath, "utf8")).routes.__manifest.target).toBe(previous.target);
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ outcome: "failed", context: { reasonCode: "previous_route_restored", changedCount: 2 } });
    expect(capture.lines.join("")).not.toMatch(/secret publish|127\.0\.0\.1/);
  });

  test("native replacement rollback restores the previous endpoint and records safe failure", () => {
    const capture = capturedEvents();
    const desired = config({ photos: { target: "http://127.0.0.1:4000", tailscaleService: { enable: true, name: "photos", port: 443 } } });
    const previous = { service: "svc:photos", port: 443, target: "http://127.0.0.1:3923" };
    const commands: string[][] = [];
    const reconciler = new NativeServiceReconciler(desired, temporaryDirectory(), {
      logger: capture.logger,
      status: () => ({ services: { "svc:photos": { endpoints: { "tcp:443": previous.target } } } }),
      execute(args) {
        commands.push(args);
        if (args.at(-1) === desired.services.photos.target) throw Object.assign(new Error("private credentials"), { code: "EACCES" });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    writeFileSync(reconciler.statePath, JSON.stringify({ services: { "svc:photos": previous } }));
    expect(() => reconciler.reconcile()).toThrow();
    expect(commands.map((args) => args.at(-1))).toEqual(["svc:photos", desired.services.photos.target, previous.target]);
    expect(JSON.parse(readFileSync(reconciler.statePath, "utf8")).services["svc:photos"].target).toBe(previous.target);
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ operation: "native_service.reconcile", outcome: "failed", context: { reasonCode: "previous_endpoint_restored", errorCode: "EACCES", changedCount: 2 } });
    expect(capture.lines.join("")).not.toMatch(/credentials|svc:photos|127\.0\.0\.1/);
  });

  test("health refresh emits one readiness summary, not one event per backend probe", async () => {
    const capture = capturedEvents();
    const server = Bun.serve({ port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/ready") return Response.json({ ready: true });
      return new Response("private body", { status: new URL(request.url).pathname === "/ok" ? 200 : 401 });
    } });
    servers.push(server);
    const target = `http://127.0.0.1:${server.port}`;
    const desired = config({ a: { target, healthPath: "/ok", readinessPath: "/ready" }, b: { target, healthPath: "/auth" } });
    const manifest = sanitizeManifest({ schemaVersion: 1, host: { name: "private-host" }, services: {
      a: { title: "private title", scheme: "http", port: 8000, path: "/", audience: "owner" },
      b: { title: "private title", scheme: "http", port: 8001, path: "/", audience: "owner" },
    } });
    await refreshManifestHealth(desired, manifest, capture.logger);
    expect(manifest.services.a.health?.status).toBe("up");
    expect(manifest.services.b.health?.status).toBe("auth-required");
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]).toMatchObject({ operation: "local_health.refresh", outcome: "degraded", context: { providerCount: 2, healthyProviderCount: 1, unhealthyProviderCount: 0, uncertainCount: 1, observationCount: 2, ready: false } });
    expect(capture.lines.join("")).not.toMatch(/private|127\.0\.0\.1|\/auth|\/ok/);
  });

  test("host check completion includes coarse readiness, never config paths or API keys", async () => {
    const capture = capturedEvents();
    const report = await collectSyncthingReport({ enable: true, url: "http://secret-backend", configFile: "/missing/private-config", folderIds: ["private-folder"] }, capture.logger);
    expect(report.status).toBe("error");
    expect(capture.records()[0]).toMatchObject({ operation: "host_checks.refresh", outcome: "failed", context: { ready: false, errorCode: "ENOENT", reasonCode: "report_unavailable" } });
    expect(capture.lines.join("")).not.toMatch(/private|secret-backend/);
  });

  test("directory refresh records partial inventory, retains cache, and reports status failures", async () => {
    const capture = capturedEvents();
    let failFetch = false;
    let failStatus = false;
    const manifest = eventManifest();
    const directory = new Directory(config(), manifest, temporaryDirectory(), {
      logger: capture.logger,
      status() {
        if (failStatus) throw Object.assign(new Error("private daemon output"), { code: "EIO" });
        return { Self: { ID: "private-self", HostName: "private-host", Online: true }, Peer: {
          peer: { ID: "private-peer", HostName: "private-peer-host", DNSName: "secret-dns.tail.net", Online: true },
        } };
      },
      async fetchManifest() {
        if (failFetch) throw new Error("secret URL token");
        return manifest;
      },
    });
    await directory.refresh();
    expect(capture.records()[0]).toMatchObject({ operation: "directory.refresh", outcome: "succeeded", context: { candidateCount: 2, itemCount: 2, missingCount: 0, queryErrorCount: 0 } });
    failFetch = true;
    await directory.refresh();
    expect(directory.getSnapshot().machines.every((machine) => !!machine.manifest)).toBe(true);
    expect(capture.records()[1]).toMatchObject({ outcome: "degraded", context: { queryErrorCount: 1, ready: false } });
    failStatus = true;
    await expect(directory.refresh()).rejects.toThrow();
    expect(capture.records()[2]).toMatchObject({ outcome: "failed", context: { errorCode: "EIO", ready: false } });
    expect(capture.records()).toHaveLength(3);
    expect(capture.lines.join("")).not.toMatch(/private|secret|tail.net/);
  });

  test("startup failure uses the actual stdout JSON transport and service identity", () => {
    const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./tailnet-registry.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    const records = result.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ service: "tailnet-registry", operation: "service.start", traffic: "background", outcome: "failed", context: { ready: false, errorCode: "UNEXPECTED_ERROR" } });
    expect(result.stderr.toString()).toBe("");
    expect(records[0].eventId).not.toBe(records[0].operationId);
  });
});

describe("route parsing", () => {
  test("extracts HTTP and HTTPS root proxies", () => {
    const observed = routesFromStatus(
      status(
        ["https", 3923, "http://127.0.0.1:3923"],
        ["http", 8765, "http://127.0.0.1:8766"],
      ),
    );
    expect(observed.get(3923)?.scheme).toBe("https");
    expect(observed.get(8765)?.target).toBe("http://127.0.0.1:8766");
  });

  test("marks ports with additional handlers as shared", () => {
    const current = status(["https", 3923, "http://127.0.0.1:3923"]);
    const web = current.Web as Record<string, any>;
    web["test.tail.ts.net:3923"].Handlers["/nested"] = {
      Proxy: "http://127.0.0.1:4000",
    };
    expect(routesFromStatus(current).get(3923)?.sharedPort).toBe(true);
  });

  test("treats unsupported handlers as occupied", () => {
    const observed = routesFromStatus({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "test.tail.ts.net:443": {
          Handlers: { "/": { Text: "hello" } },
        },
      },
    });

    expect(observed.get(443)?.sharedPort).toBe(true);
    expect(observed.get(8443)?.sharedPort).toBe(true);
  });

  test("treats raw TCP forwarding as occupied", () => {
    const observed = routesFromStatus({
      TCP: { "5432": { TCPForward: "127.0.0.1:5432" } },
      Web: {},
    });

    expect(observed.get(5432)?.sharedPort).toBe(true);
  });
});

describe("manifest boundary", () => {
  test("removes backend targets and encodes paths", () => {
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      host: { name: "test" },
      services: {
        photos: {
          title: "photos",
          description: "family photos",
          target: "http://127.0.0.1:3923",
          scheme: "https",
          port: 443,
          path: "/férias de verão/",
          audience: "family",
        },
      },
    });
    expect(manifest.services.photos).not.toHaveProperty("target");
    expect(manifest.services.photos.path).toBe(
      "/f%C3%A9rias%20de%20ver%C3%A3o/",
    );
    expect(manifest.services.photos.access).toEqual({
      tailnet: "family",
      cloudflare: "disabled",
    });
  });

  test("keeps access dimensions independent and validates logical services", () => {
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      services: {
        photos: {
          title: "photos",
          scheme: "https",
          port: 3923,
          path: "/gallery/",
          access: { tailnet: "family", cloudflare: "family" },
          tailscaleService: { name: "photos", port: 443 },
        },
      },
    });

    expect(manifest.services.photos.access.cloudflare).toBe("family");
    expect(manifest.services.photos.audience).toBe("family");
    expect(manifest.services.photos.tailscaleService).toEqual({
      name: "photos",
      port: 443,
    });
  });

  test("accepts timestamped local health without exposing backend targets", () => {
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      reportedAt: "2026-08-14T12:00:01.000Z",
      services: {
        photos: {
          title: "photos",
          target: "http://127.0.0.1:3923",
          scheme: "https",
          port: 3923,
          path: "/",
          audience: "owner",
          health: {
            status: "up",
            code: 200,
            latencyMs: 4,
            checkedAt: "2026-08-14T12:00:00.000Z",
            error: "http://127.0.0.1:3923/Users/private failed",
          },
        },
      },
    });

    expect(manifest.services.photos).not.toHaveProperty("target");
    expect(manifest.services.photos).not.toHaveProperty("healthPath");
    expect(manifest.services.photos.health).not.toHaveProperty("error");
    expect(manifest.reportedAt).toBe("2026-08-14T12:00:01.000Z");
    expect(manifest.services.photos.health).toEqual({
      status: "up",
      code: 200,
      latencyMs: 4,
      checkedAt: "2026-08-14T12:00:00.000Z",
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /127[.]0[.]0[.]1|\/Users\/private/,
    );
  });

  test("rejects executable schemes and malformed services", () => {
    expect(() =>
      sanitizeManifest({
        schemaVersion: 1,
        services: {
          unsafe: {
            title: "unsafe",
            scheme: "javascript",
            port: 443,
            path: "/",
            audience: "owner",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      sanitizeManifest({
        schemaVersion: 1,
        services: { broken: "not an object" },
      }),
    ).toThrow();
  });

  test("does not follow manifest redirects", async () => {
    let targetHit = false;
    const target = Bun.serve({
      port: 0,
      fetch() {
        targetHit = true;
        return Response.json({ schemaVersion: 1, services: {} });
      },
    });
    servers.push(target);
    const redirect = Bun.serve({
      port: 0,
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/private`);
      },
    });
    servers.push(redirect);

    const { fetchManifest } = await import("./tailnet-registry");
    await expect(
      fetchManifest(`http://127.0.0.1:${redirect.port}/manifest.json`),
    ).rejects.toThrow();
    expect(targetHit).toBe(false);
  });
});

describe("native Tailscale Services", () => {
  test("parses endpoints without confusing advertisement state", () => {
    const observed = nativeEndpointsFromConfig({
      version: "0.0.1",
      services: {
        "svc:photos": {
          advertised: false,
          endpoints: { "tcp:443": "http://127.0.0.1:3923" },
        },
      },
    });

    expect(observed.get("svc:photos")).toMatchObject({
      port: 443,
      target: "http://127.0.0.1:3923",
      advertised: false,
      shared: false,
    });
  });

  test("publishes a declared logical endpoint", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:3923",
        tailscaleService: { enable: true, name: "photos", port: 443 },
      },
    });
    const deps = dependencies({ version: "0.0.1" });
    const reconciler = new NativeServiceReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );

    reconciler.reconcile();

    expect(deps.commands).toEqual([
      [
        "tailscale",
        "serve",
        "--yes",
        "--service=svc:photos",
        "--https=443",
        "http://127.0.0.1:3923",
      ],
    ]);
  });

  test("refuses implicit ownership of an existing service", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:3923",
        tailscaleService: { enable: true, name: "photos", port: 443 },
      },
    });
    const deps = dependencies({
      version: "0.0.1",
      services: {
        "svc:photos": {
          endpoints: { "tcp:443": "http://127.0.0.1:3923" },
        },
      },
    });
    const reconciler = new NativeServiceReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );

    expect(() => reconciler.reconcile()).toThrow("adoption is disabled");
    expect(deps.commands).toEqual([]);
  });

  test("drains an owned endpoint before replacing it", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:4000",
        tailscaleService: { enable: true, name: "photos", port: 443 },
      },
    });
    const deps = dependencies({
      version: "0.0.1",
      services: {
        "svc:photos": {
          endpoints: { "tcp:443": "http://127.0.0.1:3923" },
        },
      },
    });
    const reconciler = new NativeServiceReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    writeFileSync(
      reconciler.statePath,
      JSON.stringify({
        schemaVersion: 1,
        services: {
          "svc:photos": {
            service: "svc:photos",
            port: 443,
            target: "http://127.0.0.1:3923",
          },
        },
      }),
    );

    reconciler.reconcile();

    expect(deps.commands).toEqual([
      ["tailscale", "serve", "drain", "svc:photos"],
      [
        "tailscale",
        "serve",
        "--yes",
        "--service=svc:photos",
        "--https=443",
        "http://127.0.0.1:4000",
      ],
    ]);
  });

  test("drains a removed endpoint without clearing active connections", () => {
    const current = {
      version: "0.0.1",
      services: {
        "svc:photos": {
          endpoints: { "tcp:443": "http://127.0.0.1:3923" },
        },
      },
    };
    const deps = dependencies(current);
    const reconciler = new NativeServiceReconciler(
      config(),
      temporaryDirectory(),
      deps.value,
    );
    writeFileSync(
      reconciler.statePath,
      JSON.stringify({
        schemaVersion: 1,
        services: {
          "svc:photos": {
            service: "svc:photos",
            port: 443,
            target: "http://127.0.0.1:3923",
          },
        },
      }),
    );

    reconciler.reconcile();

    expect(deps.commands).toEqual([
      ["tailscale", "serve", "drain", "svc:photos"],
    ]);
    expect(
      JSON.parse(readFileSync(reconciler.statePath, "utf8")).services[
        "svc:photos"
      ].advertised,
    ).toBe(false);
  });
});

describe("health probes", () => {
  test("classifies success, missing paths, and authentication", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/ok") return new Response("ok");
        if (path === "/private") return new Response("no", { status: 401 });
        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    expect((await probe(`${base}/ok`)).status).toBe("up");
    expect((await probe(`${base}/missing`)).status).toBe("down");
    expect((await probe(`${base}/private`)).status).toBe("auth-required");
  });

  test("publishes health from the configured loopback backend", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/health"
          ? new Response("ok")
          : new Response("missing", { status: 404 });
      },
    });
    servers.push(server);
    const desired = config({
      photos: {
        target: `http://127.0.0.1:${server.port}`,
        healthPath: "/health",
        path: "/",
        scheme: "https",
        port: 443,
      },
    });
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      services: {
        photos: {
          title: "photos",
          healthPath: "/health",
          path: "/",
          scheme: "https",
          port: 443,
          audience: "owner",
        },
      },
    });

    await refreshManifestHealth(desired, manifest);

    expect(manifest.services.photos.health?.status).toBe("up");
    expect(manifest.services.photos.health?.code).toBe(200);
    expect(manifest.services.photos.health?.checkedAt).toBeDefined();
  });

  test("distinguishes missing, stale, and offline reports", () => {
    const checkedAt = "2026-08-14T12:00:00.000Z";
    const report = { status: "up" as const, checkedAt, latencyMs: 4 };

    expect(manifestHealth(true, undefined).status).toBe("checking");
    expect(
      manifestHealth(true, report, Date.parse(checkedAt) + 121_000).status,
    ).toBe("stale");
    expect(manifestHealth(false, report).status).toBe("offline");
  });
});

describe("readiness and safe upgrade reporting", () => {
  test("injected probes distinguish a live HTTP server from readiness and reject ambiguous success", async () => {
    let ready = false;
    const request = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === "/ready" ? Response.json({ ready, reasonCode: ready ? "connected" : "bluetooth_unavailable" }, { status: ready ? 200 : 503 })
        : new Response("live");
    }) as typeof fetch;
    expect(await probeServiceHealth("http://localhost", "/health", "/ready", request)).toMatchObject({
      status: "up", reachable: true, ready: false, readiness: "not_ready", reasonCode: "bluetooth_unavailable",
    });
    ready = true;
    expect(await probeServiceHealth("http://localhost", "/health", "/ready", request)).toMatchObject({ ready: true, readiness: "ready" });
    expect(await probeServiceHealth("http://localhost", "/health", undefined, request)).toMatchObject({ reachable: true, ready: false, readiness: "not_ready", reasonCode: "readiness_not_configured" });
    const filesReady = (async (input: string | URL | Request) => new URL(String(input)).pathname === "/_files/ready"
      ? Response.json({ ready: false, reasonCode: "filesystem.EACCES" }, { status: 503 }) : new Response("live")) as typeof fetch;
    expect(await probeServiceHealth("http://localhost", "/health", "/_files/ready", filesReady)).toMatchObject({
      reachable: true, ready: false, readiness: "not_ready", reasonCode: "filesystem.EACCES",
    });
    const ambiguous = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await probeServiceHealth("http://localhost", "/health", "/ready", ambiguous)).toMatchObject({ ready: false, readiness: "not_ready", reasonCode: "readiness_unavailable" });
  });

  test("healthy-but-not-ready remains degraded in aggregate events, manifests and both directories", async () => {
    const server = Bun.serve({ port: 0, fetch(request) {
      return new URL(request.url).pathname === "/ready" ? Response.json({ ready: false, reasonCode: "bluetooth_unavailable" }, { status: 503 }) : new Response("live");
    } });
    servers.push(server);
    const desired = config({ hue: { target: server.url.origin, healthPath: "/health", readinessPath: "/ready" } });
    const manifest = sanitizeManifest({ schemaVersion: 1, host: { name: "mini" }, services: {
      hue: { scheme: "https", port: 8756, audience: "owner", tailscaleService: { name: "hue", port: 443 } },
    } });
    const capture = capturedEvents();
    await refreshManifestHealth(desired, manifest, capture.logger);
    expect(capture.records()[0]).toMatchObject({ operation: "local_health.refresh", outcome: "degraded", context: { ready: false, healthyProviderCount: 0, unhealthyProviderCount: 1 } });
    expect(sanitizeManifest(manifest).services.hue.health).toMatchObject({ status: "up", reachable: true, ready: false });
    const snapshot: Parameters<typeof renderHealth>[0] = { updatedAt: new Date().toISOString(), machines: [{
      id: "mini", hostName: "mini", dnsName: "mini.tail.ts.net", online: true, lastSeen: null, os: "macOS", manifest,
      services: [{ ...manifest.services.hue, id: "hue", url: "https://hue.tail.ts.net", health: manifest.services.hue.health! }],
    }] };
    expect(portableServiceSummaries(snapshot)[0].status).toBe("degraded");
    expect(renderDirectory(snapshot)).toContain("reachable · not ready");
    expect(renderHealth(snapshot)).toContain("bluetooth_unavailable");
    const stale = manifestHealth(true, { ...manifest.services.hue.health!, ready: true }, Date.now() + 121_000);
    expect(stale.ready).toBe(false);
    expect(manifestHealth(false, { ...manifest.services.hue.health!, ready: true }).ready).toBe(false);
  });

  test("upgrade opt-in reads safe state each refresh, emits unknown on missing/invalid state and never leaks state details", async () => {
    const desired = config();
    const manifest = sanitizeManifest({ schemaVersion: 1, services: {} });
    const capture = capturedEvents();
    const stateFile = join(temporaryDirectory(), "private-upgrade.json");
    await refreshHostChecks(desired, manifest, capture.logger);
    expect(capture.records()).toHaveLength(0);
    desired.hostChecks.upgrade = { enable: true, stateFile };
    await refreshHostChecks(desired, manifest, capture.logger);
    expect(manifest.hostChecks?.upgrade).toMatchObject({ status: "unknown", reasonCode: "state_missing" });
    writeFileSync(stateFile, JSON.stringify({ privateError: "private-token", phase: "succeeded" }));
    await refreshHostChecks(desired, manifest, capture.logger);
    expect(capture.records().at(-1)).toMatchObject({ operation: "host.upgrade_health", outcome: "degraded", context: { ready: false, readiness: "unknown", reasonCode: "state_invalid" } });
    const now = new Date().toISOString();
    writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1, host: "mini", operationId: "00000000-0000-0000-0000-000000000000", phase: "succeeded",
      desiredRevision: "a".repeat(40), appliedRevision: "a".repeat(40), startedAt: now, phaseStartedAt: now, updatedAt: now,
      lastSuccessAt: now, nextAttemptAt: null, consecutiveFailures: 0, reasonCode: "healthy", buildTimeoutMs: 1000,
      activationWarnAfterMs: 1000, components: {}, privateError: "private-token",
    }));
    await refreshHostChecks(desired, manifest, capture.logger);
    expect(capture.records().at(-1)).toMatchObject({ operation: "host.upgrade_health", outcome: "succeeded", context: { ready: true, readiness: "healthy", reasonCode: "healthy" } });
    expect(sanitizeManifest(manifest).hostChecks?.upgrade).toEqual(manifest.hostChecks?.upgrade);
    expect(Object.keys(manifest.hostChecks!.upgrade!).sort()).toEqual(["checkedAt", "status", "reasonCode", "phase", "appliedRevision", "desiredRevision", "lastSuccessAt"].sort());
    expect(capture.lines.join("")).not.toMatch(/private-token|private-upgrade|appliedRevision|desiredRevision/);
  });
});

describe("health dashboard", () => {
  test("summarizes only explicitly portable services", () => {
    expect(portableServiceStatus(["up", "up"])).toBe("available");
    expect(portableServiceStatus(["up", "down"])).toBe("degraded");
    expect(portableServiceStatus(["auth-required", "offline"])).toBe(
      "degraded",
    );
    expect(portableServiceStatus(["down", "offline"])).toBe("unavailable");
    expect(portableServiceStatus(["checking", "stale"])).toBe("unknown");
  });

  test("renders stale collection state and escapes host data", () => {
    const html = renderHealth(
      {
        updatedAt: "2026-08-14T12:00:00.000Z",
        machines: [
          {
            id: "node-1",
            hostName: "<script>alert(1)</script>",
            dnsName: "node.tail.ts.net",
            online: true,
            lastSeen: null,
            os: "linux",
            manifestFetchedAt: "2026-08-14T12:00:00.000Z",
            manifest: {
              schemaVersion: 1,
              reportedAt: "2026-08-14T12:00:00.000Z",
              host: {
                name: "node",
                checks: {
                  syncthing: {
                    status: "caught-up",
                    checkedAt: "2026-08-14T12:00:00.000Z",
                    monitoredFolders: 1,
                    caughtUpFolders: 1,
                    errorFolders: 0,
                    backlogItems: 0,
                    backlogBytes: 0,
                    configuredPeers: 2,
                    connectedPeers: 1,
                  },
                },
              },
              services: {},
            },
            services: [
              {
                id: "files",
                title: "files",
                description: null,
                path: "/",
                port: 443,
                scheme: "https",
                access: { tailnet: "owner", cloudflare: "disabled" },
                audience: "owner",
                tailscaleService: { name: "files", port: 443 },
                url: "https://files.tail.ts.net/",
                health: { status: "up", checkedAt: "2026-08-14T12:00:00.000Z" },
              },
            ],
          },
        ],
      },
      Date.parse("2026-08-14T12:03:00.000Z"),
    );

    expect(html).toContain("collector data is stale");
    expect(html).toContain("svc:files");
    expect(html).toContain("stale report 3m ago");
    expect(html).toContain('class="state syncthing-stale"');
    expect(html).toContain("stale 3m ago");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("Syncthing host check", () => {
  test("reports caught-up folders without claiming disconnected peers are fresh", async () => {
    const directory = temporaryDirectory();
    const configFile = join(directory, "config.xml");
    writeFileSync(configFile, "<configuration><apikey>test-secret</apikey></configuration>");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("x-api-key") !== "test-secret") {
          return new Response("forbidden", { status: 403 });
        }
        const url = new URL(request.url);
        if (url.pathname === "/rest/db/status") {
          return Response.json({
            state: "idle",
            error: "",
            watchError: "",
            errors: 0,
            pullErrors: 0,
            needTotalItems: 0,
            needBytes: 0,
          });
        }
        if (url.pathname === "/rest/config/devices") {
          return Response.json([{}, {}, {}]);
        }
        if (url.pathname === "/rest/system/connections") {
          return Response.json({
            connections: {
              peer1: { connected: true },
              peer2: { connected: false },
              peer3: { connected: false },
            },
          });
        }
        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);

    const report = await collectSyncthingReport({
      enable: true,
      url: `http://127.0.0.1:${server.port}`,
      configFile,
      folderIds: ["commonplace"],
    });

    expect(report).toMatchObject({
      status: "caught-up",
      monitoredFolders: 1,
      caughtUpFolders: 1,
      errorFolders: 0,
      backlogItems: 0,
      configuredPeers: 3,
      connectedPeers: 1,
    });
  });

  test("aggregates backlog and rejects API failures without publishing details", async () => {
    const directory = temporaryDirectory();
    const configFile = join(directory, "private-config.xml");
    writeFileSync(configFile, "<apikey>private-api-key</apikey>");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/rest/db/status") {
          return Response.json({
            state: "syncing",
            error: "",
            watchError: "",
            errors: 0,
            pullErrors: 0,
            needTotalItems: 7,
            needBytes: 4096,
          });
        }
        if (url.pathname === "/rest/config/devices") return Response.json([]);
        if (url.pathname === "/rest/system/connections") {
          return Response.json({ connections: {} });
        }
        return new Response("missing", { status: 404 });
      },
    });
    servers.push(server);
    const config = {
      enable: true,
      url: `http://127.0.0.1:${server.port}`,
      configFile,
      folderIds: ["commonplace"],
    };

    const busy = await collectSyncthingReport(config);
    expect(busy).toMatchObject({
      status: "busy",
      backlogItems: 7,
      backlogBytes: 4096,
    });

    server.stop(true);
    const unreachable = await collectSyncthingReport(config);
    expect(unreachable.status).toBe("unreachable");
    expect(JSON.stringify(unreachable)).not.toMatch(
      /private-api-key|private-config|127[.]0[.]0[.]1/,
    );
  });

  test("sanitizes the published report to its coarse schema", () => {
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      host: {
        name: "test-host",
        checks: {
          syncthing: {
            status: "busy",
            checkedAt: "2026-08-14T12:00:00.000Z",
            monitoredFolders: 1,
            caughtUpFolders: 0,
            errorFolders: 0,
            backlogItems: 3,
            backlogBytes: 2048,
            configuredPeers: 2,
            connectedPeers: 1,
            apiKey: "secret",
            folderIds: ["private-folder"],
          },
        },
      },
      services: {},
    });

    expect(manifest.host.checks?.syncthing).toEqual({
      status: "busy",
      checkedAt: "2026-08-14T12:00:00.000Z",
      monitoredFolders: 1,
      caughtUpFolders: 0,
      errorFolders: 0,
      backlogItems: 3,
      backlogBytes: 2048,
      configuredPeers: 2,
      connectedPeers: 1,
    });
    expect(JSON.stringify(manifest)).not.toMatch(/secret|private-folder/);
  });
});

describe("serve reconciliation", () => {
  test("explicitly adopts exact routes and preserves unmanaged ports", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:3923",
        scheme: "https",
        port: 3923,
        adoptExisting: true,
      },
    });
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 3923, "http://127.0.0.1:3923"],
      ["https", 5733, "http://127.0.0.1:5733"],
    );
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
    });

    reconciler.reconcile();

    expect(deps.commands).toEqual([]);
    const state = JSON.parse(readFileSync(reconciler.statePath, "utf8"));
    expect(Object.keys(state.routes).sort()).toEqual([
      "__manifest",
      "photos",
    ]);
  });

  test("refuses implicit adoption and unmanaged conflicts", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:3923",
        scheme: "https",
        port: 3923,
      },
    });
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 3923, "http://127.0.0.1:3923"],
    );
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
    });

    expect(() => reconciler.reconcile()).toThrow("adoption is disabled");
    expect(deps.commands).toEqual([]);
  });

  test("preflights all conflicts before creating a free route", () => {
    const desired = config({
      free: {
        target: "http://127.0.0.1:7001",
        scheme: "https",
        port: 7000,
      },
      blocked: {
        target: "http://127.0.0.1:8001",
        scheme: "https",
        port: 8000,
      },
    });
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 8000, "http://127.0.0.1:9999"],
    );
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
    });

    expect(() => reconciler.reconcile()).toThrow("occupied");
    expect(deps.commands).toEqual([]);
  });

  test("refuses ownership of ports with additional handlers", () => {
    const desired = config({
      photos: {
        target: "http://127.0.0.1:3923",
        scheme: "https",
        port: 3923,
        adoptExisting: true,
      },
    });
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 3923, "http://127.0.0.1:3923"],
    );
    const web = current.Web as Record<string, any>;
    web["test.tail.ts.net:3923"].Handlers["/other"] = {
      Proxy: "http://127.0.0.1:4000",
    };
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
    });

    expect(() => reconciler.reconcile()).toThrow("additional handlers");
    expect(deps.commands).toEqual([]);
  });

  test("old key ownership cannot adopt a new exact route", () => {
    const desired = config({
      moved: {
        target: "http://127.0.0.1:8001",
        scheme: "https",
        port: 8000,
      },
    });
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 7000, "http://127.0.0.1:7001"],
      ["https", 8000, "http://127.0.0.1:8001"],
    );
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      desired,
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
      moved: {
        key: "moved",
        scheme: "https",
        port: 7000,
        target: "http://127.0.0.1:7001",
      },
    });

    expect(() => reconciler.reconcile()).toThrow("adoption is disabled");
    expect(deps.commands).toEqual([]);
  });

  test("removes only stale routes that still match ownership state", () => {
    const current = status(
      ["http", 5252, "http://127.0.0.1:15252"],
      ["https", 7000, "http://127.0.0.1:7001"],
      ["https", 5733, "http://127.0.0.1:5733"],
    );
    const deps = dependencies(current);
    const reconciler = new ServeReconciler(
      config(),
      temporaryDirectory(),
      deps.value,
    );
    seedState(reconciler, {
      __manifest: reconciler.desired.get("__manifest")!,
      removed: {
        key: "removed",
        scheme: "https",
        port: 7000,
        target: "http://127.0.0.1:7001",
      },
    });

    reconciler.reconcile();

    expect(deps.commands).toEqual([
      ["tailscale", "serve", "--https=7000", "off"],
    ]);
  });
});
