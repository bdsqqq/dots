// Opt in explicitly: this test builds the actual Nix launcher and Backrest.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants, accessSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function objects(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return object(value);
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("built Nix launcher replaces config on every startup and preserves data", {
  skip: process.env.RUN_BACKUP_LAUNCHER_TEST !== "1" && "set RUN_BACKUP_LAUNCHER_TEST=1 to build and run the isolated Nix fixture",
  timeout: 300_000,
}, async (t) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "backup-launcher-")));
  let passed = false;
  t.after(() => {
    if (passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`isolated failure artifacts: ${root}`);
  });
  for (const directory of ["home", "tmp", "cache", "data", "source"]) mkdirSync(join(root, directory));
  const env = {
    PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
  };
  const password = join(root, "password");
  writeFileSync(password, "isolated-launcher-fixture-only\n", { mode: 0o600 });
  const resticPackage = execFileSync("nix", [
    "build", "--no-link", "--no-write-lock-file", "--impure", "--print-out-paths",
    "--expr", 'let f = builtins.getFlake ("git+file://" + toString ./.); in (import f.inputs.nixpkgs { system = builtins.currentSystem; }).restic',
  ], { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }).trim();
  const resticBinary = join(resticPackage, "bin", "restic");
  const restic = (...args: string[]) => execFileSync(resticBinary, [
    "--repo", join(root, "repository"), "--password-file", password, ...args,
  ], { cwd: root, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  restic("init");
  const guid = json(restic("cat", "config")).id;
  assert.equal(typeof guid, "string");
  assert.ok(typeof guid === "string" && /^[0-9a-f]{64}$/.test(guid));
  const port = await unusedPort();
  const fixture = fileURLToPath(new URL("./launcher-fixture.nix", import.meta.url));
  // Only the isolated module's package is built; no host or activation target.
  const output = execFileSync("nix", [
    "build", "--no-link", "--no-write-lock-file", "--impure", "--print-out-paths",
    "--file", fixture, "--argstr", "root", root, "--argstr", "guid", guid,
    "--arg", "port", String(port),
  ], { encoding: "utf8", timeout: 210_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.match(output, /^\/nix\/store\/[^\s]+$/);
  const launcher = join(output, "bin", "backup-health-server");
  t.diagnostic(`tested launcher: ${launcher}; fixture root: ${root}`);
  const configPath = join(root, "config", "config.json");
  const sentinel = join(root, "data", "fixture-sentinel");
  writeFileSync(sentinel, "preserve operation data\n");

  async function startup(round: number, command = launcher): Promise<Record<string, unknown>> {
    const logPath = join(root, `startup-${round}.log`);
    const log = openSync(logPath, "w", 0o600);
    const server = spawn(command, [], { cwd: root, env, stdio: ["ignore", log, log] });
    closeSync(log);
    let spawnError: Error | undefined;
    server.on("error", error => { spawnError = error; });
    const exited = new Promise<void>(resolve => server.once("close", () => resolve()));
    try {
      const deadline = Date.now() + 20_000;
      while (true) {
        try {
          if (spawnError || server.exitCode !== null || server.signalCode !== null) {
            throw new Error(`launcher exited: ${spawnError ?? server.exitCode ?? server.signalCode}`);
          }
          const response = await fetch(`http://127.0.0.1:${port}/v1.Backrest/GetConfig`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            signal: AbortSignal.timeout(1_000),
          });
          assert.ok(response.ok, `GetConfig: ${response.status}`);
          return json(await response.text());
        } catch (error) {
          if (spawnError || server.exitCode !== null || server.signalCode !== null || Date.now() > deadline) throw error;
          await delay(100);
        }
      }
    } catch (error) {
      t.diagnostic(readFileSync(logPath, "utf8"));
      throw error;
    } finally {
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }

  function verify(config: Record<string, unknown>): void {
    const plans = objects(config.plans);
    assert.deepEqual(plans.map(plan => plan.id), ["fixture"]);
    assert.deepEqual(plans[0].paths, [join(root, "source")]);
    assert.equal(plans[0].repo, "local");
    assert.equal(object(plans[0].schedule).disabled, true);
    const repos = objects(config.repos);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].id, "local");
    assert.equal(repos[0].uri, join(root, "repository"));
    assert.equal(repos[0].guid, guid);
    assert.equal(object(object(repos[0].checkPolicy).schedule).disabled, true);
    assert.equal(object(object(repos[0].prunePolicy).schedule).disabled, true);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    accessSync(configPath, constants.R_OK | constants.W_OK);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve operation data\n");
    assert.equal(existsSync(join(root, "config", "nix-owned.json")), false);
    assert.equal(existsSync(join(root, "data", "nix-owned.json")), false);
    assert.equal(json(restic("cat", "config")).id, guid);
  }

  verify(await startup(1));
  verify(json(readFileSync(configPath, "utf8")));
  const edited = json(readFileSync(configPath, "utf8"));
  const plans = objects(edited.plans);
  plans[0].paths = [join(root, "ui-edited-path")];
  edited.plans = [...plans, { ...plans[0], id: "ui-only" }];
  edited.instance = "ui-edited-instance";
  const editedText = JSON.stringify(edited);
  writeFileSync(configPath, editedText);
  function assertReplacement(descriptor: number): void {
    assert.notEqual(statSync(configPath).ino, fstatSync(descriptor).ino);
    assert.equal(readFileSync(descriptor, "utf8"), editedText);
  }
  // An open old inode must retain its complete bytes after startup. This catches
  // in-place truncation; checking only the final JSON would miss that regression.
  const oldConfig = openSync(configPath, "r");
  try {
    const loaded = await startup(2);
    verify(loaded);
    assert.equal(loaded.instance, "launcher-fixture");
    verify(json(readFileSync(configPath, "utf8")));
    assertReplacement(oldConfig);
  } finally {
    closeSync(oldConfig);
  }
  // Prove the same assertion detects an in-place overwrite. Only this isolated
  // launcher is modified; all paths and credentials still belong to the fixture.
  const script = readFileSync(launcher, "utf8");
  const faultyScript = script
    .replace(/^install -m 0600 (.+) "\$temporary"$/m, `cp $1 ${JSON.stringify(configPath)}`)
    .replace(/^mv -f "\$temporary" .+$/m, "");
  assert.notEqual(faultyScript, script, "fault injection must match the built launcher");
  const faultyLauncher = join(root, "in-place-launcher");
  writeFileSync(faultyLauncher, faultyScript, { mode: 0o700 });
  writeFileSync(configPath, editedText);
  const inPlaceConfig = openSync(configPath, "r");
  try {
    await startup(3, faultyLauncher);
    assert.throws(() => assertReplacement(inPlaceConfig), assert.AssertionError);
  } finally {
    closeSync(inPlaceConfig);
  }
  const snapshots: unknown = JSON.parse(restic("snapshots", "--json"));
  assert.deepEqual(snapshots, [], "disabled schedules must not create snapshots");
  passed = true;
});
