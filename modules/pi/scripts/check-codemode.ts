#!/usr/bin/env node
/** Offline CLI integration probe. Fixtures replace LLM/network/process boundaries only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

assert.equal(
  process.argv
    .slice(2)
    .every((arg) =>
      ["--negative", "--negative-recall", "--built"].includes(arg),
    ),
  true,
  "offline only; flags: --built, --negative (clobber text), --negative-recall (disable automatic recall)",
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = process.argv.includes("--built");
const expected = [
  "agent_message",
  "bash",
  "code_review",
  "commit_search",
  "delegate",
  "diff",
  "finder",
  "glob_github",
  "librarian",
  "list_directory_github",
  "list_repositories",
  "look_at",
  "oracle",
  "read",
  "read_github",
  "history_list",
  "history_read",
  "read_web_page",
  "search_github",
  "skill",
  "web_search",
].sort();
const native = ["edit", "write"];
const retired = [
  "apply_patch",
  "format_file",
  "undo_edit",
  "find",
  "grep",
  "ls",
  "read_session",
  "search_sessions",
  "memory_open",
  "memory_search",
];
const temporary = mkdtempSync(join(realpathSync(tmpdir()), "pi-codemode-cli-"));
const put = (path: string, value: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const json = (path: string, value: unknown) => put(path, JSON.stringify(value));
const executable = (name: string, source: string) => {
  const path = join(temporary, "bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
};
try {
  const agentDir = join(temporary, ".pi", "agent");
  const sessions = join(agentDir, "sessions", "--fixture--");
  const targetId = "11111111-1111-4111-8111-111111111111";
  const history = SessionManager.create(temporary, sessions, { id: targetId });
  const rootEntry = history.appendMessage({
    role: "user",
    content: "SESSION_FIXTURE",
    timestamp: Date.now(),
  });
  const abandonedLeaf = history.appendMessage({
    role: "user",
    content: "ABANDONED_BRANCH_FIXTURE",
    timestamp: Date.now(),
  });
  history.branch(rootEntry);
  const selectedLeaf = history.appendMessage({
    role: "user",
    content: "SELECTED_BRANCH_FIXTURE",
    timestamp: Date.now(),
  });
  const targetSession = history.getSessionFile()!;
  const targetMetadata = (await SessionManager.list(temporary, sessions)).find(
    (s) => s.id === targetId,
  )!;
  assert.ok(targetMetadata, "SDK did not persist fixture history");
  put(
    join(temporary, "fixture.txt"),
    "UNRELATED_USER_TEXT\nLOCAL_FIXTURE\nKEEP_TRAILING_TEXT\n",
  );
  put(join(temporary, "format.json"), '{"fixture":true}');
  put(
    join(agentDir, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: offline integration fixture\n---\nSKILL_FIXTURE\n",
  );
  // Tiny valid PNG: exercise real read's image result and codemode's image forwarding.
  put(
    join(temporary, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  // The project owns the formatter command, not a generic tool or fake formatter.
  json(join(temporary, "package.json"), {
    scripts: { format: "node format.mjs" },
  });
  put(
    join(temporary, "format.mjs"),
    `
    import {readFileSync,writeFileSync} from 'node:fs';
    writeFileSync('format.json', JSON.stringify(JSON.parse(readFileSync('format.json','utf8')),null,2)+'\\n');
  `,
  );
  executable(
    "gh",
    `
    const route=process.argv[3]?.split('?')[0]; let data;
    if(route?.includes('/compare/')) data={status:'ahead',ahead_by:1,behind_by:0,total_commits:1,commits:[{sha:'abc',commit:{message:'GH_FIXTURE'}}],files:[{filename:'fixture.txt',status:'modified',additions:1,deletions:0,changes:1,patch:'GH_FIXTURE'}]};
    else if(route?.includes('/git/trees/')) data={tree:[{path:'fixture.txt',type:'blob',size:12}]};
    else if(route?.includes('/contents/fixture.txt')) data={type:'file',content:Buffer.from('GH_FIXTURE').toString('base64'),encoding:'base64',size:10};
    else if(route?.includes('/contents/')) data=[{name:'fixture.txt',path:'fixture.txt',type:'file',size:10}];
    else if(route==='search/code') data={total_count:1,items:[{name:'fixture.txt',path:'fixture.txt',html_url:'https://github.com/fixture/repo/blob/main/fixture.txt',repository:{full_name:'fixture/repo'},text_matches:[{fragment:'GH_FIXTURE'}]}]};
    else if(route==='search/repositories') data={total_count:1,items:[{full_name:'fixture/repo',description:'GH_FIXTURE',html_url:'https://github.com/fixture/repo',language:'Text',stargazers_count:0,updated_at:'2026-01-01'}]};
    else if(route?.includes('/commits')) data=[{sha:'abc',commit:{message:'GH_FIXTURE',author:{name:'fixture',date:'2026-01-01'}}}];
    else if(route==='repos/fixture/repo') data={default_branch:'main'};
    else throw new Error('unapproved gh route: '+process.argv.join(' '));
    console.log(JSON.stringify(data));
  `,
  );
  const child = executable(
    "pi-fixture",
    `
    import readline from 'node:readline';
    const message={role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',content:[{type:'text',text:'SUBAGENT_FIXTURE'}],stopReason:'stop',timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const emit=x=>console.log(JSON.stringify(x));
    if(process.argv.includes('rpc')) {
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const command=JSON.parse(line); emit({id:command.id,type:'response',command:command.type,success:true,data:{disposition:command.type==='follow_up'?'queued':'started'}});
        if(command.type==='follow_up') {emit({type:'message_end',message}); emit({type:'agent_end',messages:[message]}); emit({type:'agent_settled'});}
      });
    } else { emit({type:'message_end',message}); emit({type:'agent_end',messages:[message]}); }
  `,
  );
  const memoryRoot = join(temporary, "memory");
  const memoryData = join(temporary, "memory-data");
  mkdirSync(memoryRoot);
  // Real editable Markdown and durable acceptance, not a fake search reply.
  const jiti = createJiti(import.meta.url);
  const { FileMemoryStore } = await jiti.import<
    typeof import("../packages/core/agent-memory/runtime/store.ts")
  >(join(root, "packages/core/agent-memory/runtime/store.ts"));
  const { createNoteRevision } = await jiti.import<
    typeof import("../packages/core/agent-memory/runtime/markdown.ts")
  >(join(root, "packages/core/agent-memory/runtime/markdown.ts"));
  const note = createNoteRevision({
    noteId:
      "mem_fixture" as import("../packages/core/agent-memory/runtime/contracts.ts").NoteId,
    scope: { kind: "personal", ownerId: "fixture" },
    ancestry: { kind: "known", parents: [] },
    path: "offline-verification--mem_fixture.md",
    body: "# offline verification\n\nMEMORY_FIXTURE\n",
    claims: [],
    links: [],
    exposure: { kind: "active" },
    authoredAt: new Date().toISOString(),
  });
  const memoryStore = new FileMemoryStore({
    root: join(memoryRoot, "runtime"),
    data: join(memoryData, "runtime"),
    state: join(temporary, "memory-state/runtime"),
    owner: "fixture",
    replicaId:
      "fixture" as import("../packages/core/agent-memory/runtime/contracts.ts").ReplicaId,
  });
  try {
    assert.equal(
      (
        await memoryStore.commit({
          commitId:
            "fixture-memory" as import("../packages/core/agent-memory/runtime/contracts.ts").CommitId,
          now: note.authoredAt,
          windows: [],
          edits: [{ revision: note, expectedHeads: [] }],
          suppressions: [],
          outcomes: [],
          lease: null,
        })
      ).kind,
      "locally-committed",
    );
  } finally {
    memoryStore.close();
  }
  const settings: Record<string, unknown> = {};
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionPaths = manifest.pi.extensions.map((p: string) =>
    join(
      root,
      built
        ? p
        : p
            .replace("./dist/extensions/", "packages/extensions/")
            .replace(/\.js$/, "/index.ts"),
    ),
  );
  for (const path of manifest.pi.extensions)
    settings[`@bds_pi/${path.split("/").at(-1).replace(/\.js$/, "")}`] = {
      enabled: true,
    };
  settings["@bds_pi/agent-memory"] = {
    enabled: !process.argv.includes("--negative-recall"),
  };
  settings["@bds_pi/agent-message"] = {
    enabled: true,
    queueDir: join(temporary, "mailbox"),
  };
  json(join(agentDir, "settings.json"), {
    ...settings,
    retry: { enabled: false },
    compaction: { enabled: false },
    defaultTools: ["codemode", "edit", "write"],
    codemode: { mode: "only" },
  });
  const calls = [
    ["read", { path: join(temporary, "fixture.txt") }, "LOCAL_FIXTURE"],
    [
      "bash",
      { cmd: 'rg --files --glob "*.txt"', cwd: temporary },
      "fixture.txt",
    ],
    ["bash", { cmd: "ls", cwd: temporary }, "image.png"],
    [
      "bash",
      { cmd: 'rg "LOCAL_FIXTURE" "fixture.txt"', cwd: temporary },
      "LOCAL_FIXTURE",
    ],
    ["bash", { cmd: "printf BASH_FIXTURE", cwd: temporary }, "BASH_FIXTURE"],
    ["bash", { cmd: "npm run format", cwd: temporary }, ""],
    ["skill", { name: "fixture" }, "SKILL_FIXTURE"],
    [
      "agent_message",
      { sessionId: targetId, message: "MESSAGE_FIXTURE" },
      "queued agent message",
    ],
    ["finder", { query: "find fixture" }, "SUBAGENT_FIXTURE"],
    ["oracle", { task: "explain fixture" }, "SUBAGENT_FIXTURE"],
    [
      "delegate",
      { prompt: "explain fixture", description: "fixture" },
      "SUBAGENT_FIXTURE",
    ],
    ["librarian", { query: "explain fixture" }, "SUBAGENT_FIXTURE"],
    [
      "look_at",
      {
        path: join(temporary, "image.png"),
        objective: "describe",
        context: "fixture",
      },
      "SUBAGENT_FIXTURE",
    ],
    ["code_review", { diff_description: "fixture diff" }, "SUBAGENT_FIXTURE"],
    [
      "read_github",
      { repository: "https://github.com/fixture/repo", path: "fixture.txt" },
      "GH_FIXTURE",
    ],
    [
      "search_github",
      { repository: "https://github.com/fixture/repo", pattern: "fixture" },
      "fixture.txt",
    ],
    [
      "list_directory_github",
      { repository: "https://github.com/fixture/repo", path: "" },
      "fixture.txt",
    ],
    ["list_repositories", { pattern: "fixture" }, "fixture/repo"],
    [
      "glob_github",
      { repository: "https://github.com/fixture/repo", filePattern: "*.txt" },
      "fixture.txt",
    ],
    [
      "commit_search",
      { repository: "https://github.com/fixture/repo", query: "fixture" },
      "GH_FIXTURE",
    ],
    [
      "diff",
      {
        repository: "https://github.com/fixture/repo",
        base: "main",
        head: "fixture",
      },
      "fixture.txt",
    ],
    [
      "web_search",
      { objective: "fixture", search_queries: ["fixture"] },
      "SEARCH_FIXTURE",
    ],
  ];
  const code = `// @options: {"timeout_ms": 120000, "max_output_tokens": 12000}
    function check(value,message) { if(!value) throw new Error(message); }
    async function call(name,args,needle) {
      const r=await tools[name](args);
      check(r && Array.isArray(r.content) && 'details' in r, name+' lost structured result');
      check(r.content.some(p=>p.type==='text' && p.text.includes(needle)), name+' missing expected output '+JSON.stringify(r));
      text({name,status:'verified'}); return r;
    }
    const failures=[];
    for(const [name,args,needle] of ${JSON.stringify(calls)}) {
      try { await call(name,args,needle); } catch(error) { failures.push(name+': '+String(error)); }
    }
    check(!failures.length,JSON.stringify(failures));
    const listed=await tools.history_list({});
    check(listed.ok,'history_list lost structured output '+JSON.stringify(listed));
    const fixture=listed.value.find(s=>s.sessionId===${JSON.stringify(targetId)});
    check(fixture && fixture.workspace===${JSON.stringify(temporary)} && fixture.sessionFile===${JSON.stringify(targetSession)},'history_list lost session identity');
    check(fixture.firstMessage===${JSON.stringify(targetMetadata.firstMessage)},'history_list disagrees with native SDK metadata');
    const request={workspace:${JSON.stringify(temporary)},sessionId:${JSON.stringify(targetId)}};
    const selected=await tools.history_read({...request,entryId:${JSON.stringify(selectedLeaf)}});
    check(selected.ok && selected.value.selection==='entry' && selected.value.leafId===${JSON.stringify(selectedLeaf)},'history_read lost selected leaf');
    check(selected.value.sessionFile===fixture.sessionFile && selected.value.workspace===fixture.workspace,'history adapters disagree on identity');
    check(JSON.stringify(selected.value.entries)===${JSON.stringify(JSON.stringify(history.getBranch(selectedLeaf)))},'selected history differs from actual SDK branch');
    const abandoned=await tools.history_read({...request,entryId:${JSON.stringify(abandonedLeaf)}});
    check(abandoned.ok && JSON.stringify(abandoned.value.entries)===${JSON.stringify(JSON.stringify(history.getBranch(abandonedLeaf)))},'explicit abandoned branch differs from native SDK');
    const persisted=await tools.history_read(request);
    check(persisted.ok && persisted.value.selection==='persisted-last-entry' && persisted.value.leafId===selected.value.leafId,'implicit history did not select last persisted entry');
    const missing=await tools.history_read({...request,sessionId:'absent'});
    check(missing.ok===false && missing.error.code==='not_found','history lookup error lost structure '+JSON.stringify(missing));
    const wrong=await tools.history_read({...request,workspace:${JSON.stringify(join(temporary, "other"))}});
    check(wrong.ok===false && wrong.error.code==='not_found','workspace-scoped history lookup lost error structure '+JSON.stringify(wrong));
    const path=${JSON.stringify(join(temporary, "fixture.txt"))};
    const edited=await tools.edit({path,edits:[{oldText:'LOCAL_FIXTURE',newText:'EDIT_FIXTURE'}]});
    check(typeof edited==='string','native edit lost text result');
    const after=await call('read',{path},'UNRELATED_USER_TEXT\\n');
    check(after.content.some(p=>p.type==='text' && p.text.includes('EDIT_FIXTURE')),'edit did not reach file');
    let editError;
    try { await tools.edit({path,edits:[{oldText:'DOES_NOT_EXIST',newText:'CORRUPTED'}]}); } catch(error) {editError=String(error);}
    check(editError && /not find|not found|match/i.test(editError),'nonmatching edit did not preserve error');
    const shellFailure=await tools.bash({cmd:'printf SHELL_ERROR_FIXTURE; exit 23',cwd:${JSON.stringify(temporary)}});
    check(shellFailure.details?.process?.exitCode===23 && shellFailure.details.process.errorKind==='nonzero_exit','bash failure lost structured process status '+JSON.stringify(shellFailure));
    check(shellFailure.content.some(p=>p.type==='text' && p.text.includes('SHELL_ERROR_FIXTURE')),'bash failure lost output');
    const written=await tools.write({path:${JSON.stringify(join(temporary, "created.txt"))},content:'WRITE_FIXTURE\\n'});
    check(typeof written==='string','native write lost text result');
    await call('read',{path:${JSON.stringify(join(temporary, "created.txt"))}},'WRITE_FIXTURE');
    ${process.argv.includes("--negative") ? "await tools.write({path,content:'EDIT_FIXTURE\\n'});" : ""}
    for(const name of ${JSON.stringify(retired)}) {
      check(!ALL_TOOLS.some(t=>t.name===name),name+' remains discoverable');
      let rejected=false;
      try { await tools[name]({}); } catch { rejected=true; }
      check(rejected,name+' remains callable');
    }
    const page=await call('read_web_page',{url:'https://codemode.example/fixture',output:['raw'],max_length:512},'WEB_FIXTURE');
    check(page.details.webPage.nextCursor,'missing web cursor');
    text({cursor:page.details.webPage.nextCursor});
    const picture=await tools.read({path:${JSON.stringify(join(temporary, "image.png"))}});
    check(picture.content.some(p=>p.type==='image' && p.mimeType==='image/png' && p.data===${JSON.stringify(readFileSync(join(temporary, "image.png")).toString("base64"))}),'read dropped or corrupted image bytes');
    for(const part of picture.content) if(part.type==='image') image(part);
    text('CODEMODE_VERIFIED');
  `;
  const plan = {
    expected,
    native,
    retired,
    extensionRoot: join(
      root,
      built ? "dist/extensions" : "packages/extensions",
    ),
    inventory: join(temporary, "inventory.json"),
    result: join(temporary, "result.json"),
    failure: join(temporary, "failure.txt"),
    memoryObserved: join(temporary, "memory-observed"),
    code,
  };
  json(join(temporary, "plan.json"), plan);
  const env = {
    ...process.env,
    HOME: temporary,
    TMPDIR: temporary,
    PI_CODING_AGENT_DIR: agentDir,
    PI_BIN: child,
    PI_MEMORY_ROOT: memoryRoot,
    PI_MEMORY_DATA_DIR: memoryData,
    PI_MEMORY_STATE_DIR: join(temporary, "memory-state"),
    PI_MEMORY_OWNER: "fixture",
    BDS_PI_LOG_DIR: join(temporary, "logs"),
    PARALLEL_API_KEY: "fixture",
    PI_CODEMODE_PLAN: join(temporary, "plan.json"),
    PI_CODEMODE_NETWORK_LOG: join(temporary, "network.log"),
    PATH: `${join(temporary, "bin")}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${join(root, "scripts/codemode-boundaries.mjs")}`,
    PI_OFFLINE: "1",
  };
  const args = [
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "-e",
    "builtin:codemode",
    ...extensionPaths.flatMap((p: string) => ["-e", p]),
    "-e",
    join(root, "scripts/codemode-fixture.ts"),
    "--provider",
    "codemode-fixture",
    "--model",
    "deterministic",
    "--session-dir",
    sessions,
    "--mode",
    "json",
    "-p",
    "run offline verification",
  ];
  const run = spawnSync(join(root, "node_modules/.bin/pi"), args, {
    cwd: temporary,
    env,
    encoding: "utf8",
    timeout: 150000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (existsSync(plan.failure))
    throw new Error(readFileSync(plan.failure, "utf8"));
  assert.equal(
    run.status,
    0,
    `${run.error ?? ""}\n${run.stderr}\n${run.stdout}`,
  );
  assert.ok(
    existsSync(plan.inventory),
    `registry assertion failed\n${run.stderr}\n${run.stdout}`,
  );
  assert.ok(
    existsSync(plan.result),
    `codemode did not complete\n${run.stderr}\n${run.stdout}`,
  );
  assert.ok(
    existsSync(plan.memoryObserved),
    "automatic memory body never reached the actual provider context",
  );
  const result = JSON.parse(readFileSync(plan.result, "utf8"));
  assert.ok(
    result.content.some((p: { type: string }) => p.type === "image"),
    "codemode did not forward image to provider",
  );
  assert.equal(
    readFileSync(join(temporary, "fixture.txt"), "utf8"),
    "UNRELATED_USER_TEXT\nEDIT_FIXTURE\nKEEP_TRAILING_TEXT\n",
    "native editing clobbered unrelated text or a failed edit changed the file",
  );
  assert.equal(
    readFileSync(join(temporary, "format.json"), "utf8"),
    '{\n  "fixture": true\n}\n',
  );
  const mailbox = join(temporary, "mailbox", targetId);
  const queued = readdirSync(mailbox).filter((p) => p.endsWith(".json"));
  assert.equal(queued.length, 1);
  assert.equal(
    JSON.parse(readFileSync(join(mailbox, queued[0]), "utf8")).content,
    "MESSAGE_FIXTURE",
  );
  // Native codemode batches text emissions; the cursor may share a block with
  // inventory lines, headers, and image-file metadata.
  const cursorLine = result.content
    .flatMap((p: { type: string; text: string }) =>
      p.type === "text" ? p.text.split("\n") : [],
    )
    .find((line: string) => line.startsWith('{"cursor":'));
  assert.ok(cursorLine, "missing continuation capability");
  const cursor = JSON.parse(cursorLine).cursor;
  const networkBefore = readFileSync(env.PI_CODEMODE_NETWORK_LOG, "utf8");
  assert.ok(networkBefore.includes("https://api.parallel.ai/v1/search"));
  assert.ok(networkBefore.includes("https://codemode.example/fixture"));
  const continuation = {
    ...plan,
    result: join(temporary, "continuation.json"),
    code: `
    const r=await tools.read_web_page({cursor:${JSON.stringify(cursor)},max_length:512});
    if(!r.content.some(p=>p.type==='text' && p.text.includes('WEB_FIXTURE'))) throw new Error('continuation lost content');
    if(r.details.webPage.start!==512) throw new Error('continuation restarted');
    text('CODEMODE_VERIFIED');
  `,
  };
  json(env.PI_CODEMODE_PLAN, continuation);
  const resumed = spawnSync(join(root, "node_modules/.bin/pi"), args, {
    cwd: temporary,
    env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (existsSync(plan.failure))
    throw new Error(readFileSync(plan.failure, "utf8"));
  assert.equal(resumed.status, 0, `${resumed.error ?? ""}\n${resumed.stderr}`);
  assert.ok(
    existsSync(continuation.result),
    "fresh CLI process did not continue cursor",
  );
  assert.equal(
    readFileSync(env.PI_CODEMODE_NETWORK_LOG, "utf8"),
    networkBefore,
    "continuation unexpectedly fetched",
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        cli: join(root, "node_modules/.bin/pi"),
        tools: expected,
        evidence: [
          `real CLI + built-in codemode + ${built ? "built" : "source"} extension registrations`,
          "structured content/details",
          "native edit/write preserve unrelated text and reject nonmatching edits",
          "project formatting script through bash; shell rg and listing",
          "image forwarded into provider context",
          "isolated mailbox enqueue",
          "automatic editable-memory recall in provider context, without specialized memory tools",
          "native SDK history metadata and explicit branches through codemode, without model extraction",
          "cursor continuation in fresh CLI process with no originating transcript or fetch",
        ],
        limitations: [
          "network and subagent process replies are deterministic boundary fixtures, not live external services",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
