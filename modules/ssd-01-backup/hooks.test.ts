import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ABSENT_EXIT, assertPolicy, isAbsentCancellation, parseDrive, runHook, type Adapters } from "./hooks.ts";

const driveContents = readFileSync(new URL("./drive.json", import.meta.url), "utf8");
const drive = parseDrive(JSON.parse(driveContents));
const policyHash = createHash("sha256").update(driveContents).digest("hex");
const canary = readFileSync(new URL("./canary.txt", import.meta.url), "utf8");
const runtime = { restic: "/mock/restic", sftpCommand: "mock-ssh -p 23" };
const absentError = "snapshot start hook: hook command triggered by CONDITION_SNAPSHOT_START: task cancelled: exit status 75";

function fixture() {
  const kinds = new Map<string, ReturnType<Adapters["kind"]>>([
    [drive.volumeRoot, "directory"], ...drive.paths.map(path => [path, "directory"] as const),
    [join(drive.volumeRoot, "igor/photos-library-2"), "directory"], [drive.photoExportDb, "file"],
  ]);
  const contents = new Map<string, string>();
  const notifications: string[] = [];
  const diagnostics: string[] = [];
  const calls: { executable: string; args: string[]; input?: string }[] = [];
  const writes: string[] = [];
  const removals: string[] = [];
  let diskInfo: unknown = { VolumeUUID: drive.volumeUuid, MountPoint: drive.volumeRoot, Mounted: true };
  let restore = "valid";
  let failCommand = "";
  const adapters: Adapters = {
    kind: path => kinds.get(path) ?? null,
    read: path => { const data = contents.get(path); assert.notEqual(data, undefined, `missing mock ${path}`); return data ?? ""; },
    writeCanary(path, data) { writes.push(path); kinds.set(path, "file"); contents.set(path, data); },
    temporaryDirectory: () => "/mock/restore",
    removeDirectory: path => { removals.push(path); },
    command(executable, args, input) {
      calls.push({ executable, args, input });
      if (executable === failCommand) throw new Error("mock command failure");
      if (executable === "/usr/sbin/diskutil") return "mock-plist";
      if (executable === "/usr/bin/plutil") { assert.equal(input, "mock-plist"); return JSON.stringify(diskInfo); }
      if (executable === runtime.restic) {
        if (restore === "failure") throw new Error("mock restic restore failure");
        if (restore !== "missing") {
          const path = join("/mock/restore", drive.canaryPath);
          kinds.set(path, "file"); contents.set(path, restore === "valid" ? canary : "corrupt");
        }
        return "restored";
      }
      throw new Error(`unexpected command ${executable}`);
    },
    notify: result => { notifications.push(result); },
    diagnostic: message => { diagnostics.push(message); },
  };
  const run = (action: string, argument = "", load = () => ({ drive, canary })) =>
    runHook(action, argument, load, runtime, adapters);
  return { kinds, contents, notifications, diagnostics, calls, writes, removals, run,
    disk(info: unknown) { diskInfo = info; }, restore(mode: string) { restore = mode; },
    fail(executable: string) { failCommand = executable; } };
}

test("absent drive cancels quietly, without diskutil, restic, or writes", () => {
  const f = fixture(); f.kinds.delete(drive.volumeRoot);
  assert.equal(f.run("presence"), ABSENT_EXIT);
  assert.equal(f.run("error", absentError), 0);
  assert.deepEqual(f.notifications, []); assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
});

test("absence filter rejects known negative error fixtures", () => {
  assert.equal(isAbsentCancellation(absentError), true);
  for (const error of ["", "exit status 75", "restic backup: exit status 75", absentError.replace("75", "1"),
    absentError.replace("task cancelled", "fatal hook"), absentError.replace("snapshot start", "snapshot end")]) {
    assert.equal(isAbsentCancellation(error), false, error);
  }
});

test("wrong UUID, unmounted path, and mount point mismatch fail before writes or remote access", () => {
  for (const info of [
    { VolumeUUID: "WRONG", MountPoint: drive.volumeRoot, Mounted: true },
    { VolumeUUID: drive.volumeUuid, MountPoint: "/", Mounted: true },
    { VolumeUUID: drive.volumeUuid, MountPoint: drive.volumeRoot, Mounted: false },
    {}, null,
  ]) {
    const f = fixture(); f.disk(info);
    assert.equal(f.run("presence"), 0); assert.equal(f.run("prepare"), 1);
    assert.equal(f.run("error", "snapshot start hook: fatal mount identity failure"), 0);
    assert.deepEqual(f.notifications, ["error"]); assert.deepEqual(f.writes, []);
    assert.ok(f.calls.every(call => call.executable !== runtime.restic));
  }
});

test("missing sources/export database, unsafe symlinks, and diskutil errors fail loudly", () => {
  for (const path of [...drive.paths, drive.photoExportDb, drive.volumeRoot]) {
    const f = fixture(); f.kinds.delete(path);
    assert.equal(f.run("prepare"), 1); assert.deepEqual(f.writes, []);
    assert.ok(f.calls.every(call => call.executable !== runtime.restic));
  }
  for (const path of [drive.volumeRoot, ...drive.paths, drive.photoExportDb, drive.canaryPath]) {
    const f = fixture(); f.kinds.set(path, "symlink");
    assert.equal(f.run("prepare"), 1); assert.deepEqual(f.writes, []);
  }
  const f = fixture(); f.fail("/usr/sbin/diskutil"); assert.equal(f.run("prepare"), 1);
});

test("valid drive prepares canary and verified restore notifies success; matching canary is not rewritten", () => {
  const f = fixture();
  assert.equal(f.run("presence"), 0); assert.equal(f.run("prepare"), 0);
  assert.deepEqual(f.writes, [drive.canaryPath]);
  assert.equal(f.run("prepare"), 0); assert.equal(f.writes.length, 1);
  assert.equal(f.run("verify", "a".repeat(64)), 0);
  assert.deepEqual(f.notifications, ["success"]); assert.deepEqual(f.removals, ["/mock/restore"]);
  const restore = f.calls.find(call => call.executable === runtime.restic);
  assert.deepEqual(restore?.args, ["-r", drive.repository.uri, "-o", "sftp.command=mock-ssh -p 23",
    "restore", "a".repeat(64), "--include", drive.canaryPath, "--target", "/mock/restore"]);
});

test("restore failure, corrupt or missing canary fail and notify once; temporary restore is cleaned", () => {
  for (const mode of ["failure", "corrupt", "missing"]) {
    const f = fixture(); f.restore(mode);
    assert.equal(f.run("verify", "b".repeat(64)), 1);
    assert.deepEqual(f.notifications, ["error"]); assert.deepEqual(f.removals, ["/mock/restore"]);
    assert.equal(f.diagnostics.length, 1);
  }
});

test("actual backup errors and partial backups notify even after the drive disappears", () => {
  for (const error of ["restic backup failed", "partial backup, files not read completely", "restic: exit status 75"]) {
    const f = fixture(); f.kinds.delete(drive.volumeRoot);
    assert.equal(f.run("error", error), 0); assert.deepEqual(f.notifications, ["error"]);
  }
});

test("unchanged/dry-run success does nothing; invalid snapshot fails without restic", () => {
  const f = fixture(); assert.equal(f.run("verify", ""), 0);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.notifications, []);
  assert.equal(f.run("verify", "latest; touch /Volumes/ssd-01/nope"), 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.notifications, ["error"]);
});

test("native JSON parser rejects known bad identity/path fixtures", () => {
  for (const value of [null, {}, { ...drive, volumeUuid: "bad" }, { ...drive, volumeRoot: "/" },
    { ...drive, canaryPath: "/Volumes/ssd-01/../outside" }, { ...drive, canaryPath: "/Volumes/ssd-01/excluded/canary" },
    { ...drive, repository: { ...drive.repository, guid: "bad" } }]) {
    assert.throws(() => parseDrive(value));
  }
});

function moduleContract(module: string, mmn: string, mbp: string): void {
  for (const host of [mmn, mbp]) assert.match(host, /\.\.\/\.\.\/modules\/ssd-01-backup\s/);
  assert.match(module, /imports = \[ \.\.\/backup \]/);
  assert.match(module, /defaultRepository = lib.mkDefault drive.repository.id/);
  assert.match(module, /requirePaths = false/);
  assert.match(module, /maxFrequencyHours = 24;\s+clock = "CLOCK_LAST_RUN_TIME"/);
  assert.match(module, /retention.policyKeepAll = true/); assert.match(module, /skipIfUnchanged = true/);
  assert.match(module, /--one-file-system/);
  assert.match(module, /ON_ERROR_CANCEL[\s\S]*hook "presence"/);
  assert.match(module, /ON_ERROR_FATAL[\s\S]*hook "prepare"/);
  assert.match(module, /CONDITION_SNAPSHOT_WARNING/);
  assert.match(module, /nodejs_24[\s\S]*liveModule.*hooks.ts/);
  assert.match(module, /SSD_BACKUP_POLICY_SHA256=.*builtins.hashString "sha256" \(builtins.readFile \.\/drive.json\)/);
  assert.doesNotMatch(module, /writeShellScript|writeText|runCommand|\/Users\/|launchd|systemd/);
  assert.match(mmn, /my.backup.plans.terraria = \{[\s\S]*maxFrequencyHours = 1/);
  const terraria = mmn.slice(mmn.indexOf("my.backup.plans.terraria = {"), mmn.indexOf("environment.systemPackages"));
  assert.doesNotMatch(terraria, /ssd|hook|requirePaths|repository/);
  assert.doesNotMatch(mmn, /ssdMountGuard|restoreVerification|diskutil|resticPasswordCommand|plans.ssd-01/);
}

test("module and host imports contract; known regression fixtures are rejected", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const module = read("./default.nix"), mmn = read("../../hosts/mmn-m4/default.nix"), mbp = read("../../hosts/mbp-m2/default.nix");
  moduleContract(module, mmn, mbp);
  assert.throws(() => moduleContract(module, mmn, mbp.replace("../../modules/ssd-01-backup", "../../modules/backup")));
  assert.throws(() => moduleContract(module.replace("requirePaths = false", "requirePaths = true"), mmn, mbp));
  assert.throws(() => moduleContract(module.replace("SSD_BACKUP_POLICY_SHA256=", "UNBOUND_POLICY="), mmn, mbp));
  assert.throws(() => moduleContract(module, mmn.replace("my.backup.plans.terraria = {", "my.backup.plans.terraria = { hooks = [ ssdGuard ];"), mbp));
});

test("pinned Backrest cancellation/error/unchanged semantics are source traced", {
  skip: !process.env.BACKREST_SOURCE && "set BACKREST_SOURCE to pinned Backrest 1.13.0 source",
}, () => {
  const source = process.env.BACKREST_SOURCE; assert.ok(source);
  assert.equal(readFileSync(join(source, "COMMIT"), "utf8").trim(), "a389bbc7e2bd344b9cace3a1bb88f73cb224128f");
  const read = (path: string) => readFileSync(join(source, "internal", path), "utf8");
  assert.match(read("orchestrator/tasks/taskbackup.go"), /CONDITION_SNAPSHOT_START,[\s\S]*return notifyError\(fmt.Errorf\("snapshot start hook: %w", err\)\)/);
  assert.match(read("orchestrator/tasks/errors.go"), /CONDITION_ANY_ERROR[\s\S]*runner.ExecuteHooks/);
  assert.match(read("orchestrator/taskrunnerimpl.go"), /errors.As\(err, &cancelErr\)[\s\S]*TaskCancelledError\{\}[\s\S]*cancelErr.Err/);
  assert.match(read("hook/types/command.go"), /return execCmd.Run\(\)/);
  assert.match(read("orchestrator/tasks/taskbackup.go"), /summary.SnapshotId == ""[\s\S]*CONDITION_SNAPSHOT_SKIPPED[\s\S]*CONDITION_SNAPSHOT_SUCCESS/);
});

test("CLI help and empty-snapshot probe are safe without runtime credentials", () => {
  const entry = new URL("./hooks.ts", import.meta.url);
  for (const args of [["--help"], ["verify", ""]]) {
    const result = spawnSync(process.execPath, [entry.pathname, ...args], {
      encoding: "utf8", env: { PATH: "", SSD_BACKUP_POLICY_SHA256: policyHash },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("active-plan fingerprint rejects changed live sources before any native drive action", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ssd-policy-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "hooks.ts");
  copyFileSync(new URL("./hooks.ts", import.meta.url), entry);
  writeFileSync(join(root, "canary.txt"), canary);
  writeFileSync(join(root, "drive.json"), driveContents);
  const alias = join(root, "linked-hooks.ts");
  symlinkSync(entry, alias);
  const invoke = (args: string[], digest: string | undefined, executable = entry) => spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8", env: { PATH: "", ...(digest ? { SSD_BACKUP_POLICY_SHA256: digest } : {}) },
  });
  assert.equal(invoke(["verify", ""], policyHash).status, 0);
  for (const executable of [entry, alias]) {
    const missing = invoke(["presence"], undefined, executable);
    assert.equal(missing.status, 1, "linked entrypoints must execute the guard too");
    assert.match(missing.stderr, /SSD policy differs from the active plan/);
  }

  const changed = driveContents.replaceAll("/Volumes/ssd-01", "/Volumes/__ssd01_isolated_changed_policy");
  assert.doesNotThrow(() => parseDrive(JSON.parse(changed)), "negative fixture must otherwise be valid");
  writeFileSync(join(root, "drive.json"), changed);
  // Verify failures notify intentionally; keep this real CLI fixture to start
  // hooks, and cover end-hook notification with injected adapters below.
  for (const args of [["presence"], ["prepare"]]) {
    const result = invoke(args, policyHash);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SSD policy differs from the active plan/);
    assert.doesNotMatch(result.stderr, /diskutil|restore runtime wiring missing/);
  }
});

test("bootstrap failures notify for verify; error reporting never loads policy", () => {
  for (const load of [
    () => { assertPolicy(driveContents, "0".repeat(64)); return { drive, canary }; },
    () => { JSON.parse("{"); return { drive, canary }; },
    () => { throw new Error("policy file missing"); },
  ]) {
    const verify = fixture();
    assert.equal(verify.run("verify", "a".repeat(64), load), 1);
    assert.deepEqual(verify.notifications, ["error"]);
    assert.deepEqual(verify.calls, []);
    assert.equal(verify.diagnostics.length, 1);

    const error = fixture();
    let loaded = false;
    assert.equal(error.run("error", "policy bootstrap failed", () => { loaded = true; return load(); }), 0);
    assert.equal(loaded, false);
    assert.deepEqual(error.notifications, ["error"]);
    assert.deepEqual(error.calls, []);
  }
});
