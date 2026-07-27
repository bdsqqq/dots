import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { lock } from "proper-lockfile";

type SessionStatus = "working" | "done" | "error";

type SessionRecord = {
  id: string;
  pid: number;
  cwd: string;
  name: string;
  status: SessionStatus;
  updatedAt: number;
};

type ActivityView = {
  title: string;
  status: string;
  detail: string;
};

type PublisherState = {
  active: boolean;
  hash: string;
  publishedAt: number;
  startedAt: number;
  retryAt: number;
};

type HarkResult = Record<string, unknown>;

const ACTIVITY_KEY = "pi-sessions-v1";
const HEARTBEAT_MS = 15_000;
const STALE_RECORD_MS = 60_000;
const REFRESH_MS = 3 * 60 * 60 * 1_000;
const RESTART_MS = 7 * 60 * 60 * 1_000;
const RETRY_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EMPTY_PUBLISHER: PublisherState = {
  active: false,
  hash: "",
  publishedAt: 0,
  startedAt: 0,
  retryAt: 0,
};

function stateRoot(): string {
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "pi-hark",
  );
}

function truncate(value: string, limit: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(normalized);
  return chars.length <= limit
    ? normalized
    : `${chars.slice(0, limit - 1).join("")}…`;
}

function statusIcon(status: SessionStatus): string {
  if (status === "working") return "●";
  if (status === "error") return "!";
  return "✓";
}

export function renderActivity(records: SessionRecord[]): ActivityView {
  const ordered = [...records].sort((a, b) => {
    const rank = { error: 0, working: 1, done: 2 } satisfies Record<
      SessionStatus,
      number
    >;
    return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
  });
  const counts = {
    working: ordered.filter((record) => record.status === "working").length,
    done: ordered.filter((record) => record.status === "done").length,
    error: ordered.filter((record) => record.status === "error").length,
  };
  const status = (["working", "done", "error"] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");

  const items = ordered.map(
    (record) => `${statusIcon(record.status)} ${truncate(record.name, 48)}`,
  );
  const visible: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const remaining = items.length - index - 1;
    const suffix = remaining > 0 ? ` · +${remaining} more` : "";
    if (
      Array.from([...visible, items[index]!].join(" · ") + suffix).length > 240
    )
      break;
    visible.push(items[index]!);
  }
  const hidden = items.length - visible.length;
  const detail = `${visible.join(" · ")}${hidden > 0 ? `${visible.length ? " · " : ""}+${hidden} more` : ""}`;

  return {
    title: "pi sessions",
    status,
    detail,
  };
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.cwd === "string" &&
    typeof record.name === "string" &&
    (record.status === "working" ||
      record.status === "done" ||
      record.status === "error") &&
    typeof record.updatedAt === "number"
  );
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[@bds_pi/hark] failed to read ${path}:`, error);
    }
    return fallback;
  }
}

async function runHark(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ data: HarkResult; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("harkctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const exitCode = code ?? 1;
      let data: HarkResult = {};
      try {
        data = stdout.trim() ? (JSON.parse(stdout) as HarkResult) : {};
      } catch {
        reject(
          new Error(`harkctl returned invalid JSON: ${stdout.slice(0, 500)}`),
        );
        return;
      }
      if (![0, 4, 5, 7].includes(exitCode)) {
        reject(
          new Error(
            `harkctl exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 1_000)}`,
          ),
        );
        return;
      }
      resolve({ data, code: exitCode, stderr });
    });
  });
}

async function listCurrentRecords(directory: string): Promise<SessionRecord[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const records: SessionRecord[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const record = await readJson<unknown>(path, null);
    if (!isSessionRecord(record) || now - record.updatedAt > STALE_RECORD_MS) {
      await unlink(path).catch(() => {});
      continue;
    }
    records.push(record);
  }
  return records;
}

function activityHash(view: ActivityView): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex");
}

function requireAccepted(
  result: Awaited<ReturnType<typeof runHark>>,
  operation: string,
): void {
  if (result.code === 7) {
    throw new Error(`No Hark device accepted the ${operation}.`);
  }
}

async function startActivity(
  view: ActivityView,
  idempotencyKey: string,
): Promise<void> {
  const result = await runHark([
    "activity",
    "start",
    "--key",
    ACTIVITY_KEY,
    "--replace",
    "--style",
    "terminal",
    "--title",
    view.title,
    "--status",
    view.status,
    "--detail",
    view.detail,
    "--privacy",
    "private",
    "--idempotency-key",
    idempotencyKey,
  ]);
  requireAccepted(result, "Live Activity start");
}

async function updateActivity(
  view: ActivityView,
  idempotencyKey: string,
): Promise<void> {
  const result = await runHark([
    "activity",
    "update",
    ACTIVITY_KEY,
    "--status",
    view.status,
    "--detail",
    view.detail,
    "--idempotency-key",
    idempotencyKey,
  ]);
  requireAccepted(result, "Live Activity update");
}

class SessionActivity {
  private readonly root = stateRoot();
  private readonly recordsDirectory = join(this.root, "sessions");
  private readonly publisherPath = join(this.root, "publisher.json");
  private readonly lockTarget = join(this.root, "publisher");
  private recordPath = "";
  private record: SessionRecord | null = null;
  private heartbeat: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();
  private lastError = "";

  constructor(private readonly pi: ExtensionAPI) {}

  async start(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    this.recordPath = join(
      this.recordsDirectory,
      `${process.pid}-${sessionId}.json`,
    );
    this.record = {
      id: sessionId,
      pid: process.pid,
      cwd: ctx.cwd,
      name: this.sessionName(ctx),
      status: ctx.isIdle() ? "done" : "working",
      updatedAt: Date.now(),
    };
    await this.publishRecord();
    this.heartbeat = setInterval(() => {
      void this.update();
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private sessionName(ctx: ExtensionContext): string {
    return truncate(
      this.pi.getSessionName() ??
        basename(ctx.cwd) ??
        ctx.sessionManager.getSessionId(),
      80,
    );
  }

  update(
    patch?: Partial<Pick<SessionRecord, "name" | "status">>,
  ): Promise<void> {
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        if (!this.record) return;
        this.record = { ...this.record, ...patch, updatedAt: Date.now() };
        await this.publishRecord();
      });
    return this.writes;
  }

  private async publishRecord(): Promise<void> {
    if (!this.record) return;
    await atomicJson(this.recordPath, this.record);
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const handle = await open(this.lockTarget, "a", 0o600);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(this.lockTarget, {
        realpath: false,
        retries: 0,
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      await handle.close();
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
      throw error;
    }

    try {
      const records = await listCurrentRecords(this.recordsDirectory);
      const publisher = await readJson(this.publisherPath, EMPTY_PUBLISHER);
      const now = Date.now();
      if (publisher.retryAt > now) return;

      if (records.length === 0) {
        if (publisher.active) {
          await runHark([
            "activity",
            "end",
            ACTIVITY_KEY,
            "--status",
            "No running sessions",
          ]);
        }
        await atomicJson(this.publisherPath, EMPTY_PUBLISHER);
        return;
      }

      const view = renderActivity(records);
      const hash = activityHash(view);
      const unchanged =
        publisher.active &&
        publisher.hash === hash &&
        now - publisher.publishedAt < REFRESH_MS;
      if (unchanged) return;

      const restart =
        !publisher.active || now - publisher.startedAt >= RESTART_MS;
      const operationKey = `pi-activity-${restart ? "start" : "update"}-${hash.slice(0, 32)}-${now}`;
      if (restart) {
        await startActivity(view, operationKey);
      } else {
        await updateActivity(view, operationKey);
      }
      await atomicJson(this.publisherPath, {
        active: true,
        hash,
        publishedAt: now,
        startedAt: restart ? now : publisher.startedAt,
        retryAt: 0,
      } satisfies PublisherState);
      this.lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const publisher = await readJson(this.publisherPath, EMPTY_PUBLISHER);
      const remoteIsInactive =
        /no hark device accepted|not found|unknown activity|already terminal|expired|\b404\b/i.test(
          message,
        );
      await atomicJson(this.publisherPath, {
        ...publisher,
        ...(remoteIsInactive ? { active: false, hash: "" } : {}),
        retryAt: Date.now() + (remoteIsInactive ? HEARTBEAT_MS : RETRY_MS),
      });
      if (message !== this.lastError) {
        console.error(`[@bds_pi/hark] ${message}`);
        this.lastError = message;
      }
    } finally {
      await release();
      await handle.close();
    }
  }

  async rename(ctx: ExtensionContext): Promise<void> {
    await this.update({ name: this.sessionName(ctx) });
  }

  async shutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      await this.writes;
    } finally {
      this.record = null;
      await unlink(this.recordPath).catch(() => {});
      await this.reconcile();
    }
  }
}

const notifySchema = Type.Object({
  body: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "Notification message",
  }),
  title: Type.Optional(
    Type.String({ minLength: 1, maxLength: 80, description: "Sender name" }),
  ),
  response: Type.Optional(
    StringEnum(["none", "approval", "yes_no", "text"] as const, {
      description: "Response requested from the phone",
    }),
  ),
  actions: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 50 }), {
      minItems: 2,
      maxItems: 8,
      description:
        "Numbered choices shown in a text-response prompt; Hark does not support custom action buttons",
    }),
  ),
  expiresInSeconds: Type.Optional(
    Type.Integer({ minimum: 30, maximum: 86_400 }),
  ),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
});

export default function harkExtension(pi: ExtensionAPI): void {
  let activity: SessionActivity | null = null;
  let runHadError = false;

  pi.on("session_start", async (_event, ctx) => {
    activity = new SessionActivity(pi);
    await activity.start(ctx);
  });

  pi.on("agent_start", async () => {
    runHadError = false;
    await activity?.update({ status: "working" });
  });

  pi.on("tool_execution_end", async (event) => {
    if (!event.isError) return;
    runHadError = true;
    await activity?.update({ status: "error" });
  });

  pi.on("agent_end", async (event) => {
    if (
      event.messages.some(
        (message) =>
          message.role === "assistant" &&
          (message.stopReason === "error" || message.stopReason === "aborted"),
      )
    ) {
      runHadError = true;
      await activity?.update({ status: "error" });
    }
  });

  pi.on("agent_settled", async () => {
    await activity?.update({ status: runHadError ? "error" : "done" });
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    await activity?.rename(ctx);
  });

  pi.on("session_shutdown", async () => {
    await activity?.shutdown();
    activity = null;
  });

  pi.registerTool({
    name: "hark_notify",
    label: "Hark Notify",
    description:
      "Send an iPhone notification through Hark. Can wait for approval, yes/no, text, or a numbered text choice. Hark Pro is required for responses.",
    promptSnippet:
      "Send an iPhone notification and optionally wait for a response",
    parameters: notifySchema,
    renderCall(args, theme) {
      const asks =
        args.actions?.length ||
        (args.response !== undefined && args.response !== "none");
      const preview = truncate(args.body || "", 72);
      return new Text(
        theme.fg("toolTitle", theme.bold("hark ")) +
          theme.fg("dim", `${asks ? "ask" : "notify"} “${preview || "…"}”`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | (HarkResult & { selectedAction?: string })
        | undefined;
      const interaction =
        details?.interaction && typeof details.interaction === "object"
          ? (details.interaction as Record<string, unknown>)
          : null;
      const status =
        details?.timedOut === true
          ? "pending"
          : typeof interaction?.status === "string"
            ? interaction.status
            : "sent";
      const response =
        details?.selectedAction ??
        (typeof interaction?.response === "string"
          ? interaction.response
          : undefined);
      const color =
        status === "denied" || status === "no"
          ? "warning"
          : status === "pending"
            ? "muted"
            : "success";
      let text = theme.fg(
        color,
        `${status}${response ? ` · ${truncate(response, 72)}` : ""}`,
      );
      if (expanded && typeof interaction?.id === "string") {
        text += theme.fg("dim", `\n${interaction.id}`);
      }
      return new Text(text, 0, 0);
    },
    async execute(toolCallId, params, signal) {
      const response = params.actions?.length
        ? "text"
        : (params.response ?? "none");
      const timeoutSeconds =
        params.timeoutSeconds ?? params.expiresInSeconds ?? 900;
      const prompt = params.actions?.length
        ? `${params.body}\n\nReply with a number or action:\n${params.actions
            .map((action, index) => `${index + 1}. ${action}`)
            .join("\n")}`
        : params.body;
      const args =
        response === "none"
          ? ["notify"]
          : [
              "notify",
              "ask",
              response === "approval"
                ? "--approval"
                : response === "yes_no"
                  ? "--yes-no"
                  : "--text",
              "--expires-in",
              `${params.expiresInSeconds ?? 900}s`,
              "--wait",
              "--timeout",
              `${timeoutSeconds}s`,
            ];
      if (params.title) args.push("--title", params.title);
      args.push(
        "--idempotency-key",
        `pi-${toolCallId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160)}`,
      );
      args.push("--", prompt);

      const result = await runHark(
        args,
        signal,
        response === "none" ? COMMAND_TIMEOUT_MS : (timeoutSeconds + 5) * 1_000,
      );
      if (result.code === 7) {
        throw new Error("No Hark device accepted the notification.");
      }
      const interaction =
        result.data.interaction && typeof result.data.interaction === "object"
          ? (result.data.interaction as Record<string, unknown>)
          : null;
      const rawResponse = interaction?.response;
      let selectedAction: string | undefined;
      if (params.actions && typeof rawResponse === "string") {
        const normalizedResponse = rawResponse.trim();
        const numeric = /^\d+$/.test(normalizedResponse)
          ? Number.parseInt(normalizedResponse, 10)
          : Number.NaN;
        selectedAction =
          (Number.isInteger(numeric)
            ? params.actions[numeric - 1]
            : undefined) ??
          params.actions.find(
            (action) =>
              action.toLowerCase() === rawResponse.trim().toLowerCase(),
          );
      }
      const details = {
        ...result.data,
        ...(selectedAction ? { selectedAction } : {}),
      };
      const timedOut = result.data.timedOut === true;
      return {
        content: [
          {
            type: "text",
            text: interaction
              ? `Hark response: ${timedOut ? "pending" : String(interaction.status)}${
                  selectedAction
                    ? ` (${selectedAction})`
                    : typeof rawResponse === "string" && rawResponse
                      ? ` (${rawResponse})`
                      : ""
                }`
              : `Hark notification sent${
                  result.code === 7 ? " (no device accepted it)" : ""
                }.`,
          },
        ],
        details,
      };
    },
  });
}

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  const record = (name: string, status: SessionStatus): SessionRecord => ({
    id: name,
    pid: 1,
    cwd: "/tmp",
    name,
    status,
    updatedAt: 1,
  });

  describe("renderActivity", () => {
    test("summarizes and orders statuses", () => {
      expect(
        renderActivity([
          record("docs", "done"),
          record("build", "working"),
          record("deploy", "error"),
        ]),
      ).toEqual({
        title: "pi sessions",
        status: "1 working · 1 done · 1 error",
        detail: "! deploy · ● build · ✓ docs",
      });
    });

    test("bounds activity detail", () => {
      const view = renderActivity(
        Array.from({ length: 20 }, (_, index) =>
          record(`session-${index}-${"x".repeat(60)}`, "working"),
        ),
      );
      expect(Array.from(view.detail).length).toBeLessThanOrEqual(240);
      expect(view.detail).toMatch(/\+\d+ more$/);
    });
  });
}
