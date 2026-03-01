/**
 * shared pi process spawning for dedicated sub-agent tools.
 *
 * extracts the spawn-parse-collect loop from the generic subagent
 * extension into a reusable function. each dedicated tool (finder,
 * oracle, Task) calls piSpawn() with its own config.
 *
 * uses shared interpolation from ./interpolate for template variables
 * ({cwd}, {roots}, {date}, etc.) in system prompts.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { interpolatePromptVars, type InterpolateContext } from "./interpolate";

// --- types ---

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface PiSpawnResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiSpawnConfig {
  cwd: string;
  task: string;
  model?: string;
  builtinTools?: string[];
  extensionTools?: string[];
  systemPromptBody?: string;
  signal?: AbortSignal;
  onUpdate?: (result: PiSpawnResult) => void;
  sessionId?: string;
  repo?: string;
  /**
   * inject a follow-up user message after the agent's first turn.
   *
   * uses pi's RPC mode instead of print mode. the follow-up is queued
   * eagerly at startup (not delivered until idle), so the agent loop's
   * getFollowUpMessages() finds it after exploration completes. the
   * process is killed after the second end_turn.
   *
   * primary use case: code_review — agent explores the diff first,
   * then receives the report format instructions.
   */
  followUp?: string;
}

// --- helpers ---

function writePromptToTempFile(
  label: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = label.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

export function zeroUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/**
 * read an agent prompt .md file, strip frontmatter, return body.
 * looks in ~/.pi/agent/agents/{filename}.
 */
export function readAgentPrompt(filename: string): string {
  const promptPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "agents",
    filename,
  );
  try {
    const content = fs.readFileSync(promptPath, "utf-8");
    if (content.startsWith("---")) {
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx !== -1) return content.slice(endIdx + 4).trim();
    }
    return content;
  } catch {
    return "";
  }
}

// --- spawn ---

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
  const useRpc = !!config.followUp;
  const args: string[] = useRpc
    ? ["--mode", "rpc", "--no-session"]
    : ["--mode", "json", "-p", "--no-session"];

  if (config.model) args.push("--model", config.model);
  if (config.builtinTools !== undefined) {
    if (config.builtinTools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", config.builtinTools.join(","));
    }
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const result: PiSpawnResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
  };

  try {
    if (config.systemPromptBody?.trim()) {
      const interpolated = interpolatePromptVars(
        config.systemPromptBody,
        config.cwd,
        { sessionId: config.sessionId, repo: config.repo },
      );
      const tmp = writePromptToTempFile("subagent", interpolated);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // in print mode, task is a CLI arg. in RPC mode, sent via stdin prompt command.
    if (!useRpc) {
      args.push(`Task: ${config.task}`);
    }

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      PI_READ_COMPACT: "1",
    };
    if (config.extensionTools !== undefined) {
      if (config.extensionTools.length === 0) {
        spawnEnv.PI_INCLUDE_TOOLS = "NONE";
      } else {
        spawnEnv.PI_INCLUDE_TOOLS = config.extensionTools.join(",");
      }
    }

    let wasAborted = false;
    const debugEnabled = !!process.env.PI_SPAWN_DEBUG;
    const debug = (label: string, data?: Record<string, unknown>) => {
      if (!debugEnabled) return;
      const suffix = data ? ` ${JSON.stringify(data)}` : "";
      process.stderr.write(`[pi-spawn] ${label}${suffix}\n`);
    };

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: config.cwd,
        shell: false,
        stdio: [useRpc ? "pipe" : "ignore", "pipe", "pipe"],
        env: spawnEnv,
      });

      // RPC state: track end_turns to know when to kill
      let endTurnCount = 0;

      // send initial prompt via RPC stdin, then immediately queue follow_up.
      // follow_up is queued (not delivered) until the agent is idle, so the
      // agent loop's getFollowUpMessages() will find it after exploration.
      // sending it eagerly avoids a race where the loop exits before a
      // late follow_up arrives through the cross-process stdin/stdout round-trip.
      if (useRpc && proc.stdin) {
        const promptCmd = JSON.stringify({
          type: "prompt",
          message: `Task: ${config.task}`,
        });
        debug("send_prompt");
        proc.stdin.write(promptCmd + "\n");

        if (config.followUp) {
          const followUpCmd = JSON.stringify({
            type: "follow_up",
            message: config.followUp,
          });
          debug("send_follow_up");
          proc.stdin.write(followUpCmd + "\n");
        }
      }

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        // skip RPC protocol responses (acks for prompt/follow_up/abort commands)
        if (event.type === "response") return;

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          result.messages.push(msg);

          if (msg.role === "assistant") {
            result.usage.turns++;
            const usage = (msg as any).usage;
            if (usage) {
              result.usage.input += usage.input || 0;
              result.usage.output += usage.output || 0;
              result.usage.cacheRead += usage.cacheRead || 0;
              result.usage.cacheWrite += usage.cacheWrite || 0;
              result.usage.cost += usage.cost?.total || 0;
              result.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!result.model && (msg as any).model)
              result.model = (msg as any).model;
            if ((msg as any).stopReason)
              result.stopReason = (msg as any).stopReason;
            if ((msg as any).errorMessage)
              result.errorMessage = (msg as any).errorMessage;

            const stopReason = (msg as any).stopReason as string | undefined;
            const isTurnEnd =
              stopReason === "end_turn" || stopReason === "stop";
            const expectedTurns = config.followUp ? 2 : 1;
            debug("turn_end", {
              stopReason,
              isTurnEnd,
              endTurnCount,
              expectedTurns,
            });

            // RPC kill logic: terminate after expected number of end_turns.
            // follow_up was already queued eagerly at startup, so we just
            // count turns and kill when done.
            if (useRpc && isTurnEnd) {
              endTurnCount++;
              if (endTurnCount >= expectedTurns) {
                debug("kill_after_turn", { endTurnCount });
                proc.kill("SIGTERM");
                setTimeout(() => {
                  if (!proc.killed) proc.kill("SIGKILL");
                }, 5000);
              }
            }

            // RPC: if agent errors, terminate immediately
            if (
              useRpc &&
              (stopReason === "error" || stopReason === "aborted")
            ) {
              debug("kill_after_error", { stopReason });
              proc.kill("SIGTERM");
              setTimeout(() => {
                if (!proc.killed) proc.kill("SIGKILL");
              }, 5000);
            }
          }

          if (config.onUpdate) config.onUpdate({ ...result });
        }

        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message as Message);
          if (config.onUpdate) config.onUpdate({ ...result });
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (config.signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (config.signal.aborted) killProc();
        else config.signal.addEventListener("abort", killProc, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
    }
    // RPC processes are killed intentionally — don't treat SIGTERM exit as error
    if (
      useRpc &&
      result.exitCode !== 0 &&
      (result.stopReason === "end_turn" || result.stopReason === "stop")
    ) {
      result.exitCode = 0;
    }
    return result;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
