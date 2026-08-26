/**
 * bash tool — replaces pi's built-in with enhanced command execution.
 *
 * differences from pi's built-in:
 * - `cmd` + `cwd` params (model-compatible interface, not pi's `command`)
 * - auto-splits `cd dir && cmd` into cwd + command (fallback for models)
 * - trailing `&` starts a tracked background process and returns immediately
 * - git commit trailer injection (session ID)
 * - git lock serialization via withFileLock (prevents concurrent git ops)
 * - SIGTERM → SIGKILL fallback on cancel/timeout (pi goes straight to SIGKILL)
 * - output truncation with head + tail (first/last N lines, not just tail)
 * - constant memory via OutputBuffer (no unbounded string growth)
 * - tool policy rules from ~/.pi/agent/tool-policy.json (allow/reject)
 *
 * shadows pi's built-in `bash` tool via same-name registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getShellConfig, highlightCode } from "@earendil-works/pi-coding-agent";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  renderLifecycleCall,
  boxRendererWindowed,
  framedTextRenderer,
  type BoxSection,
  type Excerpt,
} from "@bds_pi/box-format";
import { getText, getTruncateToWidth } from "@bds_pi/tui";
import { Type } from "typebox";
import { withFileLock } from "@bds_pi/mutex";
import * as toolPolicy from "@bds_pi/tool-policy";
import { resolveToAbsolute } from "@bds_pi/fs";
import { OutputBuffer } from "@bds_pi/output-buffer";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";

type BashExtConfig = {
  headLines: number;
  tailLines: number;
  sigkillDelayMs: number;
};

type BackgroundProcess = {
  pid: number;
  command: string;
  cwd: string;
  logPath: string;
  ownerSessionId?: string;
  startedAt: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type BackgroundState = {
  nextId: number;
  processes: Map<string, BackgroundProcess>;
};

type BashProcessStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out"
  | "spawn_error";

type BashExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  withPromptPatch: typeof withPromptPatch;
};

const CONFIG_DEFAULTS: BashExtConfig = {
  headLines: 50,
  tailLines: 50,
  sigkillDelayMs: 3000,
};

const DEFAULT_DEPS: BashExtensionDeps = {
  getEnabledExtensionConfig,
  withPromptPatch,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isBashConfig(value: Record<string, unknown>): value is BashExtConfig {
  return (
    isPositiveInteger(value.headLines) &&
    isPositiveInteger(value.tailLines) &&
    typeof value.sigkillDelayMs === "number" &&
    Number.isInteger(value.sigkillDelayMs) &&
    value.sigkillDelayMs >= 0
  );
}

const BASH_CONFIG_SCHEMA: ExtensionConfigSchema<BashExtConfig> = {
  validate: isBashConfig,
};

// --- shell config ---

/**
 * uses pi's getShellConfig() for cross-platform shell resolution.
 */

// --- command preprocessing ---

/**
 * models often emit leading `cd ... &&` out of unix habit. normalize that
 * prefix into `cwd + command` so execution metadata keeps the real directory.
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

function parseBackgroundCommand(cmd: string): {
  command: string;
  background: boolean;
} {
  if (!/\s*&\s*$/.test(cmd)) return { command: cmd, background: false };
  return {
    command: cmd.replace(/\s*&\s*$/, ""),
    background: true,
  };
}

function isExplicitPathToken(token: string): boolean {
  return /^(\/|\.\/|\.\.\/|~\/)/.test(token);
}

function extractPathTokenCandidates(token: string): string[] {
  const candidates = [token];
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1 && equalsIndex < token.length - 1) {
    candidates.push(token.slice(equalsIndex + 1));
  }

  const redirectionMatch = token.match(/^\d*(?:>>?|<<?|&>>?|&>)(.+)$/);
  if (redirectionMatch?.[1]) candidates.push(redirectionMatch[1]);

  return candidates.filter(isExplicitPathToken);
}

/**
 * conservative path extraction for tool policy checks.
 *
 * this is intentionally token-based, not a shell parser. it only tracks
 * explicit path-shaped args we care about for policy: absolute paths plus
 * `./`, `../`, and `~/` forms, including simple `flag=path` and redirection
 * shapes.
 */
function extractExplicitPathArgs(cmd: string, cwd: string): string[] {
  const paths = new Set<string>();

  for (const match of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token) continue;

    for (const candidate of extractPathTokenCandidates(token)) {
      paths.add(resolveToAbsolute(candidate, cwd));
    }
  }

  return [...paths];
}

type CommandDisplayRow = {
  text: string;
  separator?: string;
  command?: false;
};

type Heredoc = {
  delimiter: string;
  stripTabs: boolean;
};

function unquoteShellWord(word: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of word) {
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else result += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else {
      result += char;
    }
  }
  if (escaped) result += "\\";
  return result;
}

function matchHeredoc(cmd: string, index: number): Heredoc | null {
  const match = cmd.slice(index).match(/^<<(-)?[ \t]*([^\s;|&<>]+)/);
  const word = match?.[2];
  return word === undefined
    ? null
    : { delimiter: unquoteShellWord(word), stripTabs: match?.[1] === "-" };
}

function isCommentOnly(text: string): boolean {
  return /^(?:[({]\s*)*#/.test(text.trimStart());
}

/**
 * split compound shell input into display rows without changing execution.
 *
 * amp treats control operators as visual boundaries: each command or pipeline
 * stage gets one collapsed row, while quoted operators remain ordinary args.
 * this lexer is display-only; bash remains the source of truth for semantics.
 */
function splitCommandDisplayRows(cmd: string): CommandDisplayRow[] {
  const rows: CommandDisplayRow[] = [];
  const pendingHeredocs: Heredoc[] = [];
  let activeHeredoc: Heredoc | undefined;
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inComment = false;
  let escaped = false;
  let nestedParenDepth = 0;

  const push = (end: number, separator?: string, command = true) => {
    const text = cmd
      .slice(start, end)
      .replace(/[ \t]*\\\r?\n[ \t]*/g, " ")
      .trim();
    if (text) {
      rows.push({
        text,
        ...(separator ? { separator } : {}),
        ...(!command ? { command: false as const } : {}),
      });
    }
  };

  for (let i = 0; i < cmd.length; i++) {
    if (activeHeredoc) {
      const newline = cmd.indexOf("\n", i);
      const end = newline === -1 ? cmd.length : newline;
      const rawLine = cmd.slice(i, end).replace(/\r$/, "");
      const comparable = activeHeredoc.stripTabs
        ? rawLine.replace(/^\t+/, "")
        : rawLine;

      push(end, newline === -1 ? undefined : "\n", false);
      if (comparable === activeHeredoc.delimiter) {
        activeHeredoc = pendingHeredocs.shift();
      }
      start = end + 1;
      if (newline === -1) break;
      i = end;
      continue;
    }

    const ch = cmd[i];
    const next = cmd[i + 1];
    if (!ch) continue;

    if (inComment) {
      if (ch !== "\n") continue;
      const commentOnly = isCommentOnly(cmd.slice(start, i));
      push(i, "\n", !commentOnly);
      start = i + 1;
      inComment = false;
      activeHeredoc = pendingHeredocs.shift();
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }

    if (nestedParenDepth > 0) {
      if (ch === "(") nestedParenDepth++;
      if (ch === ")") nestedParenDepth--;
      continue;
    }
    if (ch === "$" && next === "(") {
      nestedParenDepth = 1;
      i++;
      continue;
    }
    if (ch === "(" && next === "(") {
      nestedParenDepth = 2;
      i++;
      continue;
    }

    if (ch === "#" && (i === start || /[\s;|&(){}]/.test(cmd[i - 1] ?? ""))) {
      inComment = true;
      continue;
    }

    if (ch === "<" && next === "<") {
      const heredoc = matchHeredoc(cmd, i);
      if (heredoc) pendingHeredocs.push(heredoc);
    }

    let separator: string | undefined;
    let separatorLength = 1;
    if (ch === "&" && next === "&") {
      separator = "&&";
      separatorLength = 2;
    } else if (ch === "|" && next === "|") {
      separator = "||";
      separatorLength = 2;
    } else if (ch === "|" && next === "&") {
      separator = "|&";
      separatorLength = 2;
    } else if (ch === "|") {
      separator = "|";
    } else if (ch === ";" && next === ";") {
      separator = ";;";
      separatorLength = 2;
    } else if (ch === ";") {
      separator = ";";
    } else if (ch === "\n") {
      separator = "\n";
    }

    if (!separator) continue;

    push(i, separator);
    i += separatorLength - 1;
    start = i + 1;
    if (separator === "\n") activeHeredoc = pendingHeredocs.shift();
  }

  const commentOnly = inComment && isCommentOnly(cmd.slice(start));
  push(cmd.length, undefined, !commentOnly);
  return rows.length > 0 ? rows : [{ text: cmd.trim() || "..." }];
}

function styleCollapsedCommandRow(
  row: CommandDisplayRow,
  _first: boolean,
  theme: any,
): string {
  const prefix = `${theme.fg("accent", "$")} `;
  const separator = row.separator
    ? row.separator === "\n"
      ? " \\"
      : ` ${row.separator} \\`
    : "";
  if (row.command === false) {
    return prefix + theme.fg("muted", row.text + separator);
  }

  const match = row.text.match(/^((?:(?:\{|\(|!)\s+)*)(\S+)(.*)$/s);
  if (!match) return prefix + theme.fg("muted", row.text + separator);

  const structure = match[1] ?? "";
  const command = match[2] ?? row.text;
  const args = match[3] ?? "";
  return (
    prefix +
    theme.fg("text", structure) +
    theme.fg("text", theme.bold(command)) +
    theme.fg("muted", args + separator)
  );
}

function normalizeCommandPolicyStage(text: string): string {
  let stage = text.trim();
  const caseCommand = stage.match(/^case\b.*\bin\b.*\)\s*(.+)$/s)?.[1];
  if (caseCommand) stage = caseCommand;

  while (stage) {
    const normalized = stage
      .replace(/^[{}()]\s*/, "")
      .replace(/^!\s*/, "")
      .replace(/^(?:if|while|until|elif|then|do|else)\b\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
    if (normalized === stage) break;
    stage = normalized;
  }
  return stage;
}

function getCommandPolicyCandidates(command: string): string[] {
  return [
    ...new Set([
      command,
      ...splitCommandDisplayRows(command)
        .filter((row) => row.command !== false)
        .map((row) => normalizeCommandPolicyStage(row.text))
        .filter(Boolean),
    ]),
  ];
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createBackgroundState(): BackgroundState {
  return {
    nextId: 1,
    processes: new Map(),
  };
}

function getBackgroundLogPath(id: string): string {
  return path.join(os.tmpdir(), `pi-bash-${id}.log`);
}

async function terminateBackgroundProcess(
  processInfo: BackgroundProcess,
  delayMs: number,
): Promise<void> {
  if (processInfo.timeoutHandle) clearTimeout(processInfo.timeoutHandle);
  if (!isPidAlive(processInfo.pid)) return;

  killGracefully(processInfo.pid, delayMs);

  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs + 500) {
    if (!isPidAlive(processInfo.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cleanupBackgroundProcesses(
  backgroundState: BackgroundState,
  delayMs: number,
): Promise<void> {
  const entries = [...backgroundState.processes.entries()];
  backgroundState.processes.clear();
  backgroundState.nextId = 1;

  await Promise.all(
    entries.map(async ([, processInfo]) => {
      await terminateBackgroundProcess(processInfo, delayMs);
    }),
  );
}

/** per-block excerpts for collapsed display — head 3 + tail 5 = 8 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

// --- tool factory ---

export function createBashTool(
  backgroundState: BackgroundState = createBackgroundState(),
  config: BashExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<any> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Executes the given shell command using bash.\n\n" +
      "- Compound commands run in one shell invocation and display one stage per line\n" +
      "- A leading `cd dir && cmd` is normalized into `cwd` + `cmd` for compatibility with model habits\n" +
      "- A trailing `&` runs the command in the background and returns immediately with a PID and log path\n" +
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
          minimum: 1,
          maximum: 2147483,
        }),
      ),
    }),

    renderCall(args: any, theme: any, context: any) {
      const Text = getText();
      const cmd = args.cmd || args.command || "...";
      const timeoutSuffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";

      if (context.expanded) {
        const highlighted = highlightCode(cmd, "bash");
        highlighted[0] = `${theme.fg("accent", "$")} ${highlighted[0] ?? ""}`;
        if (timeoutSuffix) {
          const last = highlighted.length - 1;
          highlighted[last] = `${highlighted[last] ?? ""}${timeoutSuffix}`;
        }
        return renderLifecycleCall(
          new Text(highlighted.join("\n"), 0, 0),
          theme,
          context,
        );
      }

      const rows = splitCommandDisplayRows(cmd).map((row, index) =>
        styleCollapsedCommandRow(row, index === 0, theme),
      );
      if (timeoutSuffix) rows[rows.length - 1] += timeoutSuffix;

      return renderLifecycleCall(
        rows.map((row) => ({
          render(width: number): string[] {
            const truncateToWidth = getTruncateToWidth();
            return [truncateToWidth(row, width, "…")];
          },
          invalidate() {},
        })),
        theme,
        context,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return framedTextRenderer(theme.fg("dim", "(no output)"), expanded);

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
        return framedTextRenderer(theme.fg("dim", "(no output)"), expanded);

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
      if (
        p.timeout !== undefined &&
        (!Number.isFinite(p.timeout) || p.timeout <= 0 || p.timeout > 2147483)
      ) {
        throw new Error("timeout must be between 1 and 2147483 seconds");
      }

      const parsed = parseBackgroundCommand(p.cmd);
      let command = parsed.command;
      let effectiveCwd = p.cwd ? resolveToAbsolute(p.cwd, ctx.cwd) : ctx.cwd;

      const cdSplit = splitCdCommand(command);
      if (cdSplit) {
        effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
        command = cdSplit.command;
      }

      const pathTargets = extractExplicitPathArgs(command, effectiveCwd);
      const policyRules = toolPolicy.loadToolPolicy();
      for (const policyCommand of getCommandPolicyCandidates(command)) {
        const verdict = toolPolicy.evaluateToolPolicy(
          "bash",
          {
            cmd: policyCommand,
            cwd: effectiveCwd,
            paths: pathTargets,
            sessionCwd: ctx.cwd,
          },
          policyRules,
        );
        if (verdict.action === "reject") {
          const msg = verdict.message
            ? `command rejected: ${verdict.message}`
            : `command rejected by tool policy. command: ${policyCommand}`;
          throw new Error(msg);
        }
      }

      if (!fs.existsSync(effectiveCwd)) {
        throw new Error(`working directory does not exist: ${effectiveCwd}`);
      }

      const sessionId = ctx.sessionManager.getSessionId();
      command = injectGitTrailers(command, sessionId);
      const displayCommand = parsed.background ? `${command} &` : command;
      const env = createBashSessionEnvironment(ctx);

      const run = () =>
        parsed.background
          ? runBackgroundCommand(
              command,
              displayCommand,
              effectiveCwd,
              p.timeout,
              signal,
              backgroundState,
              config,
              env,
            )
          : runForegroundCommand(
              command,
              displayCommand,
              effectiveCwd,
              p.timeout,
              signal,
              onUpdate,
              config,
              env,
            );

      if (isGitCommand(command)) {
        const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
        return withFileLock(gitLockKey, run);
      }

      return run();
    },
  };
}

// --- execution ---

const PI_SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

function createBashSessionEnvironment(ctx: any): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of PI_SESSION_ENV_KEYS) delete env[key];

  const sessionId = ctx.sessionManager?.getSessionId?.();
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionId) env.PI_SESSION_ID = sessionId;
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model?.provider) env.PI_PROVIDER = ctx.model.provider;
  if (ctx.model?.id) env.PI_MODEL = ctx.model.id;
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;

  return env;
}

function hasFailedProcess(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const processDetails = (details as Record<string, unknown>).process;
  if (!processDetails || typeof processDetails !== "object") return false;
  const status = (processDetails as Record<string, unknown>).status;
  return typeof status === "string" && status !== "completed";
}

async function runForegroundCommand(
  command: string,
  displayCommand: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  config: BashExtConfig,
  env: NodeJS.ProcessEnv,
): Promise<any> {
  const { shell, args } = getShellConfig();
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new OutputBuffer(config.headLines, config.tailLines);
    let terminationCause: "timeout" | "aborted" | undefined;
    let exitObserved = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let drainHandle: ReturnType<typeof setTimeout> | undefined;
    const terminate = (cause: "timeout" | "aborted") => {
      if (terminationCause || exitObserved) return;
      terminationCause = cause;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
    };
    const onAbort = () => terminate("aborted");

    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => terminate("timeout"), timeout * 1000);
    }
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
    child.once("exit", () => {
      exitObserved = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      drainHandle = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 100);
    });

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (drainHandle) clearTimeout(drainHandle);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        content: [
          { type: "text" as const, text: `command error: ${err.message}` },
        ],
        details: {
          command: displayCommand,
          cwd,
          process: {
            pid: child.pid,
            processGroupId: child.pid,
            ownerSessionId: env.PI_SESSION_ID,
            startedAt,
            endedAt: new Date().toISOString(),
            status: "spawn_error" satisfies BashProcessStatus,
            exitCode: null,
            signal: null,
            timeoutSeconds: timeout,
            errorKind: "spawn_error",
          },
        },
        isError: true,
      });
    });

    child.on("close", (code, signalCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (drainHandle) clearTimeout(drainHandle);
      signal?.removeEventListener("abort", onAbort);

      const { text: outputText } = output.format();
      const finish = (
        text: string,
        status: BashProcessStatus,
        errorKind?: "aborted" | "timeout" | "nonzero_exit" | "signal_exit",
      ) =>
        resolve({
          content: [{ type: "text" as const, text }],
          details: {
            command: displayCommand,
            cwd,
            process: {
              pid: child.pid,
              processGroupId: child.pid,
              ownerSessionId: env.PI_SESSION_ID,
              startedAt,
              endedAt: new Date().toISOString(),
              status,
              exitCode: code,
              signal: signalCode,
              timeoutSeconds: timeout,
              errorKind,
            },
          },
          ...(errorKind ? { isError: true } : {}),
        });

      if (terminationCause === "aborted") {
        const text = outputText
          ? `${outputText}\n\ncommand aborted`
          : "command aborted";
        finish(text, "aborted", "aborted");
        return;
      }

      if (terminationCause === "timeout") {
        const text = outputText
          ? `${outputText}\n\ncommand timed out after ${timeout} seconds`
          : `command timed out after ${timeout} seconds`;
        finish(text, "timed_out", "timeout");
        return;
      }

      let result = `$ ${displayCommand}\n\n${outputText || "(no output)"}`;

      if (signalCode !== null) {
        result += `\n\nterminated by signal ${signalCode}`;
        finish(result, "failed", "signal_exit");
      } else if (code !== 0 && code !== null) {
        result += `\n\nexit code ${code}`;
        finish(result, "failed", "nonzero_exit");
      } else {
        finish(result, "completed");
      }
    });
  });
}

async function runBackgroundCommand(
  command: string,
  displayCommand: string,
  cwd: string,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  backgroundState: BackgroundState,
  config: BashExtConfig,
  env: NodeJS.ProcessEnv,
): Promise<any> {
  const { shell, args } = getShellConfig();
  const id = `bg-${backgroundState.nextId++}`;
  const logPath = getBackgroundLogPath(id);
  const logFd = fs.openSync(logPath, "a");
  const startedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", logFd, logFd],
    });
    fs.closeSync(logFd);

    if (signal?.aborted) {
      if (child.pid) killGracefully(child.pid, config.sigkillDelayMs);
      reject(new Error("command aborted"));
      return;
    }

    child.on("error", (err) => {
      backgroundState.processes.delete(id);
      reject(new Error(`command error: ${err.message}`));
    });

    const pid = child.pid;
    if (!pid) {
      backgroundState.processes.delete(id);
      reject(new Error("command error: failed to determine background pid"));
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (isPidAlive(pid)) killGracefully(pid, config.sigkillDelayMs);
      }, timeout * 1000);
    }

    backgroundState.processes.set(id, {
      pid,
      command,
      cwd,
      logPath,
      ownerSessionId: env.PI_SESSION_ID,
      startedAt,
      timeoutHandle,
    });

    child.on("close", () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      backgroundState.processes.delete(id);
    });

    child.unref();

    const timeoutNote =
      timeout && timeout > 0
        ? `\nwill be terminated after ${timeout} seconds if still running.`
        : "";

    resolve({
      content: [
        {
          type: "text" as const,
          text:
            `$ ${displayCommand}\n\nstarted background process ${id} (pid ${pid})` +
            `\nlog: ${logPath}` +
            "\nuse the read tool on the log path to inspect readiness or output." +
            `\nuse bash to stop it, e.g. \`kill ${pid}\`.` +
            timeoutNote,
        },
      ],
      details: {
        command: displayCommand,
        cwd,
        background: {
          id,
          pid,
          processGroupId: pid,
          logPath,
          ownerSessionId: env.PI_SESSION_ID,
          startedAt,
          status: "running",
          timeoutSeconds: timeout,
        },
      },
    });
  });
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  type BashToolResult = {
    content: [{ type: "text"; text: string }];
    details?: {
      command: string;
      cwd?: string;
      process?: {
        pid?: number;
        processGroupId?: number;
        ownerSessionId?: string;
        startedAt: string;
        endedAt: string;
        status: BashProcessStatus;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        timeoutSeconds?: number;
        errorKind?: string;
      };
      background?: {
        id: string;
        pid: number;
        processGroupId: number;
        logPath: string;
        ownerSessionId?: string;
        startedAt: string;
        status: "running";
        timeoutSeconds?: number;
      };
    };
    isError?: boolean;
  };

  const backgroundState = createBackgroundState();
  const tool = createBashTool(backgroundState);
  const mockCtx = {
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => "test-session-id",
    },
  };

  async function executeWithCtx(
    cmd: string,
    ctxOverride: Partial<typeof mockCtx>,
    timeout?: number,
  ): Promise<BashToolResult> {
    return (await tool.execute!(
      "test-id",
      { cmd, timeout },
      undefined,
      undefined,
      {
        ...mockCtx,
        ...ctxOverride,
        sessionManager: ctxOverride.sessionManager ?? mockCtx.sessionManager,
      } as any,
    )) as BashToolResult;
  }

  async function execute(
    cmd: string,
    timeout?: number,
  ): Promise<BashToolResult> {
    return executeWithCtx(cmd, {}, timeout);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackgroundProcesses(backgroundState, 100);
  });

  describe("bash tool output formatting", () => {
    describe("command display", () => {
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };

      it("splits compound commands and pipelines into display rows", () => {
        expect(
          splitCommandDisplayRows(
            "rm -rf /tmp/x && { git log -1; rg term docs | head -5; } || cat /tmp/log",
          ),
        ).toEqual([
          { text: "rm -rf /tmp/x", separator: "&&" },
          { text: "{ git log -1", separator: ";" },
          { text: "rg term docs", separator: "|" },
          { text: "head -5", separator: ";" },
          { text: "}", separator: "||" },
          { text: "cat /tmp/log" },
        ]);
      });

      it("keeps quoted operators and line continuations within a row", () => {
        expect(
          splitCommandDisplayRows(
            "printf '%s' 'one && two; three | four' \\\n  tail",
          ),
        ).toEqual([{ text: "printf '%s' 'one && two; three | four' tail" }]);
      });

      it("does not split operators in comments or nested expressions", () => {
        expect(
          splitCommandDisplayRows(
            "echo start # && ignored\nfor ((i=0; i<2; i++)); do echo $(printf 'a;b'); done",
          ),
        ).toEqual([
          { text: "echo start # && ignored", separator: "\n" },
          { text: "for ((i=0; i<2; i++))", separator: ";" },
          { text: "do echo $(printf 'a;b')", separator: ";" },
          { text: "done" },
        ]);
      });

      it("treats heredoc bodies as data rather than commands", () => {
        expect(
          splitCommandDisplayRows("cat <<'EOF'\na && b; c\nEOF\necho done"),
        ).toEqual([
          { text: "cat <<'EOF'", separator: "\n" },
          { text: "a && b; c", separator: "\n", command: false },
          { text: "EOF", separator: "\n", command: false },
          { text: "echo done" },
        ]);
      });

      it("removes backslash quoting from heredoc delimiters", () => {
        expect(
          splitCommandDisplayRows("cat <<\\EOF\na && b\nEOF\necho done"),
        ).toEqual([
          { text: "cat <<\\EOF", separator: "\n" },
          { text: "a && b", separator: "\n", command: false },
          { text: "EOF", separator: "\n", command: false },
          { text: "echo done" },
        ]);
      });

      it("supports empty quoted heredoc delimiters", () => {
        expect(
          splitCommandDisplayRows("cat <<''\nbody\n\nrm nope; true"),
        ).toEqual([
          { text: "cat <<''", separator: "\n" },
          { text: "body", separator: "\n", command: false },
          { text: "rm nope", separator: ";" },
          { text: "true" },
        ]);
      });

      it("marks comments after shell token boundaries as non-commands", () => {
        expect(splitCommandDisplayRows("true;# ignored;rm nope")).toEqual([
          { text: "true", separator: ";" },
          { text: "# ignored;rm nope", command: false },
        ]);
        expect(splitCommandDisplayRows("(# ignored;rm nope\ntrue\n)")).toEqual([
          { text: "(# ignored;rm nope", separator: "\n", command: false },
          { text: "true", separator: "\n" },
          { text: ")" },
        ]);
      });

      it("keeps a prompt on each newline-delimited command", () => {
        const rows = splitCommandDisplayRows("echo one\necho two").map(
          (row, index) => styleCollapsedCommandRow(row, index === 0, theme),
        );

        expect(rows).toEqual(["$ echo one \\", "$ echo two"]);
      });

      it("truncates every collapsed row with a one-character ellipsis", () => {
        const component = tool.renderCall!(
          {
            cmd: "echo a-very-long-argument && printf another-long-argument",
          },
          theme as any,
          { expanded: false, isError: false, isPartial: false } as any,
        );
        const lines = component.render(18);

        const visibleLines = lines.map((line) =>
          line.replace(/\x1b\[[0-9;]*m/g, ""),
        );
        expect(visibleLines).toHaveLength(2);
        expect(visibleLines[0]).toMatch(/^✓ \$ /);
        expect(visibleLines[1]).toMatch(/^╰ \$ /);
        expect(visibleLines.every((line) => line.length <= 18)).toBe(true);
        expect(visibleLines.every((line) => line.endsWith("…"))).toBe(true);
      });

      it("shows the full syntax-highlighted command when expanded", () => {
        const component = tool.renderCall!(
          { cmd: 'echo one && printf "two"' },
          theme as any,
          { expanded: true, isError: false, isPartial: false } as any,
        );
        const rendered = component
          .render(120)
          .join("\n")
          .replace(/\x1b\[[0-9;]*m/g, "");

        expect(rendered).toContain('✓ $ echo one && printf "two"');
      });
    });

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
          `awk 'BEGIN { for (i = 1; i <= 200; i++) print "line " i }'`,
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
      it("returns structured process metadata on failure", async () => {
        const command = `printf 'some output\\n'; exit 42`;
        const result = await execute(command);

        expect(result.content[0].text).toContain("exit code 42");
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({
          command,
          cwd: "/tmp",
          process: {
            ownerSessionId: "test-session-id",
            status: "failed",
            exitCode: 42,
            signal: null,
            errorKind: "nonzero_exit",
          },
        });
        expect(result.details?.process?.pid).toBeTypeOf("number");
        expect(result.details?.process?.startedAt).toBeTruthy();
        expect(result.details?.process?.endedAt).toBeTruthy();
      });

      it("returns structured process metadata on success", async () => {
        const result = await execute(`echo "success"`);
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).not.toContain("exit code");
        expect(result.details?.process).toMatchObject({
          ownerSessionId: "test-session-id",
          status: "completed",
          exitCode: 0,
          signal: null,
        });
      });
    });

    describe("termination", () => {
      it("returns a structured timeout", async () => {
        const result = await execute(`sleep 2`, 0.01);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("command timed out");
        expect(result.details?.process).toMatchObject({
          status: "timed_out",
          errorKind: "timeout",
          timeoutSeconds: 0.01,
        });
      });

      it("returns a structured cancellation", async () => {
        const controller = new AbortController();
        const pending = tool.execute!(
          "test-id",
          { cmd: "sleep 2" },
          controller.signal,
          undefined,
          mockCtx as any,
        ) as Promise<BashToolResult>;
        controller.abort();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("command aborted");
        expect(result.details?.process).toMatchObject({
          status: "aborted",
          errorKind: "aborted",
        });
      });

      it("reports external signal termination as failure", async () => {
        const result = await execute(`kill -TERM $$`);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          "terminated by signal SIGTERM",
        );
        expect(result.details?.process).toMatchObject({
          status: "failed",
          exitCode: null,
          signal: "SIGTERM",
          errorKind: "signal_exit",
        });
      });

      it("keeps the first termination cause", async () => {
        const controller = new AbortController();
        const pending = tool.execute!(
          "test-id",
          { cmd: "trap '' TERM; while :; do sleep 1; done", timeout: 0.01 },
          controller.signal,
          undefined,
          mockCtx as any,
        ) as Promise<BashToolResult>;
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.abort();
        const result = await pending;

        expect(result.details?.process).toMatchObject({
          status: "timed_out",
          errorKind: "timeout",
        });
      });

      it("does not time out after the shell has exited", async () => {
        const startedAt = Date.now();
        const result = await execute(`sh -c "sleep 2 &"`, 1);

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(result.isError).toBeFalsy();
        expect(result.details?.process).toMatchObject({
          status: "completed",
          exitCode: 0,
          signal: null,
        });
      });
    });

    describe("mixed stdout/stderr", () => {
      it("captures both stdout and stderr", async () => {
        const result = await execute(`bash -lc 'echo stdout; echo stderr >&2'`);
        const text = result.content[0].text;
        expect(text).toContain("stdout");
        expect(text).toContain("stderr");
      });
    });

    describe("session environment", () => {
      it("exposes current session and model metadata", async () => {
        const result = await executeWithCtx(
          'printf \'%s|%s|%s|%s|%s\' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
          {
            sessionManager: {
              getSessionId: () => "session-123",
              getSessionFile: () => "/tmp/session-123.jsonl",
            },
            model: { provider: "openai-codex", id: "gpt-5.6-sol" },
            thinkingLevel: "medium",
          } as any,
        );

        expect(result.content[0].text).toContain(
          "session-123|/tmp/session-123.jsonl|openai-codex|gpt-5.6-sol|medium",
        );
      });

      it("removes stale inherited metadata", () => {
        vi.stubEnv("PI_SESSION_FILE", "/tmp/parent.jsonl");
        vi.stubEnv("PI_PROVIDER", "parent-provider");

        const env = createBashSessionEnvironment(mockCtx);

        expect(env.PI_SESSION_ID).toBe("test-session-id");
        expect(env.PI_SESSION_FILE).toBeUndefined();
        expect(env.PI_PROVIDER).toBeUndefined();
      });
    });

    describe("compound commands", () => {
      it("executes top-level && chains", async () => {
        const result = await execute(`echo one && echo two`);
        expect(result.content[0].text).toContain("one\ntwo");
      });

      it.each([
        "echo ok;rm -f /tmp/pi-bash-policy-nonexistent",
        "echo ok &&rm -f /tmp/pi-bash-policy-nonexistent",
        "echo ok\nrm -f /tmp/pi-bash-policy-nonexistent",
        "cat <<\\EOF\nbody\nEOF\nrm -f /tmp/pi-bash-policy-nonexistent",
        "cat <<''\nbody\n\nrm -f /tmp/pi-bash-policy-nonexistent; true",
        "if rm /tmp/pi-bash-policy-nonexistent; then :; fi",
        "while rm /tmp/pi-bash-policy-nonexistent; do :; done",
        "case x in x) rm /tmp/pi-bash-policy-nonexistent;; esac",
      ])("applies tool policy to every command stage: %s", async (cmd) => {
        vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([
          {
            tool: "bash",
            matches: { cmd: "rm *" },
            action: "reject",
            message: "rm blocked",
          },
          { tool: "*", action: "allow" },
        ]);

        await expect(execute(cmd)).rejects.toThrow(
          "command rejected: rm blocked",
        );
      });

      it("does not apply command policy to comment text", async () => {
        vi.spyOn(toolPolicy, "loadToolPolicy").mockReturnValue([
          {
            tool: "bash",
            matches: { cmd: "rm *" },
            action: "reject",
            message: "rm blocked",
          },
          { tool: "*", action: "allow" },
        ]);

        const inline = await execute("true;# ignored;rm nope");
        expect(inline.content[0].text).toContain("(no output)");

        const subshell = await execute("(# ignored;rm nope\ntrue\n)");
        expect(subshell.content[0].text).toContain("(no output)");
      });

      it("rejects commands with /tmp path escapes before spawn", async () => {
        const evaluateToolPolicySpy = vi
          .spyOn(toolPolicy, "evaluateToolPolicy")
          .mockReturnValue({ action: "reject", message: "tmp blocked" });

        await expect(execute(`cat /tmp/escape.txt`)).rejects.toThrow(
          "command rejected: tmp blocked",
        );
        expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
          "bash",
          expect.objectContaining({
            cmd: "cat /tmp/escape.txt",
            cwd: "/tmp",
            paths: ["/tmp/escape.txt"],
            sessionCwd: "/tmp",
          }),
          expect.any(Array),
        );
      });

      it("rejects sibling-worktree escapes after cd normalization", async () => {
        const evaluateToolPolicySpy = vi
          .spyOn(toolPolicy, "evaluateToolPolicy")
          .mockReturnValue({ action: "reject", message: "within only" });

        await expect(
          executeWithCtx(`cd /repo/project && cat ../sibling/secret.txt`, {
            cwd: "/workspace/root",
          }),
        ).rejects.toThrow("command rejected: within only");
        expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
          "bash",
          expect.objectContaining({
            cmd: "cat ../sibling/secret.txt",
            cwd: "/repo/project",
            paths: ["/repo/sibling/secret.txt"],
            sessionCwd: "/workspace/root",
          }),
          expect.any(Array),
        );
      });

      it("passes escaped cwd to tool policy even without explicit path args", async () => {
        const evaluateToolPolicySpy = vi
          .spyOn(toolPolicy, "evaluateToolPolicy")
          .mockReturnValue({ action: "reject", message: "within only" });

        await expect(
          executeWithCtx(`printf blocked > marker.txt`, {
            cwd: "/repo/escape",
          }),
        ).rejects.toThrow("command rejected: within only");
        expect(evaluateToolPolicySpy).toHaveBeenCalledWith(
          "bash",
          expect.objectContaining({
            cmd: "printf blocked > marker.txt",
            cwd: "/repo/escape",
            paths: [],
            sessionCwd: "/repo/escape",
          }),
          expect.any(Array),
        );
      });

      it("executes top-level semicolon chains", async () => {
        const result = await execute(`echo one; echo two`);
        expect(result.content[0].text).toContain("one\ntwo");
      });

      it("executes top-level || chains", async () => {
        const result = await execute(`false || echo two`);
        expect(result.content[0].text).toContain("two");
      });

      it("allows quoted chain operators", async () => {
        const result = await execute(
          `printf '%s\n' 'one && two; three || four'`,
        );
        expect(result.content[0].text).toContain("one && two; three || four");
      });

      it("allows leading cd normalization", async () => {
        const result = await execute(`cd /tmp && printf 'ok\n'`);
        expect(result.content[0].text).toContain("ok");
      });

      it("executes extra chaining after cd normalization", async () => {
        const result = await execute(`cd /tmp && echo one && echo two`);
        expect(result.content[0].text).toContain("one\ntwo");
      });
    });

    describe("reversion guards", () => {
      it("shows first lines, not just tail", async () => {
        const result = await execute(
          `awk 'BEGIN { for (i = 1; i <= 100; i++) print "output line " i }'`,
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
          `awk 'BEGIN { for (i = 1; i <= 150; i++) print "line " i }'`,
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
          `printf '%s\n' "special: 'quotes' and "double" and $var"`,
        );
        expect(result.content[0].text).toContain("special");
      });

      it("handles very long single line", async () => {
        const result = await execute(
          `awk 'BEGIN { for (i = 0; i < 10000; i++) printf "x"; print "" }'`,
        );
        expect(result.content[0].text).toContain("xxxxx");
      }, 10_000);

      it("handles many short lines", async () => {
        const result = await execute(
          `awk 'BEGIN { for (i = 0; i < 500; i++) print "x" }'`,
        );
        expect(result.content[0].text).toContain("truncated");
      }, 10_000);
    });

    describe("background commands", () => {
      it("returns immediately and writes output to a log file", async () => {
        const startedAt = Date.now();
        const result = await execute(`printf 'ready\\n'; sleep 60 &`);

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(result.details?.background?.pid).toBeTruthy();
        expect(result.details?.background?.id).toMatch(/^bg-/);
        expect(result.details?.background?.logPath).toBeTruthy();
        expect(result.details).toMatchObject({
          cwd: "/tmp",
          background: {
            processGroupId: result.details?.background?.pid,
            ownerSessionId: "test-session-id",
            startedAt: expect.any(String),
            status: "running",
          },
        });
        expect(result.content[0].text).toContain("started background process");

        await new Promise((resolve) => setTimeout(resolve, 150));
        const logText = fs.readFileSync(
          result.details!.background!.logPath,
          "utf-8",
        );
        expect(logText).toContain("ready");
      }, 10_000);

      it("kills background commands during cleanup", async () => {
        const result = await execute(`sleep 60 &`);
        const pid = result.details!.background!.pid;

        expect(isPidAlive(pid)).toBe(true);
        await cleanupBackgroundProcesses(backgroundState, 100);
        expect(isPidAlive(pid)).toBe(false);
      }, 10_000);
    });
  });
}

/**
 * bash also shadows a pi built-in, so disabling this extension should stop at
 * the wrapper boundary and reveal pi's native bash tool. sub-agents still ask
 * for the name `bash`; preserving that name avoids breaking tool selection
 * while letting config opt out of the stricter command policy here.
 */
function createBashExtension(
  deps: BashExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return function bashExtension(pi: ExtensionAPI): void {
    const { enabled, config: cfg } = deps.getEnabledExtensionConfig(
      "@bds_pi/bash",
      CONFIG_DEFAULTS,
      { schema: BASH_CONFIG_SCHEMA },
    );
    if (!enabled) return;

    const backgroundState = createBackgroundState();

    pi.registerTool(deps.withPromptPatch(createBashTool(backgroundState, cfg)));
    pi.on("tool_result", async (event) => {
      if (
        event.toolName.toLowerCase() === "bash" &&
        hasFailedProcess(event.details)
      ) {
        return { isError: true };
      }
    });
    pi.on("session_shutdown", async () => {
      await cleanupBackgroundProcesses(backgroundState, cfg.sigkillDelayMs);
    });
    pi.on("session_start", async (event) => {
      if (
        event.reason === "new" ||
        event.reason === "resume" ||
        event.reason === "fork"
      ) {
        await cleanupBackgroundProcesses(backgroundState, cfg.sigkillDelayMs);
      }
    });
  };
}

const bashExtension: (pi: ExtensionAPI) => void = createBashExtension();

export default bashExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tmpdir = os.tmpdir();

  function writeTmpJson(dir: string, filename: string, data: unknown): string {
    const filePath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  function createMockExtensionApiHarness() {
    const tools: unknown[] = [];
    const handlers: Array<{ event: string; handler: unknown }> = [];

    const pi = {
      registerTool(tool: unknown) {
        tools.push(tool);
      },
      on(event: string, handler: unknown) {
        handlers.push({ event, handler });
      },
    } as unknown as ExtensionAPI;

    return { pi, tools, handlers };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(path.join(tmpdir, `nonexistent-${Date.now()}.json`));
  });

  describe("bash extension", () => {
    it("registers the tool with default config when enabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createBashExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(getEnabledExtensionConfigSpy).toHaveBeenCalledWith(
        "@bds_pi/bash",
        CONFIG_DEFAULTS,
        { schema: BASH_CONFIG_SCHEMA },
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "bash" });
      expect(harness.handlers).toHaveLength(3);
      expect(harness.handlers.map((handler) => handler.event)).toEqual([
        "tool_result",
        "session_shutdown",
        "session_start",
      ]);
    });

    it("marks structured process failures as tool errors", async () => {
      const extension = createBashExtension({
        getEnabledExtensionConfig: (<T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: true,
          config: defaults,
        })) as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch: ((tool: ToolDefinition) =>
          tool) as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();
      extension(harness.pi);
      const handler = harness.handlers.find(
        ({ event }) => event === "tool_result",
      )?.handler as (event: any) => Promise<unknown>;

      await expect(
        handler({
          toolName: "bash",
          details: { process: { status: "failed" } },
        }),
      ).resolves.toEqual({ isError: true });
      await expect(
        handler({
          toolName: "bash",
          details: { process: { status: "completed" } },
        }),
      ).resolves.toBeUndefined();
      await expect(
        handler({
          toolName: "read",
          details: { process: { status: "failed" } },
        }),
      ).resolves.toBeUndefined();
    });

    it("registers no extension tool when disabled", () => {
      const getEnabledExtensionConfigSpy = vi.fn(
        <T extends Record<string, unknown>>(
          _namespace: string,
          defaults: T,
        ) => ({
          enabled: false,
          config: defaults,
        }),
      );
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createBashExtension({
        getEnabledExtensionConfig:
          getEnabledExtensionConfigSpy as typeof DEFAULT_DEPS.getEnabledExtensionConfig,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(withPromptPatchSpy).not.toHaveBeenCalled();
      expect(harness.tools).toHaveLength(0);
      expect(harness.handlers).toHaveLength(0);
    });

    it("falls back to defaults for invalid config and still registers", () => {
      const dir = fs.mkdtempSync(path.join(tmpdir, "pi-bash-test-"));
      const settingsPath = writeTmpJson(dir, "settings.json", {
        "@bds_pi/bash": {
          headLines: 0,
          tailLines: 0,
          sigkillDelayMs: -1,
        },
      });
      setGlobalSettingsPath(settingsPath);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const withPromptPatchSpy = vi.fn((tool: ToolDefinition) => tool);
      const extension = createBashExtension({
        ...DEFAULT_DEPS,
        withPromptPatch:
          withPromptPatchSpy as typeof DEFAULT_DEPS.withPromptPatch,
      });
      const harness = createMockExtensionApiHarness();

      extension(harness.pi);

      expect(errorSpy).toHaveBeenCalledWith(
        "[@bds_pi/config] invalid config for @bds_pi/bash; falling back to defaults.",
      );
      expect(withPromptPatchSpy).toHaveBeenCalledTimes(1);
      expect(harness.tools).toHaveLength(1);
      expect(harness.tools[0]).toMatchObject({ name: "bash" });
      expect(harness.handlers).toHaveLength(3);
    });
  });
}
