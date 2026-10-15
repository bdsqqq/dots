import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ABSENT_EXIT, READINESS_TIMEOUT_MS, assertPolicy, isAbsentCancellation, nativeCommand, parseDrive, readableFile, readiness, runHook, type Adapters, type CommandOptions } from "./hooks.ts";

const driveContents = readFileSync(new URL("./drive.json", import.meta.url), "utf8");
const drive = parseDrive(JSON.parse(driveContents));
const policyHash = createHash("sha256").update(driveContents).digest("hex");
const canary = readFileSync(new URL("./canary.txt", import.meta.url), "utf8");
const runtime = {
  restic: "/mock/restic", sftpCommand: "mock-ssh -p 23", timeout: "/mock/timeout",
  passwordFile: "/mock/password", sshKeyPath: "/mock/identity", knownHostsPath: "/mock/known_hosts",
};
const absentError = "snapshot start hook: hook command triggered by CONDITION_SNAPSHOT_START: task cancelled: exit status 75";

test("real local repository admits the runtime password file and rejects wrong password/GUID", {
  skip: !process.env.SSD_TEST_RESTIC || !process.env.SSD_TEST_TIMEOUT,
}, () => {
  const restic = process.env.SSD_TEST_RESTIC!;
  const timeout = process.env.SSD_TEST_TIMEOUT!;
  const root = mkdtempSync(join(tmpdir(), "ssd-auth-local-"));
  const previous = process.env;
  try {
    process.env = { PATH: "/usr/bin:/bin", HOME: root, XDG_CACHE_HOME: join(root, "cache") };
    const passwordFile = join(root, "password");
    writeFileSync(passwordFile, "isolated-fixture-only", { mode: 0o600 });
    const uri = join(root, "repository");
    nativeCommand(restic, ["-r", uri, "init"], undefined, { passwordFile, timeoutMs: 15_000 });
    const { id: guid } = JSON.parse(nativeCommand(restic, ["-r", uri, "cat", "config"], undefined, { passwordFile, timeoutMs: 15_000 }));
    const selected = { ...drive, repository: { ...drive.repository, uri, guid } };
    const reject = (): never => { throw new Error("unexpected drive/state operation"); };
    const adapters: Adapters = {
      command: nativeCommand, readableFile, kind: reject, read: reject, writeCanary: reject,
      temporaryDirectory: reject, removeDirectory: reject, notify: reject, diagnostic: reject,
    };
    const configured = { ...runtime, restic, timeout, passwordFile, sshKeyPath: passwordFile, knownHostsPath: passwordFile };
    readiness(selected, configured, adapters);
    assert.throws(() => readiness({ ...selected, repository: { ...selected.repository, guid: "0".repeat(64) } }, configured, adapters), /GUID/);
    writeFileSync(passwordFile, "wrong-isolated-fixture-only");
    assert.throws(() => readiness(selected, configured, adapters), /authentication or repository readiness failed/);
  } finally {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const kinds = new Map<string, ReturnType<Adapters["kind"]>>([
    [drive.volumeRoot, "directory"], ...drive.paths.map(path => [path, "directory"] as const),
    [join(drive.volumeRoot, "igor/photos-library-2"), "directory"], [drive.photoExportDb, "file"],
  ]);
  const contents = new Map<string, string>();
  const notifications: string[] = [];
  const diagnostics: string[] = [];
  const calls: { executable: string; args: string[]; input?: string; options?: CommandOptions }[] = [];
  const readable = new Set([runtime.passwordFile, runtime.sshKeyPath, runtime.knownHostsPath]);
  const credentialChecks: string[] = [];
  const writes: string[] = [];
  const removals: string[] = [];
  let diskInfo: unknown = { VolumeUUID: drive.volumeUuid, MountPoint: drive.volumeRoot, Mounted: true };
  let restore = "valid";
  let failCommand = "";
  let repo: unknown = { id: drive.repository.guid };
  let repoOutput: string | undefined;
  let authFailure = "";
  const adapters: Adapters = {
    readableFile(path) { credentialChecks.push(path); return readable.has(path); },
    kind: path => kinds.get(path) ?? null,
    read: path => { const data = contents.get(path); assert.notEqual(data, undefined, `missing mock ${path}`); return data ?? ""; },
    writeCanary(path, data) { writes.push(path); kinds.set(path, "file"); contents.set(path, data); },
    temporaryDirectory: () => "/mock/restore",
    removeDirectory: path => { removals.push(path); },
    command(executable, args, input, options) {
      calls.push({ executable, args, input, options });
      if (executable === failCommand) throw new Error("mock command failure");
      if (executable === "/usr/sbin/diskutil") return "mock-plist";
      if (executable === "/usr/bin/plutil") { assert.equal(input, "mock-plist"); return JSON.stringify(diskInfo); }
      if (executable === runtime.timeout) {
        if (authFailure) throw new Error(authFailure);
        return repoOutput ?? JSON.stringify(repo);
      }
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
  return { kinds, contents, notifications, diagnostics, calls, writes, removals, run, readable, credentialChecks,
    repository(value: unknown) { repo = value; }, authFailure(message: string) { authFailure = message; },
    repositoryOutput(value: string) { repoOutput = value; },
    disk(info: unknown) { diskInfo = info; }, restore(mode: string) { restore = mode; },
    fail(executable: string) { failCommand = executable; } };
}

test("absent drive cancels quietly, without diskutil, restic, or writes", () => {
  const f = fixture(); f.kinds.delete(drive.volumeRoot);
  f.readable.clear();
  assert.equal(f.run("presence"), ABSENT_EXIT);
  assert.equal(f.run("error", absentError), 0);
  assert.deepEqual(f.notifications, []); assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  assert.deepEqual(f.credentialChecks, []);
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

function moduleContract(module: string, mmn: string, mbp: string, repository: string, transport: string, terraria: string): void {
  for (const host of [mmn, mbp]) assert.match(host, /\.\.\/\.\.\/modules\/backup\/ssd-01\s/);
  assert.match(mmn, /\.\.\/\.\.\/modules\/backup\/terraria\s/);
  assert.match(mmn, /my.backup.terraria.saveRoot = config.my.terrariaSync.saveRoot/);
  assert.match(module, /imports = \[ \.\/repository.nix \]/);
  assert.match(repository, /imports = \[ \.\.\/. \.\/credential.nix \]/);
  assert.match(repository, /my.restic.ssd01.credential.required = true/);
  assert.match(transport, /passwordFile = config.sops.secrets.restic_ssd_01_password.path/);
  assert.match(repository, /inherit passwordFile/);
  assert.match(module, /RESTIC_PASSWORD_FILE=\$\{passwordFile\}/);
  assert.doesNotMatch(module + repository + transport, /passwordCommand|RESTIC_PASSWORD_COMMAND|--decrypt|SOPS_AGE_KEY_FILE/);
  for (const contract of ["StrictHostKeyChecking=yes", "UserKnownHostsFile=${cfg.knownHostsPath}",
    "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "BatchMode=yes", "IdentityAgent=none",
    "ConnectionAttempts=1", "ConnectTimeout=10", "ServerAliveCountMax=1"]) {
    assert.ok(transport.includes(contract), contract);
  }
  assert.match(module, /SSD_BACKUP_TIMEOUT=/);
  assert.match(repository, /defaultRepository = lib.mkDefault drive.repository.id/);
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
  assert.match(terraria, /imports = \[ \.\.\/ssd-01\/repository.nix \]/);
  assert.doesNotMatch(terraria, /hooks|requirePaths|diskutil|ssd-01\/default/);
  assert.doesNotMatch(mmn, /ssdMountGuard|restoreVerification|diskutil|resticPasswordCommand|plans.ssd-01|backup.plans.terraria/);
}

test("module and host imports contract; known regression fixtures are rejected", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const module = read("./default.nix"), mmn = read("../../../hosts/mmn-m4/default.nix"), mbp = read("../../../hosts/mbp-m2/default.nix");
  const repository = read("./repository.nix"), transport = read("./transport.nix"), terraria = read("../terraria/default.nix");
  const check = (m = module, n = mmn, b = mbp, r = repository, t = transport, g = terraria) => moduleContract(m, n, b, r, t, g);
  check();
  assert.throws(() => check(module, mmn, mbp.replace("../../modules/backup/ssd-01", "../../modules/backup")));
  assert.throws(() => check(module.replace("requirePaths = false", "requirePaths = true")));
  assert.throws(() => check(module.replace("SSD_BACKUP_POLICY_SHA256=", "UNBOUND_POLICY=")));
  assert.throws(() => check(module, mmn, mbp, repository, transport.replace("StrictHostKeyChecking=yes", "StrictHostKeyChecking=no")));
  assert.throws(() => check(module, mmn, mbp, repository.replace("inherit passwordFile", "inherit passwordCommand")));
  assert.throws(() => check(module, mmn, mbp, repository, transport, terraria + " hooks = [ ssdGuard ];"));
  const policy = JSON.parse(read("../terraria/plan.json"));
  assert.deepEqual(policy, {
    directories: ["Players", "Worlds"],
    schedule: { maxFrequencyHours: 1, clock: "CLOCK_LAST_RUN_TIME" },
    excludes: [".stfolder", ".stversions"],
  });
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

test("missing/unreadable credentials fail before canary writes or remote commands", () => {
  for (const path of [runtime.passwordFile, runtime.sshKeyPath, runtime.knownHostsPath]) {
    const f = fixture(); f.readable.delete(path);
    assert.equal(f.run("prepare"), 1);
    assert.deepEqual(f.writes, []);
    assert.ok(f.calls.every(call => call.executable !== runtime.timeout));
    assert.equal(f.run("error", "credential failure", () => { throw new Error("malformed policy"); }), 0);
    assert.deepEqual(f.notifications, ["error"]);
  }
});

test("rejected password, SSH/known-host failure, and timeout are redacted and stop canary writes", () => {
  for (const reason of ["wrong password", "Host key verification failed", "Permission denied (publickey)", "ETIMEDOUT"]) {
    const f = fixture(); f.authFailure(`${reason}: sentinel-password-and-private-key`);
    assert.equal(f.run("prepare"), 1);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.removals, []);
    assert.match(f.diagnostics.join(""), /readiness failed/);
    assert.doesNotMatch(f.diagnostics.join(""), /sentinel-password|private-key/);
    assert.equal(f.run("error", "auth failure"), 0);
    assert.deepEqual(f.notifications, ["error"]);
  }
  for (const repo of [{ id: "0".repeat(64) }, {}, null, { id: drive.repository.guid.toUpperCase() }]) {
    const f = fixture(); f.repository(repo);
    assert.equal(f.run("prepare"), 1);
    assert.deepEqual(f.writes, []);
    assert.match(f.diagnostics.join(""), /GUID does not match/);
  }
});

test("readiness uses only bounded no-lock cat config and the shared runtime password file", () => {
  const f = fixture(); assert.equal(f.run("prepare"), 0);
  const call = f.calls.find(call => call.executable === runtime.timeout);
  assert.deepEqual(call?.args, ["--signal=KILL", "30s", runtime.restic, "-r", drive.repository.uri,
    "--password-file", runtime.passwordFile, "-o", `sftp.command=${runtime.sftpCommand}`, "--no-lock", "cat", "config"]);
  assert.deepEqual(call?.options, { passwordFile: runtime.passwordFile, timeoutMs: READINESS_TIMEOUT_MS + 2000 });
  assert.deepEqual(f.credentialChecks, [runtime.passwordFile, runtime.sshKeyPath, runtime.knownHostsPath]);
});

test("malformed repository output never leaks through JSON parse diagnostics", () => {
  const f = fixture(); f.repositoryOutput("sentinel-password-invalid-json");
  assert.equal(f.run("prepare"), 1);
  assert.deepEqual(f.writes, []);
  assert.doesNotMatch(f.diagnostics.join(""), /sentinel-password/);
  assert.match(f.diagnostics.join(""), /child output withheld/);
});

test("native read checks accept SOPS-style links, reject absent/empty/non-files without reading contents", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ssd-auth-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const full = join(root, "full"), empty = join(root, "empty"), alias = join(root, "sops-link");
  writeFileSync(full, "synthetic-fixture"); writeFileSync(empty, ""); symlinkSync(full, alias);
  assert.equal(readableFile(full), true); assert.equal(readableFile(alias), true);
  assert.equal(readableFile(empty), false); assert.equal(readableFile(join(root, "absent")), false);
  assert.equal(readableFile(root), false);
});

test("native command failure with secret-like stdout/stderr is redacted; SIGTERM-resistant child is bounded", () => {
  assert.throws(() => nativeCommand(process.execPath, ["-e",
    'process.stdout.write("sentinel-password"); process.stderr.write("sentinel-private-key"); process.exit(1)'],
  ), error => error instanceof Error && !/sentinel/.test(error.message) && /output withheld/.test(error.message));
  assert.throws(() => nativeCommand("/nonexistent/sentinel-password", ["sentinel-private-key"]),
    error => error instanceof Error && !/sentinel/.test(error.message));
  const started = Date.now();
  assert.throws(() => nativeCommand(process.execPath, ["-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], undefined, { timeoutMs: 200 }));
  assert.ok(Date.now() - started < 3000, "timeout must kill rather than wait for the child to cooperate");
});

test("password-file commands discard inherited password and decrypt commands", () => {
  const oldPassword = process.env.RESTIC_PASSWORD, oldCommand = process.env.RESTIC_PASSWORD_COMMAND;
  try {
    process.env.RESTIC_PASSWORD = "synthetic-password";
    process.env.RESTIC_PASSWORD_COMMAND = "synthetic-decrypt-command";
    const result = nativeCommand(process.execPath, ["-e",
      'process.stdout.write(JSON.stringify([process.env.RESTIC_PASSWORD, process.env.RESTIC_PASSWORD_COMMAND, process.env.RESTIC_PASSWORD_FILE]))'],
    undefined, { passwordFile: runtime.passwordFile });
    assert.deepEqual(JSON.parse(result), [null, null, runtime.passwordFile]);
  } finally {
    if (oldPassword === undefined) delete process.env.RESTIC_PASSWORD; else process.env.RESTIC_PASSWORD = oldPassword;
    if (oldCommand === undefined) delete process.env.RESTIC_PASSWORD_COMMAND; else process.env.RESTIC_PASSWORD_COMMAND = oldCommand;
  }
});

test("GNU timeout terminates the mock restic/SSH process group including inherited output pipes", {
  skip: !process.env.SSD_TEST_TIMEOUT && "set SSD_TEST_TIMEOUT to the Nix coreutils timeout executable",
}, (t) => {
  const timeout = process.env.SSD_TEST_TIMEOUT; assert.ok(timeout);
  const root = mkdtempSync(join(tmpdir(), "ssd-timeout-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const childMarker = join(root, "child-ready"), parentMarker = join(root, "parent-ready");
  const child = `require("node:fs").writeFileSync(${JSON.stringify(childMarker)}, "ready"); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`;
  const parent = `const {spawn} = require("node:child_process"); spawn(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(child)}], {stdio:"inherit"}); require("node:fs").writeFileSync(${JSON.stringify(parentMarker)}, "ready"); setInterval(()=>{},1000);`;
  const started = Date.now();
  assert.throws(() => nativeCommand(timeout, ["--signal=KILL", "0.5s", process.execPath, "--input-type=commonjs", "-e", parent],
  undefined, { timeoutMs: 2000 }));
  assert.equal(readFileSync(parentMarker, "utf8"), "ready", "fixture must launch the parent before timeout");
  assert.equal(readFileSync(childMarker, "utf8"), "ready", "fixture must launch the child retaining inherited pipes");
  assert.ok(Date.now() - started < 3000, "descendants retaining output pipes must also be killed");
});
