// Opt in explicitly: this test builds the actual Nix launcher and Backrest.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { constants, accessSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

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

test("activation replaces config; daemon restarts preserve UI edits and data", {
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
  for (const directory of ["home", "tmp", "cache", "data", "source", "bin"]) mkdirSync(join(root, directory));
  const controller = fileURLToPath(new URL("./activation-service-fixture.ts", import.meta.url));
  for (const command of ["launchctl", "systemctl"]) {
    writeFileSync(join(root, "bin", command),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(controller)} "$@"\n`, { mode: 0o700 });
  }
  writeFileSync(join(root, "bin", "sw_vers"),
    '#!/bin/sh\nprintf "%s\\n" "${BACKUP_FIXTURE_MACOS_VERSION:-27.0}"\n', { mode: 0o700 });
  const nixBin = dirname(realpathSync(execFileSync("/bin/sh", ["-c", "command -v nix-env"], { encoding: "utf8" }).trim()));
  const env = {
    PATH: `${join(root, "bin")}:/usr/bin:/bin:${nixBin}`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    BACKUP_FIXTURE_ROOT: root,
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
  // Build an isolated Home Manager activation artifact, never a host activation.
  const buildFixture = (probeSystemd = false, omitActivationTools = false) => execFileSync("nix", [
    "build", "--no-link", "--no-write-lock-file", "--impure", "--print-out-paths",
    "--file", fixture, "--argstr", "root", root, "--argstr", "guid", guid,
    "--arg", "port", String(port),
    "--arg", "probeSystemd", String(probeSystemd),
    "--arg", "omitActivationTools", String(omitActivationTools),
  ], { encoding: "utf8", timeout: 210_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const output = buildFixture();
  assert.match(output, /^\/nix\/store\/[^\s]+$/);
  const launcher = join(output, "bin", "backup-health-server");
  const activation = join(output, "bin", "backup-fixture-activation");
  const activate = (extraEnv: Record<string, string> = {}, command = activation) =>
    execute(command, [], { cwd: root, env: { ...env, ...extraEnv }, timeout: 30_000 });
  t.diagnostic(`tested launcher: ${launcher}; fixture root: ${root}`);
  const configPath = join(root, "config", "config.json");
  const sentinel = join(root, "data", "fixture-sentinel");
  writeFileSync(sentinel, "preserve operation data\n");

  async function startup(round: number, onReady?: (config: Record<string, unknown>) => Promise<void>): Promise<Record<string, unknown>> {
    const logPath = join(root, `startup-${round}.log`);
    const log = openSync(logPath, "w", 0o600);
    rmSync(join(root, "unloaded"), { force: true });
    const server = spawn(launcher, [], { cwd: root, env, stdio: ["ignore", log, log] });
    assert.ok(server.pid);
    writeFileSync(join(root, "service.pid"), String(server.pid));
    closeSync(log);
    let spawnError: Error | undefined;
    server.on("error", error => { spawnError = error; });
    const exited = new Promise<void>(resolve => server.once("close", () => resolve()));
    try {
      const deadline = Date.now() + 20_000;
      let config: Record<string, unknown>;
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
          config = json(await response.text());
          break;
        } catch (error) {
          if (spawnError || server.exitCode !== null || server.signalCode !== null || Date.now() > deadline) throw error;
          await delay(100);
        }
      }
      await onReady?.(config);
      return config;
    } catch (error) {
      t.diagnostic(readFileSync(logPath, "utf8"));
      throw error;
    } finally {
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }

  function verify(config: Record<string, unknown>, edited = false): void {
    const plans = objects(config.plans);
    assert.deepEqual(plans.map(plan => plan.id), edited ? ["fixture", "ui-only"] : ["fixture"]);
    assert.deepEqual(plans[0].paths, [join(root, edited ? "ui-edited-path" : "source")]);
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

  if (process.platform === "darwin") {
    const missingTools = buildFixture(false, true);
    await assert.rejects(activate({}, join(missingTools, "bin", "backup-fixture-activation")),
      "the consumer-path probe must detect missing activation dependencies");
    assert.equal(existsSync(configPath), false);
  }
  await activate({ DRY_RUN: "1" });
  assert.equal(existsSync(configPath), false, "dry-run must not create configuration");
  await activate();
  verify(json(readFileSync(configPath, "utf8")));
  await startup(1, async config => {
    verify(config);
    const plans = objects(config.plans);
    plans[0].paths = [join(root, "ui-edited-path")];
    config.plans = [...plans, { ...plans[0], id: "ui-only" }];
    config.instance = "ui-edited-instance";
    const response = await fetch(`http://127.0.0.1:${port}/v1.Backrest/SetConfig`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config), signal: AbortSignal.timeout(5_000),
    });
    assert.ok(response.ok, `SetConfig: ${response.status}; ${await response.text()}`);
  });
  const editedText = readFileSync(configPath, "utf8");
  verify(json(editedText), true);
  function assertReplacement(descriptor: number): void {
    assert.notEqual(statSync(configPath).ino, fstatSync(descriptor).ino);
    assert.equal(readFileSync(descriptor, "utf8"), editedText);
  }
  // An open old inode must retain its complete bytes after activation. This catches
  // in-place truncation; checking only the final JSON would miss that regression.
  const oldConfig = openSync(configPath, "r");
  try {
    const loaded = await startup(2, async config => {
      verify(config, true);
      assert.equal(config.instance, "ui-edited-instance");
      await activate({ DRY_RUN: "1" });
      assert.equal(readFileSync(configPath, "utf8"), editedText);
      await assert.rejects(activate({ BACKUP_FIXTURE_FAIL_STOP: "1" }));
      assert.equal(readFileSync(configPath, "utf8"), editedText, "failed shutdown must not replace policy");
      await activate();
    });
    verify(loaded, true);
    verify(json(readFileSync(configPath, "utf8")));
    assertReplacement(oldConfig);
  } finally {
    closeSync(oldConfig);
  }
  // Prove the same assertion detects an in-place overwrite. Only this isolated
  // activation is modified; all paths and credentials still belong to the fixture.
  const script = readFileSync(activation, "utf8");
  const faultyScript = script
    .replace(/^\s*install -m 0600 (.+) "\$temporary"$/m, `cp $1 ${JSON.stringify(configPath)}`)
    .replace(/^\s*mv -f "\$temporary" .+$/m, "");
  assert.notEqual(faultyScript, script, "fault injection must match the built activation");
  const faultyActivation = join(root, "in-place-activation");
  writeFileSync(faultyActivation, faultyScript, { mode: 0o700 });
  writeFileSync(configPath, editedText);
  const inPlaceConfig = openSync(configPath, "r");
  try {
    await activate({}, faultyActivation);
    assert.throws(() => assertReplacement(inPlaceConfig), assert.AssertionError);
  } finally {
    closeSync(inPlaceConfig);
  }
  verify(await startup(3));
  assert.equal(json(readFileSync(configPath, "utf8")).instance, "launcher-fixture");
  const events = readFileSync(join(root, "service-events.jsonl"), "utf8").trim().split("\n").map(json);
  assert.equal(events.length, 2, "dry-run must not stop the daemon");
  for (const event of events) assert.equal(event.config, editedText, "stop must precede policy replacement");
  if (process.platform === "darwin") {
    writeFileSync(configPath, editedText);
    await startup(4, async config => {
      verify(config, true);
      await activate({ BACKUP_FIXTURE_MACOS_VERSION: "25.0" });
    });
    verify(json(readFileSync(configPath, "utf8")));
  }
  const systemdOutput = buildFixture(true);
  const systemdActivation = join(systemdOutput, "bin", "backup-fixture-activation");
  const systemdStart = join(systemdOutput, "bin", "backup-fixture-start");
  writeFileSync(configPath, editedText);
  await startup(5, async config => {
    verify(config, true);
    await assert.rejects(activate({ BACKUP_FIXTURE_NO_MANAGER: "1" }, systemdActivation));
    assert.equal(readFileSync(configPath, "utf8"), editedText, "unavailable manager must not replace policy");
    await activate({}, systemdActivation);
  });
  verify(json(readFileSync(configPath, "utf8")));
  await activate({ DRY_RUN: "1" }, systemdStart);
  await activate({}, systemdStart);
  const lastEvent = json(readFileSync(join(root, "service-events.jsonl"), "utf8").trim().split("\n").at(-1) ?? "");
  assert.equal(lastEvent.command, "start");
  verify(json(String(lastEvent.config)));
  verify(await startup(6));
  const snapshots: unknown = JSON.parse(restic("snapshots", "--json"));
  assert.deepEqual(snapshots, [], "disabled schedules must not create snapshots");
  passed = true;
});
