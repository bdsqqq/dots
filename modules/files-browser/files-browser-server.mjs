import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { spawn } from "node:child_process";
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FOLDER_ID = "sqz7z-a6tfg";
const REFRESH_INTERVAL_MS = 15_000;

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`missing required argument --${name}`);
  return value;
}

export function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "end of arguments"}`);
    }
    options.set(flag.slice(2), value);
  }

  return {
    source: resolve(required(options, "source")),
    state: resolve(required(options, "state")),
    syncthingConfig: resolve(required(options, "syncthing-config")),
    syncthingUrl: required(options, "syncthing-url"),
    copyparty: resolve(required(options, "copyparty")),
    host: options.get("host") ?? "127.0.0.1",
    port: Number(options.get("port") ?? "3925"),
  };
}

function apiKeyFromConfig(config) {
  const match = config.match(/<apikey>([^<]+)<\/apikey>/);
  if (!match) throw new Error("Syncthing API key is missing from config.xml");
  return match[1];
}

async function syncthingRequest(config, pathname) {
  const url = new URL(pathname, config.syncthingUrl);
  const response = await fetch(url, {
    headers: { "X-API-Key": config.apiKey },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Syncthing ${url.pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

function safePath(root, parent, name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`unsafe Syncthing path component: ${JSON.stringify(name)}`);
  }
  const path = resolve(root, parent, name);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Syncthing path escapes publication root: ${path}`);
  }
  return path;
}

function pathInside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function flattenModel(entries, parent = "") {
  const items = [];
  for (const entry of entries) {
    safePath("/publication", parent, entry.name);
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    items.push({
      path,
      type: entry.type,
      modTime: entry.modTime,
      size: entry.size,
    });
    if (entry.children) items.push(...flattenModel(entry.children, path));
  }
  return items;
}

function manifestSignature(items) {
  const manifest = items
    .map(({ path, type, modTime, size }) => `${type}\0${path}\0${modTime}\0${size}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(manifest).digest("hex");
}

export function modelToken(status) {
  return JSON.stringify([
    status.sequence,
    Object.entries(status.remoteSequence ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  ]);
}

export function folderReady(status) {
  return (
    status.state === "idle" &&
    status.needFiles === 0 &&
    status.needDirectories === 0 &&
    status.needSymlinks === 0 &&
    status.needBytes === 0
  );
}

async function publishItem(sourceRoot, snapshotRoot, item) {
  const source = safePath(sourceRoot, dirname(item.path), item.path.split("/").at(-1));
  const destination = safePath(snapshotRoot, dirname(item.path), item.path.split("/").at(-1));

  switch (item.type) {
    case "FILE_INFO_TYPE_DIRECTORY":
      await mkdir(destination, { recursive: true });
      return;
    case "FILE_INFO_TYPE_FILE": {
      const status = await lstat(source, { bigint: true });
      if (!status.isFile()) throw new Error(`indexed file is not a regular file: ${item.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await link(source, destination);
      const [sourceAfter, published] = await Promise.all([
        lstat(source, { bigint: true }),
        lstat(destination, { bigint: true }),
      ]);
      if (
        !sourceAfter.isFile() ||
        !published.isFile() ||
        sourceAfter.dev !== published.dev ||
        sourceAfter.ino !== published.ino
      ) {
        throw new Error(`indexed file changed during publication: ${item.path}`);
      }
      return;
    }
    case "FILE_INFO_TYPE_SYMLINK": {
      const status = await lstat(source);
      if (!status.isSymbolicLink()) throw new Error(`indexed symlink is not a symlink: ${item.path}`);
      const sourceTarget = resolve(dirname(source), await readlink(source));
      if (!pathInside(sourceRoot, sourceTarget)) {
        throw new Error(`indexed symlink escapes source root: ${item.path}`);
      }
      const snapshotTarget = join(snapshotRoot, relative(sourceRoot, sourceTarget));
      await mkdir(dirname(destination), { recursive: true });
      await symlink(relative(dirname(destination), snapshotTarget), destination);
      return;
    }
    default:
      throw new Error(`unsupported Syncthing item type ${item.type} at ${item.path}`);
  }
}

export async function materializeSnapshot(sourceRoot, snapshotsRoot, entries) {
  const items = flattenModel(entries);
  const signature = manifestSignature(items);
  const temporary = join(snapshotsRoot, `.next-${randomUUID()}`);
  const snapshot = join(snapshotsRoot, `${signature}-${randomUUID()}`);

  await mkdir(temporary, { recursive: true });
  try {
    for (const item of items.filter((item) => item.type === "FILE_INFO_TYPE_DIRECTORY")) {
      await publishItem(sourceRoot, temporary, item);
    }
    for (const item of items.filter((item) => item.type !== "FILE_INFO_TYPE_DIRECTORY")) {
      await publishItem(sourceRoot, temporary, item);
    }
    await rename(temporary, snapshot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return { signature, snapshot, itemCount: items.length };
}

export async function waitForBackend(backend) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertBackendLive(backend);
    try {
      const response = await fetch(`http://127.0.0.1:${backend.port}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        assertBackendLive(backend);
        return;
      }
    } catch {
      assertBackendLive(backend);
      // Copyparty takes a moment to bind and initialize the volume.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("timed out waiting for Copyparty");
}

export function assertBackendLive(backend) {
  if (backend.failure) throw backend.failure;
  if (backend.child.exitCode !== null) {
    throw new Error(`Copyparty exited with code ${backend.child.exitCode}`);
  }
}

function startBackend(config, generation, snapshot) {
  const port = 13_925 + generation;
  const history = join(config.state, "history", String(generation));
  const child = spawn(
    config.copyparty,
    [
      "-i",
      "127.0.0.1",
      "-p",
      String(port),
      "--hist",
      history,
      "--grid",
      "--no-del",
      "--no-mv",
      "-v",
      `${snapshot}::r`,
    ],
    {
      env: { ...process.env, HOME: config.state },
      stdio: "inherit",
    }
  );
  const backend = { child, failure: null, generation, history, inflight: 0, port, snapshot };
  child.once("error", (error) => {
    backend.failure = error;
  });
  child.once("exit", (code, signal) => {
    backend.failure ??= new Error(`Copyparty exited with ${signal ?? `code ${code}`}`);
    backend.onExit?.();
  });
  return backend;
}

async function stopBackend(backend) {
  if (backend.stopping) return backend.stopping;
  backend.stopping = (async () => {
    if (backend.child.exitCode === null) backend.child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      if (backend.child.exitCode !== null) return resolvePromise();
      backend.child.once("exit", resolvePromise);
    });
    await rm(backend.snapshot, { recursive: true, force: true });
    await rm(backend.history, { recursive: true, force: true });
  })();
  return backend.stopping;
}

function drainBackend(backend, backends) {
  const timer = setInterval(() => {
    if (backend.inflight !== 0) return;
    clearInterval(timer);
    stopBackend(backend)
      .then(() => backends.delete(backend))
      .catch((error) => console.error("failed to stop old backend", error));
  }, 250);
  timer.unref();
}

function proxyServer(activeBackend) {
  const server = createServer((incoming, outgoing) => {
    const backend = activeBackend();
    if (!backend) {
      outgoing.writeHead(503).end("files browser is starting\n");
      return;
    }

    backend.inflight += 1;
    const proxied = httpRequest(
      {
        host: "127.0.0.1",
        port: backend.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      }
    );
    const done = () => {
      backend.inflight = Math.max(0, backend.inflight - 1);
    };
    outgoing.once("close", done);
    proxied.once("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(`backend unavailable: ${error.message}\n`);
    });
    incoming.pipe(proxied);
  });

  server.on("upgrade", (request, socket, head) => {
    const backend = activeBackend();
    if (!backend) return socket.destroy();
    backend.inflight += 1;
    const upstream = connectTcp(backend.port, "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const done = () => {
      backend.inflight = Math.max(0, backend.inflight - 1);
    };
    socket.once("close", done);
    upstream.once("error", () => socket.destroy());
  });

  return server;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  await access(config.source);
  await mkdir(config.state, { recursive: true });
  const snapshotsRoot = join(config.state, "snapshots");
  await rm(snapshotsRoot, { recursive: true, force: true });
  await rm(join(config.state, "history"), { recursive: true, force: true });
  await mkdir(snapshotsRoot, { recursive: true });
  config.apiKey = apiKeyFromConfig(await readFile(config.syncthingConfig, "utf8"));

  let active = null;
  let generation = 0;
  let lastModelToken = null;
  let refreshing = false;
  const backends = new Set();

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const status = await syncthingRequest(
        config,
        `/rest/db/status?folder=${encodeURIComponent(FOLDER_ID)}`
      );
      if (!folderReady(status)) return;
      const token = modelToken(status);
      if (active && token === lastModelToken) return;

      const entries = await syncthingRequest(
        config,
        `/rest/db/browse?folder=${encodeURIComponent(FOLDER_ID)}`
      );
      const publication = await materializeSnapshot(config.source, snapshotsRoot, entries);
      const statusAfter = await syncthingRequest(
        config,
        `/rest/db/status?folder=${encodeURIComponent(FOLDER_ID)}`
      );
      if (!folderReady(statusAfter) || modelToken(statusAfter) !== token) {
        await rm(publication.snapshot, { recursive: true, force: true });
        return;
      }

      generation += 1;
      const backend = startBackend(config, generation, publication.snapshot);
      backend.signature = publication.signature;
      backends.add(backend);
      backend.onExit = () => {
        if (active !== backend) return;
        active = null;
        lastModelToken = null;
        stopBackend(backend)
          .then(() => backends.delete(backend))
          .catch((error) => console.error("failed to clean up dead backend", error));
        setTimeout(() => {
          refresh().catch((error) => console.error("backend recovery failed", error));
        }, 1_000);
      };
      try {
        await waitForBackend(backend);
        assertBackendLive(backend);
      } catch (error) {
        backends.delete(backend);
        await stopBackend(backend);
        throw error;
      }

      const previous = active;
      active = backend;
      lastModelToken = token;
      console.log(
        `published ${publication.itemCount} Syncthing-indexed items as ${publication.signature}`
      );
      if (previous) {
        drainBackend(previous, backends);
      }
    } finally {
      refreshing = false;
    }
  };

  await refresh();
  if (!active) throw new Error("Syncthing folder is not ready for publication");

  const server = proxyServer(() => active);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolvePromise);
  });
  console.log(`files browser listening on http://${config.host}:${config.port}`);

  const timer = setInterval(() => {
    refresh().catch((error) => console.error("publication refresh failed", error));
  }, REFRESH_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await Promise.all([...backends].map(stopBackend));
  };
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => shutdown().finally(() => process.exit(130)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
