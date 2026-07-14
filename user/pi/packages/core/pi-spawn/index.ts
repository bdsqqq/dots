/**
 * shared pi process spawning for dedicated sub-agent tools.
 *
 * extracts the spawn-parse-collect loop from the generic subagent
 * extension into a reusable function. each dedicated tool (finder,
 * oracle, delegate) calls piSpawn() with its own config.
 *
 * uses shared interpolation from @bds_pi/interpolate for template variables
 * ({cwd}, {roots}, {date}, etc.) in system prompts.
 *
 * cancellation matters now that extensions get ctx.signal: child pi processes
 * should die when the parent turn is aborted, otherwise sub-agents keep
 * running after the user already bailed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { KnownApi, Message, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveGlobalSettingsPath } from "@bds_pi/config";
import { interpolatePromptVars } from "@bds_pi/interpolate";

// --- types ---

/** sub-agent spawn accepts a registry model or a CLI `provider/modelId` string (JSON config). */
export type PiSpawnModel = Model<KnownApi> | string;

export function isPiSpawnModelValue(value: unknown): value is PiSpawnModel {
  if (typeof value === "string") return value.trim().length > 0;
  if (value !== null && typeof value === "object") {
    const m = value as Record<string, unknown>;
    return (
      typeof m.provider === "string" &&
      m.provider.trim().length > 0 &&
      typeof m.id === "string" &&
      m.id.trim().length > 0
    );
  }
  return false;
}

export function modelCliString(model: PiSpawnModel): string {
  return typeof model === "string" ? model : `${model.provider}/${model.id}`;
}

/**
 * resolve a `provider/modelId` string (modelId may contain slashes) via the pi-ai registry.
 * for E2E tests and dynamic env overrides where `getModel` literals are not available.
 */
export function getModelFromCliString(cliModel: string): Model<KnownApi> {
  const i = cliModel.indexOf("/");
  if (i <= 0) {
    throw new Error(`[@bds_pi/pi-spawn] invalid model string: ${cliModel}`);
  }
  const provider = cliModel.slice(0, i);
  const modelId = cliModel.slice(i + 1);
  return getModel(provider as any, modelId as any);
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface PiSpawnSession {
  id?: string;
  leafId?: string;
  persist?: boolean;
  /** source session file to link from a fresh child session header. */
  parentSession?: string;
}

export interface PiSpawnSessionMeta {
  continueId?: string;
  sessionId?: string;
  sessionFile?: string;
  leafId?: string;
  unsupported?: string;
}

export interface PiSpawnResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: PiSpawnModel;
  stopReason?: string;
  errorMessage?: string;
  session?: PiSpawnSessionMeta;
}

export interface PiSpawnConfig {
  cwd: string;
  task: string;
  model?: PiSpawnModel;
  builtinTools?: string[];
  extensionTools?: string[];
  systemPromptBody?: string;
  signal?: AbortSignal;
  onUpdate?: (result: PiSpawnResult) => void;
  session?: PiSpawnSession;
  repo?: string;
  /**
   * override the global bds config path for the child process.
   *
   * when omitted, piSpawn propagates the parent's resolved global config path
   * via PI_BDS_CONFIG_PATH so sub-agents inherit extension gating.
   */
  configPath?: string;
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
  /**
   * additional environment variables to pass to the child process.
   *
   * useful for testing tool-policy.json by overriding HOME.
   */
  env?: Record<string, string | undefined>;
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
 * resolve a prompt from either an inline string or a file.
 *
 * precedence: promptString (if non-empty) → readAgentPrompt(promptFile).
 * lets extensions externalize prompt content via config while
 * keeping shared .md prompt files as the default source.
 */
export function resolvePrompt(
  promptString: string,
  promptFile: string,
): string {
  if (promptString) return promptString;
  return readAgentPrompt(promptFile);
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

interface ResolvedSessionRouting {
  args: string[];
  meta?: PiSpawnSessionMeta;
  sessionIdForPrompt?: string;
  unsupported?: string;
}

function normalizedSessionValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredSessionDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const sessionDir = normalizedSessionValue(env.PI_CODING_AGENT_SESSION_DIR);
  if (!sessionDir) return undefined;
  return sessionDir === "~" || sessionDir.startsWith("~/")
    ? path.join(os.homedir(), sessionDir.slice(2))
    : sessionDir;
}

function readSessionHeaderId(filePath: string): string | undefined {
  try {
    const firstLine = fs.readFileSync(filePath, "utf-8").split("\n")[0];
    if (!firstLine) return undefined;
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string"
      ? header.id
      : undefined;
  } catch {
    return undefined;
  }
}

async function findLocalSessionFileByExactId(
  cwd: string,
  sessionId: string,
  sessionDir?: string,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.find((session) => session.id === sessionId)?.path;
}

function materializeSessionFile(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) {
    throw new Error("[@bds_pi/pi-spawn] failed to create child session header");
  }

  try {
    const fd = fs.openSync(sessionFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(header)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readSessionHeaderId(sessionFile) === header.id) return;
    throw new Error(
      `[@bds_pi/pi-spawn] session file already exists with a different id: ${sessionFile}`,
    );
  }
}

async function createLinkedSessionFile(
  cwd: string,
  sessionDir: string | undefined,
  sessionId: string | undefined,
  parentSession: string | undefined,
): Promise<{ sessionId: string; sessionFile: string }> {
  if (sessionId) {
    const existing = await findLocalSessionFileByExactId(
      cwd,
      sessionId,
      sessionDir,
    );
    if (existing) return { sessionId, sessionFile: existing };
  }

  const sessionManager = SessionManager.create(cwd, sessionDir, {
    ...(sessionId ? { id: sessionId } : {}),
    ...(parentSession ? { parentSession } : {}),
  });
  materializeSessionFile(sessionManager);

  const createdSessionId = sessionManager.getSessionId();
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    throw new Error("[@bds_pi/pi-spawn] failed to resolve child session file");
  }
  return { sessionId: createdSessionId, sessionFile };
}

function sessionMeta(
  sessionId: string | undefined,
  sessionFile: string | undefined,
  leafId: string | undefined,
): PiSpawnSessionMeta | undefined {
  const meta: PiSpawnSessionMeta = {};
  if (sessionId) {
    meta.sessionId = sessionId;
    meta.continueId = sessionId;
  }
  if (sessionFile) meta.sessionFile = sessionFile;
  if (leafId) meta.leafId = leafId;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

async function resolveSessionRouting(
  cwd: string,
  session: PiSpawnSession | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedSessionRouting> {
  const sessionId = normalizedSessionValue(session?.id);
  const leafId = normalizedSessionValue(session?.leafId);

  if (leafId) {
    return {
      args: [],
      meta: {
        ...(sessionId ? { sessionId, continueId: sessionId } : {}),
        leafId,
        unsupported: "leafId",
      },
      sessionIdForPrompt: sessionId,
      unsupported:
        "session.leafId is not supported yet; stable branch-target continuation is not wired.",
    };
  }

  if (session?.persist === false) {
    return { args: ["--no-session"] };
  }

  const linkedSession = await createLinkedSessionFile(
    cwd,
    configuredSessionDir(env),
    sessionId,
    normalizedSessionValue(session?.parentSession),
  );
  return {
    args: ["--session", linkedSession.sessionFile],
    meta: sessionMeta(
      linkedSession.sessionId,
      linkedSession.sessionFile,
      undefined,
    ),
    sessionIdForPrompt: linkedSession.sessionId,
  };
}

// --- spawn ---

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
  const useRpc = !!config.followUp;
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PI_BDS_CONFIG_PATH: config.configPath ?? resolveGlobalSettingsPath(),
    ...config.env,
  };
  if (config.extensionTools !== undefined) {
    if (config.extensionTools.length === 0) {
      spawnEnv.PI_INCLUDE_TOOLS = "NONE";
    } else {
      spawnEnv.PI_INCLUDE_TOOLS = config.extensionTools.join(",");
    }
  }

  const sessionRouting = await resolveSessionRouting(
    config.cwd,
    config.session,
    spawnEnv,
  );
  const args: string[] = useRpc
    ? ["--mode", "rpc", ...sessionRouting.args]
    : ["--mode", "json", "-p", ...sessionRouting.args];

  if (config.model) args.push("--model", modelCliString(config.model));
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
    exitCode: sessionRouting.unsupported ? 1 : 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
    ...(sessionRouting.meta ? { session: sessionRouting.meta } : {}),
    ...(sessionRouting.unsupported
      ? { stopReason: "error", errorMessage: sessionRouting.unsupported }
      : {}),
  };

  if (sessionRouting.unsupported) return result;

  try {
    if (config.systemPromptBody?.trim()) {
      const interpolated = interpolatePromptVars(
        config.systemPromptBody,
        config.cwd,
        { sessionId: sessionRouting.sessionIdForPrompt, repo: config.repo },
      );
      const tmp = writePromptToTempFile("subagent", interpolated);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // in print mode, task is a CLI arg. in RPC mode, sent via stdin prompt command.
    if (!useRpc) {
      args.push(`Delegated task: ${config.task}`);
    }

    let wasAborted = false;
    const debugEnabled = !!process.env.PI_SPAWN_DEBUG;
    const debug = (label: string, data?: Record<string, unknown>) => {
      if (!debugEnabled) return;
      const suffix = data ? ` ${JSON.stringify(data)}` : "";
      process.stderr.write(`[pi-spawn] ${label}${suffix}\n`);
    };

    const piBin = process.env.PI_BIN || "pi";
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(piBin, args, {
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
          message: `Delegated task: ${config.task}`,
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
                  if (proc.exitCode === null && proc.signalCode === null)
                    proc.kill("SIGKILL");
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
                if (proc.exitCode === null && proc.signalCode === null)
                  proc.kill("SIGKILL");
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

      proc.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr!.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      let killTimer: NodeJS.Timeout | undefined;
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null)
            proc.kill("SIGKILL");
        }, 5000);
      };

      proc.on("close", (code) => {
        if (config.signal) config.signal.removeEventListener("abort", killProc);
        if (killTimer) clearTimeout(killTimer);
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        if (config.signal) config.signal.removeEventListener("abort", killProc);
        if (killTimer) clearTimeout(killTimer);
        resolve(1);
      });

      if (config.signal) {
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

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const tmpRoots: string[] = [];

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-test-"));
    tmpRoots.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("resolveSessionRouting", () => {
    it("creates a header-only linked session and routes via --session", async () => {
      const cwd = makeTmpDir();
      const sessionDir = path.join(cwd, "sessions");
      const parentSession = path.join(sessionDir, "parent.jsonl");

      const routing = await resolveSessionRouting(
        cwd,
        { id: "child-session", parentSession },
        { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      );

      expect(routing.args).toEqual(["--session", routing.meta?.sessionFile]);
      expect(routing.meta).toMatchObject({
        sessionId: "child-session",
        continueId: "child-session",
      });

      const lines = fs
        .readFileSync(routing.meta!.sessionFile!, "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: "session",
        id: "child-session",
        cwd,
        parentSession,
      });
    });

    it("resumes only exact ids", async () => {
      const cwd = makeTmpDir();
      const sessionDir = path.join(cwd, "sessions");
      const existing = SessionManager.create(cwd, sessionDir, {
        id: "existing",
      });
      materializeSessionFile(existing);

      const prefixRouting = await resolveSessionRouting(
        cwd,
        { id: "exist" },
        { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      );
      const exactRouting = await resolveSessionRouting(
        cwd,
        { id: "existing" },
        { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      );

      expect(prefixRouting.meta?.sessionId).toBe("exist");
      expect(prefixRouting.meta?.sessionFile).not.toBe(
        existing.getSessionFile(),
      );
      expect(exactRouting.meta?.sessionFile).toBe(existing.getSessionFile());
    });

    it("keeps non-persistent sessions ephemeral", async () => {
      const routing = await resolveSessionRouting(
        makeTmpDir(),
        { persist: false },
        {},
      );

      expect(routing).toEqual({ args: ["--no-session"] });
    });
  });
}
