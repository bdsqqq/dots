import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";

import { classifyHttpTraffic, safeErrorCode } from "../service-events/events.ts";
import type { EventContext, Outcome } from "../service-events/events.ts";
import { hueEvents } from "./events.ts";
import type { HueEvents } from "./events.ts";

import type { HueDevice } from "./ble-adapter.ts";
import type { HueResult, HueState } from "./hue-protocol.ts";
import type { HueRuntimeSnapshot } from "./runtime.ts";
import { hueControlHtml } from "./ui.ts";

const maximumBodyBytes = 16 * 1024;

class RequestError extends Error {}

export interface HueRuntimeApi {
  discover(): Promise<HueDevice>;
  enroll(deviceId: string): Promise<void>;
  reconnect(): Promise<void>;
  setBrightness(value: number): Promise<HueResult<HueState>>;
  setColorTemperature(value: number): Promise<HueResult<HueState>>;
  setColorXy(x: number, y: number): Promise<HueResult<HueState>>;
  setPower(value: boolean): Promise<HueResult<HueState>>;
  snapshot(): HueRuntimeSnapshot;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new RequestError("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBodyBytes) throw new RequestError("request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("request body must be valid JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function result(response: ServerResponse, value: HueResult<HueState>): void {
  if (value.ok) json(response, 200, value.value);
  else json(response, value.error === "unavailable" ? 503 : 400, value);
}

async function lightCommand(
  runtime: HueRuntimeApi,
  requestBody: unknown,
): Promise<HueResult<HueState>> {
  const command = record(requestBody);
  if (Object.keys(command).length !== 1) throw new RequestError("supply exactly one light command");
  if (typeof command.power === "boolean") return runtime.setPower(command.power);
  if (typeof command.brightness === "number") return runtime.setBrightness(command.brightness);
  if (typeof command.colorTemperature === "number") {
    return runtime.setColorTemperature(command.colorTemperature);
  }
  if (
    Array.isArray(command.colorXy) &&
    command.colorXy.length === 2 &&
    command.colorXy.every((coordinate) => typeof coordinate === "number")
  ) {
    return runtime.setColorXy(command.colorXy[0], command.colorXy[1]);
  }
  throw new RequestError("unknown or invalid light command");
}

export interface HueServerOptions {
  events?: HueEvents;
  now?: () => number;
}

function routeCategory(pathname: string): string {
  switch (pathname) {
    case "/": return "ui";
    case "/health": return "health";
    case "/ready": return "readiness";
    case "/api/state": return "state";
    case "/api/discover": return "discover";
    case "/api/commission": return "commission";
    case "/api/enroll": return "enroll";
    case "/api/reconnect": return "reconnect";
    case "/api/light": return "light";
    default: return "not_found";
  }
}

export function createHueControlServer(runtime: HueRuntimeApi, options: HueServerOptions = {}): Server {
  const events = options.events ?? hueEvents;
  const now = options.now ?? Date.now;
  type Completion = { event: ReturnType<HueEvents["begin"]>; outcome: Outcome; context: EventContext };
  const polls = new Map<string, {
    signature: string; lastEmitted: number; pending?: Completion; count: number;
  }>();
  function flushPoll(poll: { pending?: Completion; count: number; lastEmitted: number }): void {
    if (!poll.pending) return;
    poll.pending.event.finish(poll.pending.outcome, { ...poll.pending.context, observationCount: poll.count });
    poll.pending = undefined;
    poll.count = 0;
    poll.lastEmitted = now();
  }
  const server = createServer(async (request, response) => {
    let url: URL | undefined;
    let urlError: unknown;
    try { url = new URL(request.url ?? "/", "http://localhost"); } catch (error) { urlError = error; }
    const route = url ? routeCategory(url.pathname) : "not_found";
    let errorCode: string | undefined;
    let reasonCode: string | undefined;
    let completed = false;
    const method = ["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"].includes(request.method ?? "")
      ? request.method! : "OTHER";
    // Classification uses only a bounded category. Neither URL nor user agent enters an event.
    const traffic = classifyHttpTraffic(request.headers["user-agent"], route === "readiness" ? "health" : route);
    const event = events.begin("http.request", traffic);
    const complete = (aborted: boolean): void => {
      if (completed) return;
      completed = true;
      const snapshot = runtime.snapshot();
      const ready = snapshot.status === "available";
      const readinessOperation = ["health", "readiness", "state", "commission", "enroll", "reconnect"].includes(route);
      const outcome: Outcome = aborted || response.statusCode >= 400 ? "failed"
        : readinessOperation && !ready ? "degraded" : "succeeded";
      const context: EventContext = {
        method, route, ...(response.headersSent ? { statusCode: response.statusCode } : {}),
        ready, readiness: snapshot.status, enrolled: snapshot.deviceId !== null,
        ...(errorCode ? { errorCode } : {}), ...(reasonCode ? { reasonCode } : {}),
        ...(aborted ? { reasonCode: "request_aborted" } : {}),
      };
      // The UI polls state every three seconds. Keep first observation and changes immediate,
      // then summarize identical health/state polls per traffic class at most once/minute.
      if (!aborted && method === "GET" && (route === "health" || route === "readiness" || route === "state")) {
        const key = `${route}:${traffic}`;
        const signature = JSON.stringify({ outcome, context });
        const previous = polls.get(key);
        if (!previous || previous.signature !== signature) {
          if (previous) flushPoll(previous);
          event.finish(outcome, { ...context, observationCount: 1 });
          polls.set(key, { signature, lastEmitted: now(), count: 0 });
        } else {
          // Summary duration is an observation window, never a single-request latency.
          previous.pending ??= { event: events.begin("http.poll_summary", traffic), outcome, context };
          previous.count += 1;
          if (now() - previous.lastEmitted >= 60_000) flushPoll(previous);
        }
      } else event.finish(outcome, context);
    };
    response.once("finish", () => complete(false));
    response.once("close", () => complete(!response.writableFinished));
    try {
      if (!url) throw urlError;
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(hueControlHtml);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, lightAvailable: runtime.snapshot().status === "available" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        const snapshot = runtime.snapshot();
        const ready = snapshot.status === "available";
        json(response, ready ? 200 : 503, {
          ready, readiness: snapshot.status,
          reasonCode: snapshot.reasonCode ?? (ready ? "connected" : snapshot.status),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, runtime.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/discover") {
        await body(request);
        json(response, 200, await runtime.discover());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/commission") {
        await body(request);
        const device = await runtime.discover();
        await runtime.enroll(device.id);
        const snapshot = runtime.snapshot();
        json(response, snapshot.status === "available" ? 200 : 503, snapshot);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/enroll") {
        const value = record(await body(request));
        if (
          typeof value.deviceId !== "string" ||
          value.deviceId.trim().length === 0 ||
          Object.keys(value).length !== 1
        ) {
          throw new RequestError("a non-empty deviceId must be the only field");
        }
        await runtime.enroll(value.deviceId);
        json(response, 200, runtime.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/reconnect") {
        await body(request);
        await runtime.reconnect();
        json(response, runtime.snapshot().status === "available" ? 200 : 503, runtime.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/light") {
        const command = await lightCommand(runtime, await body(request));
        if (!command.ok) reasonCode = command.error;
        result(response, command);
        return;
      }
      errorCode = "NOT_FOUND";
      json(response, 404, { error: "not-found", message: "route not found" });
    } catch (error) {
      const invalid = error instanceof RequestError;
      errorCode = invalid ? "INVALID_REQUEST" : safeErrorCode(error);
      json(response, invalid ? 400 : 503, {
        error: invalid ? "invalid-request" : "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.once("close", () => { for (const poll of polls.values()) flushPoll(poll); });
  return server;
}

export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
