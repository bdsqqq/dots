#!/usr/bin/env python3

import argparse
import json
import os
import plistlib
import socket
import subprocess
import sys
from pathlib import Path


def check(name, passed, evidence):
    return {"name": name, "passed": bool(passed), "evidence": evidence}


def audit(shares, volume, expected):
    share = shares.get(expected["share_name"])
    checks = [
        check("volume UUID", volume.get("VolumeUUID") == expected["volume_uuid"], volume.get("VolumeUUID")),
        check("volume mount", volume.get("MountPoint") == expected["mount_point"], volume.get("MountPoint")),
        check("volume filesystem", volume.get("FilesystemType") == "exfat", volume.get("FilesystemType")),
        check("volume writable", volume.get("Writable") is True, volume.get("Writable")),
        check("share exists", share is not None, expected["share_name"]),
    ]
    if share is None:
        return checks

    checks.extend([
        check("share path", share.get("path") == expected["share_path"], share.get("path")),
        check("SMB enabled", share.get("smb_shared") == 1, share.get("smb_shared")),
        check("guest disabled", share.get("smb_guest_access") == 0, share.get("smb_guest_access")),
        check("share writable", share.get("smb_read_only") == 0, share.get("smb_read_only")),
        check("SMB3 encryption required", share.get("smb_sealed") == 1, share.get("smb_sealed")),
    ])
    return checks


def command_output(command):
    return subprocess.run(command, check=True, capture_output=True).stdout


def sharing_records(path):
    if path:
        return json.loads(Path(path).read_text())
    return json.loads(command_output(["/usr/sbin/sharing", "-l", "-f", "json"]))


def volume_record(path, mount_point):
    if path:
        with Path(path).open("rb") as source:
            return plistlib.load(source)
    return plistlib.loads(command_output(["/usr/sbin/diskutil", "info", "-plist", mount_point]))


def listener_ready(host, port, timeout):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, f"{host}:{port} accepted a TCP connection"
    except OSError as error:
        return False, f"{host}:{port}: {error}"


def filesystem_checks(expected):
    path = Path(expected["share_path"])
    checks = [check("share directory exists", path.is_dir(), str(path))]
    if not path.exists():
        return checks
    checks.extend([
        check("share is not a symlink", not path.is_symlink(), str(path)),
        check("share resolves exactly", str(path.resolve()) == expected["share_path"], str(path.resolve())),
    ])
    return checks


def parse_args(argv):
    parser = argparse.ArgumentParser(description="fail-closed audit for the Household Drop SMB share")
    parser.add_argument("--share-name", default="Household Drop")
    parser.add_argument("--share-path", default="/Volumes/ssd-01/igor/00_inbox")
    parser.add_argument("--mount-point", default="/Volumes/ssd-01")
    parser.add_argument("--volume-uuid", default="967C80B3-674A-3C8C-A248-2E6B8230DFD7")
    parser.add_argument("--sharing-json", help="read sharing records from a fixture instead of macOS")
    parser.add_argument("--diskutil-plist", help="read volume information from a fixture instead of macOS")
    parser.add_argument("--skip-listener", action="store_true", help="skip the local TCP 445 check")
    parser.add_argument("--skip-filesystem", action="store_true", help="skip live path checks")
    parser.add_argument("--json", action="store_true", help="emit a JSON report")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    expected = {
        "share_name": args.share_name,
        "share_path": os.path.normpath(args.share_path),
        "mount_point": os.path.normpath(args.mount_point),
        "volume_uuid": args.volume_uuid,
    }
    try:
        checks = audit(
            sharing_records(args.sharing_json),
            volume_record(args.diskutil_plist, expected["mount_point"]),
            expected,
        )
        if not args.skip_filesystem:
            checks.extend(filesystem_checks(expected))
        if not args.skip_listener:
            passed, evidence = listener_ready("127.0.0.1", 445, 2)
            checks.append(check("SMB listener", passed, evidence))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, plistlib.InvalidFileException) as error:
        checks = [check("audit execution", False, str(error))]

    report = {"passed": all(item["passed"] for item in checks), "checks": checks}
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for item in checks:
            marker = "ok" if item["passed"] else "FAIL"
            print(f"{marker:4} {item['name']}: {item['evidence']}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
