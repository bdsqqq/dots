import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const route = "/api/pi-setup-dossier/state";
const serverPath = new URL("./server.ts", import.meta.url).pathname;
let work: string;
let root: string;
let stateFile: string;
let child: ChildProcess;
let origin: string;

async function start(args: string[] = []): Promise<void> {
  const port = 18000 + Math.floor(Math.random() * 20000);
  child = spawn("bun", ["run", serverPath, "--directory", root, "--port", String(port), ...args], {
    stdio: "ignore",
  });
  origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(`${origin}/`); return; } catch { await Bun.sleep(30); }
  }
  throw new Error("server did not start");
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
    expect((await fetch(`${origin}${route}`)).status).toBe(500);
    expect(await readFile(malformed, "utf8")).toBe("not json");
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
