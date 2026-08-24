#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function check(name, passed, evidence) {
  return { name, passed: Boolean(passed), evidence: evidence ?? null };
}

export function audit(shares, volume, expected) {
  const share = shares[expected.shareName];
  const checks = [
    check("volume UUID", volume.VolumeUUID === expected.volumeUuid, volume.VolumeUUID),
    check("volume mount", volume.MountPoint === expected.mountPoint, volume.MountPoint),
    check("volume filesystem", volume.FilesystemType === "exfat", volume.FilesystemType),
    check("volume writable", volume.Writable === true, volume.Writable),
    check("share exists", share !== undefined, expected.shareName),
  ];
  if (share === undefined) return checks;

  checks.push(
    check("share path", share.path === expected.sharePath, share.path),
    check("SMB enabled", share.smb_shared === 1, share.smb_shared),
    check("guest disabled", share.smb_guest_access === 0, share.smb_guest_access),
    check("share writable", share.smb_read_only === 0, share.smb_read_only),
    check("SMB3 encryption required", share.smb_sealed === 1, share.smb_sealed),
  );
  return checks;
}

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, { ...options, encoding: "utf8" });
}

function sharingRecords(path) {
  const value = path
    ? readFileSync(path, "utf8")
    : commandOutput("/usr/sbin/sharing", ["-l", "-f", "json"]);
  return JSON.parse(value);
}

function volumeRecord(path, mountPoint) {
  if (path) {
    return JSON.parse(commandOutput("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]));
  }
  const plist = execFileSync("/usr/sbin/diskutil", ["info", "-plist", mountPoint]);
  return JSON.parse(commandOutput("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: plist }));
}

function listenerReady(host, port, timeoutMs) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (passed, evidence) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise([passed, evidence]);
    };
    socket.setTimeout(timeoutMs, () => finish(false, `${host}:${port}: timed out`));
    socket.once("connect", () => finish(true, `${host}:${port} accepted a TCP connection`));
    socket.once("error", (error) => finish(false, `${host}:${port}: ${error.message}`));
  });
}

export function filesystemChecks(expected) {
  let status;
  try {
    status = lstatSync(expected.sharePath);
  } catch (error) {
    if (error.code === "ENOENT") return [check("share directory exists", false, expected.sharePath)];
    throw error;
  }
  const realPath = realpathSync(expected.sharePath);
  return [
    check("share directory exists", status.isDirectory(), expected.sharePath),
    check("share is not a symlink", !status.isSymbolicLink(), expected.sharePath),
    check("share resolves exactly", realPath === resolve(expected.sharePath), realPath),
  ];
}

export function parseArgs(argv) {
  const config = {
    shareName: "Household Drop",
    sharePath: "/Volumes/ssd-01/igor/00_inbox",
    mountPoint: "/Volumes/ssd-01",
    volumeUuid: "967C80B3-674A-3C8C-A248-2E6B8230DFD7",
    sharingJson: null,
    diskutilPlist: null,
    skipListener: false,
    skipFilesystem: false,
    json: false,
  };
  const values = {
    "--share-name": "shareName",
    "--share-path": "sharePath",
    "--mount-point": "mountPoint",
    "--volume-uuid": "volumeUuid",
    "--sharing-json": "sharingJson",
    "--diskutil-plist": "diskutilPlist",
  };
  const booleans = {
    "--skip-listener": "skipListener",
    "--skip-filesystem": "skipFilesystem",
    "--json": "json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (booleans[option]) {
      config[booleans[option]] = true;
    } else if (values[option] && argv[index + 1] !== undefined) {
      config[values[option]] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`invalid option ${option}`);
    }
  }
  config.sharePath = normalize(config.sharePath);
  config.mountPoint = normalize(config.mountPoint);
  return config;
}

export async function main(argv = process.argv.slice(2)) {
  let config;
  let checks;
  try {
    config = parseArgs(argv);
    checks = audit(
      sharingRecords(config.sharingJson),
      volumeRecord(config.diskutilPlist, config.mountPoint),
      config,
    );
    if (!config.skipFilesystem) checks.push(...filesystemChecks(config));
    if (!config.skipListener) {
      const [passed, evidence] = await listenerReady("127.0.0.1", 445, 2_000);
      checks.push(check("SMB listener", passed, evidence));
    }
  } catch (error) {
    checks = [check("audit execution", false, error.message)];
  }

  const report = { passed: checks.every((item) => item.passed), checks };
  if (config?.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of checks) {
      console.log(`${item.passed ? "ok  " : "FAIL"} ${item.name}: ${item.evidence}`);
    }
  }
  return report.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
