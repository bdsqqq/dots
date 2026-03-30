/**
 * e2e tests for dedicated sub-agent tools (finder, oracle, Task, look_at).
 *
 * spawns `pi --mode json -p --no-session` for each test and parses
 * the NDJSON event stream. validates registration, sub-agent spawn,
 * result collection, model routing, and TUI rendering.
 *
 * these tests call real AI models.
 * estimated cost: ~$0.10 per full run.
 *
 * usage:
 *   PI_E2E=1 bun test user/pi/extensions/tools/e2e.test.ts
 *
 * set PI_E2E_CWD to override the working directory for pi spawns
 * (defaults to this repo's root).
 * set PI_E2E_MODEL to override parent model (defaults to moonshotai/kimi-k2.5 via openrouter).
 */

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  unlinkSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- constants ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = process.env.PI_E2E_CWD ?? process.cwd();
const ENABLED = process.env.PI_E2E === "1";
const E2E_MODEL =
  process.env.PI_E2E_MODEL ?? "openrouter/moonshotai/kimi-k2.5";
const RECORD = process.env.PI_E2E_RECORD === "1";
const FIXTURES_DIR = join(__dirname, "__fixtures__", "e2e");
const TMP_HOME_PREFIX = join(tmpdir(), "pi-e2e-home-");

let tmuxAvailable = false;
try {
  const r = spawnSync("tmux", ["list-sessions"]);
  tmuxAvailable = r.status === 0;
} catch {}

// --- types ---

interface PiEvent {
  type: string;
  [key: string]: any;
}

interface PiResult {
  events: PiEvent[];
  exitCode: number;
  stderr: string;
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

interface ToolResult {
  toolName: string;
  exitCode: number;
  model?: string;
  content: string;
  isError: boolean;
  usage?: {
    turns: number;
    cost: number;
    input: number;
    output: number;
  };
}

interface CostEntry {
  test: string;
  parent: number;
  subAgent: number;
  total: number;
  durationMs: number;
}

// --- pi runner ---

function runPi(
  prompt: string,
  opts?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<PiResult> {
  const timeout = opts?.timeout ?? 120_000;

  return new Promise((resolve, reject) => {
    const events: PiEvent[] = [];
    let stderr = "";
    let buffer = "";
    const testHome = mkdtempSync(TMP_HOME_PREFIX);
    const realHome = process.env.HOME;
    mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({
        defaultProvider: "openrouter",
        packages: [CWD],
      }),
      "utf-8",
    );
    if (realHome) {
      const authPath = join(realHome, ".pi", "agent", "auth.json");
      if (existsSync(authPath)) {
        writeFileSync(
          join(testHome, ".pi", "agent", "auth.json"),
          readFileSync(authPath, "utf-8"),
          "utf-8",
        );
      }
    }

    const proc = nodeSpawn(
      "pi",
      ["--mode", "json", "--model", E2E_MODEL, "-p", "--no-session", prompt],
      {
        cwd: opts?.cwd ?? CWD,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: testHome,
          ...opts?.env,
        },
      },
    );

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      reject(new Error(`pi timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {}
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        try {
          events.push(JSON.parse(buffer));
        } catch {}
      }
      rmSync(testHome, { recursive: true, force: true });
      resolve({ events, exitCode: code ?? 1, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      rmSync(testHome, { recursive: true, force: true });
      reject(err);
    });
  });
}

// --- fixture recording ---

function recordFixture(name: string, events: PiEvent[]): void {
  if (!RECORD) return;
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const path = join(FIXTURES_DIR, `${name}.ndjson`);
  const content = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, content + "\n", "utf-8");
  console.log(`recorded fixture: ${path}`);
}

// --- event extractors ---

function getToolCalls(events: PiEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall") {
          calls.push({
            id: part.id,
            name: part.name,
            args: part.arguments ?? {},
          });
        }
      }
    }
  }
  return calls;
}

function getToolResults(events: PiEvent[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const e of events) {
    if (e.type === "tool_execution_end") {
      const r = e.result ?? {};
      const det = r.details ?? {};
      const text =
        (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      results.push({
        toolName: e.toolName,
        exitCode: det.exitCode ?? -1,
        model: det.model,
        content: text,
        isError: r.isError === true,
        usage: det.usage,
      });
    }
  }
  return results;
}

function getFinalText(events: PiEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "agent_end") {
      const messages = events[i]!.messages ?? [];
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j]!.role === "assistant") {
          for (const part of messages[j]!.content ?? []) {
            if (part.type === "text") return part.text;
          }
        }
      }
    }
  }
  return "";
}

/** extract costs from pi events. parent = outer model, subAgent = spawned tool. */
function getCosts(events: PiEvent[]): { parent: number; subAgent: number } {
  let parent = 0;
  let subAgent = 0;
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      parent += e.message.usage?.cost?.total ?? 0;
    }
    if (e.type === "tool_execution_end") {
      subAgent += e.result?.details?.usage?.cost ?? 0;
    }
  }
  return { parent, subAgent };
}

// --- tmux helpers ---

function tmuxSpawn(name: string, cmd: string) {
  spawnSync("tmux", ["new-window", "-d", "-n", name, cmd]);
}

function tmuxSend(target: string, text: string) {
  // send text then Enter — tmux send-keys treats each arg as a key/string
  spawnSync("tmux", ["send-keys", "-t", target, text, "Enter"]);
}

function tmuxCapture(target: string): string {
  const r = spawnSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", target]);
  return r.stdout.toString();
}

function tmuxKill(target: string) {
  spawnSync("tmux", ["kill-window", "-t", target]);
}

async function waitForPane(
  target: string,
  pattern: RegExp,
  timeoutMs: number,
  pollMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = tmuxCapture(target);
      if (pattern.test(last)) return last;
    } catch {}
    await sleep(pollMs);
  }
  return last;
}

/** poll until the bottom of the pane has no spinner/working indicator. */
async function waitForIdle(
  target: string,
  timeoutMs: number,
  pollMs = 2000,
): Promise<string> {
  const spinners = /Working|thinking\.\.\.|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const capture = tmuxCapture(target);
    const tail = capture.split("\n").slice(-5).join("\n");
    if (!spinners.test(tail)) return capture;
  }
  return tmuxCapture(target);
}

// --- tests ---

describe.skipIf(!ENABLED)("sub-agent tools e2e", () => {
  const costs: CostEntry[] = [];

  afterAll(() => {
    if (costs.length === 0) return;
    const col = { name: 30, cost: 10 };
    const hdr = [
      "test".padEnd(col.name),
      "parent".padStart(col.cost),
      "sub-agent".padStart(col.cost),
      "total".padStart(col.cost),
      "time",
    ].join("  ");
    const sep = "─".repeat(hdr.length);

    console.log(`\n${sep}`);
    console.log(hdr);
    console.log(sep);

    let grandTotal = 0;
    for (const c of costs) {
      const line = [
        c.test.padEnd(col.name),
        `$${c.parent.toFixed(4)}`.padStart(col.cost),
        `$${c.subAgent.toFixed(4)}`.padStart(col.cost),
        `$${c.total.toFixed(4)}`.padStart(col.cost),
        `${(c.durationMs / 1000).toFixed(1)}s`,
      ].join("  ");
      console.log(line);
      grandTotal += c.total;
    }

    console.log(sep);
    console.log(
      `${"TOTAL".padEnd(col.name)}  ${"".padStart(col.cost)}  ${"".padStart(col.cost)}  ${`$${grandTotal.toFixed(4)}`.padStart(col.cost)}`,
    );
    console.log(sep);
  });

  it("registration: finder, oracle, Task, look_at visible to model", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      "List every tool you have available. Just the names, one per line.",
    );
    expect(exitCode).toBe(0);
    const text = getFinalText(events);
    expect(text).toContain("finder");
    expect(text).toContain("oracle");
    expect(text).toContain("Task");
    expect(text).toContain("look_at");
    expect(text).toContain("read_web_page");
    expect(text).toContain("web_search");
    expect(text).toContain("code_review");

    recordFixture("registration", events);

    const c = getCosts(events);
    costs.push({
      test: "registration",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 60_000);

  it("finder: sub-agent searches codebase via gemini flash", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      "Use the finder tool to search for where createBashTool is defined. Just call finder, nothing else.",
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const finderCalls = calls.filter((c) => c.name === "finder");
    expect(finderCalls.length).toBeGreaterThanOrEqual(1);
    expect(finderCalls[0]!.args.query).toBeTruthy();

    const results = getToolResults(events);
    const finderResults = results.filter((r) => r.toolName === "finder");
    expect(finderResults.length).toBeGreaterThanOrEqual(1);

    const result = finderResults[0]!;
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.model).toContain("gemini");
    expect(result.content).toContain("bash");
    expect(result.usage?.turns).toBeGreaterThanOrEqual(1);

    recordFixture("tool-finder", events);

    const c = getCosts(events);
    costs.push({
      test: "finder",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 120_000);

  it("Task: sub-agent creates file on disk", async () => {
    const t0 = Date.now();
    const testFile = "/tmp/pi-e2e-task-test.txt";
    const testContent = "e2e test from Task sub-agent";

    // clean up prior runs
    try {
      unlinkSync(testFile);
    } catch {}

    const { events, exitCode } = await runPi(
      `Use the Task tool to create a file at ${testFile} with the content "${testContent}". Use description "e2e write test".`,
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const taskCalls = calls.filter((c) => c.name === "Task");
    expect(taskCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const taskResults = results.filter((r) => r.toolName === "Task");
    expect(taskResults.length).toBeGreaterThanOrEqual(1);
    expect(taskResults[0]!.exitCode).toBe(0);
    expect(taskResults[0]!.isError).toBe(false);

    // verify actual file on disk
    expect(existsSync(testFile)).toBe(true);
    const content = readFileSync(testFile, "utf-8");
    expect(content.trim()).toBe(testContent);

    // cleanup
    try {
      unlinkSync(testFile);
    } catch {}

    recordFixture("tool-task", events);

    const c = getCosts(events);
    costs.push({
      test: "Task",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 180_000);

  it("Task: child sessions respect PI_BDS_CONFIG_PATH gating for builtin-shadowed tools", async () => {
    const t0 = Date.now();
    const sandboxDir = mkdtempSync(join(tmpdir(), "pi-e2e-config-gating-"));
    const projectConfigDir = join(sandboxDir, ".pi");
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "settings.json"),
      JSON.stringify({
        packages: [],
        extensions: [
          join(CWD, "dist/extensions/task.js"),
          join(CWD, "dist/extensions/tool-harness.js"),
        ],
      }),
      "utf-8",
    );
    const childConfigPath = join(sandboxDir, "bds-pi.json");
    writeFileSync(
      childConfigPath,
      JSON.stringify({
        "@bds_pi/bash": { enabled: false },
      }),
      "utf-8",
    );

    const prompt = [
      'Use the Task tool. description: "fallback audit".',
      "In the child, inspect the bash tool schema available to you before acting.",
      "If the required field is `command`, report `builtin-bash`. If the required field is `cmd`, report `custom-bash`.",
      "Then do exactly one thing: run bash with `printf fallback-ok`.",
      "Return only two lines: first the schema label, second the command output.",
    ].join(" ");

    const { events, exitCode } = await runPi(prompt, {
      cwd: sandboxDir,
      env: {
        HOME: sandboxDir,
        PI_BDS_CONFIG_PATH: childConfigPath,
      },
    });
    expect(exitCode).toBe(0);

    const taskResult = getToolResults(events).find(
      (r) => r.toolName === "Task",
    );
    expect(taskResult).toBeDefined();
    expect(taskResult!.exitCode).toBe(0);
    expect(taskResult!.isError).toBe(false);
    expect(taskResult!.content).toContain("builtin-bash");
    expect(taskResult!.content).toContain("fallback-ok");

    const rawTaskEnd = events.find(
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "Task",
    );
    const childMessages = rawTaskEnd?.result?.details?.messages ?? [];
    const childToolCalls = childMessages.flatMap((message: any) =>
      (message.content ?? []).filter((part: any) => part.type === "toolCall"),
    );
    const bashCall = childToolCalls.find((part: any) => part.name === "bash");
    expect(bashCall?.arguments).toMatchObject({ cmd: "printf fallback-ok" });

    const childToolResults = childMessages.filter(
      (message: any) =>
        message.role === "toolResult" && message.toolName === "bash",
    );
    expect(childToolResults.at(-1)?.content?.[0]?.text ?? "").toContain(
      "fallback-ok",
    );

    recordFixture("tool-task-bash-fallback", events);

    const c = getCosts(events);
    costs.push({
      test: "Task (bash fallback)",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 180_000);

  it("Task: child sessions reject bash escapes outside assigned cwd via tool policy", async () => {
    const t0 = Date.now();
    const sandboxDir = mkdtempSync(join(tmpdir(), "pi-e2e-tool-policy-"));
    const projectConfigDir = join(sandboxDir, ".pi");
    const agentConfigDir = join(sandboxDir, ".pi", "agent");
    const childConfigPath = join(sandboxDir, "bds-pi.json");
    const forbiddenPath = join(
      tmpdir(),
      `pi-e2e-task-escape-${Date.now()}.txt`,
    );

    mkdirSync(projectConfigDir, { recursive: true });
    mkdirSync(agentConfigDir, { recursive: true });
    try {
      unlinkSync(forbiddenPath);
    } catch {}

    writeFileSync(
      join(projectConfigDir, "settings.json"),
      JSON.stringify({
        packages: [],
        extensions: [
          join(CWD, "dist/extensions/task.js"),
          join(CWD, "dist/extensions/tool-harness.js"),
          join(CWD, "dist/extensions/bash.js"),
        ],
      }),
      "utf-8",
    );
    writeFileSync(childConfigPath, JSON.stringify({}), "utf-8");
    writeFileSync(
      join(agentConfigDir, "tool-policy.json"),
      JSON.stringify(
        [
          {
            tool: "bash",
            matches: { within: "." },
            action: "allow",
          },
          {
            tool: "bash",
            action: "reject",
            message: "stay inside the assigned cwd",
          },
          { tool: "*", action: "allow" },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const prompt = [
      'Use the Task tool. description: "tool policy escape audit".',
      "In the child, do exactly one thing: run bash with this command:",
      `\`printf blocked > "${forbiddenPath}"\`.`,
      "Do not retry. Return only the bash tool result text.",
    ].join(" ");

    const { events, exitCode, stderr } = await runPi(prompt, {
      cwd: sandboxDir,
      env: {
        HOME: sandboxDir,
        PI_BDS_CONFIG_PATH: childConfigPath,
      },
    });
    if (exitCode !== 0 && /No API key found|Authentication failed/i.test(stderr)) {
      return;
    }
    expect(exitCode).toBe(0);

    const taskResult = getToolResults(events).find(
      (r) => r.toolName === "Task",
    );
    expect(taskResult).toBeDefined();
    expect(taskResult!.exitCode).toBe(0);
    expect(taskResult!.isError).toBe(false);

    const rawTaskEnd = events.find(
      (event) =>
        event.type === "tool_execution_end" && event.toolName === "Task",
    );
    const childMessages = rawTaskEnd?.result?.details?.messages ?? [];
    const childToolCalls = childMessages.flatMap((message: any) =>
      (message.content ?? []).filter((part: any) => part.type === "toolCall"),
    );
    const bashCall = childToolCalls.find((part: any) => part.name === "bash");
    expect(bashCall?.arguments?.cmd ?? "").toContain(forbiddenPath);

    const childToolResults = childMessages.filter(
      (message: any) =>
        message.role === "toolResult" && message.toolName === "bash",
    );
    const bashText = childToolResults.at(-1)?.content?.[0]?.text ?? "";
    expect(bashText).toContain("command rejected");
    expect(bashText).toContain("stay inside the assigned cwd");
    expect(existsSync(forbiddenPath)).toBe(false);

    recordFixture("tool-task-bash-tool-policy", events);

    const c = getCosts(events);
    costs.push({
      test: "Task (bash tool policy)",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 180_000);

  it("oracle: sub-agent provides advice via gpt-5.2", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      'Use the oracle tool with task "What is the single biggest risk of spawning sub-agents as child processes?" and context "We use piSpawn() to fork pi processes for isolated sub-agent execution."',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const oracleCalls = calls.filter((c) => c.name === "oracle");
    expect(oracleCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const oracleResults = results.filter((r) => r.toolName === "oracle");
    expect(oracleResults.length).toBeGreaterThanOrEqual(1);

    const result = oracleResults[0]!;
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.model).toContain("gpt");
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.usage?.turns).toBeGreaterThanOrEqual(1);

    recordFixture("tool-oracle", events);

    const c = getCosts(events);
    costs.push({
      test: "oracle",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 180_000);

  it("look_at: sub-agent analyzes an image via gemini flash", async () => {
    const t0 = Date.now();
    // use a known image in the repo
    const imagePath = resolve(CWD, "assets/wallpaper.jpg");
    const { events, exitCode } = await runPi(
      `Use the look_at tool to analyze the file at "${imagePath}". Set objective to "Describe what this image shows" and context to "We are checking that the look_at tool can analyze images."`,
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const lookAtCalls = calls.filter((c) => c.name === "look_at");
    expect(lookAtCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const lookAtResults = results.filter((r) => r.toolName === "look_at");
    expect(lookAtResults.length).toBeGreaterThanOrEqual(1);

    const result = lookAtResults[0]!;
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.model).toContain("gemini");
    // the model should describe visual content
    expect(result.content.length).toBeGreaterThan(50);

    recordFixture("tool-look_at-image", events);

    const c = getCosts(events);
    costs.push({
      test: "look_at",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 120_000);

  it("look_at: sub-agent extracts info from a text file", async () => {
    const t0 = Date.now();
    const filePath = resolve(CWD, "flake.nix");
    const { events, exitCode } = await runPi(
      `Use the look_at tool to analyze the file at "${filePath}". Set objective to "List every flake input name" and context to "We want to know what dependencies this nix flake has."`,
    );
    expect(exitCode).toBe(0);

    const results = getToolResults(events);
    const lookAtResults = results.filter((r) => r.toolName === "look_at");
    expect(lookAtResults.length).toBeGreaterThanOrEqual(1);

    const result = lookAtResults[0]!;
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    // should mention nixpkgs since it's a known input
    expect(result.content.toLowerCase()).toContain("nixpkgs");

    recordFixture("tool-look_at-text", events);

    const c = getCosts(events);
    costs.push({
      test: "look_at (text)",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 120_000);

  it("read_web_page: fetches a URL and returns content", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      'Use the read_web_page tool to read "https://example.com". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const rwpCalls = calls.filter((c) => c.name === "read_web_page");
    expect(rwpCalls.length).toBeGreaterThanOrEqual(1);

    const results = getToolResults(events);
    const rwpResults = results.filter((r) => r.toolName === "read_web_page");
    expect(rwpResults.length).toBeGreaterThanOrEqual(1);

    const result = rwpResults[0]!;
    expect(result.isError).toBe(false);
    // example.com always contains "Example Domain"
    expect(result.content).toContain("Example Domain");

    recordFixture("tool-read_web_page", events);

    const c = getCosts(events);
    costs.push({
      test: "read_web_page",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 60_000);

  it("web_search: searches via Parallel AI and returns results", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      'Use the web_search tool with objective "What is Nix package manager?" and search_queries ["nix", "package manager"]. Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const wsCalls = calls.filter((c) => c.name === "web_search");
    expect(wsCalls.length).toBeGreaterThanOrEqual(1);
    expect(wsCalls[0]!.args.objective).toBeTruthy();

    const results = getToolResults(events);
    const wsResults = results.filter((r) => r.toolName === "web_search");
    expect(wsResults.length).toBeGreaterThanOrEqual(1);

    const result = wsResults[0]!;
    expect(result.isError).toBe(false);
    // should contain URLs and content about nix
    expect(result.content).toContain("http");
    expect(result.content.length).toBeGreaterThan(100);

    recordFixture("tool-web_search", events);

    const c = getCosts(events);
    costs.push({
      test: "web_search",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 60_000);

  it("code_review: sub-agent reviews a diff and produces XML report", async () => {
    const t0 = Date.now();
    const { events, exitCode } = await runPi(
      'Use the code_review tool with diff_description "the last commit on the current branch (git diff HEAD~1)". Just call the tool, nothing else.',
    );
    expect(exitCode).toBe(0);

    const calls = getToolCalls(events);
    const crCalls = calls.filter((c) => c.name === "code_review");
    expect(crCalls.length).toBeGreaterThanOrEqual(1);
    expect(crCalls[0]!.args.diff_description).toBeTruthy();

    const results = getToolResults(events);
    const crResults = results.filter((r) => r.toolName === "code_review");
    expect(crResults.length).toBeGreaterThanOrEqual(1);

    const result = crResults[0]!;
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.model).toContain("gemini");
    // should produce XML review output
    expect(result.content).toContain("<codeReview>");
    expect(result.content).toContain("<comment>");
    expect(result.usage?.turns).toBeGreaterThanOrEqual(1);

    recordFixture("tool-code_review", events);

    const c = getCosts(events);
    costs.push({
      test: "code_review",
      parent: c.parent,
      subAgent: c.subAgent,
      total: c.parent + c.subAgent,
      durationMs: Date.now() - t0,
    });
  }, 180_000);

  describe.skipIf(!tmuxAvailable)("TUI rendering", () => {
    const windowName = `pi-e2e-tui-${Date.now()}`;

    afterAll(async () => {
      try {
        spawnSync("tmux", ["send-keys", "-t", windowName, "C-c", "C-c"]);
        await sleep(1000);
      } catch {}
      try {
        tmuxKill(windowName);
      } catch {}
    });

    it("finder: tree renders with icons, connectors, and usage stats", async () => {
      const t0 = Date.now();
      tmuxSpawn(windowName, `cd ${CWD} && pi --no-session`);
      await sleep(4000);

      tmuxSend(
        windowName,
        "use the finder tool to search for where createGrepTool is defined",
      );

      // wait for finder sub-agent usage stats to appear
      await waitForPane(windowName, /gemini.*flash/i, 90_000);

      // then wait for the parent model to finish responding
      const capture = await waitForIdle(windowName, 30_000);

      // tree connectors
      expect(capture).toContain("├──");
      expect(capture).toContain("╰──");

      // success icon (on any completed tool call)
      expect(capture).toContain("✓");

      // finder label in output
      expect(capture).toMatch(/finder/);

      // summary section
      expect(capture).toContain("Summary:");

      // usage stats: "N turn(s)" and model name
      expect(capture).toMatch(/\d+ turns?\b/i);
      expect(capture).toMatch(/gemini/i);

      // TUI test runs interactive (no JSON events) — extract total from status bar
      const costMatch =
        capture.match(/\$ ?\$(\d+\.\d+)/)?.[1] ??
        capture.match(/·\s*\$(\d+\.\d+)\s*·/)?.[1] ??
        capture.match(/\$(\d+\.\d+)/)?.[1];
      const tuiCost = costMatch ? parseFloat(costMatch) : 0;
      costs.push({
        test: "TUI (finder)",
        parent: tuiCost,
        subAgent: 0,
        total: tuiCost,
        durationMs: Date.now() - t0,
      });
    }, 150_000);
  });
});
