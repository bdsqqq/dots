import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMain } from "../tool-auth/process.ts";

export const HOSTS = ["mbp-m5", "lgo-z2e", "htz-lab", "htz-relay", "htz-xfs-lab"] as const;
export function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function identity(value: any) {
  if (value.user !== "bdsqqq" || !Number.isInteger(value.uid) || value.uid < 500 || !["/home/bdsqqq", "/Users/bdsqqq"].includes(value.home) || value.owner !== value.uid || !["Linux", "Darwin"].includes(value.os)) throw new Error("unexpected native identity or home ownership");
  return value as { user: string; uid: number; home: string; owner: number; os: string };
}
function ssh(host: string, command: string, input?: string, timeout = 15000) {
  if (![...HOSTS, "mmn-m4"].includes(host as any)) throw new Error("host not in personal fleet");
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", host, command], { input, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    if (command.startsWith("nix build")) console.error(result.stderr);
    throw new Error(`SSH ${command.split(" ")[0]} operation failed on ${host} (exit ${result.status}); private output withheld`);
  }
  return result.stdout.trim();
}
const nativeNode = 'node=$(command -v node || true); if test -z "$node"; then for n in /nix/store/*nodejs-24*/bin/node; do test -x "$n" && node="$n"; done; fi; test -n "$node" || exit 127; ';
const checkIdentity = `${nativeNode} "$node" --input-type=module -e 'import{statSync}from"node:fs";import{userInfo,type}from"node:os";console.log(JSON.stringify({user:userInfo().username,uid:process.getuid(),home:process.env.HOME,owner:statSync(process.env.HOME).uid,os:type(),node:process.execPath}))'`;

export function packageExpression(root: string, repo: string) {
  return `let
    lock = builtins.fromJSON (builtins.readFile ${JSON.stringify(`${repo}/flake.lock`)});
    nixpkgs = builtins.fetchTree lock.nodes.nixpkgs.locked;
    pkgs = import nixpkgs { system = builtins.currentSystem; config.allowUnfree = true; };
    lib = pkgs.lib;
    evaluated = lib.evalModules {
      specialArgs = { inherit pkgs; hostSystem = builtins.currentSystem; };
      modules = [ ${root}/commonplace/01_files/nix/modules/cli-proxy-api/default.nix
        ({ lib, ... }: {
          options.my.primaryUser = lib.mkOption { type = lib.types.str; };
          options.my.paths = lib.mkOption { type = lib.types.attrs; };
          options.home-manager.users.bdsqqq.home.homeDirectory = lib.mkOption { type = lib.types.str; };
          options.home-manager.users.bdsqqq.home.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = []; };
          options.home-manager.users.bdsqqq.launchd = lib.mkOption { type = lib.types.attrs; default = {}; };
          options.assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = []; };
          config.my.primaryUser = "bdsqqq";
          config.my.paths.commonplace = ${JSON.stringify(`${root}/commonplace`)};
          config.home-manager.users.bdsqqq.home.homeDirectory = builtins.getEnv "HOME";
        }) ];
    };
  in evaluated.config.my.cliProxyApi.toolsPackage`;
}

/** Exclusive transfer prevents both duplicate token installation and clobbering native edits. */
export const receive = `import assert from "node:assert/strict"; import{readFileSync,mkdirSync,lstatSync,writeFileSync}from"node:fs";import{dirname}from"node:path";
const p=JSON.parse(readFileSync(0,"utf8"));
assert.equal(process.getuid(),p.uid);assert.equal(process.env.HOME,p.home);assert.equal(lstatSync(p.home).uid,p.uid);
for(const [path,content] of Object.entries(p.files)) {
 assert.ok(path.startsWith(p.home+"/")); mkdirSync(dirname(path),{recursive:true,mode:0o700});assert.ok(!lstatSync(dirname(path)).isSymbolicLink());
 try{writeFileSync(path,content,{flag:"wx",mode:p.executable?0o700:0o600});}catch(e){if(e.code!=="EEXIST")throw e;assert.ok(!lstatSync(path).isSymbolicLink());assert.equal(lstatSync(path).uid,p.uid);assert.equal(readFileSync(path,"utf8"),content,"existing file differs; preserve and inspect");}
 assert.equal(lstatSync(path).mode&0o777,p.executable?0o700:0o600);
} console.log("private files verified");`;

export function deploy(host: string) {
  const native = identity(JSON.parse(ssh(host, checkIdentity)));
  const repo = ssh(host, 'cd "$HOME/commonplace/01_files/nix" && pwd -P');
  const sources = Object.fromEntries(["cli-proxy-api/broker.ts", "cli-proxy-api/default.nix", "cli-proxy-api/codex-archive-route.patch", "tool-auth/process.ts"].map(path => [path, readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8")]));
  const digest = createHash("sha256").update("native-tools-v3").update(JSON.stringify(sources)).digest("hex").slice(0, 16);
  const root = `${native.home}/.local/share/cli-proxy-api/client-bootstrap/${digest}`;
  const clientPath = `${native.home}/.config/cli-proxy-api/client.json`;
  // The hub prints only the credential path. Read it within this captured SSH channel.
  const credential = ssh("mmn-m4", `p=$(inference-broker issue-client ${shellQuote(host)}) && test -f "$p" && node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$p"`, undefined, 25000);
  const parsed = JSON.parse(credential);
  if (parsed.name !== host || parsed.baseUrl !== "https://mmn-m4.tail1543a7.ts.net:8317") throw new Error("hub credential does not match intended machine/endpoint");
  const files: Record<string,string> = Object.fromEntries(Object.entries(sources).map(([path, content]) => [`${root}/commonplace/01_files/nix/modules/${path}`, content]));
  files[clientPath] = `${JSON.stringify(parsed)}\n`;
  files[`${root}/tools.nix`] = packageExpression(root, repo);
  ssh(host, `${nativeNode} "$node" --input-type=module -e ${shellQuote(receive)}`, JSON.stringify({ ...native, files }));
  const output = ssh(host, `nix build --impure --no-link --no-write-lock-file --print-out-paths --file ${shellQuote(`${root}/tools.nix`)}`, undefined, 180000);
  const store = output.split("\n").at(-1)!;
  if (!/^\/nix\/store\/[a-z0-9]+-cli-proxy-api-tools$/.test(store)) throw new Error("unexpected native tools derivation output");
  const codex = ssh(host, 'command -v codex || { test -x "$HOME/.local/bin/codex" && printf "%s\\n" "$HOME/.local/bin/codex"; }');
  if (!codex.startsWith("/") || codex.includes("\n")) throw new Error("native Codex prerequisite unavailable");
  ssh(host, `nix-store --add-root ${shellQuote(`${root}/tools`)} --realise ${shellQuote(store)} >/dev/null`);
  const launchers: Record<string,string> = {};
  for (const program of ["codex", "claude"]) launchers[`${native.home}/.local/bin/${program}-broker`] = `#!/bin/sh\n${program === "codex" ? `export CODEX_BIN="\${CODEX_BIN:-${codex}}"\n` : ""}exec ${shellQuote(`${root}/tools/bin/${program}-broker`)} "$@"\n`;
  ssh(host, `${nativeNode} "$node" --input-type=module -e ${shellQuote(receive)}`, JSON.stringify({ ...native, files: launchers, executable: true }));
  const version = ssh(host, `${shellQuote(`${native.home}/.local/bin/codex-broker`)} --version`);
  let models: unknown;
  try { models = JSON.parse(ssh(host, `${shellQuote(`${root}/tools/bin/inference-broker`)} status`, undefined, 25000)); }
  catch { models = { blocked: "authenticated discovery failed; inspect native tailnet reachability and broker availability", inferenceTested: false }; }
  return { host, ...native, root, store, privateClient: "0600", version, models };
}

if (isMain(import.meta.url)) {
  for (const host of process.argv.slice(2)) {
    try { console.log(JSON.stringify(deploy(host))); }
    catch (error) { console.error(JSON.stringify({ host, error: error instanceof Error ? error.message : "deployment failed" })); process.exitCode = 1; }
  }
}
