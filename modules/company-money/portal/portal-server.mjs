import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTally } from "./tally.ts";
import { createEventLogger, classifyHttpTraffic, safeErrorCode } from "../../service-events/events.ts";

const events = createEventLogger("company-money-portal");

function routeCategory(pathname) {
  if (pathname === "/") return "index";
  if (pathname === "/api/tally") return "ledger";
  if (pathname === "/portal.css") return "stylesheet";
  if (pathname === "/portal.js") return "script";
  if (pathname === "/healthz") return "healthz";
  return "not_found";
}

const SECURITY_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
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
    if (!["host", "port", "html", "css", "js", "root"].includes(name)) throw new Error("unknown argument");
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
    root: resolve(required(options, "root")),
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

export function portalServer(assets, tally = async () => { throw new Error("unavailable"); }) {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const context = {
      method: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE"].includes(method) ? method : "OTHER",
      route: "not_found",
    };
    // Complete on response finish/close rather than when an async ledger read starts.
    let operation;
    let completed = false;
    const complete = (aborted = false) => {
      if (completed) return;
      completed = true;
      operation?.finish(aborted || response.statusCode >= 400 ? "failed" : "succeeded", {
        ...context,
        ...(aborted ? { reasonCode: "response_aborted" } : { statusCode: response.statusCode }),
      });
    };
    response.once("finish", () => complete());
    response.once("close", () => complete(!response.writableFinished));
    try {
      const url = new URL(request.url ?? "/", "http://portal.local");
      context.route = routeCategory(url.pathname);
      operation = events.begin("http.request", classifyHttpTraffic(request.headers["user-agent"], context.route), context);
      if (method !== "GET" && method !== "HEAD") {
        send(response, method, 405, "text/plain; charset=utf-8", "method not allowed\n", {
          allow: "GET, HEAD",
          "cache-control": "no-store",
        });
        return;
      }
      if (context.route === "ledger") {
        try {
          send(response, method, 200, "application/json", JSON.stringify(await tally()));
        } catch (error) {
          context.errorCode = safeErrorCode(error);
          context.reasonCode = "ledger_unavailable";
          send(response, method, 503, "application/json", '{"error":"ledger unavailable"}');
        }
        return;
      }
      if (context.route === "index") {
        send(response, method, 200, "text/html; charset=utf-8", assets.html);
        return;
      }
      if (context.route === "stylesheet") {
        send(response, method, 200, "text/css; charset=utf-8", assets.css);
        return;
      }
      if (context.route === "script") {
        send(response, method, 200, "text/javascript; charset=utf-8", assets.js);
        return;
      }
      if (context.route === "healthz") {
        send(response, method, 200, "text/plain; charset=utf-8", "ok\n", {
          "cache-control": "no-store",
        });
        return;
      }
      send(response, method, 404, "text/plain; charset=utf-8", "not found\n", {
        "cache-control": "no-store",
      });
    } catch (error) {
      operation ??= events.begin("http.request", classifyHttpTraffic(request.headers["user-agent"], context.route), context);
      context.errorCode = safeErrorCode(error);
      context.reasonCode = "request_failed";
      if (!response.headersSent) send(response, method, 500, "text/plain; charset=utf-8", "internal server error\n");
      else response.destroy();
    }
  });
}

async function main() {
  const startup = events.begin("service.start", "background");
  try {
    const config = parseArgs(process.argv.slice(2));
    const assets = {
      html: await readFile(config.html, "utf8"),
      css: await readFile(config.css, "utf8"),
      js: await readFile(config.js, "utf8"),
    };
    const server = portalServer(assets, () => readTally(config.root));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    // Listening confirms the HTTP shell, not ledger availability; healthz stays liveness-only.
    startup.finish("succeeded", { ready: true, readiness: "http_listening" });
    server.on("error", (error) => {
      events.begin("service.failure", "background").finish("failed", { ready: false, errorCode: safeErrorCode(error) });
    });
  } catch (error) {
    startup.finish("failed", { ready: false, errorCode: safeErrorCode(error) });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
