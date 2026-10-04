import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountCommands,
  ancestorMode,
  assertHostedRoot,
  candidateIdentity,
  executableMode,
  lookupGroup,
  permissionMode,
  precheckSnapshot,
  provisionAccount,
  secureTree,
  snapshotGit,
  validateNixDaemonConfig,
  verifyCandidateBoundary,
  verifyCandidateIdentity,
  verifyNixDaemon,
  within,
} from "./isolate.ts";
import type { ControllerCommand } from "./isolate.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ci-isolate-fixture-"));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const uid = process.getuid!();
const gid = process.getgid!();
const permissions = (path: string): number => lstatSync(path).mode & 0o777;

test("hosted-root guard rejects every missing authority before provisioning", () => {
  assert.doesNotThrow(() => assertHostedRoot(0, { CI: "true", GITHUB_ACTIONS: "true" }));
  for (const [id, env] of [
    [uid || 501, { CI: "true", GITHUB_ACTIONS: "true" }],
    [undefined, { CI: "true", GITHUB_ACTIONS: "true" }],
    [0, { CI: "true" }],
    [0, { GITHUB_ACTIONS: "true" }],
    [0, { CI: "1", GITHUB_ACTIONS: "true" }],
  ] as const)
    assert.throws(() => assertHostedRoot(id, env), /requires uid 0/);
});

test("linux account has exactly the dedicated uid/gid, no supplementary groups or login", () => {
  const commands = accountCommands("linux", "/fixture/home");
  assert.deepEqual(commands, [
    { program: "/usr/sbin/groupadd", args: ["--gid", "62001", "ci-candidate"] },
    {
      program: "/usr/sbin/useradd",
      args: [
        "--uid",
        "62001",
        "--gid",
        "62001",
        "--groups",
        "",
        "--no-create-home",
        "--no-user-group",
        "--home-dir",
        "/fixture/home",
        "--shell",
        "/usr/sbin/nologin",
        "ci-candidate",
      ],
    },
  ]);
  assert.equal(candidateIdentity.uid, candidateIdentity.gid);
});

test("darwin account is disabled and never appended to admin or sudo groups", () => {
  const commands = accountCommands("darwin", "/fixture/home");
  assert.equal(commands.length, 9);
  assert(commands.every((spec) => spec.program === "/usr/bin/dscl" && spec.args[1] === "-create"));
  assert(commands.some((spec) => spec.args.slice(-2).join(":") === "UniqueID:62001"));
  assert(commands.some((spec) => spec.args.slice(-2).join(":") === "UserShell:/usr/bin/false"));
  assert.equal(commands.filter((spec) => spec.args.slice(-2).join(":") === "Password:*").length, 2);
  assert(!JSON.stringify(commands).match(/admin|sudo|GroupMembership|AuthenticationAuthority/));
  assert.throws(() => accountCommands("win32", "/fixture"), /unsupported/);
});

test("linux rejects username, uid, gid and stale supplemental-group collisions", () => {
  for (const [users, groups] of [
    ["ci-candidate:x:500:500::/:/bin/sh\n", "root:x:0:\n"],
    ["old:x:62001:500::/:/bin/sh\n", "root:x:0:\n"],
    ["root:x:0:0::/:/bin/sh\n", "old:x:62001:\n"],
    ["root:x:0:0::/:/bin/sh\n", "ci-candidate:x:500:\n"],
    ["root:x:0:0::/:/bin/sh\n", "sudo:x:27:runner,ci-candidate\n"],
  ]) {
    const writes: string[] = [];
    const mock: ControllerCommand = (program, args) => {
      if (program.endsWith("getent"))
        return { status: 0, stdout: args[0] === "passwd" ? users : groups };
      writes.push(program);
      return { status: 0, stdout: "" };
    };
    assert.throws(() => provisionAccount("linux", "/fixture", mock), /collision/);
    assert.deepEqual(writes, []);
  }
});

test("darwin rejects uid/gid/name and stale admin membership before account writes", () => {
  for (const [users, groups, memberships] of [
    ["old 62001\n", "wheel 0\n", ""],
    ["ci-candidate 501\n", "wheel 0\n", ""],
    ["root 0\n", "old 62001\n", ""],
    ["root 0\n", "ci-candidate 501\n", ""],
    ["root 0\n", "wheel 0\n", "admin runner ci-candidate\n"],
  ]) {
    const writes: string[][] = [];
    const mock: ControllerCommand = (_program, args) => {
      if (args[1] !== "-list") {
        writes.push(args);
        return { status: 0, stdout: "" };
      }
      return {
        status: 0,
        stdout: args[2] === "/Users" ? users : args[3] === "GroupMembership" ? memberships : groups,
      };
    };
    assert.throws(() => provisionAccount("darwin", "/fixture", mock), /collision|membership/);
    assert.deepEqual(writes, []);
  }
});

test("successful provisioning uses only mocked commands; listing errors fail closed", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const calls: { program: string; args: string[] }[] = [];
    provisionAccount(platform, "/fixture", (program, args) => {
      calls.push({ program, args });
      return { status: 0, stdout: "" };
    });
    assert.deepEqual(
      calls.slice(platform === "linux" ? 2 : 3),
      accountCommands(platform, "/fixture"),
    );
    assert.throws(
      () => provisionAccount(platform, "/fixture", () => ({ status: 1, stdout: "" })),
      /command failed/,
    );
  }
});

test("ancestor planning preserves runner ownership, immutable modes and sticky parents", () => {
  for (const [mode, expected] of [
    [0o755, 0o755],
    [0o555, 0o555],
    [0o700, 0o705],
    [0o1777, 0o1777],
    [0o777, 0o775],
    [0o775, 0o775],
  ]) {
    const stat = { mode, uid: 501, gid: 20 };
    assert.equal(ancestorMode(stat), expected);
    assert.deepEqual(stat, { mode, uid: 501, gid: 20 });
  }
  assert.equal(ancestorMode({ mode: 0o555, uid: 0, gid: 0 }), 0o555);
  assert.equal(ancestorMode({ mode: 0o1777, uid: 0, gid: 0 }), 0o1777);
  assert.equal(ancestorMode({ mode: 0o755, uid: 0, gid: 62001 }), 0o755);
  for (const stat of [
    { mode: 0o755, uid: 62001, gid: 20 },
    { mode: 0o775, uid: 501, gid: 62001 },
    { mode: 0o1777, uid: 0, gid: 62001 },
  ])
    assert.throws(() => ancestorMode(stat), /candidate-writable/);
});

test("executable planning preserves safe owners/group write and immutable store permissions", () => {
  for (const [mode, expected] of [
    [0o555, 0o555],
    [0o755, 0o755],
    [0o775, 0o775],
    [0o700, 0o705],
    [0o777, 0o775],
  ]) {
    const stat = { mode, uid: 501, gid: 20 };
    assert.equal(executableMode(stat), expected);
    assert.deepEqual(stat, { mode, uid: 501, gid: 20 });
  }
  for (const stat of [
    { mode: 0o755, uid: 62001, gid: 20 },
    { mode: 0o775, uid: 501, gid: 62001 },
    { mode: 0o4755, uid: 0, gid: 0 },
    { mode: 0o2755, uid: 0, gid: 0 },
  ])
    assert.throws(() => executableMode(stat), /unsafe/);
});

const kernelIdentity = {
  uid: 62001,
  euid: 62001,
  gid: 62001,
  egid: 62001,
  groups: [62001],
};
test("kernel identity is exact while directory defaults remain separate facts", () => {
  const calls: { program: string; args: string[]; identity: unknown }[] = [];
  const facts = verifyCandidateIdentity((program, args, _cwd, identity) => {
    calls.push({ program, args, identity });
    return {
      status: 0,
      stdout:
        program === process.execPath ? JSON.stringify(kernelIdentity) : "62001 12 61 701 100\n",
    };
  });
  assert.deepEqual(facts, { ...kernelIdentity, directoryGroups: [62001, 12, 61, 701, 100] });
  assert.equal(calls[0].program, process.execPath);
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /process\.getgroups\(\)/);
  assert.match(calls[0].args[1], /process\.geteuid\(\)/);
  assert.deepEqual(calls[0].identity, { uid: 62001, gid: 62001 });
  assert.deepEqual(calls[1], {
    program: "/usr/bin/id",
    args: ["-G", "ci-candidate"],
    identity: undefined,
  });
  const gids = [...facts.groups, ...facts.directoryGroups];
  assert.doesNotThrow(() => validateNixDaemonConfig(nixConfig(["root"]), gids));
  assert.equal(ancestorMode({ uid: 511, gid: 100, mode: 0o555 }, gids), 0o555);
  assert.equal(executableMode({ uid: 511, gid: 100, mode: 0o555 }, gids), 0o555);
});

test("kernel probe rejects extra groups including every hosted directory default", () => {
  for (const groups of [
    [62001, 0],
    [0, 62001],
    [62001, 20],
    [62001, 12, 61, 701, 100],
    [],
    [62001, 62001],
  ]) {
    assert.throws(
      () =>
        verifyCandidateIdentity(() => ({
          status: 0,
          stdout: JSON.stringify({ ...kernelIdentity, groups }),
        })),
      /kernel identity/,
    );
  }
  for (const field of ["uid", "euid", "gid", "egid"])
    for (const value of [0, "62001", null])
      assert.throws(
        () =>
          verifyCandidateIdentity(() => ({
            status: 0,
            stdout: JSON.stringify({ ...kernelIdentity, [field]: value }),
          })),
        /kernel identity/,
      );
  for (const stdout of ["", "not JSON", "null", "[]", "{}"])
    assert.throws(() => verifyCandidateIdentity(() => ({ status: 0, stdout })), /identity/);
  assert.throws(
    () =>
      verifyCandidateIdentity(() => ({
        status: 1,
        stdout: JSON.stringify(kernelIdentity),
      })),
    /kernel identity/,
  );
});

test("directory group observation rejects malformed, missing-primary and failed lookups", () => {
  for (const stdout of ["", "12 100", "62001 admin", "62001 -1", "62001 4294967296"]) {
    assert.throws(
      () =>
        verifyCandidateIdentity((program) => ({
          status: 0,
          stdout: program === process.execPath ? JSON.stringify(kernelIdentity) : stdout,
        })),
      /directory groups/,
    );
  }
  assert.throws(
    () =>
      verifyCandidateIdentity((program) => ({
        status: program === process.execPath ? 0 : 1,
        stdout: JSON.stringify(kernelIdentity),
      })),
    /command failed/,
  );
});

function nixConfig(trusted: unknown = ["root", "@admin"], builders: unknown = "nixbld") {
  return { "trusted-users": { value: trusted }, "build-users-group": { value: builders } };
}

test("candidate cannot gain passwordless sudo or write controller files/evidence/metadata", () => {
  const calls: { program: string; args: string[]; identity: unknown }[] = [];
  verifyCandidateBoundary(
    "/trusted",
    "/evidence",
    "/private/git",
    (program, args, _cwd, identity) => {
      calls.push({ program, args, identity });
      return { status: program.endsWith("sudo") ? 1 : 0, stdout: "" };
    },
  );
  assert.deepEqual(calls[0], {
    program: "/usr/bin/sudo",
    args: ["-n", "/usr/bin/true"],
    identity: { uid: 62001, gid: 62001 },
  });
  assert.deepEqual(calls[1].args.slice(-3), [
    "/trusted/scripts/ci/probes.ts",
    "/evidence/.boundary-probe",
    "/private/git/config",
  ]);
  assert.match(calls[1].args[1], /EACCES/);
  assert.deepEqual(calls[1].identity, { uid: 62001, gid: 62001 });
  assert.throws(
    () =>
      verifyCandidateBoundary("/trusted", "/evidence", "/private/git", () => ({
        status: 0,
        stdout: "",
      })),
    /passwordless sudo/,
  );
  assert.throws(
    () =>
      verifyCandidateBoundary("/trusted", "/evidence", "/private/git", () => ({
        status: 1,
        stdout: "",
      })),
    /filesystem boundary/,
  );
});

test("nix daemon defaults trust root/admin but not the fresh candidate", () => {
  const groups = () => ({ gid: 80, members: ["runner"] });
  assert.doesNotThrow(() =>
    validateNixDaemonConfig(nixConfig(), [62001, 12, 61, 701, 100], groups),
  );
  assert.doesNotThrow(() =>
    validateNixDaemonConfig(nixConfig(["root", "@wheel", "0"]), [62001], groups),
  );
  assert.doesNotThrow(() => validateNixDaemonConfig(nixConfig([])));
});

test("nix daemon trust rejects wildcards and unknown account patterns", () => {
  for (const entry of ["*", "@*", "@ci-*", "*root", "ci-?", "@[abc]", "@", "", "root admin"])
    assert.throws(() => validateNixDaemonConfig(nixConfig(["root", entry])), /unknown or wildcard/);
});

test("nix daemon trust rejects explicit candidate names, ids and primary groups", () => {
  for (const entry of ["ci-candidate", "62001", "@ci-candidate", "@62001", "062001", "@062001"])
    assert.throws(() => validateNixDaemonConfig(nixConfig(["root", entry])), /candidate must not/);
});

test("nix trusted aliases and explicit members cannot overlap directory defaults", () => {
  const gids = [62001, 12, 61, 701, 100];
  for (const gid of gids) {
    assert.throws(
      () => validateNixDaemonConfig(nixConfig(["@alias"]), gids, () => ({ gid, members: [] })),
      /must not be trusted/,
    );
    assert.throws(
      () => validateNixDaemonConfig(nixConfig([`@${gid}`]), gids),
      /candidate|must not be trusted/,
    );
  }
  assert.throws(
    () =>
      validateNixDaemonConfig(nixConfig(["@alias"]), gids, () => ({
        gid: 80,
        members: ["runner", "ci-candidate"],
      })),
    /must not be trusted/,
  );
  assert.throws(() => validateNixDaemonConfig(nixConfig(["@admin"]), gids), /lookup is required/);
  assert.throws(
    () => validateNixDaemonConfig(nixConfig(["@admin"]), gids, () => ({ gid: NaN, members: [] })),
    /malformed/,
  );
  assert.throws(
    () =>
      validateNixDaemonConfig(nixConfig(["@admin"]), gids, () => ({
        gid: 80,
        members: ["bad member"],
      })),
    /malformed/,
  );
});

test("group cache lookups resolve aliases and parse explicit members on both platforms", () => {
  const calls: unknown[] = [];
  for (const platform of ["linux", "darwin"] as const) {
    const result = lookupGroup(platform, "alias", (program, args) => {
      calls.push({ program, args });
      return {
        status: 0,
        stdout:
          platform === "linux"
            ? "actual:x:100:runner,ci-candidate\n"
            : "name: actual\npassword: *\ngid: 100\nusers: runner ci-candidate\n\n",
      };
    });
    assert.deepEqual(result, { gid: 100, members: ["runner", "ci-candidate"] });
    assert.deepEqual(
      lookupGroup(platform, "empty", () => ({
        status: 0,
        stdout:
          platform === "linux" ? "empty:x:80:\n" : "name: empty\npassword: *\ngid: 80\nusers:\n",
      })),
      { gid: 80, members: [] },
    );
  }
  assert.deepEqual(calls, [
    { program: "/usr/bin/getent", args: ["group", "alias"] },
    { program: "/usr/bin/dscacheutil", args: ["-q", "group", "-a", "name", "alias"] },
  ]);
});

test("group cache lookup uncertainty fails closed", () => {
  for (const [platform, outputs] of [
    [
      "linux",
      [
        "",
        "admin:x:80",
        "admin:x:bad:runner",
        "admin:x:80:runner\nother:x:80:",
        "admin:x:4294967296:runner",
        "admin:x:80:bad member",
      ],
    ],
    [
      "darwin",
      [
        "",
        "name: admin\ngid: 80\n",
        "name: admin\nusers:\n",
        "name: admin\ngid: bad\nusers: runner",
        "name: admin\ngid: 80\ngid: 100\nusers:",
        "name: admin\ngid: 80\nusers:\nunknown: value",
      ],
    ],
  ] as const) {
    for (const stdout of outputs)
      assert.throws(
        () => lookupGroup(platform, "admin", () => ({ status: 0, stdout })),
        /group database/,
      );
    assert.throws(
      () => lookupGroup(platform, "admin", () => ({ status: 1, stdout: "" })),
      /command failed/,
    );
  }
  assert.throws(
    () =>
      lookupGroup("darwin", "*", () => {
        throw new Error("must not execute");
      }),
    /invalid group lookup/,
  );
});

test("observed directory gids reject writable ancestors and tools, not read-only runner homes", () => {
  const gids = [62001, 12, 61, 701, 100];
  for (const gid of gids) {
    const stat = { uid: 511, gid, mode: 0o775 };
    assert.throws(() => ancestorMode(stat, gids), /candidate-writable/);
    assert.throws(() => executableMode(stat, gids), /unsafe/);
    assert.deepEqual(stat, { uid: 511, gid, mode: 0o775 });
    assert.equal(ancestorMode({ ...stat, mode: 0o555 }, gids), 0o555);
    assert.equal(executableMode({ ...stat, mode: 0o555 }, gids), 0o555);
  }
});

test("nix daemon security metadata fails closed on missing or malformed values", () => {
  for (const config of [
    null,
    [],
    {},
    { "trusted-users": { value: ["root"] } },
    { "trusted-users": ["root"], "build-users-group": { value: "nixbld" } },
    { "trusted-users": { value: ["root"] }, "build-users-group": "nixbld" },
    nixConfig("root"),
    nixConfig([0]),
    nixConfig([null]),
    nixConfig([{}]),
    nixConfig(undefined, ""),
    nixConfig(["root"], " "),
    nixConfig(["root"], "nixbld extra"),
    nixConfig(["root"], "*"),
    nixConfig(["root"], []),
    nixConfig(["root"], null),
    { "trusted-users": {}, "build-users-group": {} },
  ])
    assert.throws(() => validateNixDaemonConfig(config), /metadata|build-users-group/);
});

test("nix security probe uses the fixed absolute tool and mocked root config query", () => {
  const calls: unknown[] = [];
  verifyNixDaemon("/nix/store/fixture/bin/nix", (program, args, cwd, identity) => {
    calls.push({ program, args, cwd, identity });
    return { status: 0, stdout: JSON.stringify(nixConfig(["root"])) };
  });
  assert.deepEqual(calls, [
    {
      program: "/nix/store/fixture/bin/nix",
      args: ["--extra-experimental-features", "nix-command", "show-config", "--json"],
      cwd: undefined,
      identity: undefined,
    },
  ]);
  assert.throws(
    () =>
      verifyNixDaemon("nix", () => {
        throw new Error("must not execute");
      }),
    /absolute/,
  );
  assert.throws(
    () => verifyNixDaemon("/fixed/nix", () => ({ status: 1, stdout: "" })),
    /command failed/,
  );
  assert.throws(
    () => verifyNixDaemon("/fixed/nix", () => ({ status: 0, stdout: "not JSON" })),
    /configuration JSON/,
  );
  assert.throws(
    () =>
      verifyNixDaemon("/fixed/nix", () => ({
        status: 0,
        stdout: JSON.stringify(nixConfig(["*"])),
      })),
    /wildcard/,
  );
});

test("nix root probe resolves every trusted group before accepting config", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const calls: string[] = [];
    const command: ControllerCommand = (program, args) => {
      calls.push(program);
      if (program === "/fixed/nix")
        return {
          status: 0,
          stdout: JSON.stringify(nixConfig(["root", "@admin", "@wheel"])),
        };
      const name = args.at(-1)!;
      return {
        status: 0,
        stdout:
          platform === "linux"
            ? `${name}:x:80:runner\n`
            : `name: ${name}\npassword: *\ngid: 80\nusers: runner\n`,
      };
    };
    verifyNixDaemon("/fixed/nix", command, [62001, 12, 61, 701, 100], platform);
    assert.deepEqual(calls, [
      "/fixed/nix",
      ...Array(2).fill(platform === "linux" ? "/usr/bin/getent" : "/usr/bin/dscacheutil"),
    ]);
    assert.throws(
      () => verifyNixDaemon("/fixed/nix", command, [62001, 80], platform),
      /must not be trusted/,
    );
    assert.throws(
      () =>
        verifyNixDaemon(
          "/fixed/nix",
          (program) =>
            program === "/fixed/nix"
              ? { status: 0, stdout: JSON.stringify(nixConfig()) }
              : { status: 1, stdout: "" },
          [62001],
          platform,
        ),
      /command failed/,
    );
  }
});

test("permission planning strips setuid and writable trust while preserving executables", () => {
  assert.equal(permissionMode("trusted", true, false), 0o555);
  assert.equal(permissionMode("trusted", false, false), 0o444);
  assert.equal(permissionMode("trusted", false, true), 0o555);
  assert.equal(permissionMode("private", true, false), 0o700);
  assert.equal(permissionMode("private", false, true), 0o600);
  assert.equal(permissionMode("public", true, false), 0o755);
  assert.equal(permissionMode("public", false, true), 0o644);
  assert.equal(permissionMode("candidate", false, true), 0o755);
});

test("candidate symlink ownership never changes its external target permissions", () => {
  const f = fixture();
  try {
    const root = join(f.dir, "candidate");
    mkdirSync(root);
    const external = join(f.dir, "trusted");
    writeFileSync(external, "trusted");
    chmodSync(external, 0o400);
    symlinkSync(external, join(root, "escape"));
    writeFileSync(join(root, "tool"), "tool");
    chmodSync(join(root, "tool"), 0o4755);
    secureTree(root, "candidate", uid, gid);
    assert.equal(permissions(external), 0o400);
    assert.equal(readFileSync(external, "utf8"), "trusted");
    assert(lstatSync(join(root, "escape")).isSymbolicLink());
    assert.equal(lstatSync(join(root, "tool")).mode & 0o7777, 0o755);
  } finally {
    f.close();
  }
});

test("trusted symlinks must remain within protected tree; hardlinks fail closed", () => {
  const f = fixture();
  try {
    const root = join(f.dir, "trusted");
    mkdirSync(root);
    writeFileSync(join(root, "source"), "trusted");
    symlinkSync("source", join(root, "internal"));
    secureTree(root, "trusted", uid, gid);
    assert.equal(permissions(join(root, "source")), 0o444);
    chmodSync(root, 0o755);
    writeFileSync(join(f.dir, "external"), "outside");
    symlinkSync("../external", join(root, "escape"));
    assert.throws(() => secureTree(root, "trusted", uid, gid), /symlink/);
    chmodSync(root, 0o755);
    rmSync(join(root, "escape"));
    linkSync(join(root, "source"), join(root, "hardlink"));
    assert.throws(() => secureTree(root, "candidate", uid, gid), /hardlink/);
  } finally {
    chmodSync(join(f.dir, "trusted"), 0o755);
    f.close();
  }
});

test("private metadata and finalized evidence use separate disclosure permissions", () => {
  const f = fixture();
  try {
    const root = join(f.dir, "evidence");
    mkdirSync(root);
    writeFileSync(join(root, "phase.log"), "evidence");
    secureTree(root, "private", uid, gid);
    assert.equal(permissions(root), 0o700);
    assert.equal(permissions(join(root, "phase.log")), 0o600);
    secureTree(root, "public", uid, gid);
    assert.equal(permissions(root), 0o755);
    assert.equal(permissions(join(root, "phase.log")), 0o644);
    symlinkSync(join(f.dir, "external"), join(root, "escape"));
    assert.throws(() => secureTree(root, "public", uid, gid), /symlink/);
  } finally {
    f.close();
  }
});

test("snapshot config is independent of candidate config and .git replacements", () => {
  const f = fixture();
  try {
    const root = join(f.dir, "candidate");
    mkdirSync(root);
    const metadata = join(root, ".git");
    mkdirSync(metadata);
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(metadata, "config"), "[core]\nfsmonitor = evil\n");
    const privateRoot = join(f.dir, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    const snapshot = snapshotGit(root, privateRoot);
    rmSync(metadata, { recursive: true });
    symlinkSync(privateRoot, metadata);
    assert.equal(readFileSync(join(snapshot, "HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert(!readFileSync(join(snapshot, "config"), "utf8").includes("evil"));
    assert(!lstatSync(join(snapshot, "HEAD")).isSymbolicLink());
    assert.equal(permissions(privateRoot), 0o700);
  } finally {
    f.close();
  }
});

test("snapshot rejects gitfiles, metadata symlinks and external object databases", () => {
  for (const variant of ["gitfile", "symlink", "commondir", "alternates"]) {
    const f = fixture();
    try {
      const root = join(f.dir, "candidate");
      mkdirSync(root);
      const metadata = join(root, ".git");
      const privateRoot = join(f.dir, "private");
      mkdirSync(privateRoot);
      if (variant === "gitfile") writeFileSync(metadata, "gitdir: /outside\n");
      else {
        mkdirSync(metadata);
        if (variant === "symlink") symlinkSync("/outside", join(metadata, "HEAD"));
        if (variant === "commondir") writeFileSync(join(metadata, "commondir"), "/outside\n");
        if (variant === "alternates") {
          mkdirSync(join(metadata, "objects/info"), { recursive: true });
          writeFileSync(join(metadata, "objects/info/alternates"), "/outside\n");
        }
      }
      assert.throws(() => snapshotGit(root, privateRoot), /standalone|indirect/);
      assert(!existsSync(join(privateRoot, "git")));
    } finally {
      f.close();
    }
  }
});

test("precheck uses only snapshot metadata and disables hooks and fsmonitor", () => {
  const calls: string[][] = [];
  const mock: ControllerCommand = (_program, args) => {
    calls.push(args);
    return { status: 0, stdout: args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "" };
  };
  precheckSnapshot("/candidate", "/private/git", "a".repeat(40), mock);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert(args.includes("--git-dir=/private/git"));
    assert(args.includes("--work-tree=/candidate"));
    assert(args.includes("core.fsmonitor=false"));
    assert(args.includes("core.hooksPath=/dev/null"));
  }
  assert.throws(() => precheckSnapshot("/candidate", "/private/git", "b".repeat(40), mock), /HEAD/);
  assert.throws(
    () =>
      precheckSnapshot("/candidate", "/private/git", "a".repeat(40), (_program, args) => ({
        status: 0,
        stdout: args.includes("rev-parse") ? "a".repeat(40) : " M file\n",
      })),
    /clean/,
  );
});

test("real git precheck detects drift even after candidate replaces .git", () => {
  const f = fixture();
  try {
    const root = join(f.dir, "candidate");
    mkdirSync(root);
    // Fresh hosted Darwin exhausted 15s before git init returned. Keep setup
    // bounded without turning host startup latency into a drift-policy failure.
    const git = (args: string[]) =>
      execFileSync("/usr/bin/git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: f.dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
    git(["init", "--quiet"]);
    writeFileSync(join(root, "tracked"), "original\n");
    git(["add", "tracked"]);
    git([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const head = git(["rev-parse", "HEAD"]).trim();
    git(["update-index", "--assume-unchanged", "tracked"]);
    writeFileSync(join(root, "tracked"), "hidden change\n");
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=no"]), "");
    const privateRoot = join(f.dir, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    const snapshot = snapshotGit(root, privateRoot);
    const command: ControllerCommand = (program, args, cwd) => ({
      status: 0,
      stdout: execFileSync(program, args, {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: f.dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }),
    });
    assert.throws(() => precheckSnapshot(root, snapshot, head, command), /clean/);
    writeFileSync(join(root, "tracked"), "original\n");
    precheckSnapshot(root, snapshot, head, command);
    rmSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "tracked"), "attacker change\n");
    assert.throws(() => precheckSnapshot(root, snapshot, head, command), /clean/);
  } finally {
    f.close();
  }
});

test("path containment checks distinguish siblings and parent escapes", () => {
  assert(within("/trusted", "/trusted/scripts/ci"));
  assert(within("/trusted", "/trusted"));
  assert(!within("/trusted", "/trusted-evil"));
  assert(!within("/trusted", "/candidate"));
});
