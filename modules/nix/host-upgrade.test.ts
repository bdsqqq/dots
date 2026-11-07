import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execute, initialize, main, parseConfig, reconcile, type UpgradeConfig } from "./host-upgrade.ts";
import { parseUpgradeState, readUpgradeHealth, upgradeHealth } from "./upgrade-status.ts";

const current = "a".repeat(40), target = "b".repeat(40);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "host-upgrade-test-"));
  const script = join(directory, "fake-tools.mjs");
  const control = join(directory, "control.json"), profile = join(directory, "profile"), history = join(directory, "commands.jsonl");
  writeFileSync(profile, current);
  writeFileSync(control, "{}");
  writeFileSync(join(directory, "unpublished-work.txt"), "preserve this user work");
  writeFileSync(script, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(directory)}, command=process.argv[2], args=process.argv.slice(3), c=JSON.parse(readFileSync(root+'/control.json','utf8'));
appendFileSync(root+'/commands.jsonl',JSON.stringify([command,...args])+'\\n');
if(command==='revision') console.log(readFileSync(root+'/profile','utf8'));
else if(command==='nix' && args[0]==='flake') console.log(JSON.stringify({revision:c.invalidRevision?'not-a-revision':${JSON.stringify(target)}}));
else if(command==='nix') {
 writeFileSync(root+'/building','yes');
 if(c.hangBuild) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
 else { if(c.buildDelayMs) await new Promise(r=>setTimeout(r,c.buildDelayMs)); process.exitCode=c.buildFailure?1:0; }
} else if(command==='activate') {
 writeFileSync(root+'/profile',${JSON.stringify(target)});
 writeFileSync(root+'/state/homebrew.json',JSON.stringify({status:c.dependenciesFailure||c.installerFailure?'failed':'succeeded',checkedAt:new Date().toISOString(),reasonCode:'fixture_install'}));
 process.exitCode=c.activationFailure?1:0;
} else if(command==='dependencies') process.exitCode=c.dependenciesFailure?1:0;
else if(command==='repair-dependencies') {
 if(c.repairFailure) process.exitCode=1;
 else {c.dependenciesFailure=false;c.installerFailure=false;writeFileSync(root+'/control.json',JSON.stringify(c));}
}
`);
  const config: UpgradeConfig = { host: "mmn-m4", flake: "github:bdsqqq/dots", stateDir: join(directory, "state"), operation: "switch",
    nixCommand: [process.execPath, script, "nix"], rebuildCommand: [process.execPath, script, "activate"],
    revisionCommand: [process.execPath, script, "revision"], dependencyCheckCommand: [process.execPath, script, "dependencies"],
    dependencyRepairCommand: [process.execPath, script, "repair-dependencies"],
    buildTimeoutMs: 5000, activationWarnAfterMs: 5000, retryBaseMs: 1000, retryMaxMs: 60_000 };
  const configFile = join(directory, "config.json"); writeFileSync(configFile, JSON.stringify(config));
  return { directory, config, configFile, profile,
    control(value: object) { writeFileSync(control, JSON.stringify(value)); },
    state() { return parseUpgradeState(JSON.parse(readFileSync(join(config.stateDir, "status.json"), "utf8"))); },
    history(): string[][] { return existsSync(history) ? readFileSync(history, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : []; },
    cleanup() { assert.equal(readFileSync(join(directory, "unpublished-work.txt"), "utf8"), "preserve this user work"); rmSync(directory, { recursive: true, force: true }); },
  };
}
const waitFor = async (condition: () => boolean) => { for (let i=0;i<100 && !condition();i++) await new Promise(r=>setTimeout(r,20)); assert.ok(condition()); };

test("validated direct operation pins one revision, verifies apply, and skips reactivation of unchanged code", async () => {
  const f = fixture(); try {
    await initialize(f.config);
    assert.equal((await readUpgradeHealth(join(f.config.stateDir,"status.json"))).status,"unknown");
    assert.deepEqual(await reconcile(parseConfig(f.config)), {status:"succeeded",reasonCode:"healthy"});
    assert.equal(f.state().appliedRevision,target);
    assert.equal(upgradeHealth(f.state()).status,"healthy");
    assert.ok(f.history().some(x=>x[0]==="nix" && x[1]==="flake"),"positive control: default discovery really records metadata calls");
    assert.ok(f.history().find(x=>x[0]==="nix" && x[1]==="build")?.includes(`github:bdsqqq/dots/${target}#darwinConfigurations.mmn-m4.system`));
    assert.equal((await reconcile(f.config)).status,"succeeded");
    assert.equal(f.history().filter(x=>x[0]==="activate").length,1);
  } finally { f.cleanup(); }
});
test("manual migration can pin an exact published revision without chasing a concurrent main update", async () => {
  const f=fixture();try {
    await assert.rejects(main(["run","--revision"]),/missing revision/);
    await assert.rejects(reconcile(f.config,{revision:"not-a-revision"}),/invalid published revision/);
    assert.deepEqual(f.history(),[]);
    assert.equal((await reconcile(f.config,{revision:target})).status,"succeeded");
    assert.equal(f.history().some(x=>x[0]==="nix" && x[1]==="flake"),false);
    assert.ok(f.history().find(x=>x[0]==="nix" && x[1]==="build")?.includes(`${f.config.flake}/${target}#darwinConfigurations.mmn-m4.system`));
  }finally{f.cleanup();}
});
test("build failure preserves current generation and applies retry backoff", async () => {
  const f=fixture();try {
    f.control({buildFailure:true});
    assert.equal((await reconcile(f.config)).reasonCode,"build_failed");
    assert.equal(readFileSync(f.profile,"utf8"),current);
    assert.equal(f.history().filter(x=>x[0]==="activate").length,0);
    assert.equal((await reconcile(f.config)).reasonCode,"retry_backoff");
    assert.equal(upgradeHealth(f.state()).status,"degraded");
  } finally { f.cleanup(); }
});
test("a hung build is terminated without activation or generation loss", {timeout:20_000}, async () => {
  const f=fixture();try {
    f.control({hangBuild:true});
    assert.equal((await reconcile({...f.config,buildTimeoutMs:250})).reasonCode,"build_timeout");
    assert.equal(readFileSync(f.profile,"utf8"),current);
    assert.equal(f.history().filter(x=>x[0]==="activate").length,0);
  } finally { f.cleanup(); }
});
test("partial dependencies cannot turn an applied revision into a healthy attempt", async () => {
  const f=fixture();try {
    f.control({dependenciesFailure:true});
    assert.equal((await reconcile(f.config)).status,"partial");
    assert.equal(f.state().appliedRevision,target);
    assert.equal(f.state().lastSuccessAt,null);
    assert.equal(upgradeHealth(f.state()).reasonCode,"partial_dependencies");
    const state=f.state();state.nextAttemptAt=null;writeFileSync(join(f.config.stateDir,"status.json"),JSON.stringify(state));
    assert.equal((await reconcile(f.config)).status,"succeeded");
    assert.equal(f.history().filter(x=>x[0]==="repair-dependencies").length,1,"transient dependencies are repaired by the supervisor");
    assert.equal(f.history().filter(x=>x[0]==="activate").length,1);
  } finally { f.cleanup(); }
});
test("presence checks cannot erase failed installers, and permanent dependency repairs have a budget", async () => {
  const f=fixture();try {
    f.control({installerFailure:true,repairFailure:true});
    assert.equal((await reconcile(f.config)).status,"partial");
    for(let i=0;i<4;i++) {
      const state=f.state();state.nextAttemptAt=null;writeFileSync(join(f.config.stateDir,"status.json"),JSON.stringify(state));
      assert.equal((await reconcile(f.config)).status,"partial");
    }
    assert.equal(f.state().reasonCode,"dependency_repair_exhausted");
    assert.equal(f.history().filter(x=>x[0]==="repair-dependencies").length,3);
    assert.equal(f.state().components.dependencies.status,"succeeded");
    assert.equal(f.state().components.homebrew.status,"failed");
  }finally{f.cleanup();}
});
test("a proven reboot can retry pre-activation work, but cannot bless interrupted activation", async () => {
  const f=fixture();try {
    await initialize(f.config);
    const state=f.state();state.phase="building";state.bootId="00000000-0000-4000-8000-000000000001";
    writeFileSync(join(f.config.stateDir,"status.json"),JSON.stringify(state));
    assert.equal((await reconcile(f.config,{bootId:"00000000-0000-4000-8000-000000000002"})).status,"succeeded");
    const active=f.state();active.phase="activating";active.bootId="00000000-0000-4000-8000-000000000002";
    writeFileSync(join(f.config.stateDir,"status.json"),JSON.stringify(active));
    const before=f.history().length;
    assert.equal((await reconcile(f.config,{bootId:"00000000-0000-4000-8000-000000000003"})).status,"blocked");
    assert.equal(f.history().length,before);
  }finally{f.cleanup();}
});
test("activation failure is quarantined, including when the system profile already changed", async () => {
  const f=fixture();try {
    f.control({activationFailure:true});
    assert.equal((await reconcile(f.config)).status,"blocked");
    const before=f.history().length;
    assert.equal((await reconcile(f.config)).status,"blocked");
    assert.equal(f.history().length,before);
    f.control({});assert.equal((await reconcile(f.config,{acknowledgeInterrupted:true})).status,"succeeded");
    assert.equal(f.history().filter(x=>x[0]==="activate").length,2,"acknowledging partial activation must reapply, not trust the profile link");
  } finally { f.cleanup(); }
});
test("concurrent invocations cannot mutate a running attempt", async () => {
  const f=fixture();try {
    f.control({buildDelayMs:1000});
    const first=reconcile(f.config);
    await waitFor(()=>existsSync(join(f.directory,"building")));
    assert.equal((await reconcile(f.config)).reasonCode,"attempt_running");
    assert.equal((await first).status,"succeeded");
  } finally { f.cleanup(); }
});
test("build-only operation never announces an applied revision", async () => {
  const f=fixture();try {
    assert.equal((await reconcile({...f.config,operation:"build"})).reasonCode,"build_only");
    assert.equal(readFileSync(f.profile,"utf8"),current);
    assert.equal(f.history().filter(x=>x[0]==="activate").length,0);
  } finally { f.cleanup(); }
});
test("health observes stale convergence, overdue phases, and invalid state without fabricating recovery", async () => {
  const f=fixture();try {
    await reconcile(f.config);const state=f.state();const now=Date.now();
    assert.equal(upgradeHealth({...state,updatedAt:new Date(now-3*60*60_000).toISOString()},now).reasonCode,"convergence_stale");
    assert.equal(upgradeHealth({...state,phase:"building",phaseStartedAt:new Date(now).toISOString()},now).status,"unknown");
    assert.equal(upgradeHealth({...state,phase:"building",phaseStartedAt:new Date(now-70_000).toISOString()},now).reasonCode,"build_overdue");
    assert.equal(upgradeHealth({...state,phase:"activating",phaseStartedAt:new Date(now-10_000).toISOString()},now).reasonCode,"activation_overdue");
    assert.equal(upgradeHealth({...state,updatedAt:new Date(now+120_000).toISOString()},now).status,"unknown");
    assert.equal((await readUpgradeHealth(join(f.directory,"missing"))).reasonCode,"state_missing");
    writeFileSync(join(f.config.stateDir,"status.json"),"not json");
    assert.equal((await readUpgradeHealth(join(f.config.stateDir,"status.json"))).reasonCode,"state_invalid");
  } finally { f.cleanup(); }
});
test("deadline kills its own descendants even after leader exit; unrelated processes survive", async () => {
  const f=fixture();const unrelated=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  try {
    await waitFor(()=>alive(unrelated.pid!));
    assert.throws(()=>assert.equal(alive(unrelated.pid!),false),"termination verifier detects a known survivor");
    const heartbeat=join(f.directory,"descendant-heartbeat");
    const worker=`process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
    const script=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const pending=execute([process.execPath,"-e",script],{timeoutMs:1000,killGraceMs:100});
    await waitFor(()=>existsSync(heartbeat));
    const live=readFileSync(heartbeat,"utf8");
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.throws(()=>assert.equal(readFileSync(heartbeat,"utf8"),live),"heartbeat verifier detects a known running descendant");
    const result=await pending;
    assert.equal(result.timedOut,true);
    const before=readFileSync(heartbeat,"utf8");assert.ok(before.length>0);
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(readFileSync(heartbeat,"utf8"),before,"owned descendant stops executing after cancellation");
    assert.equal(alive(unrelated.pid!),true);
  } finally { unrelated.kill("SIGKILL");f.cleanup(); }
});
test("CLI invokes the same checked operation and rejects invalid inputs", async () => {
  const f=fixture();try {
    const runner=fileURLToPath(new URL("./host-upgrade.ts",import.meta.url));
    const result=spawnSync(process.execPath,["--experimental-strip-types",runner,"run","--config",f.configFile],{encoding:"utf8",timeout:15_000});
    assert.equal(result.status,0,result.stderr);assert.equal(f.state().phase,"succeeded");
    const completion=result.stdout.split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line)).find(event=>event.operation==="upgrade.attempt");
    assert.equal(completion.operationId,f.state().operationId);
    assert.equal(completion.context.revision,target);
    writeFileSync(f.configFile,JSON.stringify({...f.config,buildTimeoutMs:0}));
    const rejected=spawnSync(process.execPath,["--experimental-strip-types",runner,"run","--config",f.configFile],{encoding:"utf8",timeout:15_000});
    assert.notEqual(rejected.status,0);
    assert.throws(()=>parseConfig({...f.config,host:"../other"}));
    assert.throws(()=>parseConfig({...f.config,buildTimeoutMs:2**31}));
  } finally { f.cleanup(); }
});
