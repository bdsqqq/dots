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
import { createEventLogger, classifyHttpTraffic, safeErrorCode } from "../service-events/events.ts";
import { BackendRecoveryBudget } from "./recovery.ts";

const events = createEventLogger("files-browser");

// Categories, not request targets or identities, are the HTTP event contract.
function observeRequest(incoming, outgoing, route) {
  const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(incoming.method)
    ? incoming.method : "OTHER";
  const operation = events.begin("http.request", classifyHttpTraffic(incoming.headers["user-agent"], route), { method, route });
  outgoing.once("finish", () => operation.finish(outgoing.statusCode >= 400 ? "failed" : "succeeded", { statusCode: outgoing.statusCode }));
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) operation.finish("failed", { reasonCode: "CLIENT_ABORTED" });
  });
  return operation;
}

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

async function syncthingRequest(config, pathname, signal) {
  const url = new URL(pathname, config.syncthingUrl);
  const response = await fetch(url, {
    headers: { "X-API-Key": config.apiKey },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
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

export async function waitForPublication(
  refresh,
  publicationReady,
  retryIntervalMs = REFRESH_INTERVAL_MS,
  reportError = () => {}
) {
  const operation = events.begin("publication.wait");
  let attempt = 0;
  while (!publicationReady()) {
    attempt += 1;
    try {
      await refresh();
    } catch (error) {
      reportError("initial publication failed", error);
    }
    if (!publicationReady()) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryIntervalMs));
    }
  }
  operation.finish("succeeded", { ready: true, attempt });
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
  const operation = events.begin("publication.materialize");
  try {
    const result = await buildSnapshot(sourceRoot, snapshotsRoot, entries);
    operation.finish("succeeded", { itemCount: result.itemCount });
    return result;
  } catch (error) {
    operation.finish("failed", { errorCode: safeErrorCode(error) });
    throw error;
  }
}

async function buildSnapshot(sourceRoot, snapshotsRoot, entries) {
  const items = flattenModel(entries);
  const signature = manifestSignature(items);
  const temporary = join(snapshotsRoot, `.next-${randomUUID()}`);
  const snapshot = join(snapshotsRoot, `${signature}-${randomUUID()}`);

  await mkdir(temporary, { recursive: true });
  try {
    for (const group of [
      items.filter((item) => item.type === "FILE_INFO_TYPE_DIRECTORY"),
      items.filter((item) => item.type !== "FILE_INFO_TYPE_DIRECTORY"),
    ]) {
      for (let offset = 0; offset < group.length; offset += 16) {
        // Bound filesystem pressure and let the whole batch settle before
        // cleanup on failure; otherwise late links can race removal of .next.
        const results = await Promise.allSettled(group.slice(offset, offset + 16)
          .map((item) => publishItem(sourceRoot, temporary, item)));
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    }
    await rename(temporary, snapshot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return { signature, snapshot, itemCount: items.length };
}

export async function waitForBackend(backend, signal) {
  const operation = events.begin("backend.ready", "background", { generation: backend.generation });
  try {
    await pollBackend(backend, signal);
    operation.finish("succeeded", { ready: true });
  } catch (error) {
    operation.finish("failed", { ready: false, errorCode: safeErrorCode(error) });
    throw error;
  }
}

async function pollBackend(backend, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
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

export function startBackend(config, generation, snapshot, spawnProcess = spawn) {
  const port = 13_925 + generation;
  const history = join(config.state, "history", String(generation));
  const operation = events.begin("backend.start", "background", { generation });
  const child = spawnProcess(
    config.copyparty,
    [
      "-i",
      "127.0.0.1",
      "-p",
      String(port),
      "--rproxy",
      "-1",
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
  const closed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  const backend = { child, closed, failure: null, generation, history, inflight: 0, port, snapshot };
  child.once("spawn", () => operation.finish("succeeded"));
  child.once("error", (error) => {
    operation.finish("failed", { errorCode: safeErrorCode(error) });
    backend.failure = error;
  });
  child.once("exit", (code, signal) => {
    events.begin("backend.exit", "background", { generation }).finish(backend.stopping ? "succeeded" : "failed", { reasonCode: backend.stopping ? "EXPECTED_EXIT" : "UNEXPECTED_EXIT" });
    backend.failure ??= new Error(`Copyparty exited with ${signal ?? `code ${code}`}`);
    backend.onExit?.();
  });
  return backend;
}

export async function stopBackend(backend, graceMs = 5000, retainSnapshot = false) {
  if (backend.stopping) return backend.stopping;
  const operation = events.begin("backend.stop", "background", { generation: backend.generation });
  backend.stopping = (async () => {
    if (backend.child.pid !== undefined && backend.child.exitCode === null) {
      backend.child.kill("SIGTERM");
    }
    const deadline = setTimeout(() => {
      if (backend.child.exitCode === null && backend.child.signalCode == null) backend.child.kill("SIGKILL");
    }, graceMs);
    try { await backend.closed; } finally { clearTimeout(deadline); }
    if (!retainSnapshot) await rm(backend.snapshot, { recursive: true, force: true });
    await rm(backend.history, { recursive: true, force: true });
  })().then(() => { operation.finish("succeeded"); }, (error) => {
    operation.finish("failed", { errorCode: safeErrorCode(error) });
    throw error;
  });
  return backend.stopping;
}

export async function backendReadiness(backend) {
  if (!backend || backend.failure || backend.stopping || !backend.child || backend.child.exitCode !== null) {
    return { ready: false, reasonCode: "backend_unavailable" };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${backend.port}/`, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    assertBackendLive(backend);
    return response.ok ? { ready: true, reasonCode: "ready" } : { ready: false, reasonCode: "backend_http_failure", statusCode: response.status };
  } catch (error) { return { ready: false, reasonCode: "backend_unresponsive", errorCode: safeErrorCode(error) }; }
}

export function proxyServer(activeBackend) {
  const server = createServer((incoming, outgoing) => {
    const path = (incoming.url ?? "/").split("?", 1)[0];
    const route = ["/health", "/healthz", "/_files/ready"].includes(path) ? "health" : path === "/" ? "index" : "content";
    const operation = observeRequest(incoming, outgoing, route);
    const backend = activeBackend();
    if (path === "/_files/ready") {
      void backendReadiness(backend).then(result => {
        if (result.ready && activeBackend() !== backend) result = { ready: false, reasonCode: "backend_changed" };
        const statusCode = result.ready ? 200 : 503;
        operation.finish(result.ready ? "succeeded" : "degraded", { ...result, statusCode });
        outgoing.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result));
      });
      return;
    }
    if (!backend) {
      operation.finish("failed", { statusCode: 503, ready: false, reasonCode: "BACKEND_UNAVAILABLE" });
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
        response.once("error", (error) => {
          operation.finish("failed", { reasonCode: "UPSTREAM_INTERRUPTED", errorCode: safeErrorCode(error) });
          outgoing.destroy();
        });
        response.pipe(outgoing);
      }
    );
    const done = () => {
      backend.inflight = Math.max(0, backend.inflight - 1);
    };
    outgoing.once("close", done);
    proxied.once("error", (error) => {
      operation.finish("failed", { statusCode: outgoing.headersSent ? outgoing.statusCode : 502, reasonCode: "PROXY_FAILED", errorCode: safeErrorCode(error) });
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(`backend unavailable: ${error.message}\n`);
    });
    incoming.once("aborted", () => {
      operation.finish("failed", { reasonCode: "CLIENT_ABORTED" });
      proxied.destroy();
    });
    outgoing.once("close", () => { if (!outgoing.writableFinished) proxied.destroy(); });
    incoming.pipe(proxied);
  });

  server.on("upgrade", (request, socket, head) => {
    const operation = events.begin("http.upgrade", classifyHttpTraffic(request.headers["user-agent"], "upgrade"), { route: "upgrade" });
    const backend = activeBackend();
    if (!backend) {
      operation.finish("failed", { reasonCode: "BACKEND_UNAVAILABLE" });
      return socket.destroy();
    }
    let connected = false;
    backend.inflight += 1;
    const upstream = connectTcp(backend.port, "127.0.0.1", () => {
      connected = true;
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
    socket.once("close", () => {
      done();
      operation.finish(connected && !socket.errored ? "succeeded" : "failed", { connected });
      upstream.destroy();
    });
    socket.once("error", (error) => {
      operation.finish("failed", { reasonCode: "CLIENT_ABORTED", errorCode: safeErrorCode(error) });
      upstream.destroy();
    });
    upstream.once("error", (error) => {
      operation.finish("failed", { reasonCode: "PROXY_FAILED", errorCode: safeErrorCode(error) });
      socket.destroy();
    });
  });

  return server;
}

export function createPublicationManager(config, snapshotsRoot, dependencies = {}) {
  let active = null;
  let generation = 0;
  let published = null;
  let candidate = null;
  let refreshTask = null;
  let recoveryTask = null;
  let transition = Promise.resolve();
  let failedProbes = 0;
  let failureRecorded = false;
  let closing = false;
  const abort = new AbortController();
  const backends = new Set();
  const drains = new Map();
  const recovery = new BackendRecoveryBudget(join(config.state, "backend-recovery.json"), dependencies.now);
  const checkBackend = dependencies.readiness ?? backendReadiness;
  const startOwned = dependencies.start ?? startBackend;
  const stopOwned = dependencies.stop ?? stopBackend;
  let pendingRecovery = Promise.resolve();
  let recoveryError = null;
  const recordFailure = async () => {
    try { await recovery.failed(); } catch (error) { recoveryError = error; throw error; }
  };
  // Only child transitions are serialized. Source requests/materialization must
  // never hold this queue: recovery uses the last publication, not the live tree.
  const serialize = (action) => {
    const task = transition.then(action);
    transition = task.catch(() => {});
    return task;
  };
  const collectSnapshot = async (snapshot) => {
    if (published?.publication.snapshot === snapshot || candidate?.publication.snapshot === snapshot
      || [...backends].some(backend => backend.snapshot === snapshot)) return;
    await rm(snapshot, { recursive: true, force: true });
  };
  const retire = async (backend) => {
    clearInterval(drains.get(backend));
    drains.delete(backend);
    await stopOwned(backend, 5000, true);
    backends.delete(backend);
    await collectSnapshot(backend.snapshot);
  };
  const drain = (backend) => {
    const timer = setInterval(() => {
      if (backend.inflight !== 0) return;
      retire(backend).catch(() => {}); // backend.stop records cleanup failures.
    }, 250);
    timer.unref();
    drains.set(backend, timer);
  };

  const install = async (next, operation) => {
    if (closing) return false;
    await pendingRecovery;
    if (recoveryError) throw recoveryError;
    const permit = await recovery.permit();
    if (!permit.allowed) {
      operation.finish("skipped", { ready: active !== null, reasonCode: permit.reasonCode, retryInMs: permit.retryInMs });
      return false;
    }
    const backend = startOwned(config, ++generation, next.publication.snapshot);
    backend.signature = next.publication.signature;
    backends.add(backend);
    backend.onExit = () => {
      if (active !== backend || backend.stopping || closing) return;
      active = null;
      failedProbes = 0;
      failureRecorded = true;
      pendingRecovery = recordFailure().catch(() => {});
      retire(backend).catch(() => {});
      // The independent recovery timer retries after the persisted backoff.
    };
    try {
      await waitForBackend(backend, abort.signal);
      assertBackendLive(backend);
      abort.signal.throwIfAborted();
    } catch (error) {
      await retire(backend);
      if (!closing) await recordFailure();
      throw error;
    }
    const previous = active;
    const oldPublication = published;
    active = backend;
    published = next;
    if (candidate === next) candidate = null;
    failedProbes = 0;
    failureRecorded = false;
    operation.finish("succeeded", { itemCount: next.publication.itemCount, generation, ready: true, changed: next !== oldPublication });
    if (previous) drain(previous);
    if (oldPublication) await collectSnapshot(oldPublication.publication.snapshot);
    return true;
  };

  const recover = () => {
    if (closing) return Promise.resolve();
    if (recoveryTask) return recoveryTask;
    recoveryTask = serialize(async () => {
      const operation = events.begin("backend.recover", "background", { generation: active?.generation ?? generation });
      try {
        await pendingRecovery;
        if (recoveryError) throw recoveryError;
        if (closing || !published) {
          operation.finish("skipped", { reasonCode: "NO_PUBLICATION" });
          return;
        }
        if (active) {
          const probe = events.begin("backend.probe", "background", { generation: active.generation });
          const result = await checkBackend(active);
          if (result.ready) {
            failedProbes = 0;
            failureRecorded = false;
            await recovery.healthy();
            operation.finish("succeeded", { ready: true, changed: false });
            return;
          }
          failedProbes++;
          probe.finish("degraded", { ...result, attempt: failedProbes });
          if (failedProbes < 3) {
            operation.finish("degraded", { ...result, attempt: failedProbes });
            return;
          }
          // Count one failure episode, not every probe during its backoff.
          if (!failureRecorded) {
            failureRecorded = true;
            await recordFailure();
          }
        }
        await install(published, operation);
      } catch (error) {
        operation.finish("failed", { ready: active !== null, errorCode: safeErrorCode(error) });
        throw error;
      }
    }).finally(() => { recoveryTask = null; });
    return recoveryTask;
  };
  const recoveryTimer = setInterval(() => { recover().catch(() => {}); }, dependencies.recoveryIntervalMs ?? REFRESH_INTERVAL_MS);
  recoveryTimer.unref();

  const refresh = () => {
    if (closing || refreshTask) return refreshTask ?? Promise.resolve();
    refreshTask = (async () => {
      const operation = events.begin("publication.refresh");
      try {
        await recover();
        if (closing) return;
        config.apiKey ??= apiKeyFromConfig(await readFile(config.syncthingConfig, "utf8"));
        const status = await syncthingRequest(config, `/rest/db/status?folder=${encodeURIComponent(FOLDER_ID)}`, abort.signal);
        if (!folderReady(status)) {
          operation.finish("skipped", { reasonCode: "SOURCE_SYNCING", ready: active !== null });
          return;
        }
        const token = modelToken(status);
        if (candidate && candidate.token !== token) {
          const stale = candidate;
          candidate = null;
          await collectSnapshot(stale.publication.snapshot);
        }
        if (published && token === published.token) {
          operation.finish("skipped", { reasonCode: "UNCHANGED", ready: active !== null, generation });
          return;
        }
        if (!candidate) {
          const entries = await syncthingRequest(config, `/rest/db/browse?folder=${encodeURIComponent(FOLDER_ID)}`, abort.signal);
          candidate = { token, publication: await materializeSnapshot(config.source, snapshotsRoot, entries) };
        }
        const next = candidate;
        const statusAfter = await syncthingRequest(config, `/rest/db/status?folder=${encodeURIComponent(FOLDER_ID)}`, abort.signal);
        const changed = modelToken(statusAfter) !== token;
        if (!folderReady(statusAfter) || changed) {
          // Scanning alone does not invalidate the indexed model.
          if (changed) {
            candidate = null;
            await collectSnapshot(next.publication.snapshot);
          }
          operation.finish("skipped", { reasonCode: changed ? "SOURCE_CHANGED" : "SOURCE_SYNCING", ready: active !== null });
          return;
        }
        await serialize(() => install(next, operation));
      } catch (error) {
        operation.finish("failed", { errorCode: safeErrorCode(error), ready: active !== null, generation });
        throw error;
      }
    })().finally(() => { refreshTask = null; });
    return refreshTask;
  };

  const shutdown = async () => {
    closing = true;
    clearInterval(recoveryTimer);
    abort.abort();
    for (const timer of drains.values()) clearInterval(timer);
    drains.clear();
    await Promise.allSettled([refreshTask, transition]);
    const snapshots = new Set([...backends].map(backend => backend.snapshot));
    if (published) snapshots.add(published.publication.snapshot);
    if (candidate) snapshots.add(candidate.publication.snapshot);
    active = published = candidate = null;
    await Promise.all([...backends].map(retire));
    await Promise.all([...snapshots].map(collectSnapshot));
  };
  return { refresh, recover, shutdown, backends, get active() { return active; } };
}

async function main(startup) {
  const config = parseArgs(process.argv.slice(2));
  await access(config.source);
  await mkdir(config.state, { recursive: true });
  let publication = null;
  let timer = null;
  let stopping = false;
  const server = proxyServer(() => publication?.active ?? null);
  // Acquire the public listener before clearing managed snapshots: a second
  // launcher must not erase the publication of an already-running instance.
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolvePromise);
  });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await publication?.shutdown();
  };
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => shutdown().finally(() => process.exit(130)));
  try {
    const snapshotsRoot = join(config.state, "snapshots");
    await rm(snapshotsRoot, { recursive: true, force: true });
    await rm(join(config.state, "history"), { recursive: true, force: true });
    await mkdir(snapshotsRoot, { recursive: true });
    publication = createPublicationManager(config, snapshotsRoot);
    await waitForPublication(publication.refresh, () => stopping || publication.active !== null);
    if (stopping) return;
    startup.finish("succeeded", { readiness: "listening" });
    timer = setInterval(() => {
      publication.refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
  } catch (error) { await shutdown(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const startup = events.begin("service.start");
  main(startup).catch((error) => {
    startup.finish("failed", { errorCode: safeErrorCode(error) });
    process.exit(1);
  });
}
