import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECURITY_HEADERS = {
  "cache-control": "public, max-age=300",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

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
    const name = flag.slice(2);
    if (options.has(name)) throw new Error(`duplicate argument --${name}`);
    options.set(name, value);
  }
  const host = options.get("host") ?? "127.0.0.1";
  const port = Number(options.get("port") ?? "3929");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid --port");
  }
  return {
    host,
    port,
    html: resolve(required(options, "html")),
    css: resolve(required(options, "css")),
    js: resolve(required(options, "js")),
  };
}

function send(response, requestMethod, status, contentType, body, headers = {}) {
  const contents = Buffer.from(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-length": contents.byteLength,
    "content-type": contentType,
    ...headers,
  });
  if (requestMethod === "HEAD") response.end();
  else response.end(contents);
}

export function portalServer(assets) {
  return createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      send(response, method, 405, "text/plain; charset=utf-8", "method not allowed\n", {
        allow: "GET, HEAD",
        "cache-control": "no-store",
      });
      return;
    }
    const url = new URL(request.url ?? "/", "http://portal.local");
    if (url.pathname === "/") {
      send(response, method, 200, "text/html; charset=utf-8", assets.html);
      return;
    }
    if (url.pathname === "/portal.css") {
      send(response, method, 200, "text/css; charset=utf-8", assets.css);
      return;
    }
    if (url.pathname === "/portal.js") {
      send(response, method, 200, "text/javascript; charset=utf-8", assets.js);
      return;
    }
    if (url.pathname === "/healthz") {
      send(response, method, 200, "text/plain; charset=utf-8", "ok\n", {
        "cache-control": "no-store",
      });
      return;
    }
    send(response, method, 404, "text/plain; charset=utf-8", "not found\n", {
      "cache-control": "no-store",
    });
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const assets = {
    html: await readFile(config.html, "utf8"),
    css: await readFile(config.css, "utf8"),
    js: await readFile(config.js, "utf8"),
  };
  const server = portalServer(assets);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`company-money portal listening on ${config.host}:${config.port}\n`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`company-money portal failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
