import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackendRecoveryBudget } from "./recovery.ts";
import { createPublicationManager, stopBackend } from "./files-browser-server.mjs";

test("owned backend recovery is bounded across publisher restarts and can half-open after cooldown", async()=>{
  const directory=await mkdtemp(join(tmpdir(),"backend-budget-"));let now=0;
  try{
    const file=join(directory,"budget.json");let budget=new BackendRecoveryBudget(file,()=>now);
    for(let i=0;i<3;i++){await budget.failed();now+=10_000;}
    assert.equal((await budget.permit()).reasonCode,"recovery_exhausted");
    budget=new BackendRecoveryBudget(file,()=>now);
    assert.equal((await budget.permit()).allowed,false);
    now+=30*60_000;assert.equal((await budget.permit()).allowed,true);
    await budget.failed();assert.equal((await budget.permit()).allowed,false);
    await budget.healthy();now+=10*60_000;await budget.healthy();
    assert.equal((await budget.permit()).allowed,true);
    await writeFile(file,"corrupt state");await assert.rejects(budget.permit());
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("an alive but stuck owned backend is stopped once and replacement observes a persisted circuit breaker",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"publisher-repair-"));let now=0,healthy=true,starts=0,stops=0;
  const server=createServer((request,response)=>{
    response.setHeader("content-type","application/json");
    response.end(JSON.stringify(request.url.startsWith("/rest/db/browse")?[]:{state:"idle",needFiles:0,needDirectories:0,needSymlinks:0,needBytes:0,sequence:1}));
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  const config={state:directory,source:join(directory,"source"),apiKey:"fixture",syncthingUrl:`http://127.0.0.1:${server.address().port}`};
  const snapshots=join(directory,"snapshots");await mkdir(config.source);await mkdir(snapshots);
  const dependencies={now:()=>now,readiness:async()=>({ready:healthy}),
    start:(_config,generation,snapshot)=>{starts++;return{generation,snapshot,history:join(directory,"history"),port:server.address().port,child:{exitCode:null},closed:Promise.resolve(),inflight:0};},
    stop:async backend=>{stops++;backend.stopping=true;backend.child.exitCode=0;}};
  try{
    let publisher=createPublicationManager(config,snapshots,dependencies);
    await publisher.refresh();assert.equal(starts,1);
    for(let i=0;i<3;i++){
      healthy=false;await publisher.refresh();assert.equal(stops,i+1);
      now+=10_000;
      if(i<2){healthy=true;await publisher.refresh();}
    }
    assert.equal(starts,3);assert.equal(publisher.active,null);
    publisher=createPublicationManager(config,snapshots,dependencies);
    await publisher.refresh();assert.equal(starts,3,"restarting the publisher cannot reset the recovery budget");
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

for (const changed of [false, true]) {
  test(`a candidate survives scanning but ${changed ? "is replaced when the indexed model changes" : "is reused only once the source is idle"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "publisher-scanning-"));
    let state = "idle", sequence = 1, browses = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url.startsWith("/rest/db/browse")) {
        browses += 1;
        state = "scanning";
        response.end(JSON.stringify([{ name: "indexed.txt", type: "FILE_INFO_TYPE_FILE", size: 3, modTime: String(sequence) }]));
      } else response.end(JSON.stringify({ state, sequence, needFiles: 0, needDirectories: 0, needSymlinks: 0, needBytes: 0 }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const config = { state: directory, source: join(directory, "source"), apiKey: "fixture", syncthingUrl: `http://127.0.0.1:${server.address().port}` };
    const snapshots = join(directory, "snapshots");
    await mkdir(config.source); await mkdir(snapshots); await writeFile(join(config.source, "indexed.txt"), "old");
    const publisher = createPublicationManager(config, snapshots, {
      start: (_config, generation, snapshot) => ({ generation, snapshot, port: server.address().port, child: { exitCode: null }, inflight: 0 }),
    });
    try {
      await publisher.refresh();
      assert.equal(publisher.active, null, "scanning cannot publish a candidate");
      assert.equal((await readdir(snapshots)).length, 1, "retain one bounded candidate, not a rebuild loop");
      await publisher.refresh(); assert.equal(browses, 1, "do not rebuild during scanning");
      if (changed) {
        sequence += 1;
        await writeFile(join(directory, "replacement"), "new");
        await rename(join(directory, "replacement"), join(config.source, "indexed.txt"));
        state = "idle"; await publisher.refresh();
        assert.equal(publisher.active, null, "the changed candidate must also finish scanning");
        assert.equal(browses, 2);
        assert.equal((await readdir(snapshots)).length, 1, "discard the invalidated candidate");
      }
      state = "idle"; await publisher.refresh();
      assert.ok(publisher.active);
      assert.equal(browses, changed ? 2 : 1);
      assert.equal(await readFile(join(publisher.active.snapshot, "indexed.txt"), "utf8"), changed ? "new" : "old");
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("owned backend shutdown escalates only its ChildProcess and preserves unrelated state",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"backend-stop-"));
  const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:["ignore","pipe","inherit"]});
  const closed=once(child,"close");await once(child.stdout,"data");
  const snapshot=join(directory,"snapshot"),history=join(directory,"history"),userFile=join(directory,"unpublished.txt");
  await mkdir(snapshot);await mkdir(history);await writeFile(userFile,"keep");
  let fallback=false;
  const safety=setTimeout(()=>{fallback=true;child.kill("SIGKILL");},1500);
  try{
    await stopBackend({child,closed,snapshot,history,generation:1},50);
    assert.equal(fallback,false,"shutdown must not rely on the fixture safety kill");
    assert.equal(child.signalCode,"SIGKILL");assert.equal(await readFile(userFile,"utf8"),"keep");
  }finally{clearTimeout(safety);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await rm(directory,{recursive:true,force:true});}
});
