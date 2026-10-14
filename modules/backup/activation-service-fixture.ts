// Simulate launchd only for the isolated launcher fixture; never address a host job.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.env.BACKUP_FIXTURE_ROOT;
assert.ok(root && root.includes("/backup-launcher-"));
let [command, ...args] = process.argv.slice(2);
const linux = command === "--user";
if (linux) [command, ...args] = args;
const service = args.at(-1);
const pidPath = join(root, "service.pid");
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : undefined;
if (linux) {
  if (command === "show-environment") process.exit(process.env.BACKUP_FIXTURE_NO_MANAGER === "1" ? 1 : 0);
  if (command === "show") {
    assert.equal(args[0], "backup-health.service");
    console.log(pid === undefined ? "not-found" : "loaded");
    process.exit(0);
  }
  assert.equal(service, "backup-health.service");
} else {
  assert.ok(service === `user/${process.getuid?.()}/org.nix-community.home.backup-fixture`
    || service === `gui/${process.getuid?.()}/org.nix-community.home.backup-fixture`);
}
assert.ok(service);
if (command === "start") {
  appendFileSync(join(root, "service-events.jsonl"), JSON.stringify({
    command, config: readFileSync(join(root, "config", "config.json"), "utf8"),
  }) + "\n");
  process.exit(0);
}
if (command === "print") {
  if (service.startsWith("gui/") || pid === undefined || !alive(pid)
    || existsSync(join(root, "unloaded"))) {
    console.error("Could not find service");
    process.exit(113);
  }
  console.log(`\tpid = ${pid}`);
} else {
  assert.equal(command, linux ? "stop" : "bootout");
  assert.ok(linux ? args.length === 1
    : args.length === 1 || (args.length === 2 && args[0] === "--wait"));
  assert.ok(pid !== undefined && Number.isInteger(pid) && pid > 1);
  appendFileSync(join(root, "service-events.jsonl"), JSON.stringify({
    command, config: readFileSync(join(root, "config", "config.json"), "utf8"),
  }) + "\n");
  if (process.env.BACKUP_FIXTURE_FAIL_STOP === "1") process.exit(1);
  if (alive(pid)) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, "fixture daemon failed to stop");
    await delay(25);
  }
  writeFileSync(join(root, "unloaded"), "");
}
