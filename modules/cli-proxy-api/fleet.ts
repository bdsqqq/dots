import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../tool-auth/process.ts";
import { operation, failure, journalId, type EventSink } from "./events.ts";

class FleetCommandError extends Error {}

/** flake output names own membership without forcing host configurations. */
export function configuredHosts(flakeRef = `git+${new URL("../../", import.meta.url).href}`): string[] {
  const result = spawnSync("nix", ["eval", "--json", "--impure", "--no-write-lock-file", "--expr",
    `let flake = builtins.getFlake ${JSON.stringify(flakeRef)}; in builtins.attrNames ((flake.darwinConfigurations or {}) // (flake.nixosConfigurations or {}))`],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new FleetCommandError("cannot read the configured fleet; Nix output withheld", { cause: result.error });
  const hosts: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(hosts) || hosts.some(host => typeof host !== "string")) throw new Error("invalid fleet inventory");
  return hosts;
}
export function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function identity(value: any) {
  if (value.user !== "bdsqqq" || !Number.isInteger(value.uid) || value.uid < 500 || !["/home/bdsqqq", "/Users/bdsqqq"].includes(value.home) || value.owner !== value.uid || !["Linux", "Darwin"].includes(value.os)) throw new Error("unexpected native identity or home ownership");
  return value as { user: string; uid: number; home: string; owner: number; os: string };
}
function ssh(host: string, command: string, input?: string, timeout = 15000) {
  // Keep maintenance probes independent of stale interactive control sockets.
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ControlMaster=no", "-o", "ControlPath=none", host, command], { input, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new FleetCommandError(`SSH operation failed on ${host} (exit ${result.status}); private output withheld`, { cause: result.error });
  return result.stdout.trim();
}
const nativeNode = 'node=$(command -v node || true); if test -z "$node"; then for n in /nix/store/*nodejs-24*/bin/node; do test -x "$n" && node="$n"; done; fi; test -n "$node" || exit 127; ';
const checkIdentity = `${nativeNode} "$node" --input-type=module -e 'import{statSync}from"node:fs";import{userInfo,type}from"node:os";console.log(JSON.stringify({user:userInfo().username,uid:process.getuid(),home:process.env.HOME,owner:statSync(process.env.HOME).uid,os:type()}))'`;

export function packageExpression(repo: string) {
  return `let
    lock = builtins.fromJSON (builtins.readFile ${JSON.stringify(`${repo}/flake.lock`)});
    nixpkgs = builtins.fetchTree lock.nodes.nixpkgs.locked;
    pkgs = import nixpkgs { system = builtins.currentSystem; config.allowUnfree = true; };
    lib = pkgs.lib;
    evaluated = lib.evalModules {
      specialArgs = { inherit pkgs; hostSystem = builtins.currentSystem; };
      modules = [ ${JSON.stringify(`${repo}/modules/cli-proxy-api/default.nix`)}
        ({ lib, ... }: {
          options.my.primaryUser = lib.mkOption { type = lib.types.str; };
          options.my.paths = lib.mkOption { type = lib.types.attrs; };
          options.home-manager.users.bdsqqq.home.homeDirectory = lib.mkOption { type = lib.types.str; };
          options.home-manager.users.bdsqqq.home.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = []; };
          options.home-manager.users.bdsqqq.home.activation = lib.mkOption { type = lib.types.attrs; default = {}; };
          options.home-manager.users.bdsqqq.launchd = lib.mkOption { type = lib.types.attrs; default = {}; };
          options.assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = []; };
          config.my.primaryUser = "bdsqqq";
          config.my.cliProxyApi.sourceDirectory = ${JSON.stringify(`${repo}/modules/cli-proxy-api`)};
          config.home-manager.users.bdsqqq.home.homeDirectory = builtins.getEnv "HOME";
        }) ];
    };
  in evaluated.config.my.cliProxyApi.toolsPackage`;
}

/** Exclusive transfer preserves native edits. Contents travel on stdin, never argv.
 * Preflight the entire batch so a differing tracked source blocks all writes. */
export const receive = `import assert from "node:assert/strict"; import{readFileSync,mkdirSync,lstatSync,writeFileSync}from"node:fs";import{dirname,isAbsolute}from"node:path";
const p=JSON.parse(readFileSync(0,"utf8"));
assert.equal(process.getuid(),p.uid);assert.equal(process.env.HOME,p.home);assert.equal(lstatSync(p.home).uid,p.uid);
const root=p.sourceRoot??p.home,rootInfo=lstatSync(root);
assert.ok(isAbsolute(root)&&root!=="/"&&!root.startsWith("/nix/store/")&&!root.split("/").includes("..")&&rootInfo.isDirectory()&&!rootInfo.isSymbolicLink()&&rootInfo.uid===p.uid);
for(const [path,content] of Object.entries(p.files)) {
 assert.ok(path.startsWith(root+"/")&&!path.split("/").includes(".."));
 for(let dir=dirname(path);dir!==root;dir=dirname(dir)){try{assert.ok(lstatSync(dir).isDirectory()&&!lstatSync(dir).isSymbolicLink());}catch(e){if(e.code!=="ENOENT")throw e;}}
 try{const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.uid===p.uid);if(readFileSync(path,"utf8")!==content)throw Error("existing file differs; preserve and inspect");}catch(e){if(e.code!=="ENOENT")throw e;}
}
for(const [path,content] of Object.entries(p.files)) {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 try{writeFileSync(path,content,{flag:"wx",mode:0o600});}catch(e){if(e.code!=="EEXIST")throw e;const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==p.uid||readFileSync(path,"utf8")!==content)throw Error("existing file differs; preserve and inspect");}
} console.log("source files verified");`;

const storePattern = /^\/nix\/store\/[a-z0-9]+-cli-proxy-api-tools$/;
const pinPattern = /^\/[A-Za-z0-9/._+-]+$/;
export const managedToolsRoot = (home: string) => join(home, ".local/share/cli-proxy-api/managed-tools");
function info(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
function launcher(target: string, codex?: string, marked = true): string {
  return `#!/bin/sh\n${marked ? "# managed by cli-proxy-api fleet\n" : ""}${codex ? `export CODEX_BIN="\${CODEX_BIN:-${codex}}"\n` : ""}exec ${shellQuote(target)} "$@"\n`;
}
function legacyTarget(home: string, target: string, program: string): boolean {
  const prefix = `${home}/.local/share/cli-proxy-api/client-bootstrap/`;
  return target.startsWith(prefix) && new RegExp(`^[a-f0-9]{16}/tools/bin/${program}-broker$`).test(target.slice(prefix.length));
}

/** Exact generated shapes, not just a marker, authorize replacing a launcher.
 * Retain an existing CODEX_BIN pin because T3 may not inherit the login PATH. */
export function ownedLauncher(home: string, program: string, contents: string): { codex?: string } | undefined {
  const pin = contents.match(/^export CODEX_BIN="\$\{CODEX_BIN:-(\/[^"\n]+)\}"$/m)?.[1];
  if (pin && (program !== "codex" || !pinPattern.test(pin))) return undefined;
  const target = contents.match(/^exec '([^'\n]+)' "\$@"$/m)?.[1];
  if (!target) return undefined;
  if (target === `${managedToolsRoot(home)}/bin/${program}-broker` && contents === launcher(target, pin)) return { codex: pin };
  if (legacyTarget(home, target, program) && contents === launcher(target, pin, false)) return { codex: pin };
  return undefined;
}

/** Only wiring is mutable here: never touch native CLI config or OAuth grants. */
export function refreshTools(home: string, store: string, codex?: string, eventSink?: EventSink): string {
  const completion = operation("inference.fleet.refresh", { command: "refresh-tools" }, eventSink);
  let stage = "validate";
  try {
  if (!storePattern.test(store) || (codex !== undefined && !pinPattern.test(codex))) throw new Error("invalid tools output or native Codex path");
  const root = managedToolsRoot(home);
  const rootInfo = info(root);
  if (rootInfo && (!rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid()) || !storePattern.test(readlinkSync(root)))) throw new Error("unrecognized tools root; preserve and inspect");
  stage = "preflight";
  const files: { path: string; content: string }[] = [];
  // Preflight everything before replacing either the root or any launcher.
  for (const program of ["codex", "claude", "inference"]) {
    const path = join(home, `.local/bin/${program}-broker`);
    const stat = info(path);
    let pin = program === "codex" ? codex : undefined;
    if (stat) {
      if (process.getuid && stat.uid !== process.getuid()) throw new Error("launcher is not owned; preserve and inspect");
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const oldManaged = [".local/share/cli-proxy-api-client-tools", ".local/share/cli-proxy-api/tools"].some(directory => {
          const oldRoot = join(home, directory), oldRootInfo = info(oldRoot);
          return target === `${oldRoot}/bin/${program}-broker` && oldRootInfo?.isSymbolicLink() && storePattern.test(readlinkSync(oldRoot));
        });
        if (target !== `${root}/bin/${program}-broker` && !legacyTarget(home, target, program) && !oldManaged) throw new Error("unrecognized launcher symlink; preserve and inspect");
      } else {
        if (!stat.isFile()) throw new Error("unrecognized launcher; preserve and inspect");
        const owned = ownedLauncher(home, program, readFileSync(path, "utf8"));
        if (!owned) throw new Error("launcher differs; preserve and inspect");
        pin = owned.codex || pin;
      }
    }
    files.push({ path, content: launcher(`${root}/bin/${program}-broker`, pin) });
  }
  for (const path of [root, ...files.map(file => file.path)]) {
    // Do not follow a user-created symlink in the managed directory hierarchy.
    for (let dir = dirname(path); dir !== home; dir = dirname(dir)) {
      if (dir === dirname(dir)) throw new Error("managed tools must be inside home");
      const stat = info(dir);
      if (stat && (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("unsafe managed tools directory");
    }
  }
  stage = "replace-root";
  const suffix = `.staged-${randomBytes(16).toString("hex")}`;
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".local/bin"), { recursive: true, mode: 0o700 });
  symlinkSync(store, root + suffix);
  renameSync(root + suffix, root);
  stage = "replace-launchers";
  for (const file of files) {
    writeFileSync(file.path + suffix, file.content, { flag: "wx", mode: 0o700 });
    renameSync(file.path + suffix, file.path);
  }
  completion.finish({ outcome: "success", stage: "verified", counts: { launchers: files.length } });
  return root;
  } catch (error) {
    completion.finish({ outcome: stage === "validate" || stage === "preflight" ? "rejected" : "failure", stage, ...failure(error, stage === "validate" || stage === "preflight" ? "configuration" : "filesystem") });
    throw error;
  }
}

export function deploy(host: string, eventSink?: EventSink) {
  const completion = operation("inference.fleet.deploy", { command: "deploy", clientId: journalId(host) }, eventSink);
  let stage = "inventory";
  let selectedNode: string | undefined;
  try {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(host) || !configuredHosts().includes(host)) throw new Error("host not in configured fleet");
  selectedNode = host;
  stage = "identity";
  const native = identity(JSON.parse(ssh(host, checkIdentity)));
  stage = "repository";
  const repo = ssh(host, 'cd "$HOME/commonplace/01_files/nix" && pwd -P');
  if (!repo.startsWith("/") || repo === "/" || repo.startsWith("/nix/store/") || repo.split("/").includes("..")) throw new Error("invalid canonical repository");
  stage = "source-transfer";
  const sources = Object.fromEntries(["cli-proxy-api/broker.ts", "cli-proxy-api/fleet.ts", "cli-proxy-api/default.nix", "cli-proxy-api/events.ts", "tool-auth/process.ts"].map(path => [`${repo}/modules/${path}`, readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8")]));
  ssh(host, `${nativeNode} "$node" --input-type=module -e ${shellQuote(receive)}`, JSON.stringify({ ...native, sourceRoot: repo, files: sources }));
  stage = "build";
  const output = ssh(host, `nix build --impure --no-link --no-write-lock-file --print-out-paths --expr ${shellQuote(packageExpression(repo))}`, undefined, 180000);
  const store = output.split("\n").at(-1)!;
  if (!storePattern.test(store)) throw new Error("unexpected native tools derivation output");
  stage = "native-prerequisite";
  let codex = ssh(host, 'command -v codex || { test -x "$HOME/.local/bin/codex" && printf "%s\\n" "$HOME/.local/bin/codex"; } || true');
  // A provisioned host may expose Codex only through its retained launcher pin.
  if (!codex) codex = ssh(host, `${nativeNode} "$node" --input-type=module -e ${shellQuote(`import { readFileSync, accessSync, constants } from 'node:fs'; import { ownedLauncher } from ${JSON.stringify(`${repo}/modules/cli-proxy-api/fleet.ts`)}; const pin = ownedLauncher(process.env.HOME, 'codex', readFileSync(process.env.HOME + '/.local/bin/codex-broker', 'utf8'))?.codex; if (pin) { accessSync(pin, constants.X_OK); process.stdout.write(pin); }`)}`);
  if (!pinPattern.test(codex)) throw new Error("native Codex prerequisite unavailable");
  stage = "refresh-tools";
  const root = ssh(host, `${nativeNode} "$node" ${shellQuote(`${repo}/modules/cli-proxy-api/fleet.ts`)} refresh-tools ${shellQuote(store)} ${shellQuote(codex)}`);
  ssh(host, `nix-store --add-root ${shellQuote(root)} --indirect --realise ${shellQuote(store)} >/dev/null`);
  // Credential provisioning is intentionally separate: local Macs enroll via
  // native login + use-local; remote clients may retain their existing selection.
  stage = "verify-native";
  const version = ssh(host, `${shellQuote(`${native.home}/.local/bin/codex-broker`)} --version`);
  completion.finish({ outcome: "success", stage, selectedNode, counts: { sources: Object.keys(sources).length } });
  return { host, ...native, root, store, version, credentials: "unchanged; explicit provisioning required" };
  } catch (error) {
    completion.finish({ outcome: error instanceof FleetCommandError ? "failure" : stage === "inventory" || stage === "identity" || stage === "repository" ? "rejected" : "failure", stage, selectedNode, ...failure(error, error instanceof FleetCommandError ? "process" : "configuration") });
    throw error;
  }
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;
  const { mkdtempSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  test("SSH bypasses shared control sockets and withholds private failure output", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-ssh-"));
    const executable = join(directory, "ssh.ts"), argv = join(directory, "argv"), fail = join(directory, "fail");
    writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync, existsSync } from "node:fs";\nconst args: string[] = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(args));\nif (existsSync(${JSON.stringify(fail)})) { console.log("SENTINEL_PRIVATE"); console.error("SENTINEL_PRIVATE"); process.exitCode = 255; } else console.log("verified");\n`, { mode: 0o700 });
    symlinkSync(executable, join(directory, "ssh"));
    vi.stubEnv("PATH", `${directory}:${process.env.PATH ?? ""}`);
    try {
      expect(ssh("fixture", "read-only-command")).toBe("verified");
      expect(JSON.parse(readFileSync(argv, "utf8"))).toEqual([
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ControlMaster=no", "-o", "ControlPath=none", "fixture", "read-only-command",
      ]);
      writeFileSync(fail, "");
      expect(() => ssh("fixture", "read-only-command")).toThrow(new FleetCommandError("SSH operation failed on fixture (exit 255); private output withheld"));
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("refresh emits one completion and observer failure cannot interrupt launcher installation", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-events-"));
    const events: import("./events.ts").OperationEvent[] = [];
    const store = "/nix/store/aaaaaaaa-cli-proxy-api-tools";
    try {
      expect(refreshTools(home, store, undefined, event => { events.push(event); throw new Error("SENTINEL_OBSERVER_KEY"); })).toBe(managedToolsRoot(home));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "success", command: "refresh-tools", stage: "verified", counts: { launchers: 3 } });
      expect(readlinkSync(managedToolsRoot(home))).toBe(store);
      expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(events)).not.toContain(home);
      expect(JSON.stringify(events)).not.toContain("SENTINEL");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("fleet rejection records stage without untrusted node, config paths or errors", () => {
    const events: import("./events.ts").OperationEvent[] = [];
    const secret = "SENTINEL_KEY";
    expect(() => deploy(secret, event => events.push(event))).toThrow("host not in configured fleet");
    expect(() => refreshTools(`/private/${secret}`, `https://user:${secret}@example.com/?key=${secret}`, undefined, event => events.push(event))).toThrow();
    expect(events.map(event => event.outcome)).toEqual(["rejected", "rejected"]);
    expect(events[0]).toMatchObject({ command: "deploy", stage: "inventory", errorCategory: "configuration" });
    expect(events[1]).toMatchObject({ command: "refresh-tools", stage: "validate", errorCategory: "configuration" });
    expect(JSON.stringify(events)).not.toContain(secret);
  });
}

if (isMain(import.meta.url)) {
  if (process.argv[2] === "refresh-tools") {
    try {
      if (process.argv.length < 4 || process.argv.length > 5) {
        operation("inference.fleet.refresh", { command: "refresh-tools", stage: "arguments" }).finish({ outcome: "rejected", errorCategory: "configuration" });
        throw new Error("usage: fleet.ts refresh-tools store-path [native-codex-path]");
      }
      console.log(refreshTools(homedir(), process.argv[3]!, process.argv[4]));
    } catch { process.exitCode = 1; }
  } else {
    for (const host of process.argv.slice(2)) {
      try { console.log(JSON.stringify(deploy(host))); }
      catch { process.exitCode = 1; }
    }
  }
}
