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

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  KnownApi,
  Message,
  Model,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
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

export function getToolCalls(messages: Message[]): RecordedToolCall[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    return message.content.flatMap((part) =>
      part.type === "toolCall"
        ? [
            {
              id: part.id,
              name: part.name,
              arguments: part.arguments,
            },
          ]
        : [],
    );
  });
}

export function getToolResults(
  messages: Message[],
  toolName?: string,
): ToolResultMessage[] {
  return messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" &&
      (toolName === undefined || message.toolName === toolName),
  );
}

export function getToolResultText(
  result: ToolResultMessage | undefined,
): string {
  return (
    result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? ""
  );
}

export function getNestedMessages(
  result: ToolResultMessage | undefined,
): Message[] {
  if (!result?.details || typeof result.details !== "object") return [];
  const details = result.details as {
    messages?: unknown;
    sessionFile?: unknown;
  };
  const filterMessages = (messages: unknown[]): Message[] =>
    messages.filter(
      (message): message is Message =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        ["user", "assistant", "toolResult"].includes(String(message.role)),
    );

  if (Array.isArray(details.messages)) return filterMessages(details.messages);
  if (typeof details.sessionFile !== "string") return [];

  try {
    return filterMessages(
      SessionManager.open(details.sessionFile)
        .getEntries()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
  } catch {
    return [];
  }
}

function killSpawnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
        return;
      }
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost: number;
  costBreakdown?: Usage["cost"];
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

export interface RecordedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiSpawnStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type PiSpawnErrorKind =
  | "unsupported"
  | "setup"
  | "spawn"
  | "agent"
  | "exit"
  | "signal"
  | "transport"
  | "cancelled"
  | "timeout";

export interface PiSpawnOwner {
  sessionId?: string;
  sessionFile?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface PiSpawnLifecycle {
  pid: number | null;
  processGroupId: number | null;
  owner: PiSpawnOwner | null;
  startedAt: string;
  endedAt: string | null;
  status: PiSpawnStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorKind: PiSpawnErrorKind | null;
  cancellationRequestedAt: string | null;
  timeoutMs: number | null;
  timedOutAt: string | null;
}

export function isPiSpawnFailure(result: PiSpawnResult): boolean {
  return (
    result.lifecycle?.status === "failed" ||
    result.lifecycle?.status === "cancelled" ||
    result.lifecycle?.status === "timed_out" ||
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
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
  lifecycle?: PiSpawnLifecycle;
}

export interface PiSpawnConfig {
  cwd: string;
  task: string;
  model?: PiSpawnModel;
  /** native tool names: undefined preserves defaults; [] disables all tools. */
  tools?: string[];
  excludeTools?: string[];
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
   * process is terminated after agent_settled, including automatic recovery
   * and queued follow-up work.
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
  owner?: PiSpawnOwner;
  timeoutMs?: number;
}

export type PiSpawn = (config: PiSpawnConfig) => Promise<PiSpawnResult>;

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

export function toToolUsage(
  usage: Pick<
    UsageStats,
    | "input"
    | "output"
    | "cacheRead"
    | "cacheWrite"
    | "cacheWrite1h"
    | "reasoning"
    | "cost"
    | "costBreakdown"
  >,
): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined
      ? { cacheWrite1h: usage.cacheWrite1h }
      : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens:
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: usage.costBreakdown?.input ?? 0,
      output: usage.costBreakdown?.output ?? 0,
      cacheRead: usage.costBreakdown?.cacheRead ?? 0,
      cacheWrite: usage.costBreakdown?.cacheWrite ?? 0,
      total: usage.cost,
    },
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

function findLocalSessionFileByExactId(
  cwd: string,
  sessionId: string,
  sessionDir?: string,
): string | undefined {
  if (!sessionId) return undefined;
  // Match native CLI resolution: exact header ID and cwd, without reading
  // transcripts. Duplicate IDs use the first native discovery match, not recency.
  return SessionManager.findById(cwd, sessionId, sessionDir);
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
    const existing = findLocalSessionFileByExactId(cwd, sessionId, sessionDir);
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

// --- local spawning ---

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new Error("timeoutMs must be a positive finite number");
  }
  const useRpc = !!config.followUp;
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PI_BDS_CONFIG_PATH: config.configPath ?? resolveGlobalSettingsPath(),
    ...config.env,
  };

  const startedAt = new Date().toISOString();
  const parentSessionFile = normalizedSessionValue(
    config.session?.parentSession,
  );
  const parentSessionId = parentSessionFile
    ? readSessionHeaderId(parentSessionFile)
    : undefined;
  const inferredOwner: PiSpawnOwner = {
    ...(parentSessionFile
      ? {
          sessionFile: parentSessionFile,
          ...(parentSessionId ? { sessionId: parentSessionId } : {}),
        }
      : {}),
    ...config.owner,
  };
  const lifecycle: PiSpawnLifecycle = {
    pid: null,
    processGroupId: null,
    owner: Object.keys(inferredOwner).length > 0 ? inferredOwner : null,
    startedAt,
    endedAt: null,
    status: "starting",
    exitCode: null,
    signal: null,
    errorKind: null,
    cancellationRequestedAt: null,
    timeoutMs: config.timeoutMs ?? null,
    timedOutAt: null,
  };
  const baseResult = (): PiSpawnResult => ({
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
    lifecycle,
  });

  if (config.signal?.aborted) {
    lifecycle.status = "cancelled";
    lifecycle.errorKind = "cancelled";
    lifecycle.cancellationRequestedAt = startedAt;
    lifecycle.endedAt = startedAt;
    return {
      ...baseResult(),
      exitCode: 1,
      stopReason: "aborted",
      errorMessage: "pi process cancelled",
    };
  }

  let sessionRouting: ResolvedSessionRouting;
  try {
    sessionRouting = await resolveSessionRouting(
      config.cwd,
      config.session,
      spawnEnv,
    );
  } catch (error) {
    lifecycle.status = "failed";
    lifecycle.errorKind = "setup";
    lifecycle.endedAt = new Date().toISOString();
    return {
      ...baseResult(),
      exitCode: 1,
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  const args: string[] = useRpc
    ? ["--mode", "rpc", ...sessionRouting.args]
    : ["--mode", "json", "-p", ...sessionRouting.args];

  if (config.model) args.push("--model", modelCliString(config.model));
  if (config.tools !== undefined) {
    if (config.tools.length === 0) {
      args.push("--no-tools");
    } else {
      args.push("--tools", config.tools.join(","));
    }
  }
  if (config.excludeTools?.length) {
    args.push("--exclude-tools", config.excludeTools.join(","));
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  if (sessionRouting.unsupported) {
    lifecycle.endedAt = startedAt;
    lifecycle.status = "failed";
    lifecycle.errorKind = "unsupported";
  }

  const result: PiSpawnResult = {
    ...baseResult(),
    exitCode: sessionRouting.unsupported ? 1 : 0,
    ...(sessionRouting.meta ? { session: sessionRouting.meta } : {}),
    ...(sessionRouting.unsupported
      ? { stopReason: "error", errorMessage: sessionRouting.unsupported }
      : {}),
    lifecycle,
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
    let wasTimedOut = false;
    const debugEnabled = !!process.env.PI_SPAWN_DEBUG;
    const debug = (label: string, data?: Record<string, unknown>) => {
      if (!debugEnabled) return;
      const suffix = data ? ` ${JSON.stringify(data)}` : "";
      process.stderr.write(`[pi-spawn] ${label}${suffix}\n`);
    };

    const piBin = process.env.PI_BIN || "pi";
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: string;
      transportError?: string;
      inputError?: string;
      rpcCompleted: boolean;
    }>((resolve) => {
      // RpcClient hardcodes `node <cliPath>` and does not detach children.
      // Raw stdio preserves PI_BIN overrides and process-group cancellation.
      const proc = spawn(piBin, args, {
        cwd: config.cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: [useRpc ? "pipe" : "ignore", "pipe", "pipe"],
        env: spawnEnv,
      });
      lifecycle.pid = proc.pid ?? null;
      lifecycle.processGroupId =
        process.platform !== "win32" ? (proc.pid ?? null) : null;
      lifecycle.status = "running";
      let transportError: string | undefined;
      proc.stdin?.on("error", (error) => {
        transportError = error.message;
        result.errorMessage = error.message;
        terminate();
      });

      // Only the session-level boundary includes retries and queued work.
      let rpcCompleted = false;
      let inputError: string | undefined;
      const pendingInputs = new Set(["prompt", "follow_up"]);
      const rejectInput = (message: string) => {
        inputError ??= message;
        terminate();
      };

      // send initial prompt via RPC stdin, then immediately queue follow_up.
      // follow_up is queued (not delivered) until the agent is idle, so the
      // agent loop's getFollowUpMessages() will find it after exploration.
      // sending it eagerly avoids a race where the loop exits before a
      // late follow_up arrives through the cross-process stdin/stdout round-trip.
      if (useRpc && proc.stdin) {
        const promptCmd = JSON.stringify({
          id: "prompt",
          type: "prompt",
          message: `Delegated task: ${config.task}`,
        });
        debug("send_prompt");
        proc.stdin.write(promptCmd + "\n");

        if (config.followUp) {
          const followUpCmd = JSON.stringify({
            id: "follow_up",
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
        let event: {
          type?: string;
          message?: Message;
          id?: string;
          command?: string;
          success?: boolean;
          error?: string;
          data?: { disposition?: string };
        };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "response") {
          if (useRpc && event.id && pendingInputs.has(event.id)) {
            const disposition = event.data?.disposition;
            if (
              event.command !== event.id ||
              event.success !== true ||
              (event.id === "prompt"
                ? disposition !== "started" && disposition !== "queued"
                : disposition !== "queued")
            ) {
              // "handled" is valid RPC, but did not submit this delegated phase
              // to the agent; it may never produce agent_settled.
              rejectInput(
                `pi RPC ${event.id} not accepted: ${event.error ?? disposition ?? "missing disposition"}`,
              );
            } else {
              pendingInputs.delete(event.id);
            }
          }
          return;
        }

        if (useRpc && event.type === "agent_settled") {
          if (pendingInputs.size > 0) {
            rejectInput("pi RPC settled before input acceptance receipts");
          }
          rpcCompleted = true;
          // Work is complete; the kill escalation timer bounds cleanup now.
          if (timeoutTimer) clearTimeout(timeoutTimer);
          debug("agent_settled");
          terminate();
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          result.messages.push(msg);

          if (msg.role === "assistant") {
            result.usage.turns++;
          }
          // Native toolResult usage already includes executeTool descendants.
          // Count only transcript results, never nested execution events/details.
          if (msg.role === "assistant" || msg.role === "toolResult") {
            const { usage } = msg;
            if (usage) {
              result.usage.input += usage.input || 0;
              result.usage.output += usage.output || 0;
              result.usage.cacheRead += usage.cacheRead || 0;
              result.usage.cacheWrite += usage.cacheWrite || 0;
              if (usage.cacheWrite1h !== undefined) {
                result.usage.cacheWrite1h =
                  (result.usage.cacheWrite1h ?? 0) + usage.cacheWrite1h;
              }
              if (usage.reasoning !== undefined) {
                result.usage.reasoning =
                  (result.usage.reasoning ?? 0) + usage.reasoning;
              }
              result.usage.cost += usage.cost?.total || 0;
              const previousCost = result.usage.costBreakdown;
              result.usage.costBreakdown = {
                input: (previousCost?.input ?? 0) + (usage.cost?.input || 0),
                output: (previousCost?.output ?? 0) + (usage.cost?.output || 0),
                cacheRead:
                  (previousCost?.cacheRead ?? 0) + (usage.cost?.cacheRead || 0),
                cacheWrite:
                  (previousCost?.cacheWrite ?? 0) +
                  (usage.cost?.cacheWrite || 0),
                total: (previousCost?.total ?? 0) + (usage.cost?.total || 0),
              };
              if (msg.role === "assistant")
                result.usage.contextTokens = usage.totalTokens || 0;
            }
          }
          if (msg.role === "assistant") {
            if (!result.model && msg.model) {
              result.model = `${msg.provider}/${msg.model}`;
            }
            if (msg.stopReason) result.stopReason = msg.stopReason;
            // A retry may recover from an earlier assistant error.
            result.errorMessage = msg.errorMessage;
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
      let timeoutTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (value: {
        code: number | null;
        signal: NodeJS.Signals | null;
        spawnError?: string;
      }) => {
        if (settled) return;
        settled = true;
        if (buffer.trim()) processLine(buffer);
        if (config.signal) config.signal.removeEventListener("abort", killProc);
        if (killTimer) clearTimeout(killTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve({ ...value, rpcCompleted, transportError, inputError });
      };
      const terminate = () => {
        if (killTimer) return;
        killSpawnedProcess(proc, "SIGTERM");
        killTimer = setTimeout(() => {
          killSpawnedProcess(proc, "SIGKILL");
        }, 5000);
      };
      const killProc = () => {
        if (wasAborted || wasTimedOut || settled) return;
        wasAborted = true;
        lifecycle.cancellationRequestedAt = new Date().toISOString();
        terminate();
      };

      proc.on("close", (code, signal) => {
        finish({ code, signal });
      });

      proc.on("error", (error) => {
        finish({ code: null, signal: null, spawnError: error.message });
      });

      if (config.signal) {
        if (config.signal.aborted) killProc();
        else config.signal.addEventListener("abort", killProc, { once: true });
      }
      if (config.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          if (wasAborted || wasTimedOut || settled) return;
          wasTimedOut = true;
          lifecycle.timedOutAt = new Date().toISOString();
          terminate();
        }, config.timeoutMs);
      }
    });

    lifecycle.endedAt = new Date().toISOString();
    lifecycle.exitCode = outcome.code;
    lifecycle.signal = outcome.signal;
    result.exitCode = outcome.code ?? (outcome.spawnError ? 1 : 0);
    if (wasAborted) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.errorMessage ??= "pi process cancelled";
      lifecycle.status = "cancelled";
      lifecycle.errorKind = "cancelled";
    } else if (wasTimedOut) {
      result.exitCode = 1;
      result.stopReason = "aborted";
      result.errorMessage ??= `pi process timed out after ${config.timeoutMs}ms`;
      lifecycle.status = "timed_out";
      lifecycle.errorKind = "timeout";
    } else if (outcome.spawnError) {
      result.exitCode = 1;
      result.errorMessage = outcome.spawnError;
      lifecycle.status = "failed";
      lifecycle.errorKind = "spawn";
    } else if (outcome.transportError) {
      result.exitCode = 1;
      lifecycle.status = "failed";
      lifecycle.errorKind = "transport";
    } else if (outcome.inputError) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = outcome.inputError;
      lifecycle.status = "failed";
      lifecycle.errorKind = "agent";
    }
    // Native RPC handles SIGTERM with exit 143; escalation may yield SIGKILL.
    // Normalize only our completed shutdown, never cancellation or other exits.
    const expectedRpcTermination =
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError &&
      useRpc &&
      outcome.rpcCompleted &&
      (outcome.code === 0 ||
        outcome.code === 143 ||
        outcome.signal === "SIGTERM" ||
        outcome.signal === "SIGKILL") &&
      result.stopReason !== "error" &&
      result.stopReason !== "aborted";
    if (expectedRpcTermination) {
      result.exitCode = 0;
      lifecycle.status = "succeeded";
      lifecycle.errorKind = null;
    } else if (
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError &&
      useRpc &&
      !outcome.rpcCompleted
    ) {
      result.exitCode = result.exitCode || 1;
      result.errorMessage ??= "pi RPC ended before agent_settled";
      lifecycle.status = "failed";
      lifecycle.errorKind = "agent";
    } else if (
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError &&
      (result.stopReason === "error" || result.stopReason === "aborted")
    ) {
      result.exitCode = result.exitCode || 1;
      lifecycle.status = "failed";
      lifecycle.errorKind = "agent";
    } else if (
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError &&
      outcome.signal
    ) {
      result.exitCode = 1;
      result.errorMessage ??= `pi process terminated by signal ${outcome.signal}`;
      lifecycle.status = "failed";
      lifecycle.errorKind = "signal";
    } else if (
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError &&
      outcome.code !== 0
    ) {
      result.errorMessage ??= `pi process exited with code ${outcome.code}`;
      lifecycle.status = "failed";
      lifecycle.errorKind = "exit";
    } else if (
      !wasAborted &&
      !wasTimedOut &&
      !outcome.spawnError &&
      !outcome.transportError &&
      !outcome.inputError
    ) {
      lifecycle.status = "succeeded";
      lifecycle.errorKind = null;
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
  const originalPiBin = process.env.PI_BIN;

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-test-"));
    tmpRoots.push(dir);
    return dir;
  };

  const makeFakePi = (body: string) => {
    const dir = makeTmpDir();
    const executable = path.join(dir, "fake-pi");
    fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return executable;
  };

  const isPidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterEach(() => {
    if (originalPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = originalPiBin;
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("toToolUsage", () => {
    it("preserves token and cost breakdowns", () => {
      expect(
        toToolUsage({
          input: 100,
          output: 25,
          cacheRead: 50,
          cacheWrite: 10,
          cacheWrite1h: 4,
          reasoning: 8,
          cost: 1.85,
          costBreakdown: {
            input: 1,
            output: 0.5,
            cacheRead: 0.1,
            cacheWrite: 0.25,
            total: 1.85,
          },
        }),
      ).toEqual({
        input: 100,
        output: 25,
        cacheRead: 50,
        cacheWrite: 10,
        cacheWrite1h: 4,
        reasoning: 8,
        totalTokens: 185,
        cost: {
          input: 1,
          output: 0.5,
          cacheRead: 0.1,
          cacheWrite: 0.25,
          total: 1.85,
        },
      });
    });
  });

  describe("getNestedMessages", () => {
    it("loads compact sub-agent transcripts from their session sidecar", () => {
      const cwd = makeTmpDir();
      const session = SessionManager.create(cwd, path.join(cwd, "sessions"));
      session.appendMessage({
        role: "user",
        content: "sidecar prompt",
        timestamp: 1,
      });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "sidecar response" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const result = {
        role: "toolResult",
        toolCallId: "delegate-1",
        toolName: "delegate",
        content: [{ type: "text", text: "done" }],
        details: { sessionFile: session.getSessionFile() },
        isError: false,
        timestamp: 2,
      } as ToolResultMessage;

      expect(getNestedMessages(result)[0]).toMatchObject({
        role: "user",
        content: "sidecar prompt",
      });
    });
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

    it("filters exact header ids by cwd in a shared custom directory", async () => {
      const cwd = makeTmpDir();
      const otherCwd = makeTmpDir();
      const sessionDir = path.join(cwd, "sessions");
      const foreign = SessionManager.create(otherCwd, sessionDir, {
        id: "shared-id",
      });
      materializeSessionFile(foreign);
      const foreignPath = path.join(sessionDir, "foreign.jsonl");
      fs.renameSync(foreign.getSessionFile()!, foreignPath);
      const local = SessionManager.create(cwd, sessionDir, { id: "shared-id" });
      materializeSessionFile(local);
      // Discovery uses the header, not the filename or transcript validity.
      const renamed = path.join(sessionDir, "not-the-session-id.jsonl");
      fs.renameSync(local.getSessionFile()!, renamed);
      fs.appendFileSync(renamed, "invalid transcript body\n");

      const routing = await resolveSessionRouting(
        cwd,
        { id: "shared-id" },
        { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      );
      expect(routing.meta?.sessionFile).toBe(renamed);
      expect(
        findLocalSessionFileByExactId(otherCwd, "shared-id", sessionDir),
      ).toBe(foreignPath);
      expect(
        findLocalSessionFileByExactId(cwd, "shared", sessionDir),
      ).toBeUndefined();
    });

    it("uses the native first header match for duplicate exact ids", async () => {
      const cwd = makeTmpDir();
      const sessionDir = path.join(cwd, "sessions");
      const original = SessionManager.create(cwd, sessionDir, {
        id: "duplicate",
      });
      materializeSessionFile(original);
      fs.copyFileSync(
        original.getSessionFile()!,
        path.join(sessionDir, "duplicate-copy.jsonl"),
      );
      const nativeMatch = SessionManager.findById(cwd, "duplicate", sessionDir);
      expect(nativeMatch).toBeDefined();
      const routing = await resolveSessionRouting(
        cwd,
        { id: "duplicate" },
        { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      );
      expect(routing.meta?.sessionFile).toBe(nativeMatch);
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

  describe("piSpawn lifecycle", () => {
    const emit = (event: unknown) =>
      `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});`;
    const assistantEnd = (stopReason: string, errorMessage?: string) => ({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: stopReason }],
        stopReason,
        errorMessage,
        timestamp: 0,
        usage: toToolUsage({ ...zeroUsage(), input: 2, output: 1 }),
      },
    });
    const rpcFixture = (records: string[], receipts = true) => {
      const script = path.join(makeTmpDir(), "rpc-fixture.mjs");
      fs.writeFileSync(
        script,
        `
        let buffer = "";
        let started = false;
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", async chunk => {
          buffer += chunk;
          const lines = buffer.split("\\n");
          // Reading both commands first proves eager queueing.
          if (started || lines.length < 3) return;
          started = true;
          process.stderr.write(lines.slice(0, 2).join("\\n") + "\\n");
          ${
            receipts
              ? [
                  emit({
                    id: "follow_up",
                    type: "response",
                    command: "follow_up",
                    success: true,
                    data: { disposition: "queued" },
                  }),
                  emit({
                    id: "prompt",
                    type: "response",
                    command: "prompt",
                    success: true,
                    data: { disposition: "started" },
                  }),
                ].join("\n")
              : ""
          }
          ${records.join("\n")}
          setInterval(() => {}, 1000);
        });
      `,
      );
      return makeFakePi(
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      );
    };

    it("waits through retryable errors and clears recovered error state", async () => {
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("error", "529 overloaded")),
        emit({ type: "agent_end", messages: [], willRetry: true }),
        emit({ type: "auto_retry_start", attempt: 1, delayMs: 50 }),
        "await new Promise(resolve => setTimeout(resolve, 50));",
        emit(assistantEnd("stop")),
        emit({ type: "auto_retry_end", success: true, attempt: 1 }),
        emit(assistantEnd("stop")),
        // The old stop counter would kill before this settled boundary.
        "await new Promise(resolve => setTimeout(resolve, 50));",
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.lifecycle?.status).toBe("succeeded");
      expect(result.exitCode).toBe(0);
      expect(result.stopReason).toBe("stop");
      expect(result.errorMessage).toBeUndefined();
      expect(result.usage).toMatchObject({ turns: 3, input: 6, output: 3 });
      expect(result.messages).toHaveLength(3);
      expect(
        result.stderr
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { id: "prompt", type: "prompt", message: "Delegated task: explore" },
        { id: "follow_up", type: "follow_up", message: "report" },
      ]);
    });

    it("keeps both queued phases alive until settled, not stop or agent_end", async () => {
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("stop")),
        emit({ type: "agent_end", messages: [], willRetry: false }),
        "await new Promise(resolve => setTimeout(resolve, 50));",
        emit({
          type: "message_end",
          message: {
            role: "user",
            content: "report",
            timestamp: 1,
          },
        }),
        emit(assistantEnd("stop")),
        "await new Promise(resolve => setTimeout(resolve, 50));",
        emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: "late",
            toolName: "fixture",
            content: [],
            isError: false,
            timestamp: 2,
          },
        }),
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.lifecycle?.status).toBe("succeeded");
      expect(result.messages.map((message) => message.role)).toEqual([
        "assistant",
        "user",
        "assistant",
        "toolResult",
      ]);
      expect(result.usage.turns).toBe(2);
    });

    it.each([
      { id: "prompt", success: false, error: "preflight rejected" },
      { id: "follow_up", success: false, error: "queue rejected" },
      { id: "prompt", success: true, data: { disposition: "handled" } },
      { id: "follow_up", success: true, data: { disposition: "handled" } },
      { id: "prompt", success: true },
    ])(
      "fails promptly for unaccepted input: $id $success $data",
      async (receipt) => {
        process.env.PI_BIN = rpcFixture(
          [
            emit({ type: "response", command: receipt.id, ...receipt }),
            // Even buffered success events must not overwrite input failure.
            emit(assistantEnd("stop")),
            emit({ type: "agent_settled" }),
          ],
          false,
        );
        const result = await piSpawn({
          cwd: makeTmpDir(),
          task: "explore",
          followUp: "report",
          session: { persist: false },
          timeoutMs: 2000,
        });
        expect(result.lifecycle).toMatchObject({
          status: "failed",
          errorKind: "agent",
        });
        expect(result.errorMessage).toContain(
          `pi RPC ${receipt.id} not accepted`,
        );
        expect(result.exitCode).toBe(1);
      },
    );

    it("does not accept settled without receipts", async () => {
      process.env.PI_BIN = rpcFixture([emit({ type: "agent_settled" })], false);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.lifecycle?.status).toBe("failed");
      expect(result.errorMessage).toContain("input acceptance receipts");
    });

    it.each([
      { followUp: "report", phase: "prompt", delay: 0 },
      { followUp: "/fixture", phase: "follow_up", delay: 500 },
    ])(
      "rejects native $phase receipts without a model request",
      async ({ followUp, phase, delay }) => {
        const { getPackageDir } =
          await import("@earendil-works/pi-coding-agent");
        const cwd = makeTmpDir();
        const extension = path.join(cwd, "input.ts");
        fs.writeFileSync(
          extension,
          `
        export default function(pi) {
          pi.registerCommand("fixture", { description: "fixture", handler: async () => {} });
          pi.on("input", async () => {
            await new Promise(resolve => setTimeout(resolve, ${delay}));
            return { action: "handled" };
          });
        }
      `,
        );
        process.env.PI_BIN = makeFakePi(
          `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(getPackageDir(), "dist/cli.js"))} --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --extension ${JSON.stringify(extension)} "$@"`,
        );
        const result = await piSpawn({
          cwd,
          task: "explore",
          followUp,
          session: { persist: false },
          timeoutMs: 5000,
          env: { PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: "1" },
        });
        expect(result.lifecycle, result.stderr).toMatchObject({
          status: "failed",
          errorKind: "agent",
        });
        expect(result.errorMessage).toContain(`pi RPC ${phase} not accepted`);
        expect(result.messages).toEqual([]);
        expect(result.usage.turns).toBe(0);
      },
    );

    it("counts rolled-up tool usage once without changing context or turns", async () => {
      const usage = toToolUsage({
        ...zeroUsage(),
        input: 10,
        output: 5,
        cost: 2,
      });
      const message = {
        role: "toolResult",
        toolCallId: "outer",
        toolName: "fixture",
        content: [],
        isError: false,
        timestamp: 1,
        usage,
        details: { cost: 2, messages: [assistantEnd("stop").message] },
      };
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("stop")),
        emit({
          type: "tool_execution_end",
          parentToolCallId: "outer",
          toolCallId: "outer/1",
          result: { usage },
        }),
        emit({ type: "message_end", message }),
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.lifecycle?.status).toBe("succeeded");
      expect(result.usage).toMatchObject({
        input: 12,
        output: 6,
        cost: 2,
        contextTokens: 3,
        turns: 1,
      });
      expect(result.messages).toHaveLength(2);
    });

    it.each(["error", "aborted"])(
      "classifies settled assistant %s as agent failure",
      async (stopReason) => {
        process.env.PI_BIN = rpcFixture([
          emit(assistantEnd(stopReason, "final failure")),
          "await new Promise(resolve => setTimeout(resolve, 50));",
          emit({
            type: "message_end",
            message: {
              role: "user",
              content: "settling",
              timestamp: 1,
            },
          }),
          emit({ type: "agent_settled" }),
        ]);
        const result = await piSpawn({
          cwd: makeTmpDir(),
          task: "explore",
          followUp: "report",
          session: { persist: false },
          timeoutMs: 2000,
        });
        expect(result.lifecycle).toMatchObject({
          status: "failed",
          errorKind: "agent",
        });
        expect(result.stopReason).toBe(stopReason);
        expect(result.errorMessage).toBe("final failure");
        expect(result.messages).toHaveLength(2);
        expect(result.exitCode).toBe(1);
        expect(isPiSpawnFailure(result)).toBe(true);
      },
    );

    it("times out RPC stops without a settled boundary", async () => {
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("stop")),
        emit(assistantEnd("stop")),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 200,
      });
      expect(result.messages).toHaveLength(2);
      expect(result.lifecycle).toMatchObject({
        status: "timed_out",
        errorKind: "timeout",
      });
      expect(result.exitCode).toBe(1);
    });

    it("does not let a buffered settled boundary override cancellation", async () => {
      const controller = new AbortController();
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("stop")),
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
        signal: controller.signal,
        onUpdate: () => controller.abort(),
      });
      expect(result.lifecycle).toMatchObject({
        status: "cancelled",
        errorKind: "cancelled",
        cancellationRequestedAt: expect.any(String),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stopReason).toBe("aborted");
    });

    it("uses settled rather than a particular successful stop reason", async () => {
      process.env.PI_BIN = rpcFixture([
        emit(assistantEnd("length")),
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.lifecycle?.status).toBe("succeeded");
      expect(result.stopReason).toBe("length");
      expect(result.exitCode).toBe(0);
    });

    it("preserves unexpected shutdown failures after settled", async () => {
      process.env.PI_BIN = rpcFixture([
        'process.on("SIGTERM", () => process.exit(23));',
        emit(assistantEnd("stop")),
        emit({ type: "agent_settled" }),
      ]);
      const result = await piSpawn({
        cwd: makeTmpDir(),
        task: "explore",
        followUp: "report",
        session: { persist: false },
        timeoutMs: 2000,
      });
      expect(result.exitCode).toBe(23);
      expect(result.lifecycle).toMatchObject({
        status: "failed",
        errorKind: "exit",
        exitCode: 23,
        signal: null,
      });
    });

    it("records successful process lifecycle and inferred ownership", async () => {
      const cwd = makeTmpDir();
      const parentSession = path.join(cwd, "parent.jsonl");
      fs.writeFileSync(
        parentSession,
        `${JSON.stringify({ type: "session", id: "parent-session" })}\n`,
      );
      process.env.PI_BIN = makeFakePi("exit 0");

      const result = await piSpawn({
        cwd,
        task: "test",
        session: { persist: false, parentSession },
        owner: { toolCallId: "call-1", toolName: "finder" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.lifecycle).toMatchObject({
        pid: expect.any(Number),
        processGroupId:
          process.platform === "win32" ? null : expect.any(Number),
        owner: {
          sessionId: "parent-session",
          sessionFile: parentSession,
          toolCallId: "call-1",
          toolName: "finder",
        },
        status: "succeeded",
        exitCode: 0,
        signal: null,
        errorKind: null,
        cancellationRequestedAt: null,
        timeoutMs: null,
        timedOutAt: null,
        endedAt: expect.any(String),
      });
    });

    it("distinguishes nonzero exits and signals", async () => {
      const cwd = makeTmpDir();
      process.env.PI_BIN = makeFakePi("exit 23");
      const failed = await piSpawn({
        cwd,
        task: "test",
        session: { persist: false },
      });
      expect(failed.lifecycle).toMatchObject({
        status: "failed",
        exitCode: 23,
        signal: null,
        errorKind: "exit",
      });

      process.env.PI_BIN = makeFakePi("kill -TERM $$");
      const signalled = await piSpawn({
        cwd,
        task: "test",
        session: { persist: false },
      });
      expect(signalled.lifecycle).toMatchObject({
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        errorKind: "signal",
      });
      expect(signalled.exitCode).toBe(1);
      expect(isPiSpawnFailure(signalled)).toBe(true);
    });

    it("distinguishes spawn errors, cancellation, and timeout", async () => {
      const cwd = makeTmpDir();
      process.env.PI_BIN = path.join(cwd, "missing-pi");
      const spawnFailure = await piSpawn({
        cwd,
        task: "test",
        session: { persist: false },
      });
      expect(spawnFailure.lifecycle).toMatchObject({
        pid: null,
        status: "failed",
        errorKind: "spawn",
      });

      const controller = new AbortController();
      controller.abort();
      const cancelledSessionDir = path.join(cwd, "cancelled-sessions");
      const cancelled = await piSpawn({
        cwd,
        task: "test",
        signal: controller.signal,
        session: { id: "cancelled-child" },
        env: { PI_CODING_AGENT_SESSION_DIR: cancelledSessionDir },
      });
      expect(cancelled.lifecycle).toMatchObject({
        pid: null,
        status: "cancelled",
        errorKind: "cancelled",
        cancellationRequestedAt: expect.any(String),
      });
      expect(fs.existsSync(cancelledSessionDir)).toBe(false);

      process.env.PI_BIN = makeFakePi("sleep 60");
      const timedOut = await piSpawn({
        cwd,
        task: "test",
        timeoutMs: 10,
        session: { persist: false },
      });
      expect(timedOut.lifecycle).toMatchObject({
        pid: expect.any(Number),
        status: "timed_out",
        errorKind: "timeout",
        timeoutMs: 10,
        timedOutAt: expect.any(String),
      });
    });

    it("does not normalize an incomplete RPC review to success", async () => {
      const cwd = makeTmpDir();
      const message = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          timestamp: 0,
        },
      });
      process.env.PI_BIN = makeFakePi(
        `read -r prompt; read -r follow_up; printf '%s\\n' '${message}'; exit 42`,
      );

      const result = await piSpawn({
        cwd,
        task: "test",
        followUp: "second turn",
        session: { persist: false },
      });

      expect(result.exitCode).toBe(42);
      expect(result.lifecycle).toMatchObject({
        status: "failed",
        exitCode: 42,
        errorKind: "agent",
      });
      expect(isPiSpawnFailure(result)).toBe(true);
    });

    it.runIf(process.platform !== "win32")(
      "times out the spawned process group, including descendants",
      async () => {
        const cwd = makeTmpDir();
        const childPidFile = path.join(cwd, "child.pid");
        process.env.PI_BIN = makeFakePi(
          'sleep 60 & echo $! > "$CHILD_PID_FILE"; exit 0',
        );

        const result = await piSpawn({
          cwd,
          task: "test",
          timeoutMs: 200,
          session: { persist: false },
          env: { CHILD_PID_FILE: childPidFile },
        });
        const childPid = Number(fs.readFileSync(childPidFile, "utf8").trim());

        expect(result.lifecycle?.status).toBe("timed_out");
        for (let attempt = 0; attempt < 20 && isPidAlive(childPid); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(isPidAlive(childPid)).toBe(false);
      },
    );
  });

  describe("child tool registry", () => {
    const extensionNames = [
      "read",
      "bash",
      "glob",
      "grep",
      "ls",
      "apply-patch",
      "format-file",
      "skill",
      "finder",
      "web-search",
      "read-web-page",
      "github",
    ];
    const delegateTools = [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "apply_patch",
      "format_file",
      "skill",
      "finder",
      "web_search",
      "read_web_page",
    ];

    /**
     * Exercise piSpawn's actual argv/env in a child, then initialize the pinned
     * CLI parser and SDK without prompting. Real extension definitions matter:
     * a harness spy cannot detect names removed before registry construction.
     */
    const probeTools = async (
      selection: Pick<PiSpawnConfig, "tools" | "excludeTools" | "followUp">,
    ) => {
      const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
      const { fileURLToPath, pathToFileURL } = await import("node:url");
      const cwd = makeTmpDir();
      const probe = path.join(cwd, "probe.mjs");
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const paths = extensionNames.map((name) =>
        path.join(
          root,
          process.env.PI_TEST_BUILT_TOOLS === "1"
            ? `dist/extensions/${name}.js`
            : `packages/extensions/${name}/index.ts`,
        ),
      );
      fs.writeFileSync(
        probe,
        `
        import { createAgentSession, DefaultResourceLoader, ModelRuntime,
          SessionManager, SettingsManager } from ${JSON.stringify(pathToFileURL(path.join(getPackageDir(), "dist/index.js")).href)};
        import { parseArgs } from ${JSON.stringify(pathToFileURL(path.join(getPackageDir(), "dist/cli/args.js")).href)};
        import { InMemoryCredentialStore } from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")).href)};
        const parsed = parseArgs(process.argv.slice(2));
        const settingsManager = SettingsManager.inMemory();
        let registerLateTool;
        const resourceLoader = new DefaultResourceLoader({
          cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true,
          additionalExtensionPaths: ${JSON.stringify(paths)},
          extensionFactories: [(pi) => {
            registerLateTool = () => pi.registerTool({
              name: "late_tool", label: "late", description: "late test tool",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [], details: undefined }),
            });
          }],
        });
        await resourceLoader.reload();
        const errors = resourceLoader.getExtensions().errors;
        if (errors.length) throw new Error(JSON.stringify(errors));
        const modelRuntime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(), refreshOnCreate: false, modelsPath: null,
        });
        const { session } = await createAgentSession({
          cwd: process.cwd(), agentDir: process.cwd(), settingsManager, resourceLoader,
          modelRuntime, sessionManager: SessionManager.inMemory(),
          tools: parsed.tools,
          noTools: parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined,
          excludeTools: parsed.excludeTools,
        });
        try {
          await session.bindExtensions({ mode: "json" });
          const active = session.getActiveToolNames().sort();
          const registry = session.getAllTools().map(t => t.name).sort();
          const advertised = session.agent.state.tools.map(t => t.name).sort();
          const sources = Object.fromEntries(session.getAllTools().map(t => [t.name, t.sourceInfo]));
          // A native allowlist must survive refresh, not just session_start.
          registerLateTool();
          console.error(JSON.stringify({
            active, registry, advertised, sources, afterRefresh: session.getActiveToolNames().sort(),
          }));
        } finally { session.dispose(); }
      `,
      );
      process.env.PI_BIN = makeFakePi(
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} "$@"`,
      );
      const spawnUnderTest: PiSpawn =
        process.env.PI_TEST_BUILT_TOOLS === "1"
          ? (
              await import(
                pathToFileURL(path.join(root, "dist/core/pi-spawn.js")).href
              )
            ).piSpawn
          : piSpawn;
      const result = await spawnUnderTest({
        cwd,
        task: "registry probe",
        session: { persist: false },
        timeoutMs: 15000,
        ...selection,
        env: {
          PI_OFFLINE: "1",
          PI_BDS_CONFIG_PATH: path.join(cwd, "settings.json"),
        },
      });
      // RPC deliberately exits before any model turn; only startup is probed.
      expect(result.lifecycle?.exitCode, result.stderr).toBe(0);
      expect(result.exitCode, result.stderr).toBe(selection.followUp ? 1 : 0);
      return JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    };

    it("admits delegate web and mutation tools without unrelated tools", async () => {
      const result = await probeTools({
        tools: delegateTools,
      });
      expect(result.active).toEqual([...delegateTools].sort());
      expect(result.registry).toEqual(result.active);
      expect(result.advertised).toEqual(result.active);
      expect(result.afterRefresh).toEqual(result.active);
    });

    it.each([
      {
        name: "librarian extension-only selection",
        selection: {
          tools: ["read_github", "web_search", "read_web_page"],
        },
        expected: ["read_github", "web_search", "read_web_page"],
      },
      {
        name: "eval selection without builtin defaults",
        selection: { tools: ["finder"] },
        expected: ["finder"],
      },
      {
        name: "exclusion wins over the allowlist, even for a shadowed builtin",
        selection: { tools: ["read", "bash"], excludeTools: ["bash"] },
        expected: ["read"],
      },
      {
        name: "exclusion can remove the entire allowlist",
        selection: { tools: ["web_search"], excludeTools: ["web_search"] },
        expected: [],
      },
      {
        name: "read-session disables everything",
        selection: { tools: [] },
        expected: [],
      },
      {
        name: "empty allowlist stays empty with exclusions",
        selection: { tools: [], excludeTools: ["bash"] },
        expected: [],
      },
      {
        name: "empty exclusion list does not narrow the allowlist",
        selection: { tools: ["read"], excludeTools: [] },
        expected: ["read"],
      },
      {
        name: "native registry deduplicates repeated tool names",
        selection: {
          tools: ["find", "find", "apply_patch"],
        },
        expected: ["find", "apply_patch"],
      },
      {
        name: "unknown-only explicit selection does not restore defaults",
        selection: { tools: ["missing_tool"] },
        expected: [],
      },
      {
        name: "RPC uses the same exact registry selection",
        selection: {
          tools: ["read", "bash", "web_search"],
          excludeTools: ["bash"],
          followUp: "unused offline follow-up",
        },
        expected: ["read", "web_search"],
      },
    ])("$name", async ({ selection, expected }) => {
      const result = await probeTools(selection);
      expect(result.active).toEqual([...expected].sort());
      expect(result.registry).toEqual(result.active);
      expect(result.advertised).toEqual(result.active);
      expect(result.afterRefresh).toEqual(result.active);
      if (expected.includes("read"))
        expect(JSON.stringify(result.sources.read)).toContain(
          "/extensions/read",
        );
    });

    it("excludes builtin, extension, and late-registered tools without an allowlist", async () => {
      const excluded = [
        "bash",
        "write",
        "web_search",
        "apply_patch",
        "late_tool",
      ];
      const result = await probeTools({ excludeTools: excluded });
      for (const name of excluded) {
        expect(result.registry).not.toContain(name);
        expect(result.active).not.toContain(name);
        expect(result.afterRefresh).not.toContain(name);
      }
      expect(result.active).toEqual(
        expect.arrayContaining(["read", "read_web_page"]),
      );
      expect(result.advertised).toEqual(result.active);
      expect(result.afterRefresh).toEqual(result.active);
    });

    it("leaves SDK defaults and unrestricted extensions alone when both lists are omitted", async () => {
      const result = await probeTools({});
      expect(result.active).toEqual(
        expect.arrayContaining([...delegateTools, "read_github"]),
      );
      // apply-patch's startup handler disables native edit/write.
      expect(result.active).not.toContain("edit");
      expect(result.active).not.toContain("write");
      expect(result.advertised).toEqual(result.active);
      expect(result.afterRefresh).toEqual(
        [...result.active, "late_tool"].sort(),
      );
    });
  });
}
