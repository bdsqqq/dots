import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probe,
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
  return {
    schemaVersion: 1,
    host: { name: "test-host" },
    manifest: { port: 5252, backendPort: 15252 },
    directory: { enable: false, port: 5253, backendPort: 15253 },
    services,
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
