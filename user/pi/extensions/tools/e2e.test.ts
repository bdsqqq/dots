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
 */

import { spawn as nodeSpawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync, existsSync } from "node:fs";
import { describe, it, expect, afterAll } from "bun:test";

// --- constants ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = process.env.PI_E2E_CWD ?? resolve(__dirname, "../../../..");
const ENABLED = process.env.PI_E2E === "1";

let tmuxAvailable = false;
try {
	const r = Bun.spawnSync(["tmux", "list-sessions"]);
	tmuxAvailable = r.exitCode === 0;
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

function runPi(prompt: string, opts?: { timeout?: number }): Promise<PiResult> {
	const timeout = opts?.timeout ?? 120_000;

	return new Promise((resolve, reject) => {
		const events: PiEvent[] = [];
		let stderr = "";
		let buffer = "";

		const proc = nodeSpawn("pi", ["--mode", "json", "-p", "--no-session", prompt], {
			cwd: CWD,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			reject(new Error(`pi timed out after ${timeout}ms`));
		}, timeout);

		proc.stdout!.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try { events.push(JSON.parse(line)); } catch {}
			}
		});

		proc.stderr!.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) {
				try { events.push(JSON.parse(buffer)); } catch {}
			}
			resolve({ events, exitCode: code ?? 1, stderr });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// --- event extractors ---

function getToolCalls(events: PiEvent[]): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const e of events) {
		if (e.type === "message_end" && e.message?.role === "assistant") {
			for (const part of e.message.content ?? []) {
				if (part.type === "toolCall") {
					calls.push({ id: part.id, name: part.name, args: part.arguments ?? {} });
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
			const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
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
		if (events[i].type === "agent_end") {
			const messages = events[i].messages ?? [];
			for (let j = messages.length - 1; j >= 0; j--) {
				if (messages[j].role === "assistant") {
					for (const part of messages[j].content ?? []) {
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
	Bun.spawnSync(["tmux", "new-window", "-d", "-n", name, cmd]);
}

function tmuxSend(target: string, text: string) {
	// send text then Enter — tmux send-keys treats each arg as a key/string
	Bun.spawnSync(["tmux", "send-keys", "-t", target, text, "Enter"]);
}

function tmuxCapture(target: string): string {
	const r = Bun.spawnSync(["tmux", "capture-pane", "-p", "-S", "-", "-t", target]);
	return new TextDecoder().decode(r.stdout);
}

function tmuxKill(target: string) {
	Bun.spawnSync(["tmux", "kill-window", "-t", target]);
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
		await Bun.sleep(pollMs);
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
		await Bun.sleep(pollMs);
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
		console.log(`${"TOTAL".padEnd(col.name)}  ${"".padStart(col.cost)}  ${"".padStart(col.cost)}  ${`$${grandTotal.toFixed(4)}`.padStart(col.cost)}`);
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

		const c = getCosts(events);
		costs.push({ test: "registration", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 60_000);

	it("finder: sub-agent searches codebase via gemini flash", async () => {
		const t0 = Date.now();
		const { events, exitCode } = await runPi(
			"Use the finder tool to search for where createBashTool is defined. Just call finder, nothing else.",
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const finderCalls = calls.filter(c => c.name === "finder");
		expect(finderCalls.length).toBeGreaterThanOrEqual(1);
		expect(finderCalls[0].args.query).toBeTruthy();

		const results = getToolResults(events);
		const finderResults = results.filter(r => r.toolName === "finder");
		expect(finderResults.length).toBeGreaterThanOrEqual(1);

		const result = finderResults[0];
		expect(result.exitCode).toBe(0);
		expect(result.isError).toBe(false);
		expect(result.model).toContain("gemini");
		expect(result.content).toContain("bash");
		expect(result.usage?.turns).toBeGreaterThanOrEqual(1);

		const c = getCosts(events);
		costs.push({ test: "finder", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 120_000);

	it("Task: sub-agent creates file on disk", async () => {
		const t0 = Date.now();
		const testFile = "/tmp/pi-e2e-task-test.txt";
		const testContent = "e2e test from Task sub-agent";

		// clean up prior runs
		try { unlinkSync(testFile); } catch {}

		const { events, exitCode } = await runPi(
			`Use the Task tool to create a file at ${testFile} with the content "${testContent}". Use description "e2e write test".`,
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const taskCalls = calls.filter(c => c.name === "Task");
		expect(taskCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const taskResults = results.filter(r => r.toolName === "Task");
		expect(taskResults.length).toBeGreaterThanOrEqual(1);
		expect(taskResults[0].exitCode).toBe(0);
		expect(taskResults[0].isError).toBe(false);

		// verify actual file on disk
		expect(existsSync(testFile)).toBe(true);
		const content = await Bun.file(testFile).text();
		expect(content.trim()).toBe(testContent);

		// cleanup
		try { unlinkSync(testFile); } catch {}

		const c = getCosts(events);
		costs.push({ test: "Task", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 180_000);

	it("oracle: sub-agent provides advice via gpt-5.2", async () => {
		const t0 = Date.now();
		const { events, exitCode } = await runPi(
			'Use the oracle tool with task "What is the single biggest risk of spawning sub-agents as child processes?" and context "We use piSpawn() to fork pi processes for isolated sub-agent execution."',
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const oracleCalls = calls.filter(c => c.name === "oracle");
		expect(oracleCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const oracleResults = results.filter(r => r.toolName === "oracle");
		expect(oracleResults.length).toBeGreaterThanOrEqual(1);

		const result = oracleResults[0];
		expect(result.exitCode).toBe(0);
		expect(result.isError).toBe(false);
		expect(result.model).toContain("gpt");
		expect(result.content.length).toBeGreaterThan(100);
		expect(result.usage?.turns).toBeGreaterThanOrEqual(1);

		const c = getCosts(events);
		costs.push({ test: "oracle", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
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
		const lookAtCalls = calls.filter(c => c.name === "look_at");
		expect(lookAtCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const lookAtResults = results.filter(r => r.toolName === "look_at");
		expect(lookAtResults.length).toBeGreaterThanOrEqual(1);

		const result = lookAtResults[0];
		expect(result.exitCode).toBe(0);
		expect(result.isError).toBe(false);
		expect(result.model).toContain("gemini");
		// the model should describe visual content
		expect(result.content.length).toBeGreaterThan(50);

		const c = getCosts(events);
		costs.push({ test: "look_at", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 120_000);

	it("look_at: sub-agent extracts info from a text file", async () => {
		const t0 = Date.now();
		const filePath = resolve(CWD, "flake.nix");
		const { events, exitCode } = await runPi(
			`Use the look_at tool to analyze the file at "${filePath}". Set objective to "List every flake input name" and context to "We want to know what dependencies this nix flake has."`,
		);
		expect(exitCode).toBe(0);

		const results = getToolResults(events);
		const lookAtResults = results.filter(r => r.toolName === "look_at");
		expect(lookAtResults.length).toBeGreaterThanOrEqual(1);

		const result = lookAtResults[0];
		expect(result.exitCode).toBe(0);
		expect(result.isError).toBe(false);
		// should mention nixpkgs since it's a known input
		expect(result.content.toLowerCase()).toContain("nixpkgs");

		const c = getCosts(events);
		costs.push({ test: "look_at (text)", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 120_000);

	it("read_web_page: fetches a URL and returns content", async () => {
		const t0 = Date.now();
		const { events, exitCode } = await runPi(
			'Use the read_web_page tool to read "https://example.com". Just call the tool, nothing else.',
		);
		expect(exitCode).toBe(0);

		const calls = getToolCalls(events);
		const rwpCalls = calls.filter(c => c.name === "read_web_page");
		expect(rwpCalls.length).toBeGreaterThanOrEqual(1);

		const results = getToolResults(events);
		const rwpResults = results.filter(r => r.toolName === "read_web_page");
		expect(rwpResults.length).toBeGreaterThanOrEqual(1);

		const result = rwpResults[0];
		expect(result.isError).toBe(false);
		// example.com always contains "Example Domain"
		expect(result.content).toContain("Example Domain");

		const c = getCosts(events);
		costs.push({ test: "read_web_page", parent: c.parent, subAgent: c.subAgent, total: c.parent + c.subAgent, durationMs: Date.now() - t0 });
	}, 60_000);

	describe.skipIf(!tmuxAvailable)("TUI rendering", () => {
		const windowName = `pi-e2e-tui-${Date.now()}`;

		afterAll(async () => {
			try {
				Bun.spawnSync(["tmux", "send-keys", "-t", windowName, "C-c", "C-c"]);
				await Bun.sleep(1000);
			} catch {}
			try { tmuxKill(windowName); } catch {}
		});

		it("finder: tree renders with icons, connectors, and usage stats", async () => {
			const t0 = Date.now();
			tmuxSpawn(windowName, `cd ${CWD} && pi --no-session`);
			await Bun.sleep(4000);

			tmuxSend(windowName, "use the finder tool to search for where createGrepTool is defined");

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
			const costMatch = capture.match(/\$ ?\$(\d+\.\d+)/)?.[1]
				?? capture.match(/·\s*\$(\d+\.\d+)\s*·/)?.[1]
				?? capture.match(/\$(\d+\.\d+)/)?.[1];
			const tuiCost = costMatch ? parseFloat(costMatch) : 0;
			costs.push({ test: "TUI (finder)", parent: tuiCost, subAgent: 0, total: tuiCost, durationMs: Date.now() - t0 });
		}, 150_000);
	});
});
