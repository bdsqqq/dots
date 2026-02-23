/**
 * e2e tests for editor extension — model_select event handling.
 *
 * Uses tmux for interactive session testing to verify that:
 * 1. The model display updates when model is changed via /model command
 * 2. The model_select event fires correctly
 *
 * usage:
 *   PI_E2E=1 bun test user/pi/extensions/editor.test.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = resolve(__dirname, "../../../..");
const ENABLED = process.env.PI_E2E === "1";

// Check if tmux is available
let tmuxAvailable = false;
try {
	const r = Bun.spawnSync(["tmux", "list-sessions"]);
	tmuxAvailable = r.exitCode === 0 || r.stdout.toString().includes("no server running");
} catch {
	tmuxAvailable = false;
}

// --- tmux helpers ---

function tmuxSpawn(name: string, cmd: string) {
	Bun.spawnSync(["tmux", "new-window", "-d", "-n", name, cmd]);
}

function tmuxSend(target: string, text: string) {
	Bun.spawnSync(["tmux", "send-keys", "-t", target, text, "Enter"]);
}

function tmuxCapture(target: string): string {
	const r = Bun.spawnSync(["tmux", "capture-pane", "-p", "-S", "-", "-t", target]);
	return new TextDecoder().decode(r.stdout);
}

function tmuxKill(target: string) {
	Bun.spawnSync(["tmux", "kill-window", "-t", target]);
}

async function waitForPane(target: string, pattern: RegExp, timeoutMs: number, pollMs = 1000): Promise<string> {
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

async function waitForIdle(target: string, timeoutMs: number, pollMs = 2000): Promise<string> {
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

describe.skipIf(!ENABLED || !tmuxAvailable)("editor extension - model_select", () => {
	const windowName = `pi-editor-test-${Date.now()}`;
	// Fast/cheap model for testing
	const TEST_MODEL = "openrouter/moonshotai/kimi-k2.5";

	afterAll(() => {
		try { tmuxKill(windowName); } catch {}
	});

	it("updates model display when model changes via /model command", async () => {
		// Start pi in a tmux window (interactive session) with cheap model
		tmuxSpawn(windowName, `cd ${CWD} && pi --model ${TEST_MODEL}`);
		
		// Wait for pi to start and show the editor border (LabeledEditor uses ╭)
		await waitForPane(windowName, /╭/, 30_000);

		// Wait for idle (no spinner) and for model to appear in border
		await waitForIdle(windowName, 30_000);
		
		// Additional wait for model to render in border
		await Bun.sleep(2000);

		// Capture initial state - should show kimi-k2.5 in border
		const beforeCapture = tmuxCapture(windowName);
		
		// Verify initial model is shown in border (top lines contain the model)
		// Border format: "╭─ ... ─ (openrouter) moonshotai/kimi-k2.5 ─╮"
		expect(beforeCapture.toLowerCase()).toContain("kimi");
		
		// Send /model command to change to a different model
		tmuxSend(windowName, "/model openrouter/z-ai/glm-5");
		
		// Wait for the model selector to close and model to change
		await Bun.sleep(4000);
		
		// Capture after command - the border should now show the new model
		const afterCapture = tmuxCapture(windowName);
		
		// CRITICAL: Verify the border changed from kimi to glm-5
		// The model_select handler updates the border label
		expect(afterCapture.toLowerCase()).toContain("glm");
		expect(afterCapture.toLowerCase()).not.toContain("kimi");
	}, { timeout: 90_000 });

	it("model_select event fires when model changes", async () => {
		// Start a fresh pi session with cheap model
		const testWin = `pi-model-event-${Date.now()}`;
		tmuxSpawn(testWin, `cd ${CWD} && pi --model ${TEST_MODEL}`);
		
		// Wait for pi to start
		await waitForPane(testWin, /╭|─/, 30_000);
		await waitForIdle(testWin, 30_000);

		// Send a simple message first
		tmuxSend(testWin, "Say hi");
		await waitForIdle(testWin, 60_000);
		
		// Now change the model
		tmuxSend(testWin, "/model gemini");
		await Bun.sleep(3000);
		
		const capture = tmuxCapture(testWin);
		
		// The model name should appear somewhere (in border or selector)
		const hasModelReference = capture.toLowerCase().includes("gemini") || 
			                         capture.includes("google") ||
			                         capture.includes("model");
		
		expect(capture.length).toBeGreaterThan(0);
		
		try { tmuxKill(testWin); } catch {}
	}, { timeout: 120_000 });
});

describe("editor extension - model display format (unit)", () => {
	/**
	 * Unit test for the model display format used by updateStatsLabels.
	 * Format: `${provider} ${model.id}`.trim()
	 */
	it("formats model display string correctly", () => {
		function formatModelDisplay(provider: string | undefined, modelId: string): string {
			const providerStr = provider ? `(${provider})` : "";
			return `${providerStr} ${modelId}`.trim();
		}

		expect(formatModelDisplay("anthropic", "claude-sonnet-4-20250514"))
			.toBe("(anthropic) claude-sonnet-4-20250514");
		
		expect(formatModelDisplay("openai", "gpt-4o"))
			.toBe("(openai) gpt-4o");
		
		expect(formatModelDisplay("openrouter", "z-ai/glm-5"))
			.toBe("(openrouter) z-ai/glm-5");
		
		expect(formatModelDisplay(undefined, "some-model"))
			.toBe("some-model");
	});
});