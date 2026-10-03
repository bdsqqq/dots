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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

assert.equal(
  process.argv
    .slice(2)
    .every((arg) => arg === "--negative" || arg === "--built"),
  true,
  "offline only; flags: --built, --negative (deliberately drop one call and fail)",
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = process.argv.includes("--built");
const expected = [
  "agent_message",
  "apply_patch",
  "bash",
  "code_review",
  "commit_search",
  "delegate",
  "diff",
  "find",
  "finder",
  "format_file",
  "glob_github",
  "grep",
  "librarian",
  "list_directory_github",
  "list_repositories",
  "look_at",
  "ls",
  "memory_open",
  "memory_search",
  "oracle",
  "read",
  "read_github",
  "read_session",
  "read_web_page",
  "search_github",
  "search_sessions",
  "skill",
  "undo_edit",
  "web_search",
].sort();
assert.equal(expected.length, 29);
const temporary = mkdtempSync(join(tmpdir(), "pi-codemode-cli-"));
const put = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const json = (path, value) => put(path, JSON.stringify(value));
const executable = (name, source) => {
  const path = join(temporary, "bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
};
try {
  const sessions = join(temporary, "sessions");
  const targetId = "11111111-1111-4111-8111-111111111111";
  const targetSession = join(sessions, `2026-01-01_${targetId}.jsonl`);
  put(
    targetSession,
    [
      {
        type: "session",
        version: 3,
        id: targetId,
        timestamp: new Date().toISOString(),
        cwd: temporary,
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "SESSION_FIXTURE" }],
          timestamp: Date.now(),
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  put(join(temporary, "fixture.txt"), "LOCAL_FIXTURE\n");
  put(join(temporary, "format.json"), '{"fixture":true}');
  put(
    join(temporary, "agent", "skills", "fixture", "SKILL.md"),
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
  executable(
    "prettier",
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv.at(-1), '{ "fixture": true }\\n');`,
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
  // Real verified projection publisher writes an isolated generation; no real memory is touched.
  const { publishQmdSource } = await createJiti(import.meta.url).import(
    join(root, "packages/core/agent-memory/maintainer/projection.ts"),
  );
  const memory = Buffer.from(
    '---\nmemory_version: 2\nmemory_id: "mem_fixture"\ntitle: "fixture"\ndescription: "offline memory"\nkind: "fact"\nscope: "global"\ntriggers: ["fixture"]\nkeywords: []\nstatus: "active"\nupdated: "2026-01-01"\n---\n\nMEMORY_FIXTURE\n',
  );
  publishQmdSource({ data: memoryData }, "a".repeat(40), {
    list: () => ["2026-01-01-fixture-source__agent.md"],
    read: () => memory,
  });
  const rows = [
    {
      file: "qmd://agent-memories/2026-01-01-fixture-source-agent.md",
      title: "2026-01-01-fixture-source__agent",
      body: memory.toString("utf8"),
    },
  ];
  executable("qmd", `console.log(${JSON.stringify(JSON.stringify(rows))});`);
  const settings = {};
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionPaths = manifest.pi.extensions.map((p) =>
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
  settings["@bds_pi/agent-message"] = {
    enabled: true,
    queueDir: join(temporary, "mailbox"),
    sessionsDirs: [sessions],
  };
  settings["@bds_pi/read-session"] = {
    enabled: true,
    sessionsDirs: [sessions],
  };
  settings["@bds_pi/search-sessions"] = {
    enabled: true,
    sessionsDirs: [sessions],
  };
  json(join(temporary, "bds.json"), settings);
  json(join(temporary, "agent/settings.json"), {
    retry: { enabled: false },
    compaction: { enabled: false },
    defaultTools: ["codemode"],
    codemode: { mode: "only" },
  });
  const calls = [
    ["read", { path: join(temporary, "fixture.txt") }, "LOCAL_FIXTURE"],
    ["ls", { path: temporary }, "fixture.txt"],
    ["find", { filePattern: "**/fixture.txt" }, "fixture.txt"],
    [
      "grep",
      { pattern: "LOCAL_FIXTURE", path: join(temporary, "fixture.txt") },
      "LOCAL_FIXTURE",
    ],
    ["bash", { cmd: "printf BASH_FIXTURE", cwd: temporary }, "BASH_FIXTURE"],
    ["format_file", { path: join(temporary, "format.json") }, ""],
    ["skill", { name: "fixture" }, "SKILL_FIXTURE"],
    ["search_sessions", { all_workspaces: true }, targetId],
    [
      "agent_message",
      { sessionId: targetId, message: "MESSAGE_FIXTURE" },
      "queued agent message",
    ],
    [
      "read_session",
      { session_id: targetId, goal: "summarize fixture" },
      "SUBAGENT_FIXTURE",
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
    ["memory_search", { query: "fixture" }, "mem_fixture"],
    ["memory_open", { memoryId: "mem_fixture" }, "MEMORY_FIXTURE"],
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
  if (process.argv.includes("--negative")) calls.pop();
  const code = `// @options: {"timeout_ms": 120000, "max_output_tokens": 12000}
    const expected=${JSON.stringify(expected)}; const passed=[];
    function check(value,message) { if(!value) throw new Error(message); }
    async function call(name,args,needle) {
      const r=await tools[name](args);
      check(r && Array.isArray(r.content) && 'details' in r, name+' lost structured result');
      check(r.content.some(p=>p.type==='text' && p.text.includes(needle)), name+' missing expected output '+JSON.stringify(r));
      passed.push(name); text({name,status:'verified'}); return r;
    }
    const failures=[];
    for(const [name,args,needle] of ${JSON.stringify(calls)}) {
      try { await call(name,args,needle); } catch(error) { failures.push(name+': '+String(error)); }
    }
    check(!failures.length,JSON.stringify(failures));
    const edited=await call('apply_patch',{input:${JSON.stringify(`*** Begin Patch\n*** Update File: ${join(temporary, "fixture.txt")}\n@@\n-LOCAL_FIXTURE\n+EDIT_FIXTURE\n*** End Patch`)}},'');
    check(edited.details.sessionId && edited.details.changes[0].changeId,'missing undo handles');
    await call('undo_edit',{path:${JSON.stringify(join(temporary, "fixture.txt"))},changeId:edited.details.changes[0].changeId,sessionId:edited.details.sessionId},'');
    const page=await call('read_web_page',{url:'https://codemode.example/fixture',output:['raw'],max_length:512},'WEB_FIXTURE');
    check(page.details.webPage.nextCursor,'missing web cursor');
    text({cursor:page.details.webPage.nextCursor});
    const picture=await tools.read({path:${JSON.stringify(join(temporary, "image.png"))}});
    check(picture.content.some(p=>p.type==='image'),'read dropped image');
    for(const part of picture.content) if(part.type==='image') image(part);
    check(JSON.stringify([...new Set(passed)].sort())===JSON.stringify(expected),'tools dropped from execution inventory');
    text('CODEMODE_VERIFIED');
  `;
  const plan = {
    expected,
    extensionRoot: join(
      root,
      built ? "dist/extensions" : "packages/extensions",
    ),
    inventory: join(temporary, "inventory.json"),
    result: join(temporary, "result.json"),
    failure: join(temporary, "failure.txt"),
    code,
  };
  json(join(temporary, "plan.json"), plan);
  const env = {
    ...process.env,
    HOME: temporary,
    TMPDIR: temporary,
    PI_CODING_AGENT_DIR: join(temporary, "agent"),
    PI_BDS_CONFIG_PATH: join(temporary, "bds.json"),
    PI_BDS_CONFIG_OVERRIDES_PATH: join(temporary, "none.json"),
    PI_BIN: child,
    PI_MEMORY_ROOT: memoryRoot,
    PI_MEMORY_DATA_DIR: memoryData,
    PI_MEMORY_STATE_DIR: join(temporary, "memory-state"),
    QMD_BIN: join(temporary, "bin/qmd"),
    PI_AGENT_MEMORY_PROMPT_WORKER: "0",
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
    ...extensionPaths.flatMap((p) => ["-e", p]),
    "-e",
    join(root, "scripts/codemode-fixture.mjs"),
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
  const result = JSON.parse(readFileSync(plan.result, "utf8"));
  assert.ok(
    result.content.some((p) => p.type === "image"),
    "codemode did not forward image to provider",
  );
  assert.equal(
    readFileSync(join(temporary, "fixture.txt"), "utf8"),
    "LOCAL_FIXTURE\n",
  );
  assert.equal(
    readFileSync(join(temporary, "format.json"), "utf8"),
    '{ "fixture": true }\n',
  );
  const mailbox = join(temporary, "mailbox", targetId);
  const queued = readdirSync(mailbox).filter((p) => p.endsWith(".json"));
  assert.equal(queued.length, 1);
  assert.equal(
    JSON.parse(readFileSync(join(mailbox, queued[0]), "utf8")).content,
    "MESSAGE_FIXTURE",
  );
  const cursorPart = result.content.find(
    (p) => p.type === "text" && p.text.startsWith('{"cursor":'),
  );
  assert.ok(cursorPart, "missing continuation capability");
  const cursor = JSON.parse(cursorPart.text).cursor;
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
        count: expected.length,
        evidence: [
          `real CLI + built-in codemode + ${built ? "built" : "source"} extension registrations`,
          "structured content/details",
          "edit -> explicit-handle undo",
          "image forwarded into provider context",
          "isolated mailbox enqueue",
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
