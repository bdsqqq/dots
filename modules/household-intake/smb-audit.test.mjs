#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import { join } from "node:path";

import { audit, filesystemChecks, listenerReady, parseArgs } from "./smb-audit.mjs";

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

test("accepts the exact secure share", () => {
  const records = { "Household Drop": secureShare() };
  assert.equal(audit(records, volume(), expected).every((item) => item.passed), true);
});

test("rejects every additional enabled SMB share", () => {
  const records = {
    "Household Drop": secureShare(),
    "Igor Bedesqui’s Public Folder": {
      path: "/Users/bdsqqq/Public",
      smb_guest_access: 1,
      smb_shared: 1,
    },
  };
  const failures = audit(records, volume(), expected)
    .filter((item) => !item.passed)
    .map((item) => item.name);
  assert.deepEqual(failures, ["only intended SMB share enabled"]);
});

test("rejects guest access and missing encryption", () => {
  const records = { "Household Drop": secureShare({ smb_guest_access: 1, smb_sealed: 0 }) };
  const failures = audit(records, volume(), expected)
    .filter((item) => !item.passed)
    .map((item) => item.name)
    .sort();
  assert.deepEqual(failures, ["SMB3 encryption required", "guest disabled"]);
});

test("rejects every invalid volume property", () => {
  for (const [property, value, expectedFailure] of [
    ["VolumeUUID", "wrong-uuid", "volume UUID"],
    ["MountPoint", "/Volumes/wrong", "volume mount"],
    ["FilesystemType", "apfs", "volume filesystem"],
    ["Writable", false, "volume writable"],
  ]) {
    const checks = audit(
      { "Household Drop": secureShare() },
      volume({ [property]: value }),
      expected,
    );
    assert.equal(checks.find((item) => item.name === expectedFailure)?.passed, false);
  }
});

test("rejects every invalid intended share property", () => {
  for (const [property, value, expectedFailure] of [
    ["smb_shared", 0, "SMB enabled"],
    ["smb_guest_access", 1, "guest disabled"],
    ["smb_read_only", 1, "share writable"],
    ["smb_sealed", 0, "SMB3 encryption required"],
  ]) {
    const checks = audit(
      { "Household Drop": secureShare({ [property]: value }) },
      volume(),
      expected,
    );
    assert.equal(checks.find((item) => item.name === expectedFailure)?.passed, false);
  }
});

test("rejects a missing intended share", () => {
  const failures = audit({}, volume(), expected)
    .filter((item) => !item.passed)
    .map((item) => item.name);
  assert.deepEqual(failures, ["share exists", "only intended SMB share enabled"]);
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

test("parses defaults and test overrides", () => {
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

test("filesystem checks reject final and parent symlinks", () => {
  const root = mkdtempSync(join(process.cwd(), ".smb-audit-test-"));
  try {
    const realParent = join(root, "real-parent");
    const realInbox = join(realParent, "inbox");
    const linkedParent = join(root, "linked-parent");
    const linkedInbox = join(root, "linked-inbox");
    mkdirSync(realInbox, { recursive: true });
    symlinkSync(realParent, linkedParent);
    symlinkSync(realInbox, linkedInbox);

    assert.equal(filesystemChecks({ sharePath: realInbox }).every((item) => item.passed), true);
    assert.equal(
      filesystemChecks({ sharePath: linkedInbox }).find((item) => item.name === "share is not a symlink")?.passed,
      false,
    );
    assert.equal(
      filesystemChecks({ sharePath: join(linkedParent, "inbox") }).find(
        (item) => item.name === "share resolves exactly",
      )?.passed,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listener check observes a real TCP listener", async () => {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    const [passed] = await listenerReady("127.0.0.1", server.address().port, 1_000);
    assert.equal(passed, true);
  } finally {
    await new Promise((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  }
});

test("command accepts secure real-shaped fixtures and rejects guest access", () => {
  const root = mkdtempSync(join(process.cwd(), ".smb-audit-cli-test-"));
  try {
    const inbox = join(root, "inbox");
    const sharingPath = join(root, "sharing.json");
    const volumePath = join(root, "volume.plist");
    mkdirSync(inbox);
    writeFileSync(
      volumePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>VolumeUUID</key><string>expected-uuid</string>
<key>MountPoint</key><string>/Volumes/ssd-01</string>
<key>FilesystemType</key><string>exfat</string>
<key>Writable</key><true/>
</dict></plist>`,
    );

    const run = (guestAccess) => {
      writeFileSync(
        sharingPath,
        JSON.stringify({
          "Household Drop": secureShare({ path: inbox, smb_guest_access: guestAccess }),
        }),
      );
      return spawnSync(
        process.execPath,
        [
          new URL("./smb-audit.mjs", import.meta.url).pathname,
          "--share-path",
          inbox,
          "--volume-uuid",
          "expected-uuid",
          "--sharing-json",
          sharingPath,
          "--diskutil-plist",
          volumePath,
          "--skip-listener",
          "--json",
        ],
        { encoding: "utf8" },
      );
    };

    const secure = run(0);
    assert.equal(secure.status, 0, secure.stderr || secure.stdout);
    assert.equal(JSON.parse(secure.stdout).passed, true);

    const guest = run(1);
    assert.equal(guest.status, 1, guest.stderr || guest.stdout);
    assert.equal(
      JSON.parse(guest.stdout).checks.find((item) => item.name === "guest disabled")?.passed,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
