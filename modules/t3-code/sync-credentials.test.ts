import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv as nodeParseEnv, promisify } from "node:util";
import { mergeEnvironment, secretEnvironment, syncCredentials } from "./sync-credentials.ts";

const parseEnv = (text: string) => ({ ...nodeParseEnv(text) });

test("preserves comments, multiline settings, and native edits while adopting duplicate credentials", () => {
  const original = '# native settings\nT3CODE_LAN=true\nNOTE="hello\nKEY=not-an-assignment\nworld"\nexport KEY=old\nKEY=duplicate\n';
  const next = mergeEnvironment(original, [], { KEY: "new#value" });
  assert.equal(next, '# native settings\nT3CODE_LAN=true\nNOTE="hello\nKEY=not-an-assignment\nworld"\nKEY=\'new#value\'\n');
  assert.deepEqual(parseEnv(next), { T3CODE_LAN: "true", NOTE: "hello\nKEY=not-an-assignment\nworld", KEY: "new#value" });
  assert.equal(mergeEnvironment(next, ["KEY"], { KEY: "new#value" }), next);
});

test("round-trips supported quotes, slashes, whitespace, and newlines; rejects unsafe merges", () => {
  for (const value of ["a'b", 'a"b', 'a\'"b', "a\\nb", " spaced ", "line1\nline2"]) {
    assert.equal(parseEnv(mergeEnvironment("", [], { KEY: value })).KEY, value);
  }
  assert.throws(() => mergeEnvironment("", [], { KEY: "'\"`" }));
  assert.throws(() => mergeEnvironment('NOTE="unfinished\n', [], { KEY: "new" }));
  for (const name of ["PATH", "path", "T3CODE_HOME", "T3_SERVICE_LAUNCHER_CONTEXT", "BAD-NAME"]) {
    assert.throws(() => mergeEnvironment("", [], { [name]: "value" }));
  }
});

test("discovers names and aliases without a consumer inventory; arbitrary file secrets remain available", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-secret-names-"));
  try {
    const token = join(root, "token");
    const binary = join(root, "binary");
    const large = join(root, "large");
    const quoted = join(root, "quoted");
    await writeFile(token, "token-value\n");
    await writeFile(binary, Buffer.from([0xff, 0, 0xfe]));
    await writeFile(large, "x".repeat(4097));
    await writeFile(quoted, "'\"`");
    const { values, fileOnly } = await secretEnvironment({ parallel_api_key: token, "axiom/token": token, "axiom.toml": binary, cookies: large, quoted, path: token });
    assert.equal(values.PARALLEL_API_KEY, "token-value");
    assert.equal(values.parallel_api_key, "token-value");
    assert.equal(values.PARALLEL_API_KEY_FILE, token);
    assert.equal(values.AXIOM_TOKEN, "token-value");
    assert.equal(values.AXIOM_TOML_FILE, binary);
    assert.equal(values.COOKIES_FILE, large);
    assert.equal(values.QUOTED_FILE, quoted);
    assert.ok(!("AXIOM_TOML" in values));
    assert.ok(!("COOKIES" in values));
    assert.ok(!("QUOTED" in values));
    assert.equal(values.SOPS_PATH, "token-value");
    assert.ok(!("PATH" in values));
    assert.deepEqual(fileOnly, ["axiom.toml", "cookies", "quoted"]);
    const collisions: Record<string, string>[] = [{ foo: token, FOO: token }, { "a/b": token, "a.b": token }, { foo: token, foo_file: token }];
    for (const secrets of collisions) {
      await assert.rejects(secretEnvironment(secrets), /collide/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cookie names stay file-only even when their contents are small dotenv-compatible UTF-8", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-cookie-policy-"));
  try {
    const secret = join(root, "secret");
    await writeFile(secret, "small-cookie-fixture\n");
    for (const name of ["cookies", "COOKIE", "media/cookies.txt", "session_cookie"]) {
      const { values, fileOnly } = await secretEnvironment({ [name]: secret });
      assert.deepEqual(fileOnly, [name]);
      assert.ok(Object.keys(values).every((key) => key.endsWith("_FILE")));
      assert.ok(Object.values(values).every((value) => value === secret));
      const canonical = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
      const aliases = [...new Set([canonical, ...(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? [name] : [])])];
      for (const tracked of [false, true]) {
        const home = join(root, `${name.replaceAll("/", "_")}-${tracked}`);
        await mkdir(home);
        await writeFile(join(home, "service.env"), aliases.map((alias) => `${alias}=previous-inline-cookie\n`).join(""));
        if (tracked) await writeFile(join(home, ".managed-service-env.json"), JSON.stringify(aliases));
        for (let i = 0; i < 2; i++) {
          await syncCredentials({ home, secrets: { [name]: secret } });
          const actual = parseEnv(await readFile(join(home, "service.env"), "utf8"));
          assert.deepEqual(actual, { ...values });
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("excludes concurrent writers and recovers after SIGKILL without reclaiming lock files", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-lock-recovery-"));
  const home = join(root, "t3");
  await mkdir(home);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { open } from "node:fs/promises";
    import { spawnSync } from "node:child_process";
    const file = await open(process.argv[1], "a", 0o600);
    const result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
      stdio: ["ignore", "ignore", "ignore", file.fd],
    });
    if (result.error || result.status !== 0) process.exit(1);
    process.stdout.write("locked");
    process.stdin.resume();
  `, join(home, ".credential-sync.flock")], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child.stdout, "data");
    assert.equal(ready.toString(), "locked");
    const secret = join(root, "secret");
    await writeFile(secret, "lock-fixture");
    const config = { home, secrets: { KEY: secret } };
    const original = "T3CODE_LAN=true\n";
    await writeFile(join(home, "service.env"), original);
    await assert.rejects(syncCredentials(config), /lock/);
    assert.equal(await readFile(join(home, "service.env"), "utf8"), original);
    child.kill("SIGKILL");
    await exited;
    // Old directory locks must not poison the replacement's automatic recovery.
    await mkdir(join(home, ".credential-sync.lock"));
    assert.equal((await syncCredentials(config)).changed, true);
    assert.equal((await syncCredentials(config)).changed, false);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./sync-credentials.ts", import.meta.url)), configPath]);
    assert.match(cli.stdout, /restart pending/);
    assert.equal(cli.stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs discovered additions, rotation and retirement; preserves native changes; never restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-credentials-"));
  try {
    const home = join(root, "t3");
    const secret = join(root, "secret");
    const second = join(root, "second");
    await writeFile(secret, "first\n");
    const config = { home, secrets: { KEY: secret } };
    assert.deepEqual(await syncCredentials(config), { changed: true, restartPending: true, fileOnly: [] });
    const envPath = join(home, "service.env");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    await rm(join(home, "service-env-restart-required"));
    assert.deepEqual(await syncCredentials(config), { changed: false, restartPending: false, fileOnly: [] });
    await writeFile(envPath, (await readFile(envPath, "utf8")) + "T3CODE_LAN=true\n# user edit\n");
    await writeFile(secret, "rotated\n");
    await writeFile(second, "second\n");
    await syncCredentials({ home, secrets: { KEY: secret, EXTRA: second } });
    assert.deepEqual(parseEnv(await readFile(envPath, "utf8")), { T3CODE_LAN: "true", KEY: "rotated", KEY_FILE: secret, EXTRA: "second", EXTRA_FILE: second });
    await syncCredentials({ home, secrets: { EXTRA: second } });
    const retired = await readFile(envPath, "utf8");
    assert.deepEqual(parseEnv(retired), { T3CODE_LAN: "true", EXTRA: "second", EXTRA_FILE: second });
    assert.ok(retired.includes("# user edit\n"));
    await writeFile(second, Buffer.from([0xff]));
    await syncCredentials({ home, secrets: { EXTRA: second } });
    assert.deepEqual(parseEnv(await readFile(envPath, "utf8")), { T3CODE_LAN: "true", EXTRA_FILE: second });
    await syncCredentials({ home, secrets: {} });
    assert.deepEqual(parseEnv(await readFile(envPath, "utf8")), { T3CODE_LAN: "true" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual symlink command discovers secrets without printing their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-credential-cli-"));
  try {
    const secret = join(root, "secret");
    const configPath = join(root, "config.json");
    const command = join(root, "t3-sync-credentials");
    await writeFile(secret, "private-fixture-key");
    await writeFile(configPath, JSON.stringify({ home: join(root, "t3"), secrets: { KEY: secret } }));
    await symlink(fileURLToPath(new URL("./sync-credentials.ts", import.meta.url)), command);
    const result = await promisify(execFile)(command, [configPath]);
    assert.match(result.stdout, /restart pending/);
    assert.ok(!result.stdout.includes("private-fixture-key"));
    assert.equal(result.stderr, "");
    await rm(secret);
    await assert.rejects(promisify(execFile)(command, [configPath]), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /credential sync failed/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing secrets fail without replacing live configuration; symlink targets are untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-credentials-"));
  try {
    const secret = join(root, "secret");
    await writeFile(secret, "valid");
    const config = { home: join(root, "t3"), secrets: { KEY: secret } };
    await syncCredentials(config);
    const target = join(config.home, "service.env");
    const original = await readFile(target, "utf8");
    await rm(secret);
    await assert.rejects(syncCredentials(config));
    assert.equal(await readFile(target, "utf8"), original);
    await writeFile(secret, "untouched");
    await rm(target);
    await symlink(secret, target);
    await assert.rejects(syncCredentials(config), /regular, unshared file/);
    assert.equal(await readFile(secret, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});
