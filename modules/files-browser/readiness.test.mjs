import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { proxyServer } from "./files-browser-server.mjs";

async function listen(server) { server.listen(0,"127.0.0.1");await once(server,"listening");return server.address().port; }
async function close(server) { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }

test("files readiness requires a live, responsive published backend", async () => {
  const backendServer=createServer((_request,response)=>response.writeHead(200).end("fixture"));
  const port=await listen(backendServer);
  let backend=null;
  const proxy=proxyServer(()=>backend);const publicPort=await listen(proxy);
  try {
    let response=await fetch(`http://127.0.0.1:${publicPort}/_files/ready`);
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{ready:false,reasonCode:"backend_unavailable"});
    backend={port,child:{exitCode:null},failure:null,inflight:0};
    response=await fetch(`http://127.0.0.1:${publicPort}/_files/ready`);
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ready:true,reasonCode:"ready"});
    backend.failure=new Error("private fixture path must never enter readiness JSON");
    response=await fetch(`http://127.0.0.1:${publicPort}/_files/ready`);
    assert.equal(response.status,503);assert.ok(!(await response.text()).includes("private"));
  } finally {await close(proxy);await close(backendServer);}
});
test("a competing files listener cannot erase an existing publication during startup", async () => {
  const directory=await mkdtemp(join(tmpdir(),"files-listener-"));
  const occupied=createServer((_request,response)=>response.end("existing listener"));const port=await listen(occupied);
  const state=join(directory,"state"),source=join(directory,"source"),snapshot=join(state,"snapshots");
  await mkdir(source);await mkdir(snapshot,{recursive:true});
  const marker=join(snapshot,"existing-publication");await writeFile(marker,"preserve");
  try {
    const result=spawnSync(process.execPath,[fileURLToPath(new URL("./files-browser-server.mjs",import.meta.url)),
      "--source",source,"--state",state,"--syncthing-config",join(directory,"config.xml"),
      "--syncthing-url",`http://127.0.0.1:${port}`,"--copyparty",process.execPath,"--port",String(port)],{encoding:"utf8",timeout:3000});
    assert.notEqual(result.status,0);
    assert.match(result.stdout,/EADDRINUSE/);
    assert.equal(await readFile(marker,"utf8"),"preserve");
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
  } finally {await close(occupied);await rm(directory,{recursive:true,force:true});}
});

test("an alive but hung files backend is not ready", async () => {
  const backendServer=createServer(()=>{});const port=await listen(backendServer);
  const backend={port,child:{exitCode:null},failure:null,inflight:0};
  const proxy=proxyServer(()=>backend);const publicPort=await listen(proxy);
  try {
    const response=await fetch(`http://127.0.0.1:${publicPort}/_files/ready`);
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{ready:false,reasonCode:"backend_unresponsive"});
    assert.equal(backend.child.exitCode,null);
  } finally {await close(proxy);await close(backendServer);}
});
