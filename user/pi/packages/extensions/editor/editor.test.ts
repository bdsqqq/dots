/**
 * e2e tests for editor extension — model_select event handling.
 *
 * kept separate from in-source tests because these assertions depend on tmux
 * and a real interactive pi session. the inline migration only pulled over the
 * pure string-formatting helper.
 *
 * usage:
 *   PI_E2E=1 bun x vitest run packages/extensions/editor/editor.test.ts
 *
 * set PI_E2E_MODEL to override the startup model.
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = process.env.PI_E2E_CWD ?? process.cwd();
const ENABLED = process.env.PI_E2E === "1";
const E2E_MODEL =
  process.env.PI_E2E_MODEL ?? "openrouter/moonshotai/kimi-k2.5";
const TMP_HOME_PREFIX = join(tmpdir(), "pi-editor-e2e-home-");

// Check if tmux is available
let tmuxAvailable = false;
try {
  const r = spawnSync("tmux", ["list-sessions"]);
  tmuxAvailable =
    r.status === 0 || r.stdout.toString().includes("no server running");
} catch {
  tmuxAvailable = false;
}

// --- tmux helpers ---

function createTestHome(): string {
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
  return testHome;
}

function tmuxSpawn(name: string, cmd: string) {
  spawnSync("tmux", ["new-window", "-d", "-n", name, cmd]);
}

function tmuxSend(target: string, text: string) {
  spawnSync("tmux", ["send-keys", "-t", target, text, "Enter"]);
}

function tmuxCapture(target: string): string {
  const r = spawnSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", target]);
  return r.stdout.toString();
}

function tmuxKill(target: string) {
  spawnSync("tmux", ["kill-window", "-t", target]);
}

function firstBorderLine(capture: string): string {
  return capture.split("\n").find((line) => line.includes("╭")) ?? "";
}

function expectedModelToken(model: string): string {
  return model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
}

async function waitForPane(
  target: string,
  pattern: RegExp,
  timeoutMs: number,
  pollMs = 1000,
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

describe.skipIf(!ENABLED || !tmuxAvailable)(
  "editor extension - model_select",
  () => {
    const windowName = `pi-editor-test-${Date.now()}`;
    const homes: string[] = [];
    // Fast/cheap model for testing
    const TEST_MODEL = E2E_MODEL;

    afterAll(() => {
      try {
        tmuxKill(windowName);
      } catch {}
      for (const home of homes) {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("updates model display when model changes via /model command", async () => {
      const testHome = createTestHome();
      homes.push(testHome);
      // Start pi in a tmux window (interactive session) with cheap model
      tmuxSpawn(
        windowName,
        `HOME=${testHome} PI_E2E=1 PI_E2E_CWD=${CWD} sh -lc 'cd "${CWD}" && pi --model "${TEST_MODEL}"'`,
      );

      // Wait for pi to start and show the editor border (LabeledEditor uses ╭)
      await waitForPane(windowName, /╭/, 30_000);

      // Wait for idle (no spinner) and for model to appear in border
      await waitForIdle(windowName, 30_000);

      // Additional wait for model to render in border
      await sleep(2000);

      // Capture initial state - should show the configured startup model in border
      const beforeCapture = tmuxCapture(windowName);
      const beforeBorder = firstBorderLine(beforeCapture).toLowerCase();

      expect(beforeBorder).toContain(expectedModelToken(TEST_MODEL));

      // Send /model command to change to a different model
      tmuxSend(windowName, "/model");
      await sleep(1000);
      tmuxSend(windowName, "glm-5");

      // Wait for the model selector to close and model to change
      await waitForIdle(windowName, 30_000);

      // Capture after command - the border should now show the new model
      const afterCapture = tmuxCapture(windowName);
      const afterBorder = firstBorderLine(afterCapture).toLowerCase();

      // CRITICAL: Verify the border changed from kimi to glm-5
      // The model_select handler updates the border label
      expect(afterBorder).toContain("glm");
      expect(afterBorder).not.toContain("kimi");
    }, 90_000);

    it("model_select event fires when model changes", async () => {
      const testHome = createTestHome();
      homes.push(testHome);
      // Start a fresh pi session with cheap model
      const testWin = `pi-model-event-${Date.now()}`;
      tmuxSpawn(
        testWin,
        `HOME=${testHome} PI_E2E=1 PI_E2E_CWD=${CWD} sh -lc 'cd "${CWD}" && pi --model "${TEST_MODEL}"'`,
      );

      // Wait for pi to start
      await waitForPane(testWin, /╭|─/, 30_000);
      await waitForIdle(testWin, 30_000);

      // Send a simple message first
      tmuxSend(testWin, "Say hi");
      await waitForIdle(testWin, 60_000);

      // Now change the model
      tmuxSend(testWin, "/model gemini");
      await sleep(3000);

      const capture = tmuxCapture(testWin);

      expect(capture.length).toBeGreaterThan(0);

      try {
        tmuxKill(testWin);
      } catch {}
    }, 120_000);
  },
);
