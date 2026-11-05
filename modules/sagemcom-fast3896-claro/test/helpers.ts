import assert from "node:assert/strict";
import type { Json, WireRequest, XmoCallback } from "../src/protocol.ts";
import { ACTION_OK, REQUEST_OK } from "../src/protocol.ts";
import { SagemcomFast3896Claro } from "../src/sdk.ts";
import type { ClientOptions } from "../src/client.ts";
export const ok = { code: ACTION_OK, description: "synthetic" };
export type Request = WireRequest["request"];
export function decode(init?: RequestInit): Request {
  assert.ok(init?.body instanceof URLSearchParams || init?.body instanceof FormData);
  return JSON.parse(String(init.body.get("req"))).request;
}
export function callback(value: Json, xpath?: string): XmoCallback {
  return { result: ok, ...(xpath === undefined ? {} : { xpath }), parameters: { value } };
}
export function response(request: Request, values: Json[] = ["ok"]): Response {
  return new Response(
    JSON.stringify({
      reply: {
        id: request.id,
        error: { code: REQUEST_OK, description: "ok" },
        actions: request.actions.map((a, i) => ({
          id: a.id,
          error: ok,
          callbacks: [callback(values[i] ?? null, a.xpath)],
        })),
      },
    }),
  );
}
export function sdk(
  handle: (request: Request, init: RequestInit) => Response | Promise<Response>,
  options: Partial<ClientOptions> = {},
): SagemcomFast3896Claro {
  return new SagemcomFast3896Claro({
    baseUrl: "http://router.invalid",
    auth: {
      mode: "session",
      session: { mode: "token", id: 1, nextRequestId: 1, token: "synthetic-token" },
    },
    ...options,
    fetch: async (_, init) => handle(decode(init), init!),
  });
}
