import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from "node:fs";
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
  read(path: string): string;
  writeCanary(path: string, contents: string): void;
  temporaryDirectory(): string;
  removeDirectory(path: string): void;
  command(executable: string, args: string[], input?: string): string;
  notify(result: "success" | "error"): void;
  diagnostic(message: string): void;
}
export interface Runtime {
  restic: string;
  sftpCommand: string;
}

export const ABSENT_EXIT = 75;

/** Backrest 1.13.0 calls NotifyError even after ON_ERROR_CANCEL.
 * Match the dedicated presence-hook cancellation, never later disk absence:
 * a drive disappearing during restic must still notify an actual backup error.
 */
export function isAbsentCancellation(error: string): boolean {
  return error.startsWith("snapshot start hook: ")
    && error.includes("task cancelled")
    && error.endsWith(`exit status ${ABSENT_EXIT}`);
}

function prepare(drive: Drive, canary: string, adapters: Adapters): void {
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
    ]);
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
  action: string, argument: string, drive: Drive, canary: string, runtime: Runtime, adapters: Adapters,
): number {
  try {
    switch (action) {
      case "presence": return adapters.kind(drive.volumeRoot) === null ? ABSENT_EXIT : 0;
      case "prepare": prepare(drive, canary, adapters); break;
      case "verify": verify(drive, canary, argument, runtime, adapters); break;
      case "error": if (!isAbsentCancellation(argument)) adapters.notify("error"); break;
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
  const command: Adapters["command"] = (executable, args, input) => {
    const result = spawnSync(executable, args, { input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${executable} failed (${result.status ?? result.signal}): ${result.stderr}`);
    return result.stdout;
  };
  return {
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const action = process.argv[2] ?? "--help";
  if (action === "--help") {
    process.stdout.write("usage: hooks.ts presence | prepare | verify <snapshot-id> | error <backrest-error>\n");
  } else {
    try {
      const adjacent = dirname(fileURLToPath(import.meta.url));
      const drive = parseDrive(JSON.parse(readFileSync(join(adjacent, "drive.json"), "utf8")));
      process.exitCode = runHook(action, process.argv[3] ?? "", drive, readFileSync(join(adjacent, "canary.txt"), "utf8"), {
        restic: process.env.SSD_BACKUP_RESTIC ?? "",
        sftpCommand: process.env.SSD_BACKUP_SFTP_COMMAND ?? "",
      }, nativeAdapters());
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "hook configuration failed"}\n`);
      process.exitCode = 1;
    }
  }
}
