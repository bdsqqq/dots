/**
 * bash tool — replaces pi's built-in with enhanced command execution.
 *
 * differences from pi's built-in:
 * - `cmd` + `cwd` params (model-compatible interface, not pi's `command`)
 * - auto-splits `cd dir && cmd` into cwd + command (fallback for models)
 * - strips trailing `&` (prevents background processes)
 * - git commit trailer injection (session ID)
 * - git lock serialization via withFileLock (prevents concurrent git ops)
 * - SIGTERM → SIGKILL fallback on cancel/timeout (pi goes straight to SIGKILL)
 * - output truncation with head + tail (first/last N lines, not just tail)
 * - constant memory via OutputBuffer (no unbounded string growth)
 * - permission rules from ~/.pi/agent/permissions.json (allow/reject)
 *
 * shadows pi's built-in `bash` tool via same-name registration.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  boxRendererWindowed,
  type BoxSection,
  type Excerpt,
} from "@bds_pi/box-format";
import { getText } from "@bds_pi/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "@bds_pi/mutex";
import { evaluatePermission, loadPermissions } from "@bds_pi/permissions";
import { resolveToAbsolute } from "@bds_pi/fs";
import { OutputBuffer } from "@bds_pi/output-buffer";
import { getExtensionConfig } from "@bds_pi/config";

type BashExtConfig = {
  headLines: number;
  tailLines: number;
  sigkillDelayMs: number;
};

const CONFIG_DEFAULTS: BashExtConfig = {
  headLines: 50,
  tailLines: 50,
  sigkillDelayMs: 3000,
};

// --- shell config ---

/**
 * pi's getShellConfig() lives in utils/shell.js, not re-exported
 * from the main package. reimplemented here — on macOS (our target)
 * this is always /bin/bash.
 */
function getShell(): { shell: string; args: string[] } {
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

// --- command preprocessing ---

/**
 * models sometimes emit `cd dir && cmd` despite the system prompt
 * discouraging it. split into cwd + command so the cd takes effect
 * in the spawn call rather than being lost between invocations.
 */
function splitCdCommand(cmd: string): { cwd: string; command: string } | null {
  const match = cmd.match(
    /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s,
  );
  if (!match) return null;
  const dir = match[1] ?? match[2] ?? match[3] ?? "";
  const command = match[4];
  if (!command) return null;
  return { cwd: dir, command };
}

function stripBackground(cmd: string): string {
  return cmd.replace(/\s*&\s*$/, "");
}

function isGitCommand(cmd: string): boolean {
  return /\bgit\s+/.test(cmd);
}

/**
 * inject session ID trailer into git commit commands so commits
 * are traceable back to the pi session that authored them.
 * skips if trailers are already present (model added them manually).
 */
function injectGitTrailers(cmd: string, sessionId: string): string {
  if (!/\bgit\s+commit\b/.test(cmd)) return cmd;
  if (/--trailer/.test(cmd)) return cmd;
  return cmd.replace(
    /\bgit\s+commit\b/,
    `git commit --trailer "Session-Id: ${sessionId}"`,
  );
}

// --- process management ---

/**
 * SIGTERM the process group first, escalate to SIGKILL after delay.
 * pi's built-in goes straight to SIGKILL via killProcessTree().
 * graceful fallback so processes can clean up.
 */
function killGracefully(pid: number, delayMs: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    try {
      process.kill(-pid, 0);
      process.kill(-pid, "SIGKILL");
    } catch {
      // already dead
    }
  }, delayMs);
}

/** per-block excerpts for collapsed display — head 3 + tail 5 = 8 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

// --- tool factory ---

export function createBashTool(config: BashExtConfig = CONFIG_DEFAULTS): ToolDefinition {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Executes the given shell command using bash.\n\n" +
      "- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead\n" +
      "- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
      `- Output shows first ${config.headLines} and last ${config.tailLines} lines; middle is truncated for large outputs\n` +
      "- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
      "- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
      '- ALWAYS quote file paths: `cat "path with spaces/file.txt"`\n' +
      "- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
      "- Only run `git commit` and `git push` if explicitly instructed by the user.",

    parameters: Type.Object({
      cmd: Type.String({
        description: "The shell command to execute.",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the command (absolute path). Defaults to workspace root.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const Text = getText();
      const cmd = args.cmd || args.command || "...";
      const timeout = args.timeout;
      const timeoutSuffix = timeout
        ? theme.fg("muted", ` (timeout ${timeout}s)`)
        : "";
      // show first line only for multiline commands
      const lines = cmd.split("\n");
      const firstLine = lines[0];
      const multiSuffix = lines.length > 1 ? theme.fg("muted", " …") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${firstLine}`)) +
          multiSuffix +
          timeoutSuffix,
        0,
        0,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const Text = getText();
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text(theme.fg("dim", "(no output)"), 0, 0);

      // extract command from structured details (preferred) or parse from content
      let text: string = content.text;
      let command: string = result.details?.command ?? "";
      if (!command && text.startsWith("$ ")) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) {
          command = text.slice(2, firstNewline);
        }
      }
      // strip `$ command\n\n` prefix — renderCall already shows it
      if (text.startsWith("$ ")) {
        const sep = text.indexOf("\n\n");
        if (sep !== -1) {
          text = text.slice(sep + 2);
        }
      }

      if (!text || text === "(no output)")
        return new Text(theme.fg("dim", "(no output)"), 0, 0);

      const lines = text.split("\n");

      const buildSections = (): BoxSection[] => [
        {
          blocks: [
            {
              lines: lines.map((l) => ({
                text: theme.fg("toolOutput", l),
                highlight: true,
              })),
            },
          ],
        },
      ];

      return boxRendererWindowed(
        buildSections,
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { cmd: string; cwd?: string; timeout?: number };
      let command = stripBackground(p.cmd);
      let effectiveCwd = p.cwd ? resolveToAbsolute(p.cwd, ctx.cwd) : ctx.cwd;

      const cdSplit = splitCdCommand(command);
      if (cdSplit) {
        effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
        command = cdSplit.command;
      }

      if (!existsSync(effectiveCwd)) {
        throw new Error(`working directory does not exist: ${effectiveCwd}`);
      }

      const verdict = evaluatePermission(
        "Bash",
        { cmd: command },
        loadPermissions(),
      );
      if (verdict.action === "reject") {
        const msg = verdict.message
          ? `command rejected: ${verdict.message}`
          : `command rejected by permission rule. command: ${command}`;
        throw new Error(msg);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      command = injectGitTrailers(command, sessionId);

      const run = () =>
        runCommand(command, effectiveCwd, p.timeout, signal, onUpdate, config);

      if (isGitCommand(command)) {
        const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
        return withFileLock(gitLockKey, run);
      }

      return run();
    },
  };
}

// --- execution ---

async function runCommand(
  command: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  config: BashExtConfig,
): Promise<any> {
  const { shell, args } = getShell();

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new OutputBuffer(config.headLines, config.tailLines);
    let timedOut = false;
    let aborted = false;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
      }, timeout * 1000);
    }

    const onAbort = () => {
      aborted = true;
      if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleData = (data: Buffer) => {
      output.add(data.toString("utf-8"));

      if (onUpdate) {
        const { text } = output.format();
        onUpdate({ content: [{ type: "text", text }] });
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`command error: ${err.message}`));
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);

      const { text: outputText } = output.format();

      if (aborted) {
        const text = outputText
          ? `${outputText}\n\ncommand aborted`
          : "command aborted";
        reject(new Error(text));
        return;
      }

      if (timedOut) {
        const text = outputText
          ? `${outputText}\n\ncommand timed out after ${timeout} seconds`
          : `command timed out after ${timeout} seconds`;
        reject(new Error(text));
        return;
      }

      // format result with command header
      let result = `$ ${command}\n\n${outputText || "(no output)"}`;

      if (code !== 0 && code !== null) {
        result += `\n\nexit code ${code}`;
        reject(new Error(result));
      } else {
        resolve({
          content: [{ type: "text" as const, text: result }],
          details: { command },
        });
      }
    });
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  type BashToolResult = {
    content: [{ type: "text"; text: string }];
    details?: { command: string };
    isError?: boolean;
  };

  const tool = createBashTool();
  const mockCtx = {
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => "test-session-id",
    },
  };

  async function execute(cmd: string): Promise<BashToolResult> {
    return (await tool.execute!(
      "test-id",
      { cmd },
      undefined,
      undefined,
      mockCtx as any,
    )) as BashToolResult;
  }

  describe("bash tool output formatting", () => {
    describe("command header", () => {
      it("shows command in output header", async () => {
        const result = await execute(`echo "hello world"`);
        expect(result.content[0].text).toMatch(/^\$ echo "hello world"/);
      });

      it("shows full command including args", async () => {
        const result = await execute(`ls -la /tmp`);
        expect(result.content[0].text).toContain("$ ls -la /tmp");
      });
    });

    describe("small output (no truncation)", () => {
      it("shows all output when small", async () => {
        const result = await execute(`printf 'line 1\nline 2\nline 3\n'`);
        const text = result.content[0].text;
        expect(text).toContain("line 1");
        expect(text).toContain("line 2");
        expect(text).toContain("line 3");
        expect(text).not.toContain("truncated");
      });

      it("handles no output gracefully", async () => {
        const result = await execute("true");
        expect(result.content[0].text).toContain("no output");
        expect(result.isError).toBeFalsy();
      });
    });

    describe("large output (truncation)", () => {
      it("shows head + tail for large output", async () => {
        const result = await execute(
          `for i in $(seq 1 200); do echo "line $i"; done`,
        );
        const text = result.content[0].text;

        expect(text).toContain("line 1");
        expect(text).toContain("line 2");
        expect(text).toContain("line 199");
        expect(text).toContain("line 200");
        expect(text).toContain("truncated");

        const headIndex = text.indexOf("line 1");
        const markerIndex = text.indexOf("truncated");
        const tailIndex = text.indexOf("line 200");
        expect(headIndex).toBeLessThan(markerIndex);
        expect(markerIndex).toBeLessThan(tailIndex);
      }, 10_000);
    });

    describe("exit codes", () => {
      it("shows exit code on failure", async () => {
        await expect(execute(`echo "some output"; exit 42`)).rejects.toThrow(
          "exit code 42",
        );
      });

      it("no exit code on success", async () => {
        const result = await execute(`echo "success"`);
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).not.toContain("exit code");
      });
    });

    describe("mixed stdout/stderr", () => {
      it("captures both stdout and stderr", async () => {
        const result = await execute(`echo "stdout"; echo "stderr" >&2`);
        const text = result.content[0].text;
        expect(text).toContain("stdout");
        expect(text).toContain("stderr");
      });
    });

    describe("reversion guards", () => {
      it("shows first lines, not just tail", async () => {
        const result = await execute(
          `for i in $(seq 1 100); do echo "output line $i"; done`,
        );
        const text = result.content[0].text;
        expect(text).toContain("output line 1");
        expect(text).toContain("output line 2");
        expect(text).toContain("output line 99");
        expect(text).toContain("output line 100");
      }, 10_000);

      it("puts the command header at the start of output", async () => {
        const result = await execute(`echo "test"`);
        const text = result.content[0].text;
        expect(text).toMatch(/^\$ echo "test"/);
        expect(text.slice(0, text.indexOf("\n"))).toBe('$ echo "test"');
      });

      it("keeps head lines before tail lines in truncated output", async () => {
        const result = await execute(
          `for i in $(seq 1 150); do echo "line $i"; done`,
        );
        const text = result.content[0].text;
        const firstHeadIndex = text.indexOf("line 1");
        const lastTailIndex = text.indexOf("line 150");
        expect(firstHeadIndex).toBeGreaterThan(0);
        expect(firstHeadIndex).toBeLessThan(lastTailIndex);
      }, 10_000);
    });

    describe("edge cases", () => {
      it("handles command with special characters", async () => {
        const result = await execute(
          `printf '%s\n' "special: 'quotes' and \"double\" and \$var"`,
        );
        expect(result.content[0].text).toContain("special");
      });

      it("handles very long single line", async () => {
        const result = await execute(`python3 -c "print('x' * 10000)"`);
        expect(result.content[0].text).toContain("xxxxx");
      }, 10_000);

      it("handles many short lines", async () => {
        const result = await execute(
          `for i in $(seq 1 500); do echo "x"; done`,
        );
        expect(result.content[0].text).toContain("truncated");
      }, 10_000);
    });
  });
}

export default function(pi: ExtensionAPI): void {
  const cfg = getExtensionConfig("@bds_pi/bash", CONFIG_DEFAULTS);
  pi.registerTool(withPromptPatch(createBashTool(cfg)));
}
