import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_OK,
  CALLBACK_ERROR,
  REQUEST_ACTION_ERROR,
  REQUEST_OK,
  ProtocolError,
  XmoError,
  TransportError,
  callbackValue,
  callbacks,
  checkReply,
  firstCallback,
  isJson,
  parseReply,
  validateActions,
} from "../src/protocol.ts";
import type { Action, Json, Reply, XmoCallback } from "../src/protocol.ts";

const status = (code: number, description = "synthetic") => ({ code, description });
const callback = (value: Json): XmoCallback => ({
  result: status(ACTION_OK),
  parameters: { value },
});
const reply = (): Reply => ({
  error: status(REQUEST_OK),
  actions: [{ id: 0, error: status(ACTION_OK), callbacks: [callback("ok")] }],
});
const encode = (r: unknown) => JSON.stringify({ reply: r });

test("JSON values and callback values preserve false, zero, empty text and null", () => {
  for (const value of [false, 0, "", null, [], {}, { nested: [false, 0, ""] }] satisfies Json[]) {
    assert.equal(isJson(value), true);
    assert.deepEqual(callbackValue(callback(value)), value);
    assert.doesNotThrow(() =>
      validateActions([{ method: "setValue", xpath: "Device/Test", parameters: { value } }]),
    );
  }
});

test("non-JSON primitives and nested values are rejected", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("x"),
    () => 1,
    { nested: undefined },
    [undefined],
  ]) {
    assert.equal(isJson(value), false);
    assert.throws(
      () =>
        validateActions([
          { method: "setValue", xpath: "Device/Test", parameters: { value } },
        ] as never),
      TypeError,
    );
    assert.throws(
      () => callbackValue({ result: status(ACTION_OK), parameters: { value } } as never),
      ProtocolError,
    );
  }
});

// These values otherwise become strings, empty objects, or null array entries on the wire.
for (const [name, value] of [
  ["Date", new Date(0)],
  ["Map", new Map([["x", 1]])],
  ["Set", new Set([1])],
  ["typed array", new Uint8Array([1])],
  ["sparse array", new Array(1)],
] as const) {
  test(`non-JSON ${name} cannot silently change on serialization`, () => {
    assert.equal(isJson(value), false, `${name} must not be accepted as JSON`);
    assert.throws(
      () =>
        validateActions([
          { method: "setValue", xpath: "Device/Test", parameters: { value } },
        ] as never),
      TypeError,
    );
  });
}

test("cyclic actions reject without entering transport", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  assert.throws(() =>
    validateActions([{ method: "setValue", xpath: "Device/Test", parameters: { value } }] as never),
  );
});

test("action boundary rejects malformed batches and reserved session methods", () => {
  const bad: unknown[] = [
    null,
    {},
    [],
    new Array(91).fill({ method: "getEvents" }),
    [null],
    [{ method: "" }],
    [{ method: "  " }],
    [{ method: 1 }],
    [{ method: "getValue" }],
    [{ method: "getValue", xpath: " " }],
    [{ method: "getValue", xpath: 1 }],
    [{ method: "setValue", xpath: "Device/Test", parameters: {} }],
    [{ method: "getEvents", parameters: [] }],
    [{ method: "getEvents", options: null }],
    [{ method: "getEvents", "event-id": 1 }],
    [{ method: "logIn" }],
    [{ method: "logOut" }],
  ];
  for (const actions of bad) assert.throws(() => validateActions(actions as Action[]), TypeError);
  assert.doesNotThrow(() => validateActions(new Array(90).fill({ method: "getEvents" })));
});

test("callback extraction orders action IDs without losing wildcard callbacks or mutating replies", () => {
  const r: Reply = {
    error: status(REQUEST_OK),
    actions: [
      { id: 1, error: status(ACTION_OK), callbacks: [callback(2)] },
      { id: 0, error: status(ACTION_OK), callbacks: [callback(false), callback(0)] },
    ],
  };
  assert.deepEqual(callbacks(r).map(callbackValue), [false, 0, 2]);
  assert.equal(callbackValue(firstCallback(r)), false);
  assert.deepEqual(
    r.actions.map((a) => a.id),
    [1, 0],
  );
  assert.throws(() => firstCallback({ error: status(REQUEST_OK), actions: [] }), ProtocolError);
  for (const parameters of [undefined, {}, { value: undefined }]) {
    assert.throws(
      () =>
        callbackValue({
          result: status(ACTION_OK),
          ...(parameters === undefined ? {} : { parameters }),
        } as never),
      ProtocolError,
    );
  }
});

test("JSON and multipart XML/HTML body wrappers decode exactly once", () => {
  const r = reply();
  r.actions[0]!.callbacks = [callback('&quot; <tag> & "')];
  const json = encode(r);
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  for (const text of [
    json,
    ` \n${json}\n`,
    `<?xml version="1.0"?><html><head></head><body>${escaped}</body></html>`,
    `<HTML><BODY class="upload">${escaped}</BODY></HTML>`,
  ]) {
    assert.deepEqual(parseReply(text), r);
  }
});

test("non-JSON, malformed envelopes, statuses, actions, callbacks and events reject", () => {
  const bad: unknown[] = [
    null,
    [],
    {},
    { reply: {} },
    { reply: { error: { code: REQUEST_OK } } },
    { reply: { error: status(REQUEST_OK), actions: {} } },
    { reply: { error: status(REQUEST_OK), actions: [{ error: status(ACTION_OK) }] } },
    { reply: { error: status(REQUEST_OK), actions: [{ id: "0", error: status(ACTION_OK) }] } },
    {
      reply: {
        error: status(REQUEST_OK),
        actions: [{ id: 0, error: status(ACTION_OK), callbacks: [{}] }],
      },
    },
    {
      reply: {
        error: status(REQUEST_OK),
        actions: [
          {
            id: 0,
            error: status(ACTION_OK),
            callbacks: [{ result: status(ACTION_OK), parameters: [] }],
          },
        ],
      },
    },
    { reply: { error: status(REQUEST_OK), events: [null] } },
    { reply: { error: status(REQUEST_OK), auth: { token: 1 } } },
  ];
  for (const text of [
    "",
    "not JSON",
    "<html>login required</html>",
    "<body>not JSON</body>",
    ...bad.map((v) => JSON.stringify(v)),
  ]) {
    assert.throws(() => parseReply(text), ProtocolError);
  }
});

test("request, action and callback errors retain the exact partial reply without leaking descriptions", () => {
  for (const layer of ["request", "action", "callback"] as const) {
    const r = reply();
    const failure = status(98765, "password=do-not-leak");
    if (layer === "request") r.error = failure;
    if (layer === "action") r.actions[0]!.error = failure;
    if (layer === "callback") r.actions[0]!.callbacks![0]!.result = failure;
    assert.throws(
      () => checkReply(r, [0]),
      (e: unknown) => {
        assert.ok(e instanceof XmoError);
        assert.equal(e.layer, layer);
        assert.equal(e.code, failure.code);
        assert.equal(e.actionId, layer === "request" ? undefined : 0);
        assert.equal(e.reply, r);
        assert.ok(!e.message.includes("do-not-leak"));
        assert.ok(!JSON.stringify(e).includes("do-not-leak"));
        return true;
      },
    );
  }
});

test("partial batch rejection preserves successes and never presents the batch as atomic", () => {
  const r = reply();
  r.error = status(REQUEST_ACTION_ERROR);
  r.actions.push({ id: 1, error: status(CALLBACK_ERROR), callbacks: [{ result: status(90001) }] });
  assert.throws(
    () => checkReply(r, [0, 1]),
    (e: unknown) => {
      assert.ok(e instanceof XmoError);
      assert.equal(e.layer, "callback");
      assert.equal(e.actionId, 1);
      assert.equal(callbackValue(e.reply.actions[0]!.callbacks![0]!), "ok");
      return true;
    },
  );
  const callbackless = reply();
  callbackless.actions[0]!.error = status(CALLBACK_ERROR);
  assert.throws(() => checkReply(callbackless, [0]), XmoError);
  const aggregate = reply();
  aggregate.error = status(REQUEST_ACTION_ERROR);
  assert.throws(() => checkReply(aggregate, [0]), XmoError);
});

test("missing, duplicate and unexpected action IDs reject even under a success envelope", () => {
  const missing = reply();
  missing.actions = [];
  const duplicate = reply();
  duplicate.actions.push(duplicate.actions[0]!);
  const unexpected = reply();
  unexpected.actions[0]!.id = 19;
  for (const r of [missing, duplicate, unexpected])
    assert.throws(() => checkReply(r, [0]), ProtocolError);
  const incomplete = reply();
  assert.throws(() => checkReply(incomplete, [0, 1]), ProtocolError);
  assert.equal(checkReply(reply(), [0]).actions.length, 1);
});

test("event extension fields survive parsing without treating false/zero values as absent", () => {
  const r = reply();
  r.events = [
    { id: "sub-1", type: "value-change", xpath: "Device/A", parameters: { value: false } },
    { id: 2, type: "periodic", xpath: "Device/B", parameters: { value: 0 }, "event-id": "evt-1" },
    { type: "delete-child", parameters: { uid: "child-1" } },
  ];
  assert.deepEqual(parseReply(encode(r)).events, r.events);
});

test("transport failures distinguish reads from mutations without embedding response contents", () => {
  assert.equal(new TransportError(false, 502).outcome, "not-confirmed");
  const e = new TransportError(true, 503);
  assert.equal(e.outcome, "unknown");
  assert.equal(e.httpStatus, 503);
  assert.match(e.message, /do not blindly retry/);
});
