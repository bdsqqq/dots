import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MEDIA_EXTENSIONS = new Set([
  ".3gp",
  ".avif",
  ".avi",
  ".bmp",
  ".dng",
  ".gif",
  ".heic",
  ".heif",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".png",
  ".tif",
  ".tiff",
  ".webm",
  ".webp",
]);
const VIDEO_EXTENSIONS = new Set([".3gp", ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const RESCAN_INTERVAL_MS = 5 * 60 * 1000;

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
    copyparty: resolve(required(options, "copyparty")),
    html: resolve(required(options, "html")),
    css: resolve(required(options, "css")),
    js: resolve(required(options, "js")),
    host: options.get("host") ?? "127.0.0.1",
    port: Number(options.get("port") ?? "3923"),
    backendPort: Number(options.get("backend-port") ?? "13923"),
  };
}

function calendarDate(path) {
  const match = path.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}`
    : null;
}

function publicPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function walk(root, directory, items) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, items);
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension)) continue;
    const relativePath = publicPath(root, path);
    const date = calendarDate(relativePath) ?? (await stat(path)).mtime.toISOString().slice(0, 10);
    items.push({
      date,
      name: entry.name,
      path: relativePath,
      type: VIDEO_EXTENSIONS.has(extension) ? "video" : "image",
    });
  }
}

export async function buildTimeline(root) {
  const items = [];
  await walk(root, root, items);
  items.sort((left, right) => right.date.localeCompare(left.date) || left.path.localeCompare(right.path));

  const groups = [];
  for (const item of items) {
    const current = groups.at(-1);
    if (!current || current.date !== item.date) groups.push({ date: item.date, items: [] });
    groups.at(-1).items.push({ name: item.name, path: item.path, type: item.type });
  }
  return {
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    groups,
  };
}

export function backendPath(requestUrl) {
  const url = new URL(requestUrl, "http://gallery.local");
  if (url.pathname.startsWith("/gallery/raw/")) {
    return `/raw/${url.pathname.slice("/gallery/raw/".length)}${url.search}`;
  }
  if (/^\/gallery\/\d{4}(?:\/|$)/.test(url.pathname)) {
    return `/raw/${url.pathname.slice("/gallery/".length)}${url.search}`;
  }
  if (url.pathname === "/gallery/folders" || url.pathname.startsWith("/gallery/folders/")) {
    const suffix = url.pathname.slice("/gallery/folders".length);
    return `/raw${suffix || "/"}${url.search}`;
  }
  if (url.pathname.startsWith("/raw/") || url.pathname.startsWith("/.cpr/")) {
    return `${url.pathname}${url.search}`;
  }
  return null;
}

function send(outgoing, status, contentType, body, extraHeaders = {}) {
  outgoing.writeHead(status, {
    "cache-control": "no-cache",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  outgoing.end(body);
}

function proxy(incoming, outgoing, backendPort, path) {
  const headers = { ...incoming.headers, host: `127.0.0.1:${backendPort}` };
  const proxied = httpRequest(
    { host: "127.0.0.1", port: backendPort, method: incoming.method, path, headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
  );
  proxied.once("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(`thumbnail backend unavailable: ${error.message}\n`);
  });
  incoming.pipe(proxied);
}

export function galleryServer({ assets, backendPort, timeline }) {
  return createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, "http://gallery.local");
    const proxiedPath = backendPath(incoming.url);
    if (proxiedPath) return proxy(incoming, outgoing, backendPort, proxiedPath);

    if (url.pathname === "/") {
      outgoing.writeHead(302, { location: "/gallery/" }).end();
      return;
    }
    if (url.pathname === "/gallery" || url.pathname === "/gallery/") {
      send(outgoing, 200, "text/html; charset=utf-8", assets.html, {
        "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
      });
      return;
    }
    if (url.pathname === "/gallery/gallery.css") {
      send(outgoing, 200, "text/css; charset=utf-8", assets.css);
      return;
    }
    if (url.pathname === "/gallery/gallery.js") {
      send(outgoing, 200, "text/javascript; charset=utf-8", assets.js);
      return;
    }
    if (url.pathname === "/gallery/api/timeline") {
      const current = timeline();
      if (!current) return send(outgoing, 503, "application/json", '{"error":"indexing"}\n');
      send(outgoing, 200, "application/json", `${JSON.stringify(current)}\n`);
      return;
    }
    send(outgoing, 404, "text/plain; charset=utf-8", "not found\n");
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  await Promise.all([access(config.source), mkdir(config.state, { recursive: true })]);
  const assets = {
    html: await readFile(config.html, "utf8"),
    css: await readFile(config.css, "utf8"),
    js: await readFile(config.js, "utf8"),
  };

  let timeline = await buildTimeline(config.source);
  console.log(`indexed ${timeline.itemCount} media files in ${timeline.groups.length} days`);
  const refresh = setInterval(async () => {
    try {
      timeline = await buildTimeline(config.source);
      console.log(`refreshed ${timeline.itemCount} media files in ${timeline.groups.length} days`);
    } catch (error) {
      console.error("gallery refresh failed", error);
    }
  }, RESCAN_INTERVAL_MS);
  refresh.unref();

  const backend = spawn(
    config.copyparty,
    [
      "-i",
      "127.0.0.1",
      "-p",
      String(config.backendPort),
      "--rproxy",
      "-1",
      "--hist",
      config.state,
      "--grid",
      "--no-del",
      "--no-mv",
      "-v",
      `${config.source}:/raw:r`,
    ],
    { stdio: "inherit" }
  );
  backend.once("error", (error) => console.error("failed to start copyparty", error));

  const server = galleryServer({ assets, backendPort: config.backendPort, timeline: () => timeline });
  server.listen(config.port, config.host, () => {
    console.log(`photo gallery listening on http://${config.host}:${config.port}/gallery/`);
  });

  const shutdown = () => {
    server.close();
    if (backend.exitCode === null) backend.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  backend.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`copyparty exited with ${signal ?? `code ${code}`}`);
      process.exitCode = 1;
      server.close();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
