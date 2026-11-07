import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ServiceEvent } from "../service-events/events.ts";
import { configurationFingerprint, READINESS_PATH } from "./lifecycle.ts";

const route = "/api/pi-setup-dossier/state";
const serverPath = new URL("./server.ts", import.meta.url).pathname;
let work: string;
let root: string;
let stateFile: string;
let child: ChildProcess;
let origin: string;
let output = "";

function emitted(): ServiceEvent[] {
  return output.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("expected event was not emitted");
}

async function observedRequest(path: string, options: RequestInit = {}): Promise<ServiceEvent> {
  const before = emitted().filter((event) => event.operation === "http.request").length;
  const response = await fetch(`${origin}${path}`, options);
  await response.text();
  await waitFor(() => emitted().filter((event) => event.operation === "http.request").length > before);
  const requests = emitted().filter((event) => event.operation === "http.request").slice(before);
  expect(requests).toHaveLength(1);
  expect(requests[0].context.statusCode).toBe(response.status);
  return requests[0];
}

async function start(args: string[] = []): Promise<void> {
  const port = 18000 + Math.floor(Math.random() * 20000);
  const before = emitted().filter((event) => event.operation === "http.request").length;
  child = spawn("bun", ["run", serverPath, "--directory", root, "--port", String(port), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors += chunk.toString(); });
  origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/`);
      await response.text();
      await waitFor(() => emitted().filter((event) => event.operation === "http.request").length > before);
      return;
    } catch { await Bun.sleep(30); }
  }
  throw new Error(`server did not start: ${errors}`);
}

async function stop(): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function putHeaders(etag: string, extra: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "If-Match": etag,
    "Origin": origin,
    "X-Dossier-Client": "1",
    ...extra,
  };
}

async function getState(): Promise<{ response: Response; etag: string; state: unknown }> {
  const response = await fetch(`${origin}${route}`);
  return { response, etag: response.headers.get("etag") ?? "", state: await response.json() };
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "html-stuff-state-"));
  root = join(work, "html");
  await mkdir(root);
  stateFile = join(work, "nested", "dossier.json");
  await mkdir(join(work, "nested"));
  await writeFile(join(root, "sample.html"), "<!doctype html><title>sample</title>");
  await start(["--state-file", stateFile]);
});

afterAll(async () => {
  if (child?.exitCode === null) await stop();
  await rm(work, { recursive: true, force: true });
});

describe("html stuff dossier state API", () => {
  test("emits one private completion per index, artifact and state operation with probe hints", async () => {
    const startup = emitted().find((event) => event.operation === "service.start");
    expect(startup?.outcome).toBe("succeeded");
    expect(startup?.context.ready).toBe(true);
    const index = await observedRequest("/?token=secret-query", {
      headers: { "user-agent": "Mozilla/5.0 private-browser", authorization: "Bearer secret-auth", "x-request-id": "private-id" },
    });
    expect(index.context.route).toBe("index");
    expect(index.traffic).toBe("browser");
    expect(index.outcome).toBe("succeeded");
    const head = await observedRequest("/sample.html?private-query", { method: "HEAD", headers: { "user-agent": "tailnet-registry/1" } });
    expect(head.context).toEqual({ method: "HEAD", route: "artifact", statusCode: 200 });
    expect(head.traffic).toBe("probe");
    expect((await observedRequest("/", { headers: { "user-agent": "cloudflare-origin-probe/1" } })).traffic).toBe("probe");
    expect((await observedRequest("/", { headers: { "user-agent": "custom-client" } })).traffic).toBe("unknown");
    const missing = await observedRequest("/private-missing.html");
    expect(missing.outcome).toBe("failed");
    expect(missing.context).toMatchObject({ route: "artifact", statusCode: 404, errorCode: "ENOENT" });
    const state = await observedRequest(route);
    expect(state.context.route).toBe("state");
    const rejected = await observedRequest(route, {
      method: "PUT", headers: putHeaders('"missing-v1"'), body: '{"note:private":"secret-state"}',
    });
    expect(rejected.outcome).toBe("failed");
    expect(rejected.context).toMatchObject({ method: "PUT", route: "state", statusCode: 400 });
    for (const event of emitted()) {
      expect(event.service).toBe("html-stuff");
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.timestamp).toMatch(/Z$/);
      expect(event.host.length).toBeGreaterThan(0);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(output).not.toMatch(/secret-query|secret-auth|private-id|private-browser|private-query|private-missing|secret-state|note:private|sample\.html/);
    expect(output).not.toContain(work);
    expect(new Set(emitted().map((event) => event.eventId)).size).toBe(emitted().length);
  });

  test("startup failures emit one sanitized event instead of raw configuration", async () => {
    const failed = Bun.spawn(["bun", "run", serverPath, "--directory", root, "--state-file", "private-relative-state.json"], { stdout: "pipe", stderr: "pipe" });
    expect(await failed.exited).toBe(1);
    const raw = await new Response(failed.stdout).text();
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: "service.start", outcome: "failed", context: { ready: false, errorCode: "UNEXPECTED_ERROR" } });
    expect(raw).not.toContain("private-relative-state");
    expect(await new Response(failed.stderr).text()).toBe("");
  });

  test("readiness verifies the live source and a second launcher adopts without replacing it", async () => {
    const response = await fetch(`${origin}${READINESS_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "html-stuff", protocol: 1,
      configuration: configurationFingerprint(root, stateFile), ready: true, reasonCode: "ready" });
    await expect(readFile(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    const port = new URL(origin).port;
    const adopter = spawn("bun", ["run", serverPath, "--directory", root, "--port", port, "--state-file", stateFile], { stdio: ["ignore", "pipe", "pipe"] });
    let adoptedOutput = "";
    adopter.stdout!.on("data", chunk => { adoptedOutput += chunk.toString(); });
    try {
      await waitFor(() => adoptedOutput.includes('"readiness":"adopted"'));
      expect(adopter.exitCode).toBeNull();
      expect(child.exitCode).toBeNull();
      expect((await fetch(`${origin}/sample.html`)).status).toBe(200);
      expect(await readFile(join(root, "sample.html"), "utf8")).toBe("<!doctype html><title>sample</title>");
      expect(adoptedOutput).not.toContain(root);
    } finally {
      adopter.kill("SIGTERM");
      await new Promise<void>(resolve => adopter.once("exit", () => resolve()));
    }
    expect((await fetch(`${origin}/sample.html`)).status).toBe(200);
  });

  test("missing GET is stable and does not create the file; PUT persists across reload", async () => {
    const first = await getState();
    expect(first.response.status).toBe(200);
    expect(first.state).toEqual({ version: 1, revision: 0, fields: {} });
    expect(first.etag).toBe('"missing-v1"');
    await expect(readFile(stateFile)).rejects.toMatchObject({ code: "ENOENT" });

    const next = { version: 1, revision: 1, fields: { "decision:boot": "ready", "test:efi": true } };
    const saved = await fetch(`${origin}${route}`, { method: "PUT", headers: putHeaders(first.etag), body: JSON.stringify(next) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(next);
    await waitFor(() => emitted().some((event) => event.context.route === "state" && event.context.method === "PUT" && event.context.statusCode === 200));
    const written = emitted().find((event) => event.context.route === "state" && event.context.method === "PUT" && event.context.statusCode === 200);
    expect(written?.outcome).toBe("succeeded");
    expect(output).not.toMatch(/decision:boot|test:efi/);
    expect((await readFile(stateFile, "utf8")).toString()).toBe(JSON.stringify(next));
    await stop();
    await start(["--state-file", stateFile]);
    expect((await getState()).state).toEqual(next);
  });

  test("two writes with the same snapshot yield one success and one precondition failure", async () => {
    const current = await getState();
    const a = { version: 1, revision: 2, fields: { "note:one": "a" } };
    const b = { version: 1, revision: 2, fields: { "note:one": "b" } };
    const results = await Promise.all([a, b].map((value) => fetch(`${origin}${route}`, {
      method: "PUT", headers: putHeaders(current.etag), body: JSON.stringify(value),
    })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
  });

  test("rejects origin, missing client header, missing If-Match, malformed and invalid state", async () => {
    const { etag } = await getState();
    const base = { "Content-Type": "application/json", Origin: origin, "X-Dossier-Client": "1", "If-Match": etag };
    expect((await fetch(`${origin}${route}`, { method: "PUT", headers: { ...base, Origin: "https://evil.invalid" }, body: "{}" })).status).toBe(403);
    const noClient = { ...base }; delete (noClient as Record<string, string>)["X-Dossier-Client"];
    expect((await fetch(`${origin}${route}`, { method: "PUT", headers: noClient, body: "{}" })).status).toBe(400);
    const noMatch = { ...base }; delete (noMatch as Record<string, string>)["If-Match"];
    expect((await fetch(`${origin}${route}`, { method: "PUT", headers: noMatch, body: "{}" })).status).toBe(428);
    expect((await fetch(`${origin}${route}`, { method: "PUT", headers: base, body: "{" })).status).toBe(400);
    expect((await fetch(`${origin}${route}`, {
      method: "PUT", headers: base, body: JSON.stringify({ version: 1, revision: 99, fields: {} }),
    })).status).toBe(409);
    for (const value of [
      { version: 2, revision: 1, fields: {} },
      { version: 1, revision: -1, fields: {} },
      { version: 1, revision: 1.5, fields: {} },
      { version: 1, revision: 1, fields: { "bad key": true } },
      { version: 1, revision: 1, fields: { "note:x": 1 } },
    ]) {
      expect((await fetch(`${origin}${route}`, { method: "PUT", headers: base, body: JSON.stringify(value) })).status).toBe(400);
    }
    expect((await getState()).etag).toBe(etag);
  });

  test("rejects wrong content type and oversized body without mutation", async () => {
    const { etag } = await getState();
    const noType = await fetch(`${origin}${route}`, { method: "PUT", headers: putHeaders(etag, { "Content-Type": "text/plain" }), body: "{}" });
    expect(noType.status).toBe(415);
    const tooLarge = await fetch(`${origin}${route}`, {
      method: "PUT", headers: putHeaders(etag), body: JSON.stringify({ version: 1, revision: 2, fields: { "note:x": "x".repeat(2 * 1024 * 1024) } }),
    });
    expect(tooLarge.status).toBe(413);
    expect((await getState()).etag).toBe(etag);
  });

  test("rejects a symlink state path and preserves static HTTP behavior and CSP", async () => {
    const staticResponse = await fetch(`${origin}/sample.html`);
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toContain("sample");
    expect(staticResponse.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect((await fetch(`${origin}/missing.html`)).status).toBe(404);
    await stop();
    const malformed = join(work, "malformed.json");
    await writeFile(malformed, "not json");
    await start(["--state-file", malformed]);
    const unavailable = await observedRequest(route);
    expect(unavailable.context).toMatchObject({ statusCode: 500, reasonCode: "state_unavailable", errorCode: "UNEXPECTED_ERROR" });
    expect(unavailable.outcome).toBe("failed");
    expect(output).not.toContain(malformed);
    expect(await readFile(malformed, "utf8")).toBe("not json");
    const readiness = await fetch(`${origin}${READINESS_PATH}`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({ ready: false, reasonCode: "source_unavailable" });
    expect((await fetch(`${origin}/sample.html`)).status).toBe(200);
    await stop();
    const target = join(work, "target.json");
    await writeFile(target, JSON.stringify({ version: 1, revision: 0, fields: {} }));
    const link = join(work, "link.json");
    await symlink(target, link);
    await start(["--state-file", link]);
    expect((await fetch(`${origin}${route}`)).status).toBe(500);
    expect((await readFile(target, "utf8"))).toContain('"revision":0');
  });

  test("state route is disabled without --state-file", async () => {
    await stop();
    await start();
    expect((await fetch(`${origin}${route}`)).status).toBe(404);
  });
});
