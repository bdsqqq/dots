import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  SagemcomXmoClient,
  readCallbacks,
  sessionFromCookie,
  validateSession,
} from "../src/client.ts";
import type { ClientOptions, Session } from "../src/client.ts";
import { ACTION_OK, REQUEST_OK, ProtocolError, XmoError, TransportError } from "../src/protocol.ts";
import type { Json, Reply, WireRequest } from "../src/protocol.ts";

type Request = WireRequest["request"];
const status = (code: number) => ({ code, description: "synthetic" });
const imported = (): Session => ({
  mode: "token",
  id: "fixture-session",
  token: "fixture-token",
  nextRequestId: 41,
});
const response = (request: Request, value: Json = "ok", extra: Partial<Reply> = {}) =>
  new Response(
    JSON.stringify({
      reply: {
        id: request.id,
        error: status(REQUEST_OK),
        actions: request.actions.map((a) => ({
          id: a.id,
          error: status(ACTION_OK),
          callbacks: [{ result: status(ACTION_OK), xpath: a.xpath, parameters: { value } }],
        })),
        ...extra,
      },
    }),
  );
const decode = (init?: RequestInit): Request => {
  assert.equal(init?.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.body instanceof URLSearchParams || init.body instanceof FormData);
  const req = init.body.get("req");
  assert.equal(typeof req, "string");
  return (JSON.parse(req as string) as WireRequest).request;
};
const clientWith = (
  handle: (request: Request, init: RequestInit, url: string) => Response | Promise<Response>,
  options: Partial<ClientOptions> = {},
) => {
  const fetch: typeof globalThis.fetch = async (input, init) =>
    handle(decode(init), init!, String(input));
  return new SagemcomXmoClient({
    baseUrl: "http://router.invalid",
    auth: { mode: "session", session: imported() },
    ...options,
    fetch,
  });
};
const credentials: ClientOptions["auth"] = {
  mode: "credentials",
  username: "synthetic-user",
  password: "synthetic-password",
  salt: "synthetic-salt",
};

for (const algorithm of ["sha512", "md5"] as const) {
  test(`fresh ${algorithm} digest login and subsequent request sign independently computed hashes`, async () => {
    const requests: Request[] = [];
    const h = (s: string) => createHash(algorithm).update(s, "utf8").digest("hex");
    const passwordHash = h("synthetic-password:synthetic-salt");
    const client = clientWith(
      (request) => {
        const initial = requests.length === 0;
        requests.push(request);
        assert.equal(request.id, initial ? 0 : 1);
        assert.equal(request["session-id"], initial ? "0" : "session-7");
        assert.ok(
          Number.isInteger(request.cnonce) && request.cnonce >= 0 && request.cnonce <= 0xffffffff,
        );
        const ha1 = h(["synthetic-user", initial ? "" : "nonce-7", passwordHash].join(":"));
        const expected = h(
          [ha1, String(request.id), String(request.cnonce), "JSON", "/cgi/json-req"].join(":"),
        );
        assert.equal(request["auth-key"], expected);
        if (initial) {
          assert.equal(request.actions[0]!.method, "logIn");
          assert.equal(request.actions[0]!.parameters?.user, "synthetic-user");
          assert.equal(request.actions[0]!.parameters?.persistent, "true");
          return new Response(
            JSON.stringify({
              reply: {
                error: status(REQUEST_OK),
                actions: [
                  {
                    id: 0,
                    error: status(ACTION_OK),
                    callbacks: [
                      {
                        result: status(ACTION_OK),
                        parameters: { id: "session-7", nonce: "nonce-7" },
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }
        return response(request, false);
      },
      { auth: algorithm === "sha512" ? credentials : { ...credentials, algorithm } },
    );
    assert.equal(client.connected, false);
    assert.equal(await client.get("Device/Test"), false);
    assert.equal(requests.length, 2);
    assert.equal(client.connected, true);
    assert.deepEqual(client.exportSession(), {
      mode: "digest",
      id: "session-7",
      nextRequestId: 2,
      username: "synthetic-user",
      nonce: "nonce-7",
      passwordHash,
      algorithm,
    });
  });
}

test("login token replaces digest signing; concurrent calls share one login and reserve unique IDs", async () => {
  let logins = 0;
  const ids: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = clientWith(
    async (request) => {
      ids.push(request.id);
      if (request.actions[0]!.method === "logIn") {
        logins++;
        await gate;
        return new Response(
          JSON.stringify({
            reply: {
              error: status(REQUEST_OK),
              auth: { token: "new-token" },
              actions: [
                {
                  id: 0,
                  error: status(ACTION_OK),
                  callbacks: [{ result: status(ACTION_OK), parameters: { id: 7 } }],
                },
              ],
            },
          }),
        );
      }
      assert.equal(request["auth-key"], "new-token");
      assert.equal(request["session-id"], 7);
      await Promise.resolve();
      return response(request, request.id);
    },
    { auth: credentials },
  );
  const calls = Array.from({ length: 24 }, (_, i) => client.get(`Device/Test${i}`));
  release();
  await Promise.all(calls);
  assert.equal(logins, 1);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i),
  );
  assert.equal(client.exportSession().nextRequestId, 25);
});

test("imported sessions skip login, preserve request counter, and are defensively cloned", async () => {
  const session = imported();
  const requests: Request[] = [];
  const client = clientWith(
    (request) => {
      requests.push(request);
      return response(request, 0);
    },
    { auth: { mode: "session", session } },
  );
  session.nextRequestId = 999;
  const exported = client.exportSession();
  exported.nextRequestId = 888;
  assert.equal(await client.get("Device/Test"), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, 41);
  assert.equal(requests[0]!["auth-key"], "fixture-token");
  assert.equal(client.exportSession().nextRequestId, 42);
});

test("digest and token cookie imports validate credentials and never read browser state", () => {
  const hash = "a".repeat(128);
  const ha1 = "x".repeat(10) + hash + "x".repeat(118);
  assert.deepEqual(
    sessionFromCookie(JSON.stringify({ sess_id: 9, req_id: 8, user: "u", nonce: "n", ha1 })),
    {
      mode: "digest",
      id: 9,
      nextRequestId: 8,
      username: "u",
      nonce: "n",
      algorithm: "sha512",
      passwordHash: hash,
    },
  );
  assert.deepEqual(sessionFromCookie(JSON.stringify({ sess_id: 9, req_id: 8, authToken: "t" })), {
    mode: "token",
    id: 9,
    nextRequestId: 8,
    token: "t",
  });
  const md5 = "b".repeat(32);
  assert.equal(
    (
      sessionFromCookie(
        JSON.stringify({
          sess_id: 9,
          req_id: 0,
          user: "u",
          nonce: "n",
          ha1: "x".repeat(10) + md5 + "x".repeat(22),
        }),
        "md5",
      ) as { passwordHash: string }
    ).passwordHash,
    md5,
  );
  for (const value of [
    "not-json",
    "null",
    "{}",
    JSON.stringify({ basic: true }),
    JSON.stringify({ sess_id: 9, req_id: 0, ha1: "bad" }),
  ])
    assert.throws(() => sessionFromCookie(value), TypeError);
  for (const patch of [
    { id: 0 },
    { id: "0" },
    { id: "" },
    { nextRequestId: -1 },
    { nextRequestId: 0x100000000 },
    { token: "" },
  ])
    assert.throws(() => validateSession({ ...imported(), ...patch }), TypeError);
});

test("uint32 request counter wrap does not duplicate IDs in concurrent requests", async () => {
  const ids: number[] = [];
  const client = clientWith(
    (request) => {
      ids.push(request.id);
      return response(request);
    },
    { auth: { mode: "session", session: { ...imported(), nextRequestId: 0xffffffff } } },
  );
  await Promise.all([client.get("Device/A"), client.get("Device/B"), client.get("Device/C")]);
  assert.deepEqual(ids, [0xffffffff, 1, 2]);
});

test("default write gate rejects writes, arbitrary commands, mixed batches and uploads BEFORE login", async () => {
  let fetches = 0;
  const client = clientWith(
    (request) => {
      fetches++;
      return response(request);
    },
    { auth: credentials },
  );
  const attempts = [
    () => client.set("Device/Test", false),
    () => client.add("Device/Test", 0),
    () => client.delete("Device/Test"),
    () => client.call("Device/Test", "reboot"),
    () =>
      client.execute([
        { method: "getValue", xpath: "Device/A" },
        { method: "setValue", xpath: "Device/B", parameters: { value: "" } },
      ]),
    () =>
      client.upload(
        [{ method: "restore", xpath: "Device/Test" }],
        [{ field: "file", filename: "fixture.bin", data: new Blob(["synthetic"]) }],
      ),
  ];
  for (const attempt of attempts) await assert.rejects(attempt, /mutations disabled/);
  assert.equal(fetches, 0);
  assert.equal(client.connected, false);
});

test("invalid input rejects before login; valid false, zero and empty string survive writes and reads", async () => {
  let fetches = 0;
  const invalidClient = clientWith(
    (request) => {
      fetches++;
      return response(request);
    },
    { auth: credentials, allowMutations: true },
  );
  for (const value of [undefined, NaN, Infinity, 1n, { nested: undefined }])
    await assert.rejects(() => invalidClient.set("Device/Test", value as never));
  await assert.rejects(() => invalidClient.get(""), TypeError);
  assert.equal(fetches, 0);
  for (const value of [false, 0, "", null] satisfies Json[]) {
    const client = clientWith(
      (request) => {
        assert.deepEqual(request.actions[0]!.parameters, { value });
        return response(request, value);
      },
      { allowMutations: true },
    );
    const r = await client.set("Device/Test", value);
    assert.deepEqual(
      readCallbacks(r).map((c) => c.value),
      [value],
    );
    const reader = clientWith((request) => response(request, value));
    assert.deepEqual(await reader.get("Device/Test"), value);
  }
});

test("execute snapshots caller actions before asynchronous login", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = clientWith(
    async (request) => {
      if (request.actions[0]!.method === "logIn") {
        await gate;
        return new Response(
          JSON.stringify({
            reply: {
              error: status(REQUEST_OK),
              auth: { token: "t" },
              actions: [
                {
                  id: 0,
                  error: status(ACTION_OK),
                  callbacks: [{ result: status(ACTION_OK), parameters: { id: 7 } }],
                },
              ],
            },
          }),
        );
      }
      assert.equal(request.actions[0]!.xpath, "Device/Original");
      assert.deepEqual(request.actions[0]!.options, { nested: { enabled: false } });
      return response(request);
    },
    { auth: credentials },
  );
  const action = {
    method: "getValue",
    xpath: "Device/Original",
    options: { nested: { enabled: false } },
  };
  const pending = client.execute([action]);
  action.xpath = "Device/Changed";
  action.options.nested.enabled = true;
  release();
  await pending;
});

test("request, action and callback failures reject client calls with complete partial replies", async () => {
  for (const layer of ["request", "action", "callback"] as const) {
    const client = clientWith((request) => {
      const r = {
        error: status(REQUEST_OK),
        actions: request.actions.map((a) => ({
          id: a.id,
          error: status(ACTION_OK),
          callbacks: [{ result: status(ACTION_OK), parameters: { value: a.id } }],
        })),
      };
      if (layer === "request") r.error = status(90001);
      if (layer === "action") r.actions[1]!.error = status(90002);
      if (layer === "callback") r.actions[1]!.callbacks[0]!.result = status(90003);
      return new Response(JSON.stringify({ reply: r }));
    });
    await assert.rejects(
      () =>
        client.execute([
          { method: "getValue", xpath: "Device/A" },
          { method: "getValue", xpath: "Device/B" },
        ]),
      (e: unknown) => {
        assert.ok(e instanceof XmoError);
        assert.equal(e.layer, layer);
        assert.equal(e.reply.actions.length, 2);
        assert.equal(e.reply.actions[0]!.callbacks![0]!.parameters!.value, 0);
        return true;
      },
    );
  }
});

test("missing/duplicate action IDs and non-JSON successful HTTP replies reject", async () => {
  for (const handle of [
    (r: Request) => response(r, "ok", { actions: [] }),
    (r: Request) =>
      response(r, "ok", {
        actions: [
          { id: 0, error: status(ACTION_OK) },
          { id: 0, error: status(ACTION_OK) },
        ],
      }),
    () => new Response("<html><body>login page</body></html>"),
  ]) {
    const client = clientWith(handle);
    await assert.rejects(() => client.get("Device/Test"), ProtocolError);
  }
});

test("HTTP errors and dropped mutation responses are not retried and have unknown outcomes", async () => {
  for (const failure of ["http", "network", "body"] as const) {
    let count = 0;
    const client = clientWith(
      () => {
        count++;
        if (failure === "network") throw new Error("synthetic connection reset");
        if (failure === "body")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("synthetic truncated response"));
              },
            }),
          );
        return new Response("synthetic private response", { status: 503 });
      },
      { allowMutations: true },
    );
    await assert.rejects(
      () => client.set("Device/Test", false),
      (e: unknown) => {
        assert.ok(e instanceof TransportError);
        assert.equal(e.outcome, "unknown");
        assert.equal(e.httpStatus, failure === "http" ? 503 : undefined);
        assert.ok(!e.message.includes("private response"));
        return true;
      },
    );
    assert.equal(count, 1);
  }
  const reader = clientWith(() => new Response("unavailable", { status: 502 }));
  await assert.rejects(
    () => reader.get("Device/Test"),
    (e: unknown) =>
      e instanceof TransportError && e.outcome === "not-confirmed" && e.httpStatus === 502,
  );
});

test("session failure clears imported auth but never logs in again or retries a mutation", async () => {
  let count = 0;
  const client = clientWith(
    (request) => {
      count++;
      return response(request, null, { error: status(16777219), actions: [] });
    },
    { allowMutations: true },
  );
  await assert.rejects(() => client.set("Device/Test", 1), XmoError);
  assert.equal(client.connected, false);
  await assert.rejects(() => client.get("Device/Test"), /session expired/);
  assert.equal(count, 1);
});

test("pre-aborted requests never reach fetch", async () => {
  let count = 0;
  const client = clientWith((request) => {
    count++;
    return response(request);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => client.get("Device/Test", { signal: controller.signal }));
  assert.equal(count, 0);
});

for (const mode of ["timeout", "abort"] as const) {
  test(`in-flight ${mode} cancels transport exactly once without mutation retry`, async () => {
    let count = 0;
    let aborted = false;
    const controller = new AbortController();
    const client = clientWith(
      (_request, init) => {
        count++;
        return new Promise((_resolve, reject) => {
          // Keep the event loop alive: AbortSignal.timeout's own timer is unreferenced.
          const watchdog = setTimeout(
            () => reject(new Error("transport did not receive abort")),
            1000,
          );
          init.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(watchdog);
              reject(init.signal!.reason);
            },
            { once: true },
          );
          if (mode === "abort") queueMicrotask(() => controller.abort());
        });
      },
      { allowMutations: true },
    );
    await assert.rejects(
      () =>
        client.set("Device/Test", 1, {
          timeoutMs: mode === "timeout" ? 15 : 500,
          signal: controller.signal,
        }),
      (e: unknown) => e instanceof TransportError && e.outcome === "unknown",
    );
    assert.equal(count, 1);
    assert.equal(
      aborted,
      true,
      "transport must observe cancellation, not merely fail via watchdog",
    );
    assert.equal(controller.signal.aborted, mode === "abort");
  });
}

test("multipart upload carries signed req and named Blob and parses XML response body", async () => {
  const client = clientWith(
    async (request, init, url) => {
      assert.equal(url, "http://router.invalid/cgi/upload");
      assert.ok(init.body instanceof FormData);
      assert.equal(request["auth-key"], "fixture-token");
      const file = init.body.get("configuration");
      assert.ok(file instanceof Blob);
      assert.equal((file as File).name, "fixture.xml");
      assert.equal(await file.text(), "<synthetic/>");
      const json = await response(request, "restored").text();
      return new Response(
        `<?xml version="1.0"?><html><body>${json.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</body></html>`,
        { headers: { "content-type": "text/xml" } },
      );
    },
    { allowMutations: true },
  );
  assert.equal(
    readCallbacks(
      await client.upload(
        [{ method: "restore", xpath: "Device/Test" }],
        [{ field: "configuration", filename: "fixture.xml", data: new Blob(["<synthetic/>"]) }],
      ),
    )[0]!.value,
    "restored",
  );
});

test("invalid multipart fields reject before credential login", async () => {
  let count = 0;
  const client = clientWith(
    (request) => {
      count++;
      return response(request);
    },
    { auth: credentials, allowMutations: true },
  );
  const file = { field: "file", filename: "fixture.bin", data: new Blob(["synthetic"]) };
  for (const files of [
    [],
    [{ ...file, field: "req" }],
    [file, file],
    [{ ...file, filename: "" }],
    [{ ...file, data: "not a Blob" }],
  ]) {
    await assert.rejects(() => client.upload([{ method: "restore" }], files as never), TypeError);
  }
  assert.equal(count, 0);
});

test("downloads enforce same origin and reject real redirects without requesting the target", async (t) => {
  let targets = 0;
  const target = createServer((_req, res) => {
    targets++;
    res.end("cross-origin target");
  });
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: `http://127.0.0.1:${(target.address() as { port: number }).port}/target`,
      });
      res.end();
    } else if (req.url === "/same-origin-redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
    } else if (req.url === "/error") {
      res.writeHead(500);
      res.end("failure");
    } else {
      if (req.url === "/target") targets++;
      res.end("synthetic-download");
    }
  });
  t.after(() =>
    Promise.all(
      [server, target].map(
        (s) =>
          new Promise<void>((resolve, reject) => {
            s.close((error) => (error ? reject(error) : resolve()));
            s.closeAllConnections();
          }),
      ),
    ),
  );
  await Promise.all(
    [server, target].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))),
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new SagemcomXmoClient({
    baseUrl,
    auth: { mode: "session", session: imported() },
    timeoutMs: 1000,
  });
  assert.equal(await (await client.download("/file")).text(), "synthetic-download");
  for (const uri of [
    "https://elsewhere.invalid/file",
    "//elsewhere.invalid/file",
    `${baseUrl.replace("http://", "http://user:secret@")}/file`,
    "file:///tmp/fixture",
  ]) {
    await assert.rejects(() => client.download(uri), TypeError);
  }
  for (const uri of ["/redirect", "/same-origin-redirect"])
    await assert.rejects(() => client.download(uri), TransportError);
  assert.equal(targets, 0);
  await assert.rejects(
    () => client.download("/error"),
    (e: unknown) => e instanceof TransportError && e.httpStatus === 500,
  );
});

test("event subscribe/unsubscribe/poll/reset and command event-id use explicit wire forms", async () => {
  const requests: Request[] = [];
  const events = [
    { id: "1", type: "value-change", xpath: "Device/A", parameters: { value: false } },
    { id: 2, type: "periodic", parameters: { value: 0 } },
  ];
  const client = clientWith((request) => {
    requests.push(request);
    return response(request, null, request.actions[0]!.method === "getEvents" ? { events } : {});
  });
  assert.equal(
    await client.events.subscribe("Device/A", {
      type: "periodic",
      timer: 2.5,
      currentValue: false,
    }),
    "1",
  );
  assert.equal(
    await client.events.subscribe("Device/B", { type: "value-change", currentValue: true }),
    "2",
  );
  assert.equal(await client.events.subscribe("Device/C", { type: "delete-child" }), "3");
  await client.events.unsubscribe("1");
  assert.deepEqual(await client.events.poll(), events);
  await client.events.reset();
  assert.deepEqual(
    requests.map((r) => r.actions[0]),
    [
      {
        id: 0,
        method: "subscribeForNotification",
        xpath: "Device/A",
        parameters: { id: "1", type: "periodic", timer: 2.5, "current-value": false },
      },
      {
        id: 0,
        method: "subscribeForNotification",
        xpath: "Device/B",
        parameters: { id: "2", type: "value-change", "current-value": true },
      },
      {
        id: 0,
        method: "subscribeForNotification",
        xpath: "Device/C",
        parameters: { id: "3", type: "delete-child" },
      },
      { id: 0, method: "unsubscribeForNotification", parameters: { id: "1" } },
      { id: 0, method: "getEvents" },
      { id: 0, method: "resetEvents" },
    ],
  );
  const empty = clientWith((request) => response(request));
  assert.deepEqual(await empty.events.poll(), []);
  const command = clientWith(
    (request) => {
      assert.equal(request.actions[0]!["event-id"], "evt-7");
      return response(request);
    },
    { allowMutations: true },
  );
  await command.call("Device/A", "customCommand", {}, undefined, "evt-7");
});

test("invalid subscriptions reject before login", async () => {
  let count = 0;
  const client = clientWith(
    (request) => {
      count++;
      return response(request);
    },
    { auth: credentials },
  );
  for (const subscription of [
    { type: "unknown" },
    { type: "periodic", timer: 0 },
    { type: "periodic", timer: Infinity },
    { type: "periodic", timer: -1 },
    { type: "value-change", currentValue: 0 },
  ]) {
    await assert.rejects(
      () => client.events.subscribe("Device/Test", subscription as never),
      TypeError,
    );
  }
  assert.throws(() => client.events.unsubscribe(""), TypeError);
  assert.equal(count, 0);
});
