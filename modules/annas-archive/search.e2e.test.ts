import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { card, cards, cookie, key, page } from "./fixtures/index.ts";

/** Only network transport is mapped to loopback. Login, private-file checks, HTML
 * parsing, live preferences, ranking, and rendering run in real CLI processes. */
test("CLI end to end: private credential → login → HTML index → live preferences and output", async () => {
  const root = mkdtempSync(join(tmpdir(), "anna-search-e2e-"));
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.test");
    requests.push(url.pathname);
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(req.headers.authorization, undefined);
    if (url.pathname === "/account/") {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.cookie, undefined);
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.equal(new URLSearchParams(body).get("key"), key);
      res.writeHead(302, { "Set-Cookie": `aa_account_id2=${cookie}; Secure; HttpOnly`, Location: "/account/" });
      res.end(); return;
    }
    assert.equal(url.pathname, "/search");
    assert.equal(req.headers.cookie, `aa_account_id2=${cookie}`);
    const q = url.searchParams.get("q") ?? "";
    res.setHeader("Content-Type", "text/html");
    if (q === "challenge") { res.writeHead(403); res.end(`<title>DDoS-Guard</title>${key}`); return; }
    if (q === "malformed") { res.end(`<h1>REMOTE-PRIVATE ${cookie}</h1>`); return; }
    if (q === "empty") { res.end(page("", q)); return; }
    if (q === "reflect-key" || q === "reflect-cookie") { res.end(page(card(1, q === "reflect-key" ? key : cookie), q)); return; }
    res.end(page(cards, q));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const preferences = join(root, "preferences.conf");
    writeFileSync(preferences, "language: en, pt-BR > pt > *\nformat: pdf, epub > * > mobi\n");
    const hook = join(root, "transport.mjs");
    writeFileSync(hook, `
      const transport = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const original = new URL(String(input));
        if (original.origin !== "https://annas-archive.gl") throw new Error("unexpected external request");
        const url = new URL(original);
        url.protocol = "http:";
        url.hostname = "127.0.0.1";
        url.port = ${JSON.stringify(String(address.port))};
        const response = await transport(url, init);
        Object.defineProperty(response, "url", { value: original.href });
        return response;
      };
    `);
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = (args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, ANNAS_ARCHIVE_ENABLED: "1", ANNAS_ARCHIVE_KEY_FILE: keyFile, ANNAS_ARCHIVE_PREFERENCES_FILE: preferences, ANNAS_ARCHIVE_BASE_URL: "https://annas-archive.gl", FORCE_COLOR: "0", ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      proc.stdout.on("data", b => { stdout += b; });
      proc.stderr.on("data", b => { stderr += b; });
      const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("CLI fixture timed out")); }, 5000);
      proc.on("error", error => { clearTimeout(timeout); reject(error); });
      proc.on("close", status => {
        clearTimeout(timeout);
        try {
          for (const secret of [key, cookie, encodeURIComponent(key), "REMOTE-PRIVATE"]) {
            assert(!stdout.includes(secret), "stdout leaked private fixture data");
            assert(!stderr.includes(secret), "stderr leaked private fixture data");
          }
          resolve({ status, stdout, stderr });
        } catch (error) { reject(error); }
      });
    });
    const first = await child(["search", "design", "--pages", "1"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Anna’s Archive index — file MD5s/);
    assert.match(first.stdout, /1\. Preferred PDF/);
    assert.match(first.stdout, /2\. Preferred EPUB/);
    assert.match(first.stdout, /\[secondary\] Secondary Portuguese/);
    assert(!first.stdout.includes("Last resort MOBI"));
    assert(!first.stdout.includes("\x1b"));
    assert.deepEqual(requests, ["/account/", "/search"]);

    const colored = await child(["search", "design", "--pages", "1"], { FORCE_COLOR: "1", NO_COLOR: undefined });
    assert.equal(colored.status, 0, colored.stderr);
    assert.match(colored.stdout, /\x1b\[2m[\s\S]*\[secondary\]/);
    const noColor = await child(["search", "design", "--pages", "1"], { FORCE_COLOR: "1", NO_COLOR: "1" });
    assert.equal(noColor.status, 0, noColor.stderr);
    assert(!noColor.stdout.includes("\x1b"));

    writeFileSync(preferences, "language: en > pt > *\nformat: mobi > * > pdf, epub\n");
    const edited = await child(["search", "design", "--pages", "1", "--json"]);
    assert.equal(edited.status, 0, edited.stderr);
    assert.equal(JSON.parse(edited.stdout).results[0].title, "Last resort MOBI");
    const overridden = await child(["search", "design", "--pages", "1", "--format", "pdf, epub > * > mobi", "--all", "--json"]);
    assert.equal(overridden.status, 0, overridden.stderr);
    const result = JSON.parse(overridden.stdout);
    assert.equal(result.source, "annas-archive");
    assert.equal(result.results[0].title, "Preferred PDF");
    assert.equal(result.results.find((b: { title: string }) => b.title === "Last resort MOBI").display, "hidden");
    assert(result.results.every((b: { md5: string }) => /^[a-f0-9]{32}$/.test(b.md5)));
    const limited = await child(["search", "design", "--pages", "1", "--limit", "1", "--json"]);
    assert.equal(limited.status, 0, limited.stderr);
    assert.equal(JSON.parse(limited.stdout).results.length, 1);
    assert(JSON.parse(limited.stdout).omitted > 0);
    const empty = await child(["search", "empty", "--pages", "1"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /no primary index matches/);

    for (const query of ["challenge", "malformed", "reflect-key", "reflect-cookie"]) {
      const before = requests.length;
      const failed = await child(["search", query, "--pages", "1"]);
      assert.equal(failed.status, 1);
      assert.equal(failed.stdout, "");
      assert.match(failed.stderr, /anna:/);
      assert.equal(requests.length - before, 2, "failed search retried");
    }
    const before = requests.length;
    const disabled = await child(["search", "design"], { ANNAS_ARCHIVE_ENABLED: "0" });
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, /integration disabled/);
    chmodSync(keyFile, 0o644);
    const unsafe = await child(["search", "design"]);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /credential is missing or unsafe/);
    assert.equal(requests.length, before);
    assert(requests.every(path => path === "/account/" || path === "/search"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
