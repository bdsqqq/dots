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
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  boxRendererWindowed,
  type BoxSection,
  type Excerpt,
} from "./lib/box-format";
import { getText } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { resolveToAbsolute } from "./read";
import { OutputBuffer } from "./lib/output-buffer";

const HEAD_LINES = 50;
const TAIL_LINES = 50;
const SIGKILL_DELAY_MS = 3000;

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
  const dir = match[1] ?? match[2] ?? match[3];
  return { cwd: dir, command: match[4] };
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
function killGracefully(pid: number): void {
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
  }, SIGKILL_DELAY_MS);
}

/** per-block excerpts for collapsed display — head 3 + tail 5 = 8 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

// --- tool factory ---

export function createBashTool(): ToolDefinition {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Executes the given shell command using bash.\n\n" +
      "- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead\n" +
      "- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
      `- Output shows first ${HEAD_LINES} and last ${TAIL_LINES} lines; middle is truncated for large outputs\n` +
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

    renderResult(result: any, _opts: { expanded: boolean }, theme: any) {
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

      return boxRendererWindowed(buildSections, {
        collapsed: { excerpts: COLLAPSED_EXCERPTS },
        expanded: {},
      });
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let command = stripBackground(params.cmd);
      let effectiveCwd = params.cwd
        ? resolveToAbsolute(params.cwd, ctx.cwd)
        : ctx.cwd;

      const cdSplit = splitCdCommand(command);
      if (cdSplit) {
        effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
        command = cdSplit.command;
      }

      if (!existsSync(effectiveCwd)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `working directory does not exist: ${effectiveCwd}`,
            },
          ],
          isError: true,
        } as any;
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
        return {
          content: [{ type: "text" as const, text: msg }],
          isError: true,
        } as any;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      command = injectGitTrailers(command, sessionId);

      const run = () =>
        runCommand(command, effectiveCwd, params.timeout, signal, onUpdate);

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
): Promise<any> {
  const { shell, args } = getShell();

  return new Promise((resolve) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
    let timedOut = false;
    let aborted = false;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killGracefully(child.pid);
      }, timeout * 1000);
    }

    const onAbort = () => {
      aborted = true;
      if (child.pid) killGracefully(child.pid);
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
      resolve({
        content: [
          { type: "text" as const, text: `command error: ${err.message}` },
        ],
        isError: true,
      } as any);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);

      const { text: outputText } = output.format();

      if (aborted) {
        const text = outputText
          ? `${outputText}\n\ncommand aborted`
          : "command aborted";
        resolve({
          content: [{ type: "text" as const, text }],
          isError: true,
        } as any);
        return;
      }

      if (timedOut) {
        const text = outputText
          ? `${outputText}\n\ncommand timed out after ${timeout} seconds`
          : `command timed out after ${timeout} seconds`;
        resolve({
          content: [{ type: "text" as const, text }],
          isError: true,
        } as any);
        return;
      }

      // format result with command header
      let result = `$ ${command}\n\n${outputText || "(no output)"}`;

      if (code !== 0 && code !== null) {
        result += `\n\nexit code ${code}`;
        resolve({
          content: [{ type: "text" as const, text: result }],
          isError: true,
          details: { command },
        } as any);
      } else {
        resolve({
          content: [{ type: "text" as const, text: result }],
          details: { command },
        } as any);
      }
    });
  });
}
