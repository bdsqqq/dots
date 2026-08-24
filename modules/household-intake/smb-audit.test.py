#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("smb_audit", Path(__file__).with_name("smb-audit.py"))
smb_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smb_audit)


EXPECTED = {
    "share_name": "Household Drop",
    "share_path": "/Volumes/ssd-01/igor/00_inbox",
    "mount_point": "/Volumes/ssd-01",
    "volume_uuid": "expected-uuid",
}


def volume(**changes):
    return {
        "VolumeUUID": "expected-uuid",
        "MountPoint": "/Volumes/ssd-01",
        "FilesystemType": "exfat",
        "Writable": True,
    } | changes


def secure_share(**changes):
    return {
        "path": "/Volumes/ssd-01/igor/00_inbox",
        "smb_shared": 1,
        "smb_guest_access": 0,
        "smb_read_only": 0,
        "smb_sealed": 1,
    } | changes


class SmbAuditTest(unittest.TestCase):
    def test_accepts_exact_secure_share_and_ignores_unrelated_records(self):
        records = {
            "Household Drop": secure_share(),
            "Unrelated": {"path": "/Users/example/Public", "smb_guest_access": 1},
        }
        checks = smb_audit.audit(records, volume(), EXPECTED)
        self.assertTrue(all(item["passed"] for item in checks))

    def test_rejects_guest_access_and_missing_encryption(self):
        records = {"Household Drop": secure_share(smb_guest_access=1, smb_sealed=0)}
        failures = {
            item["name"]
            for item in smb_audit.audit(records, volume(), EXPECTED)
            if not item["passed"]
        }
        self.assertEqual(failures, {"guest disabled", "SMB3 encryption required"})

    def test_rejects_wrong_volume_even_when_share_record_looks_valid(self):
        records = {"Household Drop": secure_share()}
        failures = [
            item
            for item in smb_audit.audit(records, volume(VolumeUUID="wrong-uuid"), EXPECTED)
            if not item["passed"]
        ]
        self.assertEqual([item["name"] for item in failures], ["volume UUID"])

    def test_rejects_parent_or_neighbor_share_path(self):
        for path in ["/Volumes/ssd-01/igor", "/Volumes/ssd-01/igor/01_files"]:
            with self.subTest(path=path):
                records = {"Household Drop": secure_share(path=path)}
                failures = [
                    item["name"]
                    for item in smb_audit.audit(records, volume(), EXPECTED)
                    if not item["passed"]
                ]
                self.assertEqual(failures, ["share path"])


if __name__ == "__main__":
    unittest.main()
