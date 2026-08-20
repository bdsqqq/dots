import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    intelligenceUrl: options.get("intelligence-url") ?? "http://127.0.0.1:3924",
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

function proxy(incoming, outgoing, target, path) {
  const headers = { ...incoming.headers, host: target.host };
  const proxied = httpRequest(
    { hostname: target.hostname, port: target.port, method: incoming.method, path, headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
  );
  proxied.once("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(`backend unavailable: ${error.message}\n`);
  });
  incoming.pipe(proxied);
}

export function galleryServer({ assets, backendPort, intelligenceUrl }) {
  return createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, "http://gallery.local");
    const proxiedPath = backendPath(incoming.url);
    if (proxiedPath) {
      return proxy(incoming, outgoing, new URL(`http://127.0.0.1:${backendPort}`), proxiedPath);
    }

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
      const target = new URL("/timeline", intelligenceUrl);
      return proxy(incoming, outgoing, target, `${target.pathname}${target.search}`);
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

  const server = galleryServer({
    assets,
    backendPort: config.backendPort,
    intelligenceUrl: config.intelligenceUrl,
  });
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
