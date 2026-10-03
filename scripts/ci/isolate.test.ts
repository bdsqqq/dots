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

test("spawn identity probe explicitly drops uid/gid and rejects extra groups", () => {
  const calls: { program: string; args: string[]; identity: unknown }[] = [];
  verifyCandidateIdentity((program, args, _cwd, identity) => {
    calls.push({ program, args, identity });
    return { status: 0, stdout: "62001\n" };
  });
  assert.deepEqual(
    calls,
    ["-u", "-G"].map((flag) => ({
      program: "/usr/bin/id",
      args: [flag],
      identity: { uid: 62001, gid: 62001 },
    })),
  );
  for (const groups of ["62001 0\n", "0 62001\n", "62001 20\n", "62001 999\n", ""]) {
    assert.throws(
      () =>
        verifyCandidateIdentity((_program, args) => ({
          status: 0,
          stdout: args[0] === "-u" ? "62001\n" : groups,
        })),
      /only uid\/gid/,
    );
  }
  assert.throws(
    () => verifyCandidateIdentity(() => ({ status: 0, stdout: "0\n" })),
    /only uid\/gid/,
  );
  assert.throws(
    () => verifyCandidateIdentity(() => ({ status: 1, stdout: "62001\n" })),
    /only uid\/gid/,
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
  assert.doesNotThrow(() => validateNixDaemonConfig(nixConfig()));
  assert.doesNotThrow(() => validateNixDaemonConfig(nixConfig(["root", "@wheel", "0"])));
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
    return { status: 0, stdout: JSON.stringify(nixConfig()) };
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
    const git = (args: string[]) =>
      execFileSync("/usr/bin/git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
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
