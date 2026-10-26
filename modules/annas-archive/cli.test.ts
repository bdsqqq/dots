import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configFromEnv, run, type Config } from "./cli.ts";

const md5 = "0123456789abcdef0123456789abcdef";
const downloadUrl = "https://downloads.example.test/file?signature=private-capability";
const secret = "fixture-account-key&not-another=parameter";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "annas-archive-"));
  const apiKeyFile = join(root, "key");
  writeFileSync(apiKeyFile, `${secret}\n`, { mode: 0o400 });
  const cfg: Config = { enabled: true, apiKeyFile, baseUrl: "https://archive.example.test" };
  return { root, cfg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const offline: typeof fetch = async () => { throw new Error("test attempted an unexpected request"); };
const result = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function sanitized(error: unknown): boolean {
  assert(error instanceof Error);
  assert(!error.message.includes(secret));
  assert(!error.message.includes(encodeURIComponent(secret)));
  assert(!error.message.includes("REMOTE-PRIVATE"));
  assert(!error.message.includes(downloadUrl));
  return true;
}

test("help needs no credentials and no network; defaults do not enable requests", async () => {
  const cfg = configFromEnv({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.apiKeyFile, "");
  for (const args of [[], ["help"], ["--help"], ["-h"]]) assert.match(await run(args, cfg, offline), /download allowance/);
  await assert.rejects(run(["doctor"], cfg, offline), /integration disabled/);
  await assert.rejects(run(["resolve", md5], cfg, offline), /integration disabled/);
});

test("doctor is local only; ready makes one request and discards all private response fields", async () => {
  const { cfg, cleanup } = fixture();
  try {
    assert.match(await run(["doctor"], cfg, offline), /remote membership access is unverified/);
    let requests = 0;
    const ready = await run(["ready", md5], cfg, async () => {
      requests++;
      return result({ download_url: downloadUrl, account_fast_download_info: { secret, private: "REMOTE-PRIVATE" } });
    });
    assert.equal(requests, 1);
    assert.match(ready, /response discarded/);
    assert(!ready.includes(downloadUrl));
    assert(!ready.includes(secret));
  } finally { cleanup(); }
});

test("resolve encodes the runtime key, forwards indices, forbids redirects, and limits output", async () => {
  const { cfg, cleanup } = fixture();
  try {
    let requests = 0;
    const output = await run(["resolve", md5.toUpperCase(), "--path-index", "0", "--domain-index", "2"], cfg, async (input, init) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.origin, cfg.baseUrl);
      assert.equal(url.pathname, "/dyn/api/fast_download.json");
      assert.deepEqual([...url.searchParams], [["md5", md5], ["key", secret], ["path_index", "0"], ["domain_index", "2"]]);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert(init?.signal instanceof AbortSignal);
      assert(!init.signal.aborted);
      assert.deepEqual(init.headers, { Accept: "application/json" });
      return result({ download_url: downloadUrl, account_fast_download_info: { secret, private: "REMOTE-PRIVATE" } });
    });
    assert.equal(requests, 1);
    assert.deepEqual(JSON.parse(output), { download_url: downloadUrl });
    assert(!output.includes(secret));
  } finally { cleanup(); }
});

test("unknown arguments and invalid MD5s/indices fail before any request", async () => {
  const { cfg, cleanup } = fixture();
  try {
    for (const args of [
      ["download", md5], ["resolve"], ["resolve", "not-md5"], ["doctor", "extra"],
      ["resolve", md5, "--key", secret], ["resolve", md5, "--base-url", "https://evil.example"],
      ["resolve", md5, "--path-index"], ["resolve", md5, "--path-index", "-1"],
      ["resolve", md5, "--path-index", "1.5"], ["resolve", md5, "--path-index", "01"],
      ["resolve", md5, "--path-index", "9007199254740992"],
      ["resolve", md5, "--domain-index", "0", "--domain-index", "1"],
    ]) await assert.rejects(run(args, cfg, offline), sanitized);
  } finally { cleanup(); }
});

test("key-file mode is enforced and a disabled integration cannot use an existing credential", async () => {
  const { cfg, cleanup } = fixture();
  try {
    await assert.rejects(run(["resolve", md5], { ...cfg, enabled: false }, offline), /integration disabled/);
    for (const path of ["relative-key", "/nix/store/fixture-key", cfg.apiKeyFile + "-missing"]) {
      await assert.rejects(run(["doctor"], { ...cfg, apiKeyFile: path }, offline), /credential is missing or unsafe/);
    }
    chmodSync(cfg.apiKeyFile, 0o644);
    await assert.rejects(run(["doctor"], cfg, offline), /credential is missing or unsafe/);
    chmodSync(cfg.apiKeyFile, 0o600);
    for (const key of [" \n", "key\nwith-newline", "a".repeat(4097)]) {
      writeFileSync(cfg.apiKeyFile, key);
      await assert.rejects(run(["doctor"], cfg, offline), /credential is missing or unsafe/);
    }
  } finally { cleanup(); }
});

test("only an explicitly trusted HTTPS origin can receive the key", async () => {
  const { cfg, cleanup } = fixture();
  try {
    for (const baseUrl of [
      "http://archive.example.test", "not a url", "https://user:pass@archive.example.test",
      "https://archive.example.test/path", "https://archive.example.test?key=bad", "https://archive.example.test#fragment",
    ]) await assert.rejects(run(["resolve", md5], { ...cfg, baseUrl }, offline), /baseUrl must be an HTTPS origin/);
  } finally { cleanup(); }
});

test("HTTP errors, redirects and transport failures cannot expose secret-bearing details or retry", async () => {
  const { cfg, cleanup } = fixture();
  try {
    for (const status of [302, 400, 401, 403, 429, 500]) {
      let requests = 0;
      await assert.rejects(run(["resolve", md5], cfg, async () => {
        requests++;
        return new Response(`REMOTE-PRIVATE ${secret}`, { status, headers: { Location: `https://evil.example/?key=${secret}` } });
      }), error => {
        sanitized(error);
        assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
        return true;
      });
      assert.equal(requests, 1);
    }
    let requests = 0;
    await assert.rejects(run(["resolve", md5], cfg, async () => {
      requests++;
      throw new Error(`REMOTE-PRIVATE https://example.test/?key=${encodeURIComponent(secret)}`);
    }), sanitized);
    assert.equal(requests, 1);
  } finally { cleanup(); }
});

test("malformed, oversized, insecure and key-reflecting successful responses fail closed", async () => {
  const { cfg, cleanup } = fixture();
  try {
    const responses = [
      new Response("not JSON"), new Response(null, { status: 204 }),
      result(null), result({}), result({ download_url: null }), result({ download_url: 123 }),
      result({ download_url: "http://downloads.example.test/file" }),
      result({ download_url: "https://user:password@downloads.example.test/file" }),
      result({ download_url: "https://downloads.example.test/\nfile" }),
      result({ download_url: `https://downloads.example.test/?key=${encodeURIComponent(secret)}` }),
      result({ download_url: `https://downloads.example.test/${[...secret].map(c => "%" + c.charCodeAt(0).toString(16)).join("")}` }),
      result({ download_url: downloadUrl, extra: "x".repeat(64 * 1024) }),
    ];
    for (const response of responses) {
      await assert.rejects(run(["resolve", md5], cfg, async () => response), error => {
        sanitized(error);
        assert.match((error as Error).message, /no safe download URL/);
        return true;
      });
    }
  } finally { cleanup(); }
});

test("real and linked CLI entrypoints expose no private material", () => {
  const { root, cfg, cleanup } = fixture();
  try {
    const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const alias = join(root, "anna.ts");
    symlinkSync(entry, alias);
    const env = { ...process.env, ANNAS_ARCHIVE_ENABLED: "1", ANNAS_ARCHIVE_KEY_FILE: cfg.apiKeyFile, ANNAS_ARCHIVE_BASE_URL: cfg.baseUrl };
    for (const path of [entry, alias]) {
      const doctor = spawnSync(process.execPath, [path, "doctor"], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /remote membership access is unverified/);
      assert(!doctor.stdout.includes(secret));
      const disabled = spawnSync(process.execPath, [path, "resolve", md5], { env: { ...env, ANNAS_ARCHIVE_ENABLED: "0" }, encoding: "utf8", timeout: 5000 });
      assert.equal(disabled.status, 1);
      assert.equal(disabled.stdout, "");
      assert.match(disabled.stderr, /integration disabled/);
      assert(!disabled.stderr.includes(secret));
    }
  } finally { cleanup(); }
});
