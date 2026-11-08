import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identity, packageExpression, receive, shellQuote, managedToolsRoot, ownedLauncher, refreshTools } from "./fleet.ts";

test("fleet refuses unexpected users, homes and unowned homes", () => {
  const good = { user: "bdsqqq", uid: 1000, home: "/home/bdsqqq", owner: 1000, os: "Linux" };
  assert.deepEqual(identity(good), good);
  for (const change of [{user:"root"},{uid:0},{home:"/root"},{owner:0},{os:"Windows"}]) assert.throws(() => identity({...good,...change}));
});

test("SSH arguments remain literal, including quotes and shell substitution", () => {
  const value = "fixture ' $(exit 7) \n x";
  const r = spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {encoding:"utf8"});
  assert.equal(r.status, 0); assert.equal(r.stdout, value);
});

test("native transfer is private, idempotent, and detects an existing differing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-fleet-"));
  try {
    const file = join(dir, "client.json");
    const input = {uid:process.getuid!(),home:dir,files:{[file]:"fixture\n"}};
    const run = () => spawnSync(process.execPath,["--input-type=module","-e",receive],{input:JSON.stringify(input),env:{...process.env,HOME:dir},encoding:"utf8"});
    assert.equal(run().status,0); assert.equal(statSync(file).mode&0o777,0o600);
    assert.equal(run().status,0);
    writeFileSync(file,"unrelated native edit\n");
    assert.notEqual(run().status,0);
    assert.equal(readFileSync(file,"utf8"),"unrelated native edit\n");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("managed tools refresh migrates exact owned legacy wrappers and upgrades the stable root", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-wiring-"));
  const store1 = "/nix/store/abc-cli-proxy-api-tools";
  const store2 = "/nix/store/def-cli-proxy-api-tools";
  try {
    const bin = join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    const legacy = `${home}/.local/share/cli-proxy-api/client-bootstrap/0123456789abcdef/tools/bin/codex-broker`;
    const wrapper = `#!/bin/sh\nexport CODEX_BIN="${"${CODEX_BIN:-/native/pinned-codex}"}"\nexec '${legacy}' "$@"\n`;
    writeFileSync(join(bin, "codex-broker"), wrapper, { mode: 0o700 });
    assert.deepEqual(ownedLauncher(home, "codex", wrapper), { codex: "/native/pinned-codex" });
    assert.equal(ownedLauncher(home, "codex", wrapper + "# user edit\n"), undefined);
    const root = refreshTools(home, store1, "/native/new-codex");
    assert.equal(root, managedToolsRoot(home));
    assert.equal(readlinkSync(root), store1);
    const first = readFileSync(join(bin, "codex-broker"), "utf8");
    assert.match(first, /\/native\/pinned-codex/);
    assert.ok(first.includes(root));
    assert.ok(!first.includes("client-bootstrap"));
    refreshTools(home, store2);
    assert.equal(readlinkSync(root), store2);
    assert.equal(readFileSync(join(bin, "codex-broker"), "utf8"), first);
    assert.equal(statSync(join(bin, "codex-broker")).mode & 0o777, 0o700);
    assert.deepEqual(ownedLauncher(home, "codex", first), { codex: "/native/pinned-codex" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("managed tools preflight refuses native edits without changing root or another launcher", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-wiring-"));
  try {
    refreshTools(home, "/nix/store/abc-cli-proxy-api-tools", "/native/codex");
    const codex = join(home, ".local/bin/codex-broker");
    const claude = join(home, ".local/bin/claude-broker");
    const before = readFileSync(codex, "utf8");
    writeFileSync(claude, "#!/bin/sh\n# user-owned\nexit 0\n");
    assert.throws(() => refreshTools(home, "/nix/store/def-cli-proxy-api-tools"), /differs/);
    assert.equal(readlinkSync(managedToolsRoot(home)), "/nix/store/abc-cli-proxy-api-tools");
    assert.equal(readFileSync(codex, "utf8"), before);
    assert.equal(readFileSync(claude, "utf8"), "#!/bin/sh\n# user-owned\nexit 0\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("managed tools adopts known legacy symlinks but refuses arbitrary symlinks and root files", () => {
  for (const kind of ["owned", "hub-owned", "foreign", "root-file"]) {
    const home = mkdtempSync(join(tmpdir(), "broker-links-"));
    try {
      const bin = join(home, ".local/bin");
      mkdirSync(bin, { recursive: true });
      const oldRoot = join(home, kind === "hub-owned" ? ".local/share/cli-proxy-api/tools" : ".local/share/cli-proxy-api-client-tools");
      mkdirSync(join(oldRoot, ".."), { recursive: true });
      symlinkSync("/nix/store/abc-cli-proxy-api-tools", oldRoot);
      symlinkSync(kind === "foreign" ? "/user/custom/codex" : `${oldRoot}/bin/codex-broker`, join(bin, "codex-broker"));
      if (kind === "root-file") {
        mkdirSync(join(home, ".local/share/cli-proxy-api"));
        writeFileSync(managedToolsRoot(home), "native file");
      }
      if (kind === "owned" || kind === "hub-owned") {
        symlinkSync(`${oldRoot}/bin/inference-broker`, join(bin, "inference-broker"));
        refreshTools(home, "/nix/store/def-cli-proxy-api-tools", "/native/codex");
        assert.match(readFileSync(join(bin, "codex-broker"), "utf8"), /managed by cli-proxy-api fleet/);
        assert.match(readFileSync(join(bin, "inference-broker"), "utf8"), /managed by cli-proxy-api fleet/);
      } else assert.throws(() => refreshTools(home, "/nix/store/def-cli-proxy-api-tools"), /unrecognized/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test("source transfer accepts an owned relocated checkout but cannot escape its explicit root", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-home-")), sourceRoot = mkdtempSync(join(tmpdir(), "broker-relocated-"));
  try {
    const file = join(sourceRoot, "module.ts");
    const transfer = (files: Record<string, string>) => spawnSync(process.execPath, ["--input-type=module", "-e", receive], {
      input: JSON.stringify({ uid: process.getuid!(), home, sourceRoot, files }), env: { ...process.env, HOME: home }, encoding: "utf8",
    });
    assert.equal(transfer({ [file]: "canonical source" }).status, 0);
    assert.equal(readFileSync(file, "utf8"), "canonical source");
    const outside = join(home, "outside.ts");
    assert.notEqual(transfer({ [outside]: "not granted" }).status, 0);
    assert.throws(() => statSync(outside));
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(sourceRoot, { recursive: true, force: true }); }
});

test("source transfer refuses a differing file before creating any other source and withholds contents", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-sources-"));
  try {
    const native = join(home, "native.ts");
    const absent = join(home, "new.ts");
    writeFileSync(native, "private native edit");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", receive], {
      input: JSON.stringify({ uid: process.getuid!(), home, files: { [absent]: "new", [native]: "private incoming content" } }),
      env: { ...process.env, HOME: home }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.throws(() => statSync(absent));
    assert.equal(readFileSync(native, "utf8"), "private native edit");
    assert.ok(!result.stderr.includes("private native edit"));
    assert.ok(!result.stderr.includes("private incoming content"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("built absolute launcher uses its pinned native Codex on a minimal T3 PATH without editing direct defaults", { skip: !process.env.CLI_PROXY_API_TEST_TOOLS }, () => {
  const home = mkdtempSync(join(tmpdir(), "broker-runtime-"));
  try {
    mkdirSync(join(home, ".codex"));
    const direct = join(home, ".codex/config.toml");
    const oauth = join(home, ".codex/auth.json");
    writeFileSync(direct, 'model_provider = "openai"\n');
    writeFileSync(oauth, "fixture native OAuth state", { mode: 0o600 });
    const native = join(home, "native-codex");
    writeFileSync(native, '#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync(process.env.HOME + "/injected-key", process.env.CLI_PROXY_API_KEY); fs.writeFileSync(process.env.HOME + "/native-args", process.argv.slice(2).join("\\n"));\n', { mode: 0o700 });
    const selected = join(home, "client.json");
    const apiKey = `broker-${"t".repeat(43)}`;
    writeFileSync(selected, JSON.stringify({ version: 1, name: "fixture", baseUrl: "http://127.0.0.1:18317", apiKey }), { mode: 0o600 });
    refreshTools(home, process.env.CLI_PROXY_API_TEST_TOOLS!, native);
    const result = spawnSync(join(home, ".local/bin/codex-broker"), ["app-server"], {
      encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", CLI_PROXY_API_CLIENT_FILE: selected },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(join(home, "injected-key"), "utf8"), apiKey);
    const args = readFileSync(join(home, "native-args"), "utf8");
    assert.ok(args.includes("app-server"));
    assert.ok(args.includes("http://127.0.0.1:18317/v1"));
    assert.ok(!args.includes(apiKey));
    assert.equal(readFileSync(direct, "utf8"), 'model_provider = "openai"\n');
    assert.equal(readFileSync(oauth, "utf8"), "fixture native OAuth state");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bootstrap builds the existing native tools module without evaluating a whole host or scanning unrelated checkout files", () => {
  const expression=packageExpression("/home/bdsqqq/commonplace/01_files/nix");
  assert.match(expression,/builtins.fetchTree lock.nodes.nixpkgs.locked/);
  assert.match(expression,/builtins.currentSystem/);
  assert.match(expression,/cli-proxy-api\/default.nix/);
  assert.match(expression,/config.my.cliProxyApi.toolsPackage/);
  assert.ok(!expression.includes("getFlake"));
  assert.match(expression, /modules = \[ "\/home\/bdsqqq\/commonplace\/01_files\/nix\/modules\/cli-proxy-api\/default.nix"/);
  assert.match(expression, /config.my.cliProxyApi.sourceDirectory = "\/home\/bdsqqq\/commonplace\/01_files\/nix\/modules\/cli-proxy-api"/);
  assert.ok(packageExpression("/home/bdsqqq/relocated-repo").includes('config.my.cliProxyApi.sourceDirectory = "/home/bdsqqq/relocated-repo/modules/cli-proxy-api"'));
  assert.ok(!expression.includes("client-bootstrap"));
});
