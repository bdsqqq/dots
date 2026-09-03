import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";

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

export function createHueControlServer(runtime: HueRuntimeApi): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
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
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, runtime.snapshot());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/discover") {
        await body(request);
        json(response, 200, await runtime.discover());
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
        result(response, await lightCommand(runtime, await body(request)));
        return;
      }
      json(response, 404, { error: "not-found", message: "route not found" });
    } catch (error) {
      const invalid = error instanceof RequestError;
      json(response, invalid ? 400 : 503, {
        error: invalid ? "invalid-request" : "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
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
