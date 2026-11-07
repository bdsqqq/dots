import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { identity, packageExpression, receive, shellQuote } from "./fleet.ts";

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

test("bootstrap builds the existing native tools module without evaluating a whole host or scanning unrelated checkout files", () => {
  const expression=packageExpression("/home/bdsqqq/bootstrap","/home/bdsqqq/repo");
  assert.match(expression,/builtins.fetchTree lock.nodes.nixpkgs.locked/);
  assert.match(expression,/builtins.currentSystem/);
  assert.match(expression,/cli-proxy-api\/default.nix/);
  assert.match(expression,/config.my.cliProxyApi.toolsPackage/);
  assert.ok(!expression.includes("getFlake"));
});
