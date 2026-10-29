import assert from "node:assert/strict";
import test from "node:test";
import { createSearchSession, SessionError } from "./session.ts";

const ORIGIN = "https://annas-archive.gl";
const KEY = "fixture-account-key+&=private";
const COOKIE = "fixture-session-private";

type Call = { url: URL; init: RequestInit };
function fake(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init: init! });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert(response, "unexpected fetch: retries are forbidden");
    return response;
  };
  return { calls, fetcher };
}
function login(status = 302, cookies = [`aa_account_id2=${COOKIE}; Path=/; HttpOnly; Secure`], location?: string) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  if (location !== undefined) headers.set("location", location);
  return new Response("unused login body", { status, headers });
}
function html(status = 200, type = "text/html; charset=utf-8") {
  return new Response("<html>fixture results</html>", { status, headers: { "content-type": type } });
}
async function sanitized(action: () => Promise<unknown>, status?: number) {
  await assert.rejects(action, error => {
    assert(error instanceof SessionError);
    for (const secret of [KEY, COOKIE, "server-diagnostics", "foreign-private"]) {
      assert(!String(error).includes(secret));
      assert(!error.stack?.includes(secret));
    }
    assert.equal(error.cause, undefined);
    if (status !== undefined) assert(error.message.includes(`HTTP ${status}`));
    return true;
  });
}

test("login exchanges a form body once, cancels it, and searches with only Anna cookies", async () => {
  const authentication = login(302, [
    `aa_account_id2=${COOKIE}; Path=/; HttpOnly; Secure`,
    "aa_other=allowed; Expires=Wed, 09 Jun 2030 10:18:14 GMT; Path=/",
    "unrelated=not-forwarded; Path=/",
  ], "/account/");
  const results = html();
  const { fetcher, calls } = fake([authentication, results]);
  const session = await createSearchSession(ORIGIN, KEY, fetcher);
  assert(authentication.bodyUsed);
  assert.deepEqual(Object.keys(session).sort(), ["assertPublic", "page"]);
  assert.equal(JSON.stringify(session), "{}");
  const first = calls[0]!;
  assert.equal(first.url.href, `${ORIGIN}/account/`);
  assert(!first.url.href.includes(KEY));
  assert.equal(first.init.method, "POST");
  assert.equal(first.init.redirect, "manual");
  assert(first.init.body instanceof URLSearchParams);
  assert.deepEqual([...first.init.body], [["key", KEY]]);
  const headers = new Headers(first.init.headers);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("accept"), "text/html");
  assert.equal(headers.get("user-agent"), "anna/1.0 (+https://github.com/bdsqqq/dots)");
  assert.equal(headers.get("cookie"), null);
  assert(first.init.signal instanceof AbortSignal);
  assert.equal(first.init.signal.aborted, false);

  assert.equal(await session.page("spaces & 日本語 /?x=1", 5), results);
  assert.equal(results.bodyUsed, false, "caller owns the successful response body");
  assert.equal(await results.text(), "<html>fixture results</html>");
  assert.equal(calls.length, 2);
  const second = calls[1]!;
  assert.equal(second.url.origin, ORIGIN);
  assert.equal(second.url.pathname, "/search");
  assert.deepEqual([...second.url.searchParams], [["q", "spaces & 日本語 /?x=1"], ["page", "5"]]);
  assert(!second.url.href.includes(KEY));
  assert(!second.url.href.includes(COOKIE));
  assert.equal(second.init.method, "GET");
  assert.equal(second.init.redirect, "error");
  const searchHeaders = new Headers(second.init.headers);
  assert.equal(searchHeaders.get("cookie"), `aa_account_id2=${COOKIE}; aa_other=allowed`);
  assert.equal(searchHeaders.get("accept"), "text/html");
  assert.equal(searchHeaders.get("user-agent"), headers.get("user-agent"));
  assert(second.init.signal instanceof AbortSignal);
});

test("public-result guard rejects raw, JSON-escaped, and percent-encoded private values", async () => {
  const specialKey = 'private-key-with-a-"quote';
  const { fetcher } = fake([login()]);
  const session = await createSearchSession(ORIGIN, specialKey, fetcher);
  for (const value of [specialKey, COOKIE, JSON.stringify({ title: specialKey }), encodeURIComponent(specialKey), [...COOKIE].map(c => "%" + c.charCodeAt(0).toString(16)).join("")]) {
    assert.throws(() => session.assertPublic(value), error => {
      assert(error instanceof SessionError);
      assert.equal(error.message, "Private data in search results");
      return true;
    });
  }
  assert.doesNotThrow(() => session.assertPublic("a 100% public title"));
});

test("all accepted login statuses require the session cookie; same-origin redirects are not followed", async () => {
  for (const status of [200, 302, 303]) {
    for (const location of [undefined, "/account/", `${ORIGIN}/account/`, "?ok=1"]) {
      const { fetcher, calls } = fake([login(status, undefined, location)]);
      await createSearchSession(ORIGIN + "/", KEY, fetcher);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.init.redirect, "manual");
    }
  }
});

test("unsafe origins and account keys fail before any request", async () => {
  const { fetcher, calls } = fake([]);
  for (const origin of [
    "http://annas-archive.gl", "https://user:password@annas-archive.gl",
    "https://@annas-archive.gl", "https://:@annas-archive.gl",
    "https://annas-archive.gl/path", `${ORIGIN}?`, `${ORIGIN}#`,
    `${ORIGIN}?key=${KEY}`, "https://annas-archive.gl/../", "not a URL",
    ` ${ORIGIN}`, `${ORIGIN}\n`, "https://annas-archive.gl\\@evil.test",
  ]) await sanitized(() => createSearchSession(origin, KEY, fetcher));
  for (const key of ["", " ", "with space", "with\ttab", "with\nnewline", "with\rreturn", "nul\0", "del\x7f", "c1\x85", "x".repeat(4097)]) {
    await sanitized(() => createSearchSession(ORIGIN, key, fetcher));
  }
  assert.equal(calls.length, 0);
});

test("a 4096-character account key is supported", async () => {
  const { fetcher } = fake([login()]);
  await createSearchSession(ORIGIN, "x".repeat(4096), fetcher);
});

test("foreign and non-HTTPS login redirects are rejected without following or leaking Location", async () => {
  for (const location of [
    "https://foreign-private.test/account", "//foreign-private.test/account",
    "http://annas-archive.gl/account/", "https://annas-archive.gl.foreign-private.test/",
    "javascript:foreign-private", "https://[invalid", "https://annas-archive.gl:444/",
  ]) {
    const response = login(302, undefined, location);
    const { fetcher, calls } = fake([response]);
    await sanitized(() => createSearchSession(ORIGIN, KEY, fetcher));
    assert.equal(calls.length, 1);
    assert(response.bodyUsed);
  }
});

test("unsupported login statuses are rejected, cancelled, and never retried", async () => {
  for (const status of [201, 301, 307, 308, 400, 401, 403, 429, 500]) {
    const response = login(status);
    const { fetcher, calls } = fake([response]);
    await sanitized(() => createSearchSession(ORIGIN, KEY, fetcher), status);
    assert.equal(calls.length, 1);
    assert(response.bodyUsed);
  }
});

test("missing, empty, malformed, duplicate, and oversized cookies are rejected", async () => {
  const invalid = [
    [], ["unrelated=value"], ["aa_other=value"], ["aa_account_id2="],
    ["aa_account_id2=has space"], ['aa_account_id2="quoted"'],
    ["aa_account_id2=comma,merged"], ["aa_account_id2=back\\slash"],
    ["aa_account_id2"], ["bad name=value", `aa_account_id2=${COOKIE}`],
    [`aa_account_id2=${COOKIE}`, "aa_account_id2=duplicate"],
    [`aa_account_id2=${COOKIE}`, "aa_other="],
    ["aa_account_id2=" + "x".repeat(4096)],
    [`aa_account_id2=${COOKIE}`, ...Array.from({ length: 32 }, (_, i) => `other${i}=value`)],
    [`aa_account_id2=${COOKIE}`, ...Array.from({ length: 5 }, (_, i) => `other${i}=${"x".repeat(4000)}`)],
    ["aa_account_id2=bad\tvalue"], ["aa_account_id2=bad\x7fvalue"],
  ];
  for (const cookies of invalid) {
    const response = login(200, cookies);
    const { fetcher, calls } = fake([response]);
    await sanitized(() => createSearchSession(ORIGIN, KEY, fetcher));
    assert.equal(calls.length, 1);
    assert(response.bodyUsed);
  }
});

test("raw cookie control characters are rejected even from a custom response", async () => {
  for (const unsafe of ["aa_account_id2=bad\r\nInjected: value", "aa_account_id2=bad\0value"]) {
    const response = login();
    response.headers.getSetCookie = () => [unsafe];
    const { fetcher } = fake([response]);
    await sanitized(() => createSearchSession(ORIGIN, KEY, fetcher));
    assert(response.bodyUsed);
  }
});

test("search pages are restricted to integers 1 through 5 without issuing invalid requests", async () => {
  const { fetcher, calls } = fake([login(), ...Array.from({ length: 5 }, () => html())]);
  const session = await createSearchSession(ORIGIN, KEY, fetcher);
  for (const page of [0, -1, 6, 1.5, NaN, Infinity]) await sanitized(() => session.page("query", page));
  assert.equal(calls.length, 1);
  for (const page of [1, 2, 3, 4, 5]) await (await session.page("query", page)).body?.cancel();
  assert.equal(calls.length, 6);
});

test("challenge, redirect, and non-HTML search responses are cancelled without retries", async () => {
  for (const [status, type] of [[403, "text/html"], [302, "text/html"], [200, "application/json"], [200, ""], [500, "text/html"]] as const) {
    const response = html(status, type);
    response.headers.set("location", "https://foreign-private.test/");
    const { fetcher, calls } = fake([login(), response]);
    const session = await createSearchSession(ORIGIN, KEY, fetcher);
    await sanitized(() => session.page("query", 1), status);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init.redirect, "error");
    assert(response.bodyUsed);
  }
});

test("already-followed login and search responses are rejected", async () => {
  const response = login();
  Object.defineProperty(response, "redirected", { value: true });
  const first = fake([response]);
  await sanitized(() => createSearchSession(ORIGIN, KEY, first.fetcher));
  assert(response.bodyUsed);
  const redirected = html();
  Object.defineProperty(redirected, "redirected", { value: true });
  const second = fake([login(), redirected]);
  const session = await createSearchSession(ORIGIN, KEY, second.fetcher);
  await sanitized(() => session.page("query", 1));
  assert(redirected.bodyUsed);
});

test("foreign response URLs are rejected even when redirected is false", async () => {
  const firstResponse = login();
  Object.defineProperty(firstResponse, "url", { value: "https://foreign-private.test/" });
  const first = fake([firstResponse]);
  await sanitized(() => createSearchSession(ORIGIN, KEY, first.fetcher));
  assert(firstResponse.bodyUsed);
  const secondResponse = html();
  Object.defineProperty(secondResponse, "url", { value: "https://foreign-private.test/" });
  const second = fake([login(), secondResponse]);
  const session = await createSearchSession(ORIGIN, KEY, second.fetcher);
  await sanitized(() => session.page("query", 1));
  assert(secondResponse.bodyUsed);
});

test("body cancellation errors cannot leak server diagnostics", async () => {
  const response = new Response(new ReadableStream({
    cancel() { throw new Error(`${KEY} ${COOKIE} server-diagnostics`); },
  }), { status: 403 });
  const { fetcher } = fake([response]);
  await sanitized(() => createSearchSession(ORIGIN, KEY, fetcher), 403);
});

test("network and redirect errors are redacted at both request boundaries without retries", async () => {
  const message = `${KEY} ${COOKIE} foreign-private server-diagnostics`;
  for (const error of [new Error(message), new SessionError(message), new DOMException(message, "TimeoutError")]) {
    const first = fake([error]);
    await sanitized(() => createSearchSession(ORIGIN, KEY, first.fetcher));
    assert.equal(first.calls.length, 1);
    const second = fake([login(), error]);
    const session = await createSearchSession(ORIGIN, KEY, second.fetcher);
    await sanitized(() => session.page("query", 1));
    assert.equal(second.calls.length, 2);
  }
});
