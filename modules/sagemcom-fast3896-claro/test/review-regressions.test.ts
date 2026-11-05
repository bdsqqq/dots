import test from "node:test";
import assert from "node:assert/strict";
import { SagemcomXmoClient } from "../src/client.ts";
import { discoverCapabilities } from "../src/discovery.ts";
import { ProtocolError, CALLBACK_ERROR } from "../src/protocol.ts";
import { sdk, response, ok } from "./helpers.ts";

const credentials = {
  mode: "credentials" as const,
  username: "fixture-user",
  password: "fixture-password",
};
test("each shared-login waiter honors its own abort/timeout without cancelling authentication", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let authSignal: AbortSignal | null | undefined;
  const router = sdk(
    async (r, init) => {
      calls++;
      if (r.actions[0]!.method === "logIn") {
        authSignal = init.signal;
        await gate;
        return new Response(
          JSON.stringify({
            reply: {
              error: { code: 16777216, description: "ok" },
              actions: [
                {
                  id: 0,
                  error: ok,
                  callbacks: [{ result: ok, parameters: { id: 1, nonce: "fixture-nonce" } }],
                },
              ],
            },
          }),
        );
      }
      return response(r);
    },
    { auth: credentials },
  );
  const original = router.login();
  const controller = new AbortController();
  const waiter = router.login({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiter, (e) => e instanceof Error && e.name === "AbortError");
  assert.equal(authSignal?.aborted, false);
  const getController = new AbortController();
  const waitingRead = router.get("Device/DeviceInfo", { signal: getController.signal });
  getController.abort();
  await assert.rejects(waitingRead, (e) => e instanceof Error && e.name === "AbortError");
  const keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      router.login({ timeoutMs: 5 }),
      (e) => e instanceof Error && e.name === "TimeoutError",
    );
  } finally {
    clearTimeout(keeper);
    release();
    await original;
  }
  assert.equal(calls, 1);
  assert.equal(router.connected, true);
  await router.logout();
  assert.equal(router.connected, false);
});

test("logout requested during login waits for the owned session then closes it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const methods: string[] = [];
  const router = sdk(
    async (r) => {
      const method = r.actions[0]!.method;
      methods.push(method);
      if (method === "logIn") {
        await gate;
        return new Response(
          JSON.stringify({
            reply: {
              error: { code: 16777216, description: "ok" },
              actions: [
                {
                  id: 0,
                  error: ok,
                  callbacks: [{ result: ok, parameters: { id: 1, nonce: "fixture" } }],
                },
              ],
            },
          }),
        );
      }
      return response(r);
    },
    { auth: credentials },
  );
  const login = router.login(),
    logout = router.logout();
  release();
  await Promise.all([login, logout]);
  assert.deepEqual(methods, ["logIn", "logOut"]);
  assert.equal(router.connected, false);
});

test("a cancelled login cannot install a late session when an injected fetch ignores abort", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = sdk(
    async () => {
      await gate;
      return new Response(
        JSON.stringify({
          reply: {
            error: { code: 16777216, description: "ok" },
            actions: [
              {
                id: 0,
                error: ok,
                callbacks: [{ result: ok, parameters: { id: 1, nonce: "fixture" } }],
              },
            ],
          },
        }),
      );
    },
    { auth: credentials },
  );
  const controller = new AbortController();
  const login = router.login({ signal: controller.signal });
  controller.abort();
  await assert.rejects(login, (e) => e instanceof Error && e.name === "AbortError");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(router.connected, false);
});

test("mixed-success wildcard callbacks contribute capabilities while failure outcomes remain visible", async () => {
  const root = {
    name: "Device",
    type: "xmo:node",
    flags: { node: true },
    attributes: [{ name: "Things", type: "xmo:container", flags: { list: true } }],
  };
  const router = sdk((r) => {
    const actions = r.actions.map((a) => {
      if (a.xpath === "Device/Things/*")
        return {
          id: a.id,
          error: { code: CALLBACK_ERROR, description: "partial" },
          callbacks: [
            {
              result: ok,
              xpath: "Device/Things/Thing[@uid='1']",
              parameters: {
                capability: {
                  name: "Thing",
                  type: "xmo:node",
                  flags: { node: true },
                  attributes: [
                    { name: "Enabled", type: "xmo:boolean xmo:value", flags: { value: true } },
                  ],
                },
                value: {},
              },
            },
            {
              result: { code: 16777245, description: "denied" },
              xpath: "Device/Things/Thing[@uid='2']",
            },
          ],
        };
      return {
        id: a.id,
        error: ok,
        callbacks: [
          {
            result: ok,
            xpath: a.xpath,
            parameters: { capability: a.xpath === "Device" ? root : root.attributes[0], value: {} },
          },
        ],
      };
    });
    return new Response(
      JSON.stringify({
        reply: {
          error: {
            code: actions.some((a) => a.error.code === CALLBACK_ERROR) ? 16777236 : 16777216,
            description: "fixture",
          },
          actions,
        },
      }),
    );
  });
  const discovered = await discoverCapabilities(router);
  assert.ok(discovered.nodes.some((n) => n.path === "Device/Things/Thing/Enabled"));
  assert.ok(discovered.coverage.issues.some((i) => i.code === CALLBACK_ERROR));
  assert.ok(discovered.coverage.issues.some((i) => i.code === 16777245));
});

test("invalid credential-bearing URLs are replaced by value-free errors", async () => {
  const uri = "http://[fixture-secret-token";
  const safe = (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.doesNotMatch(e.message + JSON.stringify(e), /fixture-secret-token/);
    assert.equal(Object.hasOwn(e, "input"), false);
    return true;
  };
  assert.throws(() => new SagemcomXmoClient({ baseUrl: uri, auth: credentials }), safe);
  const router = sdk(
    () =>
      new Response(
        JSON.stringify({
          reply: {
            error: { code: 16777216, description: "ok" },
            actions: [{ id: 0, error: ok, callbacks: [{ result: ok, parameters: { uri } }] }],
          },
        }),
      ),
    { allowMutations: true },
  );
  await assert.rejects(router.download(uri), safe);
  await assert.rejects(
    router.files.getDownloadUri("Device"),
    (e) => e instanceof ProtocolError && safe(e),
  );
});
