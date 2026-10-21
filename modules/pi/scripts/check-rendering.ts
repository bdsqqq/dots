#!/usr/bin/env node
/** Full-session PTY sampler: real CLI/tools/renderers, deterministic model and HTTP boundaries. */
import assert from "node:assert/strict";
import {
  assertToolGrid,
  assertBoundedCodemode,
  assertRawExport,
  assertLifecycle,
  assertOfflineRenderingArgs,
  toolResultRegion,
  type RenderEvidence,
} from "./rendering-assertions.ts";
import {
  assertMarkdownGrid,
  markdownShapes,
  markdownRegion,
} from "./rendering-markdown.ts";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";

assertOfflineRenderingArgs(process.argv.slice(2));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentTools = [
  "oracle",
  "finder",
  "delegate",
  "librarian",
  "look_at",
  "code_review",
];
const temporary = mkdtempSync(join(realpathSync(tmpdir()), "pi-rendering-"));
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
const output = temporary;
console.log(`rendering artifacts: ${output}`);
try {
  const agentDir = join(temporary, ".pi", "agent");
  const sessions = join(agentDir, "sessions", "--fixture--");
  const targetId = "11111111-1111-4111-8111-111111111111";
  const history = SessionManager.create(temporary, sessions, { id: targetId });
  history.appendMessage({
    role: "user",
    content: "SESSION_FIXTURE",
    timestamp: Date.now(),
  });
  const targetSession = history.getSessionFile()!;
  put(
    join(temporary, "fixture.txt"),
    "UNRELATED_USER_TEXT\nLOCAL_FIXTURE\nKEEP_TRAILING_TEXT\n",
  );
  put(
    join(agentDir, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: offline integration fixture\n---\nSKILL_FIXTURE\n",
  );
  // generate valid checksums: native image processing decodes even tiny inputs.
  const pngChunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  put(
    join(temporary, "image.png"),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  // Exercise native dispatch separately from tmux's intentionally text-only session.
  // This is a terminal I/O boundary, not a second implementation of image layout.
  const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
  const { pathToFileURL } = await import("node:url");
  const {
    getCapabilities,
    setCapabilities,
    stripTerminalSequences,
    ScrollView,
    Container,
    Text,
  } = await import("@earendil-works/pi-tui");
  const loadAgent = (path: string) =>
    import(pathToFileURL(join(getPackageDir(), "dist", path)).href);
  const { ToolExecutionComponent } = await loadAgent(
    "modes/interactive/components/tool-execution.js",
  );
  const { initTheme } = await loadAgent("modes/interactive/theme/theme.js");
  const { createReadToolDefinition } = await loadAgent("core/tools/read.js");
  const tuiRoot = dirname(
    realpathSync(
      join(root, "node_modules/@earendil-works/pi-tui/package.json"),
    ),
  );
  const { TuiMainScreen } = await import(
    pathToFileURL(join(tuiRoot, "dist/tui-main-screen.js")).href
  );
  initTheme("dark", false);
  const originalCapabilities = getCapabilities();
  const nativeHeader = Buffer.from(header);
  nativeHeader.writeUInt32BE(80, 0);
  nativeHeader.writeUInt32BE(80, 4);
  const nativePixels = Buffer.alloc(80 * 321);
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 80; x++)
      nativePixels.writeUInt32BE(0xff0000ff, y * 321 + 1 + x * 4);
  const nativePng = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", nativeHeader),
    pngChunk("IDAT", deflateSync(nativePixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  try {
    for (const protocol of ["kitty", "iterm2"] as const) {
      setCapabilities({ ...originalCapabilities, images: protocol });
      let raw = "";
      const terminal = {
        columns: 40,
        rows: 100,
        write(data: string) {
          raw += data;
        },
        hideCursor() {},
        showCursor() {},
      };
      const tui = new TuiMainScreen(terminal, false);
      tui.stopped = false;
      const row = new ToolExecutionComponent(
        "read",
        "native-image",
        { path: "image.png" },
        { imageWidthCells: 12 },
        createReadToolDefinition(temporary),
        { requestRender() {} },
        temporary,
      );
      row.updateResult({
        content: [
          {
            type: "image",
            data: nativePng.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: undefined,
        isError: false,
      });
      tui.addChild(row);
      const observations = [];
      for (const width of [40, 20, 40]) {
        terminal.columns = width;
        for (const expanded of [false, true]) {
          row.setExpanded(expanded);
          row.setOutputPad(expanded ? 1 : 2);
          const lines: string[] = row.render(width, false);
          const plain = lines.map(stripTerminalSequences);
          const token = protocol === "kitty" ? "\x1b_Ga=T" : "\x1b]1337;File=";
          const anchors = lines.flatMap((line, index) =>
            line.includes(token) ? [index] : [],
          );
          assert.equal(anchors.length, 1, `${protocol}: native image anchor`);
          assert.equal(
            plain.at(-1)?.trim(),
            "╰────",
            `${protocol}: footer below image`,
          );
          assert.equal(
            plain[anchors[0]!]!.trim(),
            "│",
            `${protocol}: gutter on protocol row`,
          );
          if (protocol === "kitty") {
            const anchor = anchors[0]!;
            const rows = Number(lines[anchor]!.match(/,r=(\d+)/)?.[1]);
            assert.equal(
              tui.getKittyImageReservedRows(lines, anchor),
              rows,
              "framed Kitty rows stay one reservation",
            );
          }
          const before = raw.length;
          tui.doRender();
          const dispatched = raw.slice(before);
          assert.ok(
            dispatched.includes(token),
            `${protocol}: real renderer dispatch`,
          );
          assert.ok(
            dispatched.includes("╰────"),
            `${protocol}: footer dispatched`,
          );
          observations.push({ width, expanded, lines, plain, dispatched });
          // Force one full repaint as well as the differential expansion repaint.
          if (expanded) tui.resetRenderState();
        }
      }
      put(join(temporary, `image-${protocol}.ansi`), raw);
      json(join(temporary, `image-${protocol}.json`), observations);
      if (protocol === "kitty") {
        const { TuiAltScreen } = await import(
          pathToFileURL(join(tuiRoot, "dist/tui-alt-screen.js")).href
        );
        const transcript = new Container();
        transcript.addChild(row);
        transcript.addChild(new Text("tail\ntail\ntail\ntail", 0, 0));
        const scroll = new ScrollView(transcript, {
          follow: "none",
          scrollbar: "hidden",
          primary: true,
        });
        const fullscreen = new TuiAltScreen(terminal, false);
        fullscreen.stopped = false;
        fullscreen.altScreenActive = true;
        fullscreen.imageProtocol = "kitty";
        fullscreen.layoutRoot = scroll;
        terminal.rows = 4;
        raw = "";
        const cropped = [];
        fullscreen.doRender();
        for (const width of [40, 20, 40])
          for (const pad of [1, 3]) {
            terminal.columns = width;
            row.setOutputPad(pad);
            fullscreen.doRender();
            const lines: string[] = row.render(width, false);
            const anchor = lines.findIndex((line) => line.includes("\x1b_G"));
            const rows = Number(lines[anchor]!.match(/,r=(\d+)/)?.[1]);
            for (const hidden of [0, 1, 2, 3]) {
              scroll.scrollTo(anchor + hidden);
              const before = raw.length;
              fullscreen.doRender();
              const screen: string[] = fullscreen.currentLayout.lines;
              const command = screen.find((line) => line.includes("\x1b_G"));
              const visibleRows = Math.min(4, rows - hidden);
              assert.ok(
                command,
                `fullscreen: image survives ${hidden} hidden rows`,
              );
              assert.ok(
                command.includes(`r=${visibleRows}`),
                "fullscreen crop height",
              );
              const plain = screen.map(stripTerminalSequences);
              assert.ok(
                plain
                  .slice(0, visibleRows)
                  .every((line) => line.trim() === "│"),
                "fullscreen image gutters",
              );
              if (visibleRows < 4)
                assert.equal(plain[visibleRows]?.trim(), "╰────");
              const dispatched = raw.slice(before);
              assert.ok(
                dispatched.includes(`r=${visibleRows}`),
                "fullscreen cropped placement dispatched",
              );
              cropped.push({
                width,
                pad,
                hidden,
                visibleRows,
                screen,
                plain,
                dispatched,
              });
            }
          }
        put(join(temporary, "image-kitty-fullscreen.ansi"), raw);
        json(join(temporary, "image-kitty-fullscreen.json"), cropped);
      }
    }
  } finally {
    setCapabilities(originalCapabilities);
  }
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
  json(join(agentDir, "rendering-child/settings.json"), {
    retry: { enabled: false },
    compaction: { enabled: false },
    "@bds_pi/read": { enabled: true },
  });
  const child = executable(
    "pi-child",
    `import ${JSON.stringify(new URL("./rendering-child-launch.mjs", import.meta.url).href)};`,
  );
  const settings: Record<string, unknown> = {};
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionPaths = manifest.pi.extensions.map((p: string) =>
    join(
      root,
      p
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
  };
  json(join(agentDir, "settings.json"), {
    ...settings,
    retry: { enabled: false },
    compaction: { enabled: false },
    defaultTools: ["codemode", "edit", "write"],
    codemode: { mode: "on" },
    quietStartup: true,
  });
  await runSampler({
    root,
    temporary,
    agentDir,
    extensionPaths,
    child,
    targetId,
    targetSession,
  });
} finally {
  // Artifacts deliberately survive both passing and failed runs.
}

async function runSampler({
  root,
  temporary,
  agentDir,
  extensionPaths,
  child,
  targetId,
  targetSession,
}: any) {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { setTimeout: delay } = await import("node:timers/promises");
  const negative = process.argv.some((arg) =>
    ["--negative-footer", "--negative-result"].includes(arg),
  );
  const dropResults = process.argv.includes("--negative-result");
  assert.ok(
    process.argv
      .slice(2)
      .every((arg) =>
        ["--live", "--negative-footer", "--negative-result"].includes(arg),
      ),
    "flags: --live",
  );
  const socket = `pi-render-${process.pid}`;
  const tmuxConfig = join(temporary, "tmux.conf");
  // history-limit is copied when a pane is created, not when it is later set globally.
  writeFileSync(tmuxConfig, "set -g history-limit 50000\n");
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-f", tmuxConfig, "-L", socket, ...args], {
      encoding: "utf8",
      timeout: 10000,
      env,
    });
  const call = (name: string, args: unknown) => ({ name, args });
  const states: any[] = [];
  const state = (
    id: string,
    calls: unknown[],
    expectedText: string,
    pending = false,
  ) => states.push({ id, calls, expectedText, pending });
  state(
    "bash-compound",
    [
      call("bash", {
        cmd: 'uname -s; find . -maxdepth 1 -type d; printf "\\033[32mSUCCESS\\033[0m \\033[33mWARNING\\033[0m \\033[31mFAILURE\\033[0m λ → 日本語\\n"; sleep 1',
        cwd: temporary,
      }),
    ],
    "SUCCESS",
    true,
  );
  state(
    "bash-error",
    [
      call("bash", {
        cmd: "printf SHELL_ERROR_FIXTURE; exit 23",
        cwd: temporary,
      }),
    ],
    "23",
  );
  state(
    "read-ranges",
    [
      call("read", {
        path: join(root, "../../flake.nix"),
        read_range: [1, 24],
      }),
    ],
    "description",
  );
  state(
    "read-hidden",
    [call("read", { path: join(temporary, "fixture.txt") })],
    "LOCAL_FIXTURE",
  );
  state(
    "read-image",
    [call("read", { path: join(root, "../../assets/susuwatari.jpg") })],
    "[Image:",
  );
  state(
    "write",
    [
      call("write", {
        path: join(temporary, "written.ts"),
        content: "export const before = 1;\n",
      }),
    ],
    "export const before",
  );
  state(
    "edit-preview",
    [
      call("edit", {
        path: join(temporary, "written.ts"),
        edits: [{ oldText: "before = 1", newText: "after = 2" }],
      }),
    ],
    "after",
  );
  state(
    "edit-error",
    [
      call("edit", {
        path: join(temporary, "written.ts"),
        edits: [{ oldText: "NOT_PRESENT", newText: "no" }],
      }),
    ],
    "Could not",
  );
  state(
    "bash-long",
    [
      call("bash", {
        cmd: 'for i in $(seq 1 90); do printf "LONG_%03d λ output\\n" "$i"; done',
        cwd: temporary,
      }),
    ],
    "LONG_090",
  );
  for (const name of agentTools) {
    const args: Record<string, unknown> = {
      oracle: { task: "explain fixture" },
      finder: { query: "find fixture" },
      delegate: { prompt: "explain fixture", description: "fixture" },
      librarian: { query: "fixture" },
      look_at: {
        path: join(temporary, "image.png"),
        objective: "describe",
        context: "fixture",
      },
      code_review: { diff_description: "fixture diff" },
    };
    state(`direct-${name}`, [call(name, args[name])], "SUBAGENT_FIXTURE", true);
  }
  const repo = { repository: "https://github.com/fixture/repo" };
  for (const [name, args] of [
    ["read_github", { ...repo, path: "fixture.txt" }],
    ["search_github", { ...repo, pattern: "fixture" }],
    ["list_directory_github", { ...repo, path: "" }],
    ["list_repositories", { pattern: "fixture" }],
    ["glob_github", { ...repo, filePattern: "*.txt" }],
    ["commit_search", { ...repo, query: "fixture" }],
    ["diff", { ...repo, base: "main", head: "fixture" }],
    ["skill", { name: "fixture" }],
    ["agent_message", { sessionId: targetId, message: "RENDER_FIXTURE" }],
    ["history_list", {}],
    ["history_read", { workspace: temporary, sessionId: targetId }],
    ["web_search", { objective: "fixture", search_queries: ["fixture"] }],
    [
      "read_web_page",
      {
        url: "https://codemode.example/fixture",
        output: ["raw"],
        max_length: 4096,
      },
    ],
  ] as [string, any][]) {
    const needles: Record<string, string> = {
      read_github: "GH_FIXTURE",
      search_github: "fixture.txt",
      list_directory_github: "fixture.txt",
      list_repositories: "fixture/repo",
      glob_github: "fixture.txt",
      commit_search: "GH_FIXTURE",
      diff: "Changed files",
      skill: "skill loaded",
      agent_message: "queued agent message",
      history_list: "SESSION_FIXTURE",
      history_read: "SESSION_FIXTURE",
      web_search: "SEARCH_FIXTURE",
      read_web_page: "WEB_FIXTURE",
    };
    state(`direct-${name}`, [call(name, args)], needles[name]!);
  }
  state(
    "codemode-head-tail",
    [
      call("codemode", {
        code: [
          "// SCRIPT_TOP",
          "text('PREVIEW_' + 'TOP');",
          ...Array.from({ length: 24 }, (_, n) =>
            n === 12
              ? "text('RAW_ONLY_' + 'SENTINEL'); // SCRIPT_MIDDLE_12"
              : `text('PREVIEW_ROW_' + ${n}); // SCRIPT_MIDDLE_${n}`,
          ),
          "text('PREVIEW_' + 'FINAL_ERROR');",
          "// SCRIPT_TAIL",
        ].join("\n"),
      }),
    ],
    "PREVIEW_FINAL_ERROR",
  );
  state(
    "codemode-four-emissions",
    [
      call("codemode", {
        code: `// @options: {"max_output_tokens": 80}\nawait Promise.all([1,2,3,4].map(async n => text('EMISSION_HEAD_'+n+'\\n'+'x'.repeat(n===1?80000:2000)+'\\nEMISSION_TAIL_'+n)));`,
      }),
    ],
    "EMISSION_HEAD_1",
  );
  state(
    "codemode-small-results",
    [call("codemode", { code: `text('A');text('B');text('C');` })],
    "B",
  );
  state(
    "codemode-eight-lines",
    [
      call("codemode", {
        code: `text(Array.from({length:8},(_,n)=>'FULL_ROW_'+n).join('\\n'));`,
      }),
    ],
    "FULL_ROW_7",
  );
  state(
    "codemode-line-edges",
    [
      call("codemode", {
        code: `text(Array.from({length:300},(_,n)=>(n+1)+' line of output').join('\\n'));`,
      }),
    ],
    "1 line of output",
  );
  state(
    "codemode-clipped-failure",
    [
      call("codemode", {
        code: "try {await tools.read({path:'detail'.repeat(25)+'RAW_ERROR_SUFFIX'})} catch {} text('CAUGHT');",
      }),
    ],
    "CAUGHT",
  );
  state(
    "codemode-opaque-json",
    [
      call("codemode", {
        code: `text(JSON.stringify({first:'OPAQUE_FIRST',body:'x'.repeat(5000)+'OPAQUE_RAW_SENTINEL'+'y'.repeat(5000),last:'OPAQUE_LAST'}));`,
      }),
    ],
    "OPAQUE_FIRST",
  );
  state(
    "codemode-mixed-failures",
    [
      call("codemode", {
        code: `text(await Promise.allSettled(Array.from({length:20},(_,i)=>tools.read({path:i<10?${JSON.stringify(join(temporary, "absent"))}+i:${JSON.stringify(join(temporary, "fixture.txt"))}})))); text('MIXED_'+'RESULT');`,
      }),
    ],
    "MIXED_RESULT",
  );
  state(
    "codemode-directories-discovery",
    [
      call("codemode", {
        code: `// @options: {"timeout_ms": 15000, "max_output_tokens": 3000}\ntext(await Promise.allSettled([tools.read({path:${JSON.stringify(temporary)}}),tools.read({path:${JSON.stringify(join(temporary, "absent"))}})])); text(await searchTools('read')); text(await describeTool('read')); text(ALL_TOOLS); text('STRUCTURED_LONG_' + 'x'.repeat(1500)); text('DISCOVERY_'+'DONE');`,
      }),
    ],
    "DISCOVERY_DONE",
  );
  state(
    "codemode-agents-web",
    [
      call("codemode", {
        code: `// @options: {"timeout_ms": 15000}\ntext(await Promise.allSettled([tools.delegate({prompt:'fixture',description:'fixture'}),tools.oracle({task:'fixture'}),tools.web_search({objective:'fixture',search_queries:['fixture']})])); text(await tools.read_web_page({url:'https://codemode.example/fixture',output:['raw'],max_length:512}));`,
      }),
    ],
    "SUBAGENT_FIXTURE",
    true,
  );
  state(
    "codemode-partial-error",
    [
      call("codemode", {
        code: "text({partial:'PARTIAL_FIXTURE'}); throw new Error('EXPECTED_SCRIPT_FAILURE');",
      }),
    ],
    "EXPECTED_SCRIPT_FAILURE",
  );
  const markdown =
    "# markdown sampler\n\n**bold** *italics* ~~strike~~ `inline` [link](https://example.com)\n\n> blockquote\n\n| state | result |\n|---|---|\n| real | content |\n\n```typescript\nconst answer: number = 42;\n```\n\n```diff\n-old\n+new\n```\n\n```mermaid\ngraph LR\n A --> B\n```\n\n- item\n  - nested item\n1. ordered\n- [x] done\n- [ ] pending\n\nLONG_IDENTIFIER_" +
    "x".repeat(180) +
    "\n\n---\n\nMARKDOWN_END";
  state(
    "native-grep",
    [
      call("grep", {
        path: join(temporary, "fixture.txt"),
        pattern: "LOCAL_FIXTURE",
      }),
    ],
    "LOCAL_FIXTURE",
  );
  state(
    "native-find",
    [call("find", { path: temporary, pattern: "fixture.txt" })],
    "fixture.txt",
  );
  state("native-ls", [call("ls", { path: temporary })], "fixture.txt");
  state(
    "native-powershell-platform-error",
    [call("powershell", { command: "Write-Output POWERSHELL_FIXTURE" })],
    "only available on Windows",
  );
  states.push({ id: "markdown", expectedText: "MARKDOWN_END" });
  const gates = join(temporary, "gates");
  mkdirSync(gates);
  const events = join(temporary, "events.jsonl");
  writeFileSync(events, "");
  const plan = {
    states,
    markdown,
    gates,
    events,
    renders: join(temporary, "renders.jsonl"),
    inventory: join(temporary, "inventory.json"),
  };
  writeFileSync(join(temporary, "plan.json"), JSON.stringify(plan));
  // Matrix is committed to disk BEFORE starting the PTY, not inferred from captures.
  writeFileSync(
    join(temporary, "matrix.json"),
    JSON.stringify(
      states.map((s, index) => ({
        index,
        ...s,
        consumer: s.calls?.[0]?.name ?? "assistant markdown",
        widths: [20, 80, 140],
        pendingWidths: s.pending ? [80] : [],
        mouse:
          "not applicable: regular-mode terminal owns mouse/scrollback; ctrl+o is exercised",
        image:
          s.id === "read-image"
            ? "tmux text fallback + isolated real renderer kitty/iTerm dispatch (image-PROTOCOL.json/.ansi); pixels NOT covered"
            : undefined,
        actions: ["collapsed", "ctrl+o expanded", "ctrl+o collapsed"],
        boundary:
          "real parent/child Pi and local tools; synthetic outer/child models, HTTP and gh API responses",
        artifacts: `${index}-WIDTH-STATE.txt`,
      })),
      null,
      2,
    ),
  );
  const sourcePaths = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "packages",
      "scripts",
      "package.json",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  sourcePaths.push(
    "../../flake.nix",
    "../../assets/susuwatari.jpg",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/visual-truncate.js",
    "patches/pi-coding-agent-1.3.0.patch",
    "node_modules/@earendil-works/pi-tui/package.json",
    "node_modules/@earendil-works/pi-tui/dist/tui.js",
  );
  const hashes = Object.fromEntries(
    sourcePaths
      .filter((p) => existsSync(join(root, p)))
      .map((p) => [
        p,
        createHash("sha256")
          .update(readFileSync(join(root, p)))
          .digest("hex"),
      ]),
  );
  writeFileSync(
    join(temporary, "provenance.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        hashes,
        node: process.version,
        terminal: "tmux xterm-256color",
        rows: 160,
        widths: [20, 80, 140],
        synthetic: [
          "outer and child model responses/usage",
          "HTTP and gh API responses",
        ],
        image: "tmux does not display image pixels; protocol/fallback only",
        screenshots: "unavailable: grid evidence only",
      },
      null,
      2,
    ),
  );
  const env = {
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    HOME: temporary,
    TMPDIR: temporary,
    PI_CODING_AGENT_DIR: agentDir,
    PI_BIN: child,
    BDS_PI_LOG_DIR: join(temporary, "logs"),
    PARALLEL_API_KEY: "fixture",
    PI_RENDER_PLAN: join(temporary, "plan.json"),
    PI_CODEMODE_NETWORK_LOG: join(temporary, "network.log"),
    PATH: `${join(temporary, "bin")}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${join(root, "scripts/codemode-boundaries.mjs")}${negative && !dropResults ? ` --import=${join(root, "scripts/rendering-negative.mjs")}` : ""} --import=${join(root, "scripts/rendering-observe.mjs")}`,
    PI_RENDER_OBSERVED_SOURCE: join(temporary, "observed-tool-execution.js"),
    PI_RENDER_DROP_RESULTS: dropResults ? "1" : "0",
    PI_RENDER_NEGATIVE_SOURCE: join(temporary, "broken-tool-execution.js"),
    PI_OFFLINE: "1",
    PI_TUI_WRITE_LOG: join(temporary, "raw.ansi"),
    TERM: "xterm-256color",
  };
  const args = [
    "--offline",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--tui-mode",
    "regular",
    "-e",
    "builtin:codemode",
    ...extensionPaths.flatMap((p: string) => ["-e", p]),
    "-e",
    join(root, "scripts/rendering-fixture.ts"),
    "--provider",
    "rendering-fixture",
    "--model",
    "deterministic",
    "--session-dir",
    dirname(targetSession),
    "run rendering sampler",
  ];
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const command = [
    "exec",
    quote(join(root, "node_modules/.bin/pi")),
    ...args.map(quote),
  ].join(" ");
  const records: any[] = [];
  const deadline = Date.now() + 240000;
  const readEvents = () =>
    readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const wait = async (predicate: () => boolean, label: string) => {
    const end = Date.now() + 30000;
    while (!predicate()) {
      assert.ok(Date.now() < Math.min(end, deadline), `timeout: ${label}`);
      await delay(40);
    }
  };
  const evidenceFor = (
    index: number,
    width: number,
    expanded = true,
  ): RenderEvidence => {
    const renders = readFileSync(plan.renders, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const relevant = renders.filter(
      (e) =>
        e.toolCallId === `sampler-${index}-0` &&
        e.viewport === width &&
        e.expanded === expanded &&
        !e.isPartial,
    );
    const call = relevant.findLast((e) => e.phase === "call");
    const result = relevant.findLast((e) => e.phase === "result");
    assert.ok(
      call && result,
      `missing production render boundaries for ${index}/${width}`,
    );
    return {
      callLines: call.lines,
      resultLines: result.lines,
      nativePreviewOnly:
        ["write", "edit-preview"].includes(states[index].id) &&
        result.lines.length === 0,
    };
  };
  const capture = (id: string) => {
    const text = tmux("capture-pane", "-p", "-J", "-S", "-", "-t", "sampler");
    writeFileSync(join(temporary, `${id}.txt`), text);
    return text;
  };
  try {
    tmux(
      "new-session",
      "-d",
      "-s",
      "sampler",
      "-x",
      "80",
      "-y",
      "160",
      "-c",
      temporary,
      command,
    );
    await wait(
      () => readEvents().some((e) => e.type === "gate" && e.index === 0),
      "startup",
    );
    for (let index = 0; index < states.length; index++) {
      const s = states[index];
      assert.ok(Date.now() < deadline, "four-minute replay deadline");
      tmux("resize-window", "-t", "sampler", "-x", "80", "-y", "160");
      await delay(120);
      const before = capture(`${index}-before`);
      writeFileSync(join(gates, String(index)), "go");
      if (s.pending) {
        await wait(
          () =>
            readEvents().some(
              (e) =>
                e.type === "tool_execution_start" &&
                e.toolCallId === `sampler-${index}-0`,
            ),
          "pending",
        );
        await delay(100);
        const pending = capture(`${index}-80-pending`);
        assert.ok(
          !readEvents().some(
            (e) =>
              e.type === "tool_execution_end" &&
              e.toolCallId === `sampler-${index}-0`,
          ),
          "pending capture happened after completion",
        );
        assert.ok(/^ ● /m.test(pending), `${s.id}: no pending tool UI`);
      }
      if (s.calls)
        await wait(
          () =>
            readEvents().some(
              (e) => e.type === "gate" && e.index === index + 1,
            ),
          s.id,
        );
      await delay(180);
      for (const width of [80, 20, 140]) {
        tmux(
          "resize-window",
          "-t",
          "sampler",
          "-x",
          String(width),
          "-y",
          "160",
        );
        await delay(160);
        const collapsed = capture(`${index}-${width}-collapsed`);
        const collapsedEvidence = s.calls
          ? evidenceFor(index, width, false)
          : undefined;
        tmux("send-keys", "-t", "sampler", "C-o");
        await delay(160);
        const expanded = capture(`${index}-${width}-expanded`);
        tmux("send-keys", "-t", "sampler", "C-o");
        await delay(160);
        const recollapsed = capture(`${index}-${width}-recollapsed`);
        // Wide grids preserve tool identities and content; narrow grids are inspected separately.
        if (width === 80 || width === 140) {
          if (s.calls) {
            const name = s.calls[0].name;
            const title =
              name === "powershell"
                ? "PS>"
                : name === "bash"
                  ? "$"
                  : name === "skill"
                    ? "using fixture skill"
                    : name;
            const frame = assertToolGrid(
              expanded,
              index + 1,
              title,
              s.expectedText,
              evidenceFor(index, width),
            );
            const output = toolResultRegion(frame, evidenceFor(index, width));
            if (["write", "edit-preview"].includes(s.id))
              assert.equal(
                readFileSync(join(temporary, "written.ts"), "utf8"),
                s.id === "write"
                  ? "export const before = 1;\n"
                  : "export const after = 2;\n",
                "native preview did not accompany the actual file mutation",
              );
            if (width === 80)
              writeFileSync(join(temporary, `${index}-frame.txt`), frame);
            if (s.id === "read-hidden") {
              assert.ok(
                !collapsed.includes("LOCAL_FIXTURE"),
                "read contents not hidden when collapsed",
              );
              assert.ok(
                expanded.includes("LOCAL_FIXTURE"),
                "read contents did not expand",
              );
              assert.ok(
                !recollapsed.includes("LOCAL_FIXTURE"),
                "read contents did not collapse again",
              );
            }
            if (s.id === "codemode-head-tail") {
              for (const grid of [collapsed, recollapsed]) {
                const compact = assertToolGrid(
                  grid,
                  index + 1,
                  "codemode",
                  "PREVIEW_TOP",
                  collapsedEvidence!,
                );
                const result = toolResultRegion(compact, collapsedEvidence!);
                assert.ok(
                  result.includes("PREVIEW_FINAL_ERROR"),
                  "collapsed result lost final error",
                );
                assert.ok(
                  !result.includes("PREVIEW_ROW_12"),
                  "collapsed result exposed middle",
                );
                assert.match(
                  result,
                  /\d+ results omitted/,
                  "truthful omission count absent",
                );
                assert.ok(
                  result.indexOf("/tool-output") >
                    result.indexOf("PREVIEW_FINAL_ERROR"),
                  "shared omission hint missing after output group",
                );
                assert.ok(
                  !compact.includes("SCRIPT_TOP") &&
                    !compact.includes("SCRIPT_TAIL"),
                  "collapsed source displaced returned content",
                );
                assert.ok(
                  !result.includes("Took"),
                  "timing telemetry displaced content",
                );
              }
              assert.ok(
                !output.includes("RAW_ONLY_SENTINEL"),
                "expanded result leaked omitted raw middle",
              );
              assert.ok(
                !frame.includes("SCRIPT_MIDDLE_12"),
                "expanded script is unbounded",
              );
              assert.ok(
                frame.includes("SCRIPT_MIDDLE_3"),
                "expansion did not add useful script context",
              );
              assert.ok(
                output.includes("PREVIEW_ROW_2"),
                "expansion did not add useful result context",
              );
            }
            if (s.id === "codemode-four-emissions") {
              for (const n of [1, 2, 3, 4]) {
                assert.ok(
                  !output.includes(`result ${n}/4`),
                  "result ordinal bookkeeping returned",
                );
                assert.ok(
                  output.includes(`EMISSION_HEAD_${n}`),
                  `starved emission head ${n}`,
                );
                assert.ok(
                  output.includes(`EMISSION_TAIL_${n}`),
                  `starved emission tail ${n}`,
                );
                const head = output.indexOf(`EMISSION_HEAD_${n}`);
                const tail = output.indexOf(`EMISSION_TAIL_${n}`);
                assert.ok(
                  output.indexOf("shortened", head) > head &&
                    output.indexOf("shortened", head) < tail,
                  `missing local marker within emission ${n}`,
                );
              }
              const compact = toolResultRegion(
                assertToolGrid(
                  collapsed,
                  index + 1,
                  "codemode",
                  "EMISSION_HEAD_1",
                  collapsedEvidence!,
                ),
                collapsedEvidence!,
              );
              assert.ok(
                compact.includes("EMISSION_HEAD_2") &&
                  compact.includes("EMISSION_HEAD_3"),
                "collapsed hid retained short previews that fit",
              );
            }
            if (s.id === "codemode-four-emissions")
              assert.equal(
                (output.match(/\/tool-output/g) || []).length,
                1,
                "raw hint is shared by the output group",
              );
            if (
              s.id === "codemode-small-results" ||
              s.id === "codemode-eight-lines"
            ) {
              const actual = toolResultRegion(
                assertToolGrid(
                  collapsed,
                  index + 1,
                  "codemode",
                  s.expectedText,
                  collapsedEvidence!,
                ),
                collapsedEvidence!,
              );
              assert.ok(
                !actual.includes("/tool-output"),
                "fully retained fitting output has a false omission hint",
              );
              if (s.id === "codemode-small-results")
                assert.ok(
                  actual
                    .split("\n")
                    .some((line) => line.replace(/[│\s]/g, "") === "B"),
                  "B missing from actual collapsed result",
                );
              else
                for (let n = 0; n < 8; n++)
                  assert.ok(
                    actual.includes("FULL_ROW_" + n),
                    "fitting eight-line body clipped",
                  );
            }
            if (s.id === "codemode-line-edges") {
              const actual = toolResultRegion(
                assertToolGrid(
                  collapsed,
                  index + 1,
                  "codemode",
                  "1 line of output",
                  collapsedEvidence!,
                ),
                collapsedEvidence!,
              );
              for (const view of [actual, output]) {
                assert.equal((view.match(/\/tool-output/g) || []).length, 1);
                assert.equal((view.match(/shortened/g) || []).length, 1);
                assert.ok(
                  !view
                    .split("\n")
                    .some((line) =>
                      ["l", "put"].includes(line.replace(/[│\s]/g, "")),
                    ),
                  "fixed-unit line fragment leaked",
                );
              }
            }
            if (s.id === "codemode-clipped-failure") {
              assert.equal(
                (output.match(/\/tool-output/g) ?? []).length,
                1,
                "clipped lone failure needs exactly one raw hint",
              );
              assert.ok(
                !output.includes("RAW_ERROR_SUFFIX"),
                "failure suffix unexpectedly fits fixture width",
              );
              assert.ok(
                output.includes("ENOENT"),
                "clipped failure lost its reason prefix",
              );
            }
            if (s.id === "codemode-opaque-json") {
              assert.ok(
                output.includes('{"first":"OPAQUE_FIRST","body":"'),
                "opaque JSON was heuristically reformatted",
              );
              assert.ok(
                output.replace(/[\s│]/g, "").includes('"last":"OPAQUE_LAST"}'),
                "opaque tail missing",
              );
              assert.ok(
                !output.includes("OPAQUE_RAW_SENTINEL"),
                "opaque raw middle escaped budget",
              );
            }
            if (s.id === "codemode-mixed-failures") {
              assert.equal(
                (output.match(/✗ read/g) ?? []).length,
                10,
                "expanded failures not prioritized",
              );
              assert.match(
                output,
                /8 more calls/,
                "activity omission count incorrect",
              );
              assert.ok(output.includes("ENOENT"), "failure reason missing");
              const compactCalls = collapsedEvidence!.resultLines
                .map(stripTerminalSequences)
                .join("\n");
              assert.equal(
                (compactCalls.match(/✗ read/g) ?? []).length,
                8,
                "collapsed activity lost prioritized failures",
              );
              assert.match(
                compactCalls,
                /2 more calls \(2 failed\)/,
                "omitted failure counter is not truthful",
              );
            }
            if (s.id === "bash-long") {
              assert.ok(
                !collapsed.includes("LONG_045"),
                "long bash content not collapsed",
              );
              assert.ok(
                expanded.includes("LONG_045"),
                "ctrl+o did not expose middle bash output",
              );
              assert.ok(
                !recollapsed.includes("LONG_045"),
                "second ctrl+o did not re-collapse",
              );
            }
            if (s.id === "bash-compound" && width === 140)
              assert.ok(
                collapsed.includes("├ $ find"),
                "compound bash tree missing",
              );
            if (s.id.startsWith("direct-") && agentTools.includes(name)) {
              const result = readEvents().find(
                (e) =>
                  e.type === "tool_execution_end" &&
                  e.toolCallId === `sampler-${index}-0`,
              );
              const usage = result.result.details.pi.usage;
              assert.ok(
                usage.turns >= 2 && usage.cost > 0,
                "child did not complete real tool + final-model turns",
              );
              assert.ok(
                !frame.includes(`${usage.turns} turns`) &&
                  !frame.includes(`$${usage.cost.toFixed(4)}`) &&
                  frame.toLowerCase().includes("read") &&
                  /│ [├╰] ✓ Read/.test(frame),
                "subagent activity missing or telemetry leaked",
              );
            }
            if (s.id === "codemode-directories-discovery")
              assert.ok(
                output.includes("✗ read") &&
                  output.includes("✓ read") &&
                  !output.includes("Took"),
                "nested partial-failure statuses missing or telemetry leaked",
              );
            if (s.id === "codemode-agents-web") {
              for (const child of [
                "delegate",
                "oracle",
                "web_search",
                "read_web_page",
              ])
                assert.ok(
                  output.includes(`✓ ${child}`),
                  `nested summary missing ${child}`,
                );
              assert.ok(
                !/│ \d turns?/.test(frame),
                "nested children unexpectedly duplicated direct custom UI",
              );
            }
          } else {
            const styled = tmux(
              "capture-pane",
              "-p",
              "-e",
              "-J",
              "-S",
              "-",
              "-t",
              "sampler",
            );
            writeFileSync(
              join(temporary, `${index}-${width}-styled.txt`),
              styled,
            );
            assertMarkdownGrid(expanded, styled);
          }
          assert.ok(
            expanded.length > before.length || expanded !== before,
            `${s.id}: empty/unchanged UI`,
          );
        }
        const maxColumns = Math.max(
          ...expanded.split("\n").map((line) => visibleWidth(line)),
        );
        assert.ok(
          maxColumns <= width,
          `${s.id}: terminal grid exceeds ${width} columns (${maxColumns})`,
        );
        if (s.calls?.[0].name === "codemode") {
          assertBoundedCodemode(evidenceFor(index, width), true);
          assertBoundedCodemode(collapsedEvidence!, false);
        }
        if (
          s.id.startsWith("direct-") &&
          agentTools.includes(s.calls?.[0].name)
        ) {
          const resultRows = evidenceFor(index, width).resultLines;
          assert.ok(
            resultRows.length <= 49,
            "unbounded direct child presentation",
          );
          assert.equal(
            resultRows.join("\n").split("SUBAGENT_FIXTURE").length - 1,
            1,
            "child answer duplicated or absent",
          );
          assert.ok(
            !resultRows.join("\n").includes("CHILD_RAW_SENTINEL"),
            "expanded child leaked raw middle",
          );
          assert.ok(
            collapsedEvidence!.resultLines.length < resultRows.length,
            "re-collapse lost distinction",
          );
        }
        // Narrow windows may clip an opaque child's answer; require its executed status here.
        // Wide views above still require SUBAGENT_FIXTURE in the actual result region.
        if (width === 20 && s.calls)
          assertToolGrid(
            expanded,
            index + 1,
            s.calls[0].name === "powershell"
              ? "PS>"
              : s.calls[0].name === "bash"
                ? "$"
                : s.calls[0].name === "skill"
                  ? "using"
                  : s.calls[0].name.slice(0, 6),
            s.id === "codemode-directories-discovery"
              ? "DISCOVERY_"
              : s.id === "codemode-agents-web"
                ? "✓ delegate"
                : s.expectedText.slice(0, 8),
            evidenceFor(index, width),
          );
        records.push({
          index,
          id: s.id,
          width,
          rows: 160,
          maxColumns,
          collapsedBytes: collapsed.length,
          expandedBytes: expanded.length,
          interactionChanged: expanded !== collapsed,
          recollapsedBytes: recollapsed.length,
        });
      }
      console.log(`captured ${index}: ${s.id}`);
    }
    // Commands run only after the final assistant turn settles; no model invocation.
    await wait(
      () => readEvents().some((e) => e.type === "settled"),
      "agent settled for commands",
    );
    tmux("resize-window", "-t", "sampler", "-x", "140", "-y", "160");
    const sendCommand = async (text: string) => {
      tmux("send-keys", "-t", "sampler", "-l", text);
      tmux("send-keys", "-t", "sampler", "Enter");
      await delay(350);
    };
    const exports = () =>
      readdirSync(temporary).filter((name) =>
        name.startsWith("pi-tool-output-"),
      );
    await sendCommand("/fixture-snapshot before");
    await sendCommand("/tool-output");
    const picker = capture("raw-picker");
    assert.match(picker, /Persisted tool results/);
    const exportCount = exports().length;
    tmux("send-keys", "-t", "sampler", "Escape");
    await delay(150);
    assert.equal(exports().length, exportCount, "picker cancel wrote a file");
    const rawIndex = states.findIndex((s) => s.id === "codemode-head-tail");
    const id = `sampler-${rawIndex}-0`;
    await sendCommand(`/tool-output ${id}`);
    const rawStatus = capture("raw-explicit-status");
    assert.match(rawStatus, /PERSISTED RAW RESULT:/);
    assert.match(rawStatus, /not a full child transcript/);
    assert.match(rawStatus, /Execution spill file unavailable/);
    const directory = exports().find((name) =>
      existsSync(join(temporary, name, "persisted-result.json")),
    )!;
    assert.ok(directory, "raw export missing");
    const path = join(temporary, directory, "persisted-result.json");
    const branchBefore = JSON.parse(
      readFileSync(join(temporary, "branch-before.json"), "utf8"),
    );
    const resultEntry = branchBefore.find(
      (e: any) =>
        e.type === "message" &&
        e.message.role === "toolResult" &&
        e.message.toolCallId === id,
    );
    const callEntry = branchBefore.find(
      (e: any) =>
        e.type === "message" &&
        e.message.role === "assistant" &&
        e.message.content.some(
          (p: any) => p.type === "toolCall" && p.id === id,
        ),
    );
    const original = {
      call: callEntry.message.content.find(
        (p: any) => p.type === "toolCall" && p.id === id,
      ),
      callEntry,
      resultEntry,
    };
    assertRawExport(
      JSON.parse(readFileSync(path, "utf8")),
      original,
      "RAW_ONLY_SENTINEL",
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(temporary, directory)).mode & 0o777, 0o700);
    const opaqueIndex = states.findIndex(
      (s) => s.id === "codemode-opaque-json",
    );
    await sendCommand(`/tool-output sampler-${opaqueIndex}-0`);
    const availableStatus = capture("raw-available-spill-status");
    assert.match(availableStatus, /Execution spill file available:/);
    assert.ok(
      existsSync(join(temporary, "available-spill.txt")),
      "advertised available file absent",
    );
    await sendCommand("/tool-output");
    tmux("send-keys", "-t", "sampler", "Enter");
    await delay(250);
    assert.equal(
      exports().length,
      exportCount + 3,
      "native picker choice did not export",
    );
    capture("raw-picker-choice-status");
    const failureIndex = states.findIndex(
      (s) => s.id === "codemode-clipped-failure",
    );
    const failureId = `sampler-${failureIndex}-0`;
    const priorExports = new Set(exports());
    await sendCommand(`/tool-output ${failureId}`);
    capture("raw-clipped-failure-status");
    const failureDirectory = exports().find((name) => !priorExports.has(name))!;
    const failureExport = JSON.parse(
      readFileSync(
        join(temporary, failureDirectory, "persisted-result.json"),
        "utf8",
      ),
    );
    const failureResultEntry = branchBefore.find(
      (e: any) =>
        e.type === "message" &&
        e.message.role === "toolResult" &&
        e.message.toolCallId === failureId,
    );
    const failureCallEntry = branchBefore.find(
      (e: any) =>
        e.type === "message" &&
        e.message.role === "assistant" &&
        e.message.content.some(
          (p: any) => p.type === "toolCall" && p.id === failureId,
        ),
    );
    assert.deepEqual(failureExport, {
      call: failureCallEntry.message.content.find(
        (p: any) => p.id === failureId,
      ),
      callEntry: failureCallEntry,
      resultEntry: failureResultEntry,
    });
    assert.ok(
      failureExport.resultEntry.message.details.calls[0].error.includes(
        "RAW_ERROR_SUFFIX",
      ),
      "raw export lost clipped diagnostic suffix",
    );
    await sendCommand("/fixture-snapshot after");
    assert.deepEqual(
      JSON.parse(readFileSync(join(temporary, "branch-after.json"), "utf8")),
      branchBefore,
      "render/commands mutated persisted model-facing fields",
    );
    const lifecycle = readEvents();
    const ids = states.flatMap((s, i) =>
      (s.calls ?? []).map((_: unknown, n: number) => `sampler-${i}-${n}`),
    );
    assertLifecycle(lifecycle, ids);
    for (const event of lifecycle.filter(
      (e) => e.type === "tool_execution_end" && !e.parentToolCallId,
    )) {
      const index = Number(event.toolCallId.split("-")[1]);
      assert.equal(
        event.isError,
        [
          "bash-error",
          "edit-error",
          "codemode-partial-error",
          "native-powershell-platform-error",
        ].includes(states[index].id),
        `unexpected tool failure: ${states[index].id}`,
      );
    }
    const control = join(temporary, "negative-control");
    mkdirSync(control);
    // Isolated old expansion behavior: native Text renders all script/output rows.
    // Feed those actual visual rows to the SAME verifier, not echoed PTY source.
    const { Text } = await import("@earendil-works/pi-tui");
    // Scale the isolated negative beyond the aggregate ceiling at every width.
    // Execution-time truncation can make even huge real emissions quite short;
    // neither a clipped real result nor the small head/tail fixture proves that
    // the verifier rejects the old unbounded native Text behavior.
    const unboundedFixture = Array(3).fill(
      resultEntry.message.content.map((p: any) => p.text ?? "").join("\n"),
    ).join("\n");
    for (const width of [20, 80, 140]) {
      const unbounded = {
        callLines: [
          "codemode",
          "script",
          ...new Text(states[rawIndex].calls[0].args.code, 0, 0).render(
            width - 4,
          ),
        ],
        resultLines: evidenceFor(rawIndex, width).resultLines,
      };
      json(join(control, `old-unbounded-${width}.json`), unbounded);
      assert.throws(
        () => assertBoundedCodemode(unbounded, true),
        /unbounded script/,
      );
      const unboundedOutput = {
        ...evidenceFor(rawIndex, width),
        resultLines: [
          "output",
          ...new Text(
            unboundedFixture,
            0,
            0,
          ).render(width - 4),
        ],
      };
      assert.throws(
        () => assertBoundedCodemode(unboundedOutput, true),
        /unbounded output/,
      );
    }
    const noSentinel = JSON.parse(JSON.stringify(original));
    noSentinel.resultEntry.message.content = [
      { type: "text", text: "preview only" },
    ];
    json(join(control, "raw-preview-only.json"), noSentinel);
    assert.throws(
      () => assertRawExport(noSentinel, original, "RAW_ONLY_SENTINEL"),
      /original persisted/,
    );
    assert.throws(
      () => assertRawExport(noSentinel, noSentinel, "RAW_ONLY_SENTINEL"),
      /missing raw sentinel/,
    );
    for (const id of [
      "bash-compound",
      "codemode-directories-discovery",
      "direct-web_search",
    ]) {
      const index = states.findIndex((s) => s.id === id);
      const s = states[index];
      const grid = readFileSync(
        join(temporary, `${index}-80-expanded.txt`),
        "utf8",
      );
      const lines = grid.split("\n");
      const start = lines.findLastIndex((line) => /^ [✓✕] /.test(line));
      const end = lines.findIndex(
        (line, n) => n > start && /^ ╰────\s*$/.test(line),
      );
      const evidence = evidenceFor(index, 80);
      const noResult = [
        ...lines.slice(0, start + evidence.callLines.length),
        ...lines.slice(end),
      ].join("\n");
      writeFileSync(join(control, `${id}-inputs-only.txt`), noResult);
      assert.throws(
        () =>
          assertToolGrid(
            noResult,
            index + 1,
            id === "bash-compound" ? "$" : s.calls[0].name,
            s.expectedText,
            evidence,
          ),
        /result/,
      );
    }
    const markdownIndex = states.findIndex((s) => s.id === "markdown");
    const markdownGrid = readFileSync(
      join(temporary, `${markdownIndex}-80-expanded.txt`),
      "utf8",
    );
    for (const [shape, pattern] of Object.entries(markdownShapes)) {
      const broken = markdownGrid
        .split("\n")
        .filter((line) => !pattern.test(line))
        .join("\n");
      writeFileSync(join(control, `markdown-without-${shape}.txt`), broken);
      assert.throws(() => assertMarkdownGrid(broken));
    }
    const styledMarkdown = readFileSync(
      join(temporary, `${markdownIndex}-80-styled.txt`),
      "utf8",
    );
    assert.throws(
      () =>
        assertMarkdownGrid(
          markdownGrid,
          styledMarkdown.replaceAll(/\x1b\[[0-9;]*m/g, ""),
        ),
      /span attribute/,
    );
    const sentinelOnly = markdownGrid.replace(
      markdownRegion(markdownGrid),
      " ● markdown sampler\n │ MARKDOWN_END",
    );
    writeFileSync(join(control, "markdown-sentinel-only.txt"), sentinelOnly);
    assert.throws(() => assertMarkdownGrid(sentinelOnly));
    const liveAttempt = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), "--live"],
      {
        encoding: "utf8",
        env: { ...process.env, PI_RENDER_LIVE_ACK: "uncapped-cost" },
        timeout: 10000,
      },
    );
    assert.notEqual(liveAttempt.status, 0);
    assert.match(liveAttempt.stderr, /live execution disabled/);
    assert.ok(!liveAttempt.stdout.includes("rendering artifacts:"));
    writeFileSync(join(control, "live-disabled.log"), liveAttempt.stderr);
    const delegateIndex = states.findIndex((s) => s.id === "direct-delegate");
    const grid = readFileSync(
      join(temporary, `${delegateIndex}-80-expanded.txt`),
      "utf8",
    );
    const footer = grid.lastIndexOf(" ╰────");
    const broken =
      grid.slice(0, footer) +
      grid.slice(footer).replace(" ╰────", " MISSING_FOOTER");
    writeFileSync(join(control, "missing-footer.txt"), broken);
    assert.throws(
      () =>
        assertToolGrid(
          broken,
          delegateIndex + 1,
          "Delegate",
          "SUBAGENT_FIXTURE",
          evidenceFor(delegateIndex, 80),
        ),
      /footer/,
    );
    const headers = grid.split("\n");
    const header = headers.findLastIndex((line) => /^ ✓ Delegate /.test(line));
    headers[header] = " BYPASSED_DIRECT_RENDERER";
    const bypassed = headers.join("\n");
    writeFileSync(join(control, "bypassed-renderer.txt"), bypassed);
    assert.throws(
      () =>
        assertToolGrid(
          bypassed,
          delegateIndex + 1,
          "Delegate",
          "SUBAGENT_FIXTURE",
          evidenceFor(delegateIndex, 80),
        ),
      /header/,
    );
    writeFileSync(
      join(control, "result.json"),
      JSON.stringify({
        missingFooter: "rejected",
        bypassedDirectRenderer: "rejected",
        sourceMutation: false,
      }),
    );
    assert.ok(
      records.some(
        (r) => r.id === "bash-long" && r.width === 80 && r.interactionChanged,
      ),
      "ctrl+o did not reveal long output",
    );
    const inventory = JSON.parse(readFileSync(plan.inventory, "utf8"));
    const exercised = new Set(
      states.flatMap((s) => s.calls?.map((c: any) => c.name) ?? []),
    );
    for (const tool of inventory)
      assert.ok(
        exercised.has(tool.name),
        `registered tool never directly exercised: ${tool.name}`,
      );
    if (!negative) {
      const controlRun = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(import.meta.url),
          "--negative-footer",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      writeFileSync(
        join(control, "runtime-control.log"),
        controlRun.stdout + "\n" + controlRun.stderr,
      );
      assert.notEqual(
        controlRun.status,
        0,
        "broken production runtime unexpectedly passed",
      );
      assert.match(
        controlRun.stderr,
        /missing or duplicate root tool footer/,
        "negative runtime failed for an unrelated reason",
      );
      writeFileSync(
        join(control, "runtime-result.json"),
        JSON.stringify({
          status: "rejected missing production footer",
          exitCode: controlRun.status,
          artifacts: controlRun.stdout
            .split("\n")
            .find((line) => line.startsWith("rendering artifacts:")),
        }),
      );
    }
    if (!negative) {
      const missingResults = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(import.meta.url),
          "--negative-result",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      writeFileSync(
        join(control, "runtime-inputs-only.log"),
        missingResults.stdout + "\n" + missingResults.stderr,
      );
      assert.notEqual(missingResults.status, 0);
      assert.match(
        missingResults.stderr,
        /rendered result rows|production result component/,
      );
    }
    writeFileSync(
      join(temporary, "report.json"),
      JSON.stringify(
        {
          status: "passed",
          observationHash: createHash("sha256")
            .update(readFileSync(env.PI_RENDER_OBSERVED_SOURCE))
            .digest("hex"),
          records,
          limitations: [
            "no real image pixels or desktop screenshots; native image decode + text fallback only",
            "live backends not implemented or verified; outer/child models and HTTP/gh replies synthetic; child Pi and read execution REAL",
            "nested calls are native summary UI, NOT child custom renderer coverage",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`passed; artifacts retained: ${temporary}`);
  } catch (error) {
    try {
      capture("failure");
    } catch {}
    writeFileSync(join(temporary, "failure.txt"), String(error));
    throw error;
  } finally {
    try {
      tmux("kill-server");
    } catch {}
  }
}
