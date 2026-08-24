#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { audit, parseArgs } from "./smb-audit.mjs";

const expected = {
  shareName: "Household Drop",
  sharePath: "/Volumes/ssd-01/igor/00_inbox",
  mountPoint: "/Volumes/ssd-01",
  volumeUuid: "expected-uuid",
};

function volume(changes = {}) {
  return {
    VolumeUUID: "expected-uuid",
    MountPoint: "/Volumes/ssd-01",
    FilesystemType: "exfat",
    Writable: true,
    ...changes,
  };
}

function secureShare(changes = {}) {
  return {
    path: "/Volumes/ssd-01/igor/00_inbox",
    smb_shared: 1,
    smb_guest_access: 0,
    smb_read_only: 0,
    smb_sealed: 1,
    ...changes,
  };
}

test("accepts the exact secure share and ignores unrelated records", () => {
  const records = {
    "Household Drop": secureShare(),
    Unrelated: { path: "/Users/example/Public", smb_guest_access: 1 },
  };
  assert.equal(audit(records, volume(), expected).every((item) => item.passed), true);
});

test("rejects guest access and missing encryption", () => {
  const records = { "Household Drop": secureShare({ smb_guest_access: 1, smb_sealed: 0 }) };
  const failures = audit(records, volume(), expected)
    .filter((item) => !item.passed)
    .map((item) => item.name)
    .sort();
  assert.deepEqual(failures, ["SMB3 encryption required", "guest disabled"]);
});

test("rejects a wrong volume even when the share looks valid", () => {
  const records = { "Household Drop": secureShare() };
  const failures = audit(records, volume({ VolumeUUID: "wrong-uuid" }), expected)
    .filter((item) => !item.passed)
    .map((item) => item.name);
  assert.deepEqual(failures, ["volume UUID"]);
});

test("rejects parent and neighboring share paths", () => {
  for (const path of ["/Volumes/ssd-01/igor", "/Volumes/ssd-01/igor/01_files"]) {
    const records = { "Household Drop": secureShare({ path }) };
    const failures = audit(records, volume(), expected)
      .filter((item) => !item.passed)
      .map((item) => item.name);
    assert.deepEqual(failures, ["share path"]);
  }
});

test("parses defaults and fail-closed audit flags", () => {
  assert.deepEqual(parseArgs(["--skip-listener", "--json"]), {
    shareName: "Household Drop",
    sharePath: "/Volumes/ssd-01/igor/00_inbox",
    mountPoint: "/Volumes/ssd-01",
    volumeUuid: "967C80B3-674A-3C8C-A248-2E6B8230DFD7",
    sharingJson: null,
    diskutilPlist: null,
    skipListener: true,
    skipFilesystem: false,
    json: true,
  });
});
