import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativePlatform, runPlan, validatePlan } from "./run.ts";
import type { Plan, Platform } from "./policy.ts";

export const candidateIdentity = { uid: 62001, gid: 62001, name: "ci-candidate" } as const;
export type AccountCommand = { program: string; args: string[] };
export type CommandReply = { status: number | null; stdout: string };
export type ControllerCommand = (
  program: string,
  args: string[],
  cwd?: string,
  identity?: { uid: number; gid: number },
) => CommandReply;

/** only disposable github VMs may change account databases or ancestor permissions. */
export function assertHostedRoot(uid: number | undefined, env: NodeJS.ProcessEnv): void {
  if (uid !== 0 || env.CI !== "true" || env.GITHUB_ACTIONS !== "true")
    throw new Error("isolation requires uid 0 and CI=true GITHUB_ACTIONS=true");
}

export const controllerCommand: ControllerCommand = (program, args, cwd, identity) => {
  const reply = spawnSync(program, args, {
    ...identity,
    cwd,
    timeout: 15_000,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/var/empty",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
  if (reply.error || reply.signal)
    throw new Error(
      `controller command failed: ${program}: ${reply.error?.message ?? reply.signal}`,
    );
  return { status: reply.status, stdout: reply.stdout ?? "" };
};

function checked(
  command: ControllerCommand,
  program: string,
  args: string[],
  cwd?: string,
): string {
  const reply = command(program, args, cwd);
  if (reply.status !== 0)
    throw new Error(`controller command failed: ${program} (${reply.status})`);
  return reply.stdout;
}

/** never reuse an account: existing groups, credentials and sudo policy are not trusted. */
export function accountCommands(platform: NodeJS.Platform, home: string): AccountCommand[] {
  const { uid, gid, name } = candidateIdentity;
  if (platform === "linux")
    return [
      { program: "/usr/sbin/groupadd", args: ["--gid", String(gid), name] },
      {
        program: "/usr/sbin/useradd",
        args: [
          "--uid",
          String(uid),
          "--gid",
          String(gid),
          "--groups",
          "",
          "--no-create-home",
          "--no-user-group",
          "--home-dir",
          home,
          "--shell",
          "/usr/sbin/nologin",
          name,
        ],
      },
    ];
  if (platform !== "darwin") throw new Error("unsupported account platform");
  const create = (path: string, ...args: string[]): AccountCommand => ({
    program: "/usr/bin/dscl",
    args: [".", "-create", path, ...args],
  });
  return [
    create(`/Groups/${name}`),
    create(`/Groups/${name}`, "PrimaryGroupID", String(gid)),
    create(`/Groups/${name}`, "Password", "*"),
    create(`/Users/${name}`),
    create(`/Users/${name}`, "UniqueID", String(uid)),
    create(`/Users/${name}`, "PrimaryGroupID", String(gid)),
    create(`/Users/${name}`, "NFSHomeDirectory", home),
    create(`/Users/${name}`, "UserShell", "/usr/bin/false"),
    create(`/Users/${name}`, "Password", "*"),
  ];
}

export function provisionAccount(
  platform: NodeJS.Platform,
  home: string,
  command: ControllerCommand,
): void {
  const { name, uid, gid } = candidateIdentity;
  if (platform === "linux") {
    const users = checked(command, "/usr/bin/getent", ["passwd"]);
    const groups = checked(command, "/usr/bin/getent", ["group"]);
    if (
      users
        .trim()
        .split("\n")
        .some((line) => {
          const fields = line.split(":");
          return fields[0] === name || fields[2] === String(uid);
        }) ||
      groups
        .trim()
        .split("\n")
        .some((line) => {
          const fields = line.split(":");
          return (
            fields[0] === name || fields[2] === String(gid) || fields[3]?.split(",").includes(name)
          );
        })
    )
      throw new Error("candidate account or group collision");
  } else if (platform === "darwin") {
    for (const [kind, field, id] of [
      ["Users", "UniqueID", uid],
      ["Groups", "PrimaryGroupID", gid],
    ] as const) {
      const listing = checked(command, "/usr/bin/dscl", [".", "-list", `/${kind}`, field]);
      if (
        listing
          .trim()
          .split("\n")
          .some((line) => {
            const fields = line.trim().split(/\s+/);
            return fields[0] === name || fields[1] === String(id);
          })
      )
        throw new Error("candidate account or group collision");
    }
    const memberships = checked(command, "/usr/bin/dscl", [
      ".",
      "-list",
      "/Groups",
      "GroupMembership",
    ]);
    if (memberships.split(/\s+/).includes(name))
      throw new Error("candidate has stale group membership");
  } else throw new Error("unsupported account platform");
  for (const spec of accountCommands(platform, home)) checked(command, spec.program, spec.args);
}

export type IdentityFacts = {
  uid: number;
  euid: number;
  gid: number;
  egid: number;
  groups: number[];
  directoryGroups: number[];
};
const numericId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

/**
 * apple shell_cmds/id.c queries directory defaults, not kernel credentials.
 * node v24.18.0 src/node_credentials.cc uses getgroups; libuv unix/process.c
 * drops groups before setgid/setuid (xnu bsd/kern/kern_prot.c).
 */
export function verifyCandidateIdentity(command: ControllerCommand): IdentityFacts {
  const { uid, gid } = candidateIdentity;
  const probe = `console.log(JSON.stringify({
    uid: process.getuid(), euid: process.geteuid(),
    gid: process.getgid(), egid: process.getegid(), groups: process.getgroups()
  }))`;
  const reply = command(process.execPath, ["-e", probe], undefined, { uid, gid });
  let value: unknown;
  try {
    value = JSON.parse(reply.stdout);
  } catch {
    throw new Error("invalid candidate process identity JSON");
  }
  if (
    reply.status !== 0 ||
    typeof value !== "object" ||
    value === null ||
    !("uid" in value) ||
    value.uid !== uid ||
    !("euid" in value) ||
    value.euid !== uid ||
    !("gid" in value) ||
    value.gid !== gid ||
    !("egid" in value) ||
    value.egid !== gid ||
    !("groups" in value) ||
    !Array.isArray(value.groups) ||
    value.groups.length !== 1 ||
    value.groups[0] !== gid
  )
    throw new Error("candidate kernel identity must contain only uid/gid 62001");
  const directory = checked(command, "/usr/bin/id", ["-G", candidateIdentity.name]).trim();
  if (!/^[0-9]+(?:\s+[0-9]+)*$/.test(directory))
    throw new Error("invalid candidate directory groups");
  const directoryGroups = directory.split(/\s+/).map(Number);
  if (!directoryGroups.every(numericId) || !directoryGroups.includes(gid))
    throw new Error("invalid candidate directory groups");
  return { uid, euid: uid, gid, egid: gid, groups: [gid], directoryGroups };
}

/** effective denial matters more than group labels when an image's sudo policy changes. */
export function verifyCandidateBoundary(
  trusted: string,
  output: string,
  gitDir: string,
  command: ControllerCommand,
): void {
  const { uid, gid } = candidateIdentity;
  const sudo = command("/usr/bin/sudo", ["-n", "/usr/bin/true"], undefined, { uid, gid });
  if (sudo.status === 0) throw new Error("candidate has passwordless sudo");
  const probe = `
    const fs = require('node:fs');
    for (const file of process.argv.slice(1)) {
      try {
        const fd = fs.openSync(file, file.endsWith('.boundary-probe') ? 'wx' : 'r+');
        fs.closeSync(fd);
        throw new Error('candidate can write controller resource: ' + file);
      } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      }
    }
  `;
  const reply = command(
    process.execPath,
    [
      "-e",
      probe,
      join(trusted, "scripts/ci/probes.ts"),
      join(output, ".boundary-probe"),
      join(gitDir, "config"),
    ],
    undefined,
    { uid, gid },
  );
  if (reply.status !== 0) throw new Error("candidate filesystem boundary probe failed");
}

export type GroupRecord = { gid: number; members: string[] };
export type GroupLookup = (name: string) => GroupRecord;
const accountPattern = /^(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)$/;

/** use the platform's getgrnam database, including aliases and directory-service cache. */
export function lookupGroup(
  platform: NodeJS.Platform,
  name: string,
  command: ControllerCommand,
): GroupRecord {
  if (!accountPattern.test(name)) throw new Error("invalid group lookup name");
  let id: string;
  let members: string[];
  if (platform === "linux") {
    const output = checked(command, "/usr/bin/getent", ["group", name]).trim();
    const fields = output.split(":");
    if (fields.length !== 4 || !accountPattern.test(fields[0]) || output.includes("\n"))
      throw new Error("malformed group database result");
    id = fields[2];
    members = fields[3] === "" ? [] : fields[3].split(",");
  } else if (platform === "darwin") {
    const output = checked(command, "/usr/bin/dscacheutil", ["-q", "group", "-a", "name", name]);
    const fields = new Map<string, string>();
    for (const line of output.trim().split("\n")) {
      const match = /^(name|password|gid|users):\s*(.*?)\s*$/.exec(line);
      if (!match || fields.has(match[1])) throw new Error("malformed group database result");
      fields.set(match[1], match[2]);
    }
    if (!accountPattern.test(fields.get("name") ?? "") || !fields.has("users"))
      throw new Error("incomplete group database result");
    id = fields.get("gid") ?? "";
    const users = fields.get("users")!;
    members = users === "" ? [] : users.split(/\s+/);
  } else throw new Error("unsupported group database platform");
  if (
    !/^[0-9]+$/.test(id) ||
    !numericId(Number(id)) ||
    !members.every((member) => accountPattern.test(member))
  )
    throw new Error("malformed group database result");
  return { gid: Number(id), members };
}

/**
 * trust must exclude both kernel groups and directory defaults used by getgrouplist.
 * assumes the installer's fresh daemon reads the same protected system config;
 * client output does not introspect an already-running daemon's state.
 */
export function validateNixDaemonConfig(
  config: unknown,
  candidateGids: readonly number[] = [candidateIdentity.gid],
  groups?: GroupLookup,
): void {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(config) || !object(config["trusted-users"]) || !object(config["build-users-group"]))
    throw new Error("missing nix daemon security metadata");
  const trusted = config["trusted-users"].value;
  const builders = config["build-users-group"].value;
  const account = accountPattern;
  if (
    !Array.isArray(trusted) ||
    !trusted.every(
      (entry): entry is string =>
        typeof entry === "string" && account.test(entry.startsWith("@") ? entry.slice(1) : entry),
    )
  )
    throw new Error("unknown or wildcard nix trusted-users metadata");
  if (typeof builders !== "string" || !account.test(builders))
    throw new Error("nix daemon requires a nonempty build-users-group");
  for (const entry of trusted) {
    const name = entry.startsWith("@") ? entry.slice(1) : entry;
    if (
      name === candidateIdentity.name ||
      (/^[0-9]+$/.test(name) && Number(name) === candidateIdentity.uid)
    )
      throw new Error("candidate must not be a trusted nix daemon client");
    if (entry.startsWith("@")) {
      if (/^[0-9]+$/.test(name) && candidateGids.includes(Number(name)))
        throw new Error("candidate directory group must not be trusted by nix");
      if (!groups) throw new Error("nix trusted group lookup is required");
      const group = groups(name);
      if (
        !group ||
        !numericId(group.gid) ||
        !Array.isArray(group.members) ||
        !group.members.every((member) => typeof member === "string" && account.test(member))
      )
        throw new Error("malformed trusted group lookup");
      if (candidateGids.includes(group.gid) || group.members.includes(candidateIdentity.name))
        throw new Error("candidate directory group must not be trusted by nix");
    }
  }
}

/** controllerCommand omits NIX_CONFIG and mutable user config; never query via candidate PATH. */
export function verifyNixDaemon(
  nix: string,
  command: ControllerCommand,
  candidateGids: readonly number[] = [candidateIdentity.gid],
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isAbsolute(nix)) throw new Error("nix security probe requires an absolute executable");
  const output = checked(command, nix, [
    "--extra-experimental-features",
    "nix-command",
    "show-config",
    "--json",
  ]);
  let config: unknown;
  try {
    config = JSON.parse(output);
  } catch {
    throw new Error("invalid nix daemon configuration JSON");
  }
  validateNixDaemonConfig(config, candidateGids, (name) => lookupGroup(platform, name, command));
}

export function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

export type TreeMode = "trusted" | "candidate" | "private" | "public";
export function permissionMode(mode: TreeMode, directory: boolean, executable: boolean): number {
  if (mode === "trusted") return directory || executable ? 0o555 : 0o444;
  if (mode === "private") return directory ? 0o700 : 0o600;
  if (mode === "public") return directory ? 0o755 : 0o644;
  return directory || executable ? 0o755 : 0o644;
}

/** lstat/lchown avoid turning candidate symlinks into writes to controller resources. */
export function secureTree(
  path: string,
  mode: TreeMode,
  uid: number,
  gid: number,
  boundary = path,
): void {
  const stat = lstatSync(path);
  if (mode === "trusted") boundary = realpathSync(boundary);
  if (stat.isSymbolicLink()) {
    if (mode !== "candidate" && !(mode === "trusted" && within(boundary, realpathSync(path))))
      throw new Error(`symlink in protected tree: ${path}`);
    lchownSync(path, uid, gid);
    return;
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`special file in tree: ${path}`);
  if (stat.isFile() && stat.nlink !== 1) throw new Error(`hardlink in tree: ${path}`);
  chownSync(path, uid, gid);
  chmodSync(path, permissionMode(mode, stat.isDirectory(), !!(stat.mode & 0o111)));
  if (stat.isDirectory())
    for (const name of readdirSync(path)) secureTree(join(path, name), mode, uid, gid, boundary);
}

type PermissionStat = { mode: number; uid: number; gid: number };

/** sticky parents protect other owners' names; runner ownership/write access must survive. */
export function ancestorMode(
  stat: PermissionStat,
  candidateGids: readonly number[] = [candidateIdentity.gid],
): number {
  if (stat.uid === candidateIdentity.uid || (candidateGids.includes(stat.gid) && stat.mode & 0o020))
    throw new Error("candidate-writable controller ancestor");
  const mode = (stat.mode & 0o7777) | 0o005;
  return mode & 0o1000 ? mode : mode & ~0o002;
}

export function executableMode(
  stat: PermissionStat,
  candidateGids: readonly number[] = [candidateIdentity.gid],
): number {
  if (
    stat.uid === candidateIdentity.uid ||
    (candidateGids.includes(stat.gid) && stat.mode & 0o020) ||
    stat.mode & 0o6000
  )
    throw new Error("unsafe toolchain executable");
  return ((stat.mode & 0o7777) | 0o005) & ~0o002;
}

/** protected names also need protected parents; chmod of a leaf does not prevent rename. */
export function protectAncestors(
  path: string,
  candidateGids: readonly number[] = [candidateIdentity.gid],
): void {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory()) throw new Error(`unsafe controller ancestor: ${cursor}`);
    const mode = ancestorMode(stat, candidateGids);
    if ((stat.mode & 0o7777) !== mode) chmodSync(cursor, mode);
    if (dirname(cursor) === cursor) break;
  }
}

function accessibleToolchain(
  root: string,
  path: string,
  candidateGids: readonly number[] = [candidateIdentity.gid],
): Record<string, string> {
  const tools: Record<string, string> = {};
  const entries = path.split(":");
  for (const entry of entries) {
    if (!isAbsolute(entry)) throw new Error("PATH must contain only absolute directories");
    if (within(root, resolve(entry))) throw new Error("candidate-owned PATH directory");
    if (!existsSync(entry)) {
      let parent = dirname(entry);
      while (!existsSync(parent)) parent = dirname(parent);
      const actualParent = realpathSync(parent);
      if (within(root, actualParent)) throw new Error("candidate-owned PATH ancestor");
      protectAncestors(actualParent, candidateGids);
      continue;
    }
    const actual = realpathSync(entry);
    if (within(root, actual)) throw new Error("candidate-owned PATH directory");
    protectAncestors(realpathSync(dirname(entry)), candidateGids);
    protectAncestors(actual, candidateGids);
  }
  for (const name of ["node", "pnpm", "nix", "nix-instantiate", "git"]) {
    const tool =
      name === "node"
        ? process.execPath
        : entries.map((entry) => join(entry, name)).find(existsSync);
    if (!tool) throw new Error(`missing toolchain executable: ${name}`);
    const actual = realpathSync(tool);
    const stat = lstatSync(actual);
    if (within(root, actual) || stat.uid === candidateIdentity.uid || !stat.isFile())
      throw new Error(`candidate-owned toolchain executable: ${name}`);
    protectAncestors(dirname(actual), candidateGids);
    // Store executables may be immutable; already public, non-writable files need no edit.
    const mode = executableMode(stat, candidateGids);
    if ((stat.mode & 0o7777) !== mode) chmodSync(actual, mode);
    tools[name] = actual;
  }
  return tools;
}

/** git reads a detached, root-only snapshot with no candidate config, hooks or alternates. */
export function snapshotGit(root: string, privateRoot: string): string {
  const source = join(root, ".git");
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
    throw new Error("candidate requires a standalone .git directory");
  const inspect = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error("indirect git metadata is not supported");
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(source);
  for (const file of ["commondir", "objects/info/alternates", "objects/info/http-alternates"])
    if (existsSync(join(source, file))) throw new Error("indirect git metadata is not supported");
  const gitDir = join(privateRoot, "git");
  cpSync(source, gitDir, { recursive: true, dereference: false });
  writeFileSync(join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  // An attacker-controlled index could hide modifications with assume-unchanged bits.
  rmSync(join(gitDir, "index"), { force: true });
  // The private parent is the security boundary; git may need to refresh its index.
  return gitDir;
}

export function precheckSnapshot(
  root: string,
  gitDir: string,
  head: string,
  command: ControllerCommand,
): void {
  const args = [
    `--git-dir=${gitDir}`,
    `--work-tree=${root}`,
    "-c",
    "safe.directory=*",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
  if (checked(command, "/usr/bin/git", [...args, "rev-parse", "HEAD"], root).trim() !== head)
    throw new Error("worker candidate HEAD does not match plan");
  checked(command, "/usr/bin/git", [...args, "read-tree", "HEAD"], root);
  if (
    checked(
      command,
      "/usr/bin/git",
      [...args, "status", "--porcelain=v1", "--untracked-files=no"],
      root,
    )
  )
    throw new Error("worker candidate tracked checkout must be clean");
}

function flags(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (
      !["--root", "--trusted", "--plan", "--platform", "--output"].includes(name) ||
      result.has(name) ||
      !argv[index + 1]
    )
      throw new Error("invalid isolation flags");
    result.set(name, argv[index + 1]);
  }
  if (result.size !== 5)
    throw new Error("isolate.ts requires root, trusted, plan, platform and output");
  return result;
}

/** root retains certification; only runPlan children receive the candidate uid/gid. */
export async function main(argv: string[]): Promise<void> {
  assertHostedRoot(process.getuid?.(), process.env);
  if (!process.setgroups) throw new Error("controller cannot clear supplementary groups");
  process.setgroups([]);
  const values = flags(argv);
  const root = realpathSync(values.get("--root")!);
  const trusted = realpathSync(values.get("--trusted")!);
  const controller = realpathSync(fileURLToPath(import.meta.url));
  if (!within(trusted, controller)) throw new Error("controller must run from trusted checkout");
  const planPath = realpathSync(values.get("--plan")!);
  if (within(root, planPath)) throw new Error("verification plan must live outside candidate");
  const plan: Plan = JSON.parse(readFileSync(planPath, "utf8"));
  validatePlan(plan);
  const requested = values.get("--platform")!;
  const platform: Platform = requested === "native" ? nativePlatform() : (requested as Platform);
  if (platform !== nativePlatform())
    throw new Error("worker does not match requested native platform");
  const outputArg = resolve(values.get("--output")!);
  if (existsSync(outputArg)) throw new Error("evidence output must be fresh");
  const output = join(
    realpathSync(dirname(outputArg)),
    outputArg.slice(dirname(outputArg).length + 1),
  );
  if (
    within(root, trusted) ||
    within(trusted, root) ||
    within(root, output) ||
    within(output, root) ||
    within(trusted, output) ||
    within(output, trusted)
  )
    throw new Error("candidate, trusted and evidence trees must be disjoint");
  // Sticky ancestors protect root-owned evidence, but not a candidate-owned checkout name.
  if (lstatSync(dirname(root)).mode & 0o1000)
    throw new Error("candidate checkout requires a non-sticky protected parent");
  protectAncestors(dirname(root));
  protectAncestors(dirname(trusted));
  protectAncestors(dirname(output));
  secureTree(trusted, "trusted", 0, 0);
  const toolPath = `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  accessibleToolchain(root, toolPath);
  const temporary = realpathSync(tmpdir());
  protectAncestors(temporary);
  mkdirSync(output, { mode: 0o700 });
  chownSync(output, 0, 0);
  let privateRoot: string | undefined;
  let home: string | undefined;
  try {
    privateRoot = mkdtempSync(join(temporary, "ci-controller-"));
    chmodSync(privateRoot, 0o700);
    home = mkdtempSync(join(temporary, "ci-candidate-home-"));
    const gitDir = snapshotGit(root, privateRoot);
    secureTree(privateRoot, "private", 0, 0);
    precheckSnapshot(root, gitDir, plan.head, controllerCommand);
    provisionAccount(process.platform, home, controllerCommand);
    const identity = verifyCandidateIdentity(controllerCommand);
    const candidateGids = [...new Set([...identity.groups, ...identity.directoryGroups])];
    for (const parent of [dirname(root), dirname(trusted), dirname(output), temporary])
      protectAncestors(parent, candidateGids);
    const tools = accessibleToolchain(root, toolPath, candidateGids);
    verifyNixDaemon(tools.nix, controllerCommand, candidateGids);
    secureTree(root, "candidate", candidateIdentity.uid, candidateIdentity.gid);
    secureTree(home, "candidate", candidateIdentity.uid, candidateIdentity.gid);
    verifyCandidateBoundary(trusted, output, gitDir, controllerCommand);
    const options = {
      root,
      output,
      execution: { uid: candidateIdentity.uid, gid: candidateIdentity.gid, home, gitDir },
    };
    const receipt = await runPlan(plan, platform, options);
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.errors.length || receipt.results.some((result) => result.status !== "passed"))
      process.exitCode = 1;
  } finally {
    // The uid is never reused on this VM. Home cleanup must not traverse candidate links.
    try {
      if (home) rmSync(home, { recursive: true, force: true });
    } finally {
      try {
        if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
      } finally {
        secureTree(output, "public", 0, 0);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
