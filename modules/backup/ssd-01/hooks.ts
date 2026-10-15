import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, lstatSync, readFileSync, writeFileSync, renameSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Drive {
  volumeRoot: string;
  volumeUuid: string;
  paths: string[];
  photoExportDb: string;
  canaryPath: string;
  repository: { id: string; uri: string; guid: string; sshTarget: string; sshPort: number };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}

/** Both Nix and these hooks consume the adjacent native drive identity file. */
export function parseDrive(value: unknown): Drive {
  if (!object(value) || !object(value.repository)) throw new Error("invalid drive configuration");
  const volumeRoot = string(value.volumeRoot, "volumeRoot");
  if (!volumeRoot.startsWith("/Volumes/") || resolve(volumeRoot) !== volumeRoot) {
    throw new Error("volumeRoot must be a canonical /Volumes path");
  }
  const child = (value: unknown, name: string): string => {
    const path = string(value, name);
    if (!path.startsWith(`${volumeRoot}/`) || resolve(path) !== path) throw new Error(`invalid ${name}`);
    return path;
  };
  if (!Array.isArray(value.paths) || value.paths.length !== 2) throw new Error("expected two source paths");
  const paths = value.paths.map((path: unknown) => child(path, "source path"));
  const photoExportDb = child(value.photoExportDb, "photoExportDb");
  const canaryPath = child(value.canaryPath, "canaryPath");
  if (![photoExportDb, canaryPath].every(path => paths.some(source => path.startsWith(`${source}/`)))) {
    throw new Error("database and canary must be included in backup sources");
  }
  const volumeUuid = string(value.volumeUuid, "volumeUuid");
  if (!/^[\dA-F]{8}-(?:[\dA-F]{4}-){3}[\dA-F]{12}$/i.test(volumeUuid)) throw new Error("invalid volume UUID");
  const repo = value.repository;
  const guid = string(repo.guid, "repository guid");
  if (!/^[\da-f]{64}$/.test(guid)) throw new Error("invalid repository GUID");
  if (typeof repo.sshPort !== "number" || !Number.isInteger(repo.sshPort) || repo.sshPort < 1 || repo.sshPort > 65535) {
    throw new Error("invalid SSH port");
  }
  return {
    volumeRoot, volumeUuid, paths, photoExportDb, canaryPath,
    repository: {
      id: string(repo.id, "repository id"), uri: string(repo.uri, "repository uri"), guid,
      sshTarget: string(repo.sshTarget, "SSH target"), sshPort: repo.sshPort,
    },
  };
}

type Kind = "directory" | "file" | "symlink" | "other" | null;
export interface Adapters {
  kind(path: string): Kind;
  readableFile(path: string): boolean;
  read(path: string): string;
  writeCanary(path: string, contents: string): void;
  temporaryDirectory(): string;
  removeDirectory(path: string): void;
  command(executable: string, args: string[], input?: string, options?: CommandOptions): string;
  notify(result: "success" | "error"): void;
  diagnostic(message: string): void;
}
export interface Runtime {
  restic: string;
  sftpCommand: string;
  passwordFile: string;
  sshKeyPath: string;
  knownHostsPath: string;
  timeout: string;
}

export interface CommandOptions { passwordFile?: string; timeoutMs?: number }
export const READINESS_TIMEOUT_MS = 30_000;

/** Open credentials without reading their contents. SOPS runtime links are
 * intentional; fstat validates the opened target rather than rejecting links. */
export function readableFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Child output can contain credential values, even on parse/spawn failures.
 * Keep all diagnostics structural and never interpolate output or argv. */
export function nativeCommand(executable: string, args: string[], input?: string, options?: CommandOptions): string {
  const env = { ...process.env };
  if (options?.passwordFile) {
    delete env.RESTIC_PASSWORD;
    delete env.RESTIC_PASSWORD_COMMAND;
    env.RESTIC_PASSWORD_FILE = options.passwordFile;
  }
  const result = spawnSync(executable, args, {
    input, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    timeout: options?.timeoutMs, killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) throw new Error("backup command failed or timed out; child output withheld");
  return result.stdout;
}

/** Runtime-only, read-only admission. timeout kills the entire process group
 * (including SSH); spawnSync's deadline is an independent local backstop. */
export function readiness(drive: Drive, runtime: Runtime, adapters: Adapters): void {
  for (const [name, path] of [
    ["password", runtime.passwordFile], ["SSH identity", runtime.sshKeyPath], ["known hosts", runtime.knownHostsPath],
  ]) {
    if (!path || !path.startsWith("/") || path.startsWith("/nix/store/") || !adapters.readableFile(path)) {
      throw new Error(`backup ${name} file unavailable or empty`);
    }
  }
  if (!runtime.restic.startsWith("/") || !runtime.timeout.startsWith("/") || !runtime.sftpCommand) {
    throw new Error("backup readiness runtime wiring missing");
  }
  let config: unknown;
  try {
    config = JSON.parse(adapters.command(runtime.timeout, [
      "--signal=KILL", `${READINESS_TIMEOUT_MS / 1000}s`, runtime.restic,
      "-r", drive.repository.uri, "--password-file", runtime.passwordFile,
      "-o", `sftp.command=${runtime.sftpCommand}`, "--no-lock", "cat", "config",
    ], undefined, { passwordFile: runtime.passwordFile, timeoutMs: READINESS_TIMEOUT_MS + 2000 }));
  } catch { throw new Error("backup authentication or repository readiness failed; child output withheld"); }
  if (!object(config) || config.id !== drive.repository.guid) {
    throw new Error("backup repository GUID does not match the expected repository");
  }
}

export const ABSENT_EXIT = 75;

/** Reject live policy drift before a hook can validate different sources from
 * the active Backrest plan. Hash the same bytes Nix read, not a JSON reencoding. */
export function assertPolicy(contents: string, expected: string | undefined): void {
  if (!expected || createHash("sha256").update(contents).digest("hex") !== expected) {
    throw new Error("SSD policy differs from the active plan; activate the updated policy before retrying");
  }
}

/** Backrest 1.13.0 calls NotifyError even after ON_ERROR_CANCEL.
 * Match the dedicated presence-hook cancellation, never later disk absence:
 * a drive disappearing during restic must still notify an actual backup error.
 */
export function isAbsentCancellation(error: string): boolean {
  return error.startsWith("snapshot start hook: ")
    && error.includes("task cancelled")
    && error.endsWith(`exit status ${ABSENT_EXIT}`);
}

function prepare(drive: Drive, canary: string, runtime: Runtime, adapters: Adapters): void {
  if (adapters.kind(drive.volumeRoot) !== "directory") throw new Error("SSD mount path is not a directory");
  const plist = adapters.command("/usr/sbin/diskutil", ["info", "-plist", drive.volumeRoot]);
  const info: unknown = JSON.parse(adapters.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist));
  if (!object(info) || info.VolumeUUID !== drive.volumeUuid || info.MountPoint !== drive.volumeRoot || info.Mounted !== true) {
    throw new Error("SSD mount identity does not match the expected UUID and mount point");
  }
  for (const path of drive.paths) {
    if (adapters.kind(path) !== "directory") throw new Error(`backup source missing or unsafe: ${path}`);
  }
  if (adapters.kind(dirname(drive.photoExportDb)) !== "directory" || adapters.kind(drive.photoExportDb) !== "file") {
    throw new Error(`photo export database missing or unsafe: ${drive.photoExportDb}`);
  }
  const kind = adapters.kind(drive.canaryPath);
  if (kind !== null && kind !== "file") throw new Error("restore canary is not a regular file");
  readiness(drive, runtime, adapters);
  if (kind === null || adapters.read(drive.canaryPath) !== canary) adapters.writeCanary(drive.canaryPath, canary);
}

function verify(drive: Drive, canary: string, snapshot: string, runtime: Runtime, adapters: Adapters): void {
  // Backrest emits SUCCESS after --skip-if-unchanged as well as after dry runs.
  // Neither produces a snapshot to restore or warrants a completion notification.
  if (snapshot === "") return;
  if (!/^[\da-f]{8,64}$/.test(snapshot)) throw new Error("invalid snapshot ID");
  if (!runtime.restic.startsWith("/") || !runtime.sftpCommand) throw new Error("restore runtime wiring missing");
  const target = adapters.temporaryDirectory();
  try {
    adapters.command(runtime.restic, [
      "-r", drive.repository.uri, "-o", `sftp.command=${runtime.sftpCommand}`,
      "restore", snapshot, "--include", drive.canaryPath, "--target", target,
    ], undefined, { passwordFile: runtime.passwordFile });
    const restored = join(target, drive.canaryPath);
    if (adapters.kind(restored) !== "file" || adapters.read(restored) !== canary) {
      throw new Error("restored canary does not match");
    }
  } finally {
    adapters.removeDirectory(target);
  }
  adapters.notify("success");
}

export function runHook(
  action: string, argument: string, load: () => { drive: Drive; canary: string }, runtime: Runtime, adapters: Adapters,
): number {
  try {
    // Reporting must survive missing/malformed policy. Defer every policy read
    // into this boundary so verify bootstrap failures also notify exactly once.
    if (action === "error") {
      if (!isAbsentCancellation(argument)) adapters.notify("error");
      return 0;
    }
    const { drive, canary } = load();
    switch (action) {
      case "presence": return adapters.kind(drive.volumeRoot) === null ? ABSENT_EXIT : 0;
      case "prepare": prepare(drive, canary, runtime, adapters); break;
      case "verify": verify(drive, canary, argument, runtime, adapters); break;
      default: throw new Error(`unknown hook action: ${action}`);
    }
    return 0;
  } catch (error) {
    adapters.diagnostic(error instanceof Error ? error.message : "backup hook failed");
    // A fatal end hook is returned directly; Backrest does not call NotifyError.
    if (action === "verify") {
      try { adapters.notify("error"); }
      catch (error) { adapters.diagnostic(error instanceof Error ? error.message : "notification failed"); }
    }
    return 1;
  }
}

function nativeAdapters(): Adapters {
  const command = nativeCommand;
  return {
    readableFile,
    kind(path) {
      try {
        const stat = lstatSync(path);
        return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      } catch (error) {
        if (object(error) && error.code === "ENOENT") return null;
        throw error;
      }
    },
    read: path => readFileSync(path, "utf8"),
    writeCanary(path, contents) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, contents, { mode: 0o444, flag: "wx" });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    },
    temporaryDirectory: () => mkdtempSync(join(tmpdir(), "ssd-01-restore-")),
    removeDirectory: path => rmSync(path, { recursive: true, force: true }),
    command,
    notify(result) {
      command("/usr/bin/osascript", ["-e", result === "success"
        ? 'display notification "The encrypted off-site snapshot and canary restore completed." with title "ssd-01 backup complete"'
        : 'display notification "Open Backrest for details." with title "ssd-01 backup needs attention" sound name "Basso"']);
    },
    diagnostic: message => process.stderr.write(`${message}\n`),
  };
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  const action = process.argv[2] ?? "--help";
  if (action === "--help") {
    process.stdout.write("usage: hooks.ts presence | prepare | verify <snapshot-id> | error <backrest-error>\n");
  } else {
    const adjacent = dirname(fileURLToPath(import.meta.url));
    process.exitCode = runHook(action, process.argv[3] ?? "", () => {
      const contents = readFileSync(join(adjacent, "drive.json"), "utf8");
      assertPolicy(contents, process.env.SSD_BACKUP_POLICY_SHA256);
      return {
        drive: parseDrive(JSON.parse(contents)),
        canary: readFileSync(join(adjacent, "canary.txt"), "utf8"),
      };
    }, {
      restic: process.env.SSD_BACKUP_RESTIC ?? "",
      sftpCommand: process.env.SSD_BACKUP_SFTP_COMMAND ?? "",
      passwordFile: process.env.RESTIC_PASSWORD_FILE ?? "",
      sshKeyPath: process.env.SSD_BACKUP_SSH_KEY ?? "",
      knownHostsPath: process.env.SSD_BACKUP_KNOWN_HOSTS ?? "",
      timeout: process.env.SSD_BACKUP_TIMEOUT ?? "",
    }, nativeAdapters());
  }
}
