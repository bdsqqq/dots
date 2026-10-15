// Exercise generated host plans with isolated Backrest and a local Restic repo.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

type Schedule = { disabled?: boolean; maxFrequencyHours?: number; cron?: string; clock?: string };
type Hook = { conditions: string[]; onError: string; actionCommand: { command: string } };
type Plan = {
  id: string;
  repo: string;
  paths: string[];
  schedule: Schedule;
  retention: { policyKeepAll: boolean };
  hooks: Hook[];
  skipIfUnchanged?: boolean;
  excludes?: string[];
  iexcludes?: string[];
  backup_flags?: string[];
};
type Operation = {
  id: string;
  status: string;
  operationBackup?: unknown;
  unixTimeEndMs?: string | number;
};
type RpcResponses = {
  GetConfig: { plans: Plan[] };
  GetOperations: { operations?: Operation[] };
  Backup: unknown;
};

function pathGuard(paths: readonly string[]): string {
  // This exact allowlist prevents newly added host hooks from being executed by
  // the fixture. Only the generated existence guard is rewritten and exercised.
  for (const path of paths) assert.match(path, /^\/[a-zA-Z0-9/_.-]+$/);
  return `#!/bin/sh\nset -eu\n${paths.map((path) =>
    `if [ ! -e ${path} ]; then\n  printf '%s\\n' 'backup source missing: ${path}' >&2\n  exit 1\nfi\n`,
  ).join("\n")}\n`;
}

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("real Backrest backup, historical restore, and independent guard failures", {
  skip: !["BACKUP_GENERATED", "BACKREST_BIN", "RESTIC_BIN"].some(name => process.env[name])
    && "needs built host config and binaries",
  timeout: 150_000,
}, async (t) => {
  assert.ok(process.env.BACKUP_GENERATED, "BACKUP_GENERATED is required");
  assert.ok(process.env.BACKREST_BIN, "BACKREST_BIN is required");
  assert.ok(process.env.RESTIC_BIN, "RESTIC_BIN is required");
  const generated = JSON.parse(readFileSync(process.env.BACKUP_GENERATED, "utf8")) as { plans: Plan[] };
  const plans = Object.fromEntries(generated.plans.map((plan) => [plan.id, plan]));
  assert.deepEqual(Object.keys(plans).sort(), ["ssd-01", "terraria"]);
  assert.equal(plans.terraria.schedule.maxFrequencyHours, 1);
  assert.deepEqual(plans.terraria.retention, { policyKeepAll: true });
  assert.equal(plans["ssd-01"].schedule.maxFrequencyHours, 24);
  assert.doesNotMatch(JSON.stringify(plans["ssd-01"].paths), /terraria/);
  assert.match(JSON.stringify(plans["ssd-01"].hooks), /backup\/ssd-01/);
  assert.doesNotMatch(JSON.stringify(plans.terraria.hooks), /backup\/ssd-01/);
  assert.equal(plans.terraria.paths.length, 2);
  assert.deepEqual(plans.terraria.hooks, [{
    conditions: ["CONDITION_SNAPSHOT_START"], onError: "ON_ERROR_CANCEL",
    actionCommand: { command: pathGuard(plans.terraria.paths) },
  }]);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "backup-runtime-")));
  // Keep failure artifacts and server output for diagnosis, remove passing runs.
  let passed = false;
  t.after(() => {
    if (passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`isolated failure artifacts: ${root}`);
  });
  for (const directory of ["home", "tmp", "cache"]) mkdirSync(join(root, directory));
  // Do not inherit RESTIC_PASSWORD_COMMAND, credentials, or user config paths.
  const env = {
    PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "home"),
    RESTIC_PASSWORD: "isolated-fixture-only",
  };
  const repository = join(root, "repository");
  const restic = (...args: string[]) => execFileSync(process.env.RESTIC_BIN!, ["-r", repository, ...args], {
    env, cwd: root, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  restic("init");
  const guid = (JSON.parse(restic("cat", "config")) as { id: string }).id;
  const newPaths = [join(root, "Players"), join(root, "Worlds")];
  const guard = structuredClone(plans.terraria.hooks[0]);
  for (let i = 0; i < newPaths.length; i += 1) {
    guard.actionCommand.command = guard.actionCommand.command.replaceAll(plans.terraria.paths[i], newPaths[i]);
  }
  assert.equal(guard.actionCommand.command, pathGuard(newPaths));
  // Construct an allowlisted config: no original repositories, credentials,
  // SSD paths, notifications, remote restore commands, or extra hooks survive.
  const config = {
    version: 6, modno: 1, instance: "isolated", auth: { disabled: true },
    repos: [{
      id: plans.terraria.repo, uri: repository, guid,
      env: ["RESTIC_PASSWORD=isolated-fixture-only"],
      prunePolicy: { schedule: { disabled: true } }, checkPolicy: { schedule: { disabled: true } },
    }],
    plans: generated.plans.map((plan): Plan => ({
      id: plan.id, repo: plans.terraria.repo,
      paths: plan.id === "terraria" ? newPaths : [join(root, "absent-ssd")],
      schedule: { disabled: true }, retention: { policyKeepAll: true },
      skipIfUnchanged: plan.skipIfUnchanged,
      excludes: plan.excludes, iexcludes: [], backup_flags: ["--host isolated"],
      hooks: plan.id === "terraria" ? [guard] : [{
        conditions: ["CONDITION_SNAPSHOT_START"], onError: "ON_ERROR_CANCEL",
        actionCommand: { command: "#!/bin/sh\nexit 1\n" },
      }],
    })),
  };
  // Load a native calendar schedule too. Its fixture guard always cancels,
  // even if the test happens to cross the scheduled local time.
  config.plans.push({
    id: "calendar-fixture", repo: plans.terraria.repo, paths: newPaths,
    schedule: { cron: "0 22 * * *", clock: "CLOCK_LAST_RUN_TIME" },
    retention: { policyKeepAll: true }, iexcludes: [], excludes: [], backup_flags: [],
    hooks: [{ conditions: ["CONDITION_SNAPSHOT_START"], onError: "ON_ERROR_CANCEL",
      actionCommand: { command: "#!/bin/sh\nexit 1\n" } }],
  });
  for (const path of newPaths) mkdirSync(path);
  const player = join(newPaths[0], "fixture.plr");
  const world = join(newPaths[1], "fixture.wld");
  writeFileSync(player, "original player");
  writeFileSync(world, "original world");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}/v1.Backrest/`;
  const logPath = join(root, "server.log");
  const log = openSync(logPath, "w", 0o600);
  const server = spawn(process.env.BACKREST_BIN, [
    "-bind-address", `127.0.0.1:${port}`, "-config-file", configPath,
    "-data-dir", join(root, "data"), "-restic-cmd", process.env.RESTIC_BIN,
  ], { env, cwd: root, stdio: ["ignore", log, log] });
  closeSync(log);
  let spawnError: Error | undefined;
  server.on("error", (error) => { spawnError = error; });
  const exited = new Promise<number | null>((resolve) => server.once("close", resolve));
  const logs = () => readFileSync(logPath, "utf8");
  async function rpc<M extends keyof RpcResponses>(method: M, body: unknown): Promise<RpcResponses[M]> {
    const response = await fetch(base + method, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`RPC ${method} ${response.status}: ${text}`);
    return JSON.parse(text) as RpcResponses[M];
  }
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { await rpc("GetConfig", {}); break; }
      catch (error) {
        if (spawnError || server.exitCode !== null || server.signalCode !== null || Date.now() > deadline) {
          throw new Error(`Backrest did not start: ${spawnError ?? error}\n${logs()}`);
        }
        await delay(100);
      }
    }
    const loaded = await rpc("GetConfig", {});
    assert.deepEqual(loaded.plans.find((plan) => plan.id === "calendar-fixture")!.schedule,
      config.plans.at(-1)!.schedule);
    async function backup(plan: string, expected: readonly string[]): Promise<void> {
      const query = { selector: { planId: plan }, lastN: 100 };
      const previous = new Set(((await rpc("GetOperations", query)).operations ?? []).map((op) => op.id));
      try { await rpc("Backup", { value: plan }); }
      catch (error) {
        // Start-hook cancellation may precede creation of a backup operation.
        if (expected.includes("STATUS_SUCCESS")) throw error;
        assert.match((error as Error).message, /snapshot start hook:/);
        assert.match((error as Error).message, /task cancelled:/);
        return;
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const operations = (await rpc("GetOperations", query)).operations ?? [];
        const completed = operations.filter((op) => !previous.has(op.id) && op.operationBackup && op.unixTimeEndMs);
        if (completed.length) {
          assert.ok(expected.includes(completed[0].status), JSON.stringify(completed[0]));
          return;
        }
        await delay(100);
      }
      assert.fail(`backup timed out:\n${logs()}`);
    }
    const snapshots = (): { id: string }[] => JSON.parse(restic("snapshots", "--json")) as { id: string }[];
    const cancelled = ["STATUS_SYSTEM_CANCELLED", "STATUS_ERROR"];
    await backup("ssd-01", cancelled);
    assert.equal(snapshots().length, 0);
    await backup("terraria", ["STATUS_SUCCESS"]);
    const initial = snapshots();
    assert.equal(initial.length, 1);
    const first = initial[0].id;
    writeFileSync(player, "changed player");
    unlinkSync(world);
    await backup("terraria", ["STATUS_SUCCESS"]);
    assert.equal(snapshots().length, 2);
    const restore = join(root, "restore");
    restic("restore", first, "--target", restore);
    assert.equal(readFileSync(join(restore, player.replace(/^\/+/, "")), "utf8"), "original player");
    assert.equal(readFileSync(join(restore, world.replace(/^\/+/, "")), "utf8"), "original world");
    // Known failure: missing source must not create a successful partial backup.
    rmdirSync(newPaths[1]);
    await backup("terraria", cancelled);
    assert.equal(snapshots().length, 2);
    passed = true;
  } catch (error) {
    t.diagnostic(logs());
    throw error;
  } finally {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
});
