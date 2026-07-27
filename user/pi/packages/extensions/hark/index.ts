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
import { createActivityState, renderActivityDetail } from "@bds_pi/editor";
import { Type } from "typebox";
import { lock } from "proper-lockfile";

type SessionStatus = "working" | "done" | "error";
export type HarkConnection = "paired" | "disconnected";

type SessionRecord = {
  id: string;
  pid: number;
  cwd: string;
  blocked: boolean;
  enabled: boolean;
  name: string;
  status: SessionStatus;
  activity: string;
  activityAt: number;
  updatedAt: number;
};

type ActivityView = {
  title: string;
  status: string;
  detail: string;
  symbol: "build" | "success" | "warning";
};

type PublisherState = {
  active: boolean;
  connection: HarkConnection;
  generation: number;
  hash: string;
  pendingSignature: string;
  publishedAt: number;
  startedAt: number;
  retryAt: number;
};

type HarkResult = Record<string, unknown>;

const ACTIVITY_KEY = "pi-sessions-v1";
const HEARTBEAT_MS = 15_000;
const STATUS_POLL_MS = 2_000;
const STALE_RECORD_MS = 60_000;
const REFRESH_MS = 3 * 60 * 60 * 1_000;
const RESTART_MS = 7 * 60 * 60 * 1_000;
const RETRY_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EMPTY_PUBLISHER: PublisherState = {
  active: false,
  connection: "disconnected",
  generation: 0,
  hash: "",
  pendingSignature: "",
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

export function renderHarkWidgetStatus(
  connection: HarkConnection,
  waitingForResponse: boolean,
): string {
  if (waitingForResponse)
    return "waiting for live activity response from iph16";
  return connection === "paired"
    ? "live activity paired to iph16"
    : "live activity disconnected from iph16";
}

export function renderActivity(records: SessionRecord[]): ActivityView {
  const ordered = [...records].sort((a, b) => {
    const rank = { working: 0, error: 1, done: 2 } satisfies Record<
      SessionStatus,
      number
    >;
    return (
      rank[a.status] - rank[b.status] ||
      b.activityAt - a.activityAt ||
      a.name.localeCompare(b.name)
    );
  });
  const primary = ordered[0]!;
  const items = ordered.map(
    (record) =>
      `${statusIcon(record.status)} ${truncate(record.name, 42)} — ${truncate(record.activity, 48)}`,
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
    title: truncate(primary.name, 80),
    status: truncate(primary.activity, 60),
    detail,
    symbol: ordered.some((record) => record.status === "error")
      ? "warning"
      : ordered.some((record) => record.status === "working")
        ? "build"
        : "success",
  };
}

function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SessionRecord>;
  const valid =
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.cwd === "string" &&
    typeof record.name === "string" &&
    (record.status === "working" ||
      record.status === "done" ||
      record.status === "error") &&
    typeof record.updatedAt === "number";
  if (!valid) return null;
  return {
    id: record.id!,
    pid: record.pid!,
    cwd: record.cwd!,
    blocked: record.blocked === true,
    enabled: record.enabled === true,
    name: record.name!,
    status: record.status!,
    activity:
      typeof record.activity === "string" ? record.activity : record.status!,
    activityAt:
      typeof record.activityAt === "number"
        ? record.activityAt
        : record.updatedAt!,
    updatedAt: record.updatedAt!,
  };
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
      console.error(`[@bds_pi/live-activity] failed to read ${path}:`, error);
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
    const record = parseSessionRecord(await readJson<unknown>(path, null));
    if (!record || now - record.updatedAt > STALE_RECORD_MS) {
      await unlink(path).catch(() => {});
      continue;
    }
    if (record.enabled) records.push(record);
  }
  return records;
}

function activityHash(view: ActivityView): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex");
}

function activityMutationIdentity(
  publisher: PublisherState,
  operation: "start" | "update",
  hash: string,
): { generation: number; pendingMatches: boolean; signature: string } {
  const signature = `${operation}:${hash}`;
  const pendingMatches = publisher.pendingSignature === signature;
  return {
    generation: pendingMatches
      ? publisher.generation
      : (typeof publisher.generation === "number" ? publisher.generation : 0) +
        1,
    pendingMatches,
    signature,
  };
}

export function isActivityMutationAccepted(exitCode: number): boolean {
  // Hark uses 7 when the server mutation succeeded but APNs accepted no push.
  return exitCode === 0 || exitCode === 7;
}

async function startActivity(
  view: ActivityView,
  idempotencyKey: string,
): Promise<HarkConnection> {
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
    "standard",
    "--symbol",
    view.symbol,
    "--idempotency-key",
    idempotencyKey,
  ]);
  if (!isActivityMutationAccepted(result.code)) {
    throw new Error(
      `Unexpected Live Activity provider exit code: ${result.code}`,
    );
  }
  return result.code === 0 ? "paired" : "disconnected";
}

async function updateActivity(
  view: ActivityView,
  idempotencyKey: string,
): Promise<HarkConnection> {
  const result = await runHark([
    "activity",
    "update",
    ACTIVITY_KEY,
    "--title",
    view.title,
    "--status",
    view.status,
    "--detail",
    view.detail,
    "--privacy",
    "standard",
    "--symbol",
    view.symbol,
    "--idempotency-key",
    idempotencyKey,
  ]);
  if (!isActivityMutationAccepted(result.code)) {
    throw new Error(
      `Unexpected Live Activity provider exit code: ${result.code}`,
    );
  }
  return result.code === 0 ? "paired" : "disconnected";
}

class SessionActivity {
  private readonly root = stateRoot();
  private readonly recordsDirectory = join(this.root, "sessions");
  private readonly publisherPath = join(this.root, "publisher.json");
  private readonly lockTarget = join(this.root, "publisher");
  private recordPath = "";
  private record: SessionRecord | null = null;
  private heartbeat: NodeJS.Timeout | undefined;
  private statusPoll: NodeJS.Timeout | undefined;
  private writes: Promise<void> = Promise.resolve();
  private reconcileRequested = false;
  private forceReconcileRequested = false;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly getActivityText: () => string,
    private readonly onConnection: (connection: HarkConnection) => void,
  ) {}

  async start(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const now = Date.now();
    this.recordPath = join(
      this.recordsDirectory,
      `${process.pid}-${sessionId}.json`,
    );
    const previous = parseSessionRecord(
      await readJson<unknown>(this.recordPath, null),
    );
    this.record = {
      id: sessionId,
      pid: process.pid,
      cwd: ctx.cwd,
      blocked: previous?.blocked === true,
      enabled: previous?.enabled === true,
      name: this.sessionName(ctx),
      status: ctx.isIdle() ? "done" : "working",
      activity: ctx.isIdle() ? "done" : "thinking",
      activityAt: now,
      updatedAt: now,
    };
    if (this.record.enabled) {
      await this.publishRecord();
      this.startHeartbeat();
    } else {
      this.requestReconcile();
    }
  }

  async activate(explicit = false): Promise<boolean> {
    if (!this.record || this.record.enabled) return false;
    if (this.record.blocked && !explicit) return false;
    this.record.blocked = false;
    this.record.enabled = true;
    this.record.updatedAt = Date.now();
    await this.publishRecord();
    this.startHeartbeat();
    return true;
  }

  async deactivate(): Promise<boolean> {
    if (!this.record?.enabled) return false;
    this.record.blocked = true;
    this.record.enabled = false;
    this.record.updatedAt = Date.now();
    this.stopTimers();
    await this.publishRecord();
    return true;
  }

  isEnabled(): boolean {
    return this.record?.enabled === true;
  }

  reconnect(): void {
    if (this.record?.enabled) this.requestReconcile(true);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const patch =
        this.record?.status === "working"
          ? { activity: this.getActivityText() }
          : undefined;
      void this.update(patch, false);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    void this.syncConnection();
    this.statusPoll = setInterval(() => {
      void this.syncConnection();
    }, STATUS_POLL_MS);
    this.statusPoll.unref();
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statusPoll) clearInterval(this.statusPoll);
    this.heartbeat = undefined;
    this.statusPoll = undefined;
  }

  private async syncConnection(): Promise<void> {
    const publisher = await readJson(this.publisherPath, EMPTY_PUBLISHER);
    this.onConnection(
      publisher.connection === "paired" ? "paired" : "disconnected",
    );
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
    patch?: Partial<Pick<SessionRecord, "activity" | "name" | "status">>,
    markActivity = patch !== undefined,
  ): Promise<void> {
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        if (!this.record) return;
        const now = Date.now();
        this.record = {
          ...this.record,
          ...patch,
          ...(markActivity ? { activityAt: now } : {}),
          updatedAt: now,
        };
        if (this.record.enabled) await this.publishRecord();
      });
    return this.writes;
  }

  private async publishRecord(): Promise<void> {
    if (!this.record) return;
    await atomicJson(this.recordPath, this.record);
    this.requestReconcile();
  }

  private requestReconcile(force = false): void {
    this.reconcileRequested = true;
    this.forceReconcileRequested ||= force;
    if (this.reconciling) return;
    this.reconciling = this.drainReconciles().finally(() => {
      this.reconciling = null;
      if (this.reconcileRequested) this.requestReconcile();
    });
  }

  private async drainReconciles(): Promise<void> {
    while (this.reconcileRequested) {
      this.reconcileRequested = false;
      const force = this.forceReconcileRequested;
      this.forceReconcileRequested = false;
      await this.reconcile(force).catch(() => {});
    }
  }

  private async reconcile(force = false): Promise<void> {
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
      if (!force && publisher.retryAt > now) return;

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
        await atomicJson(this.publisherPath, {
          ...EMPTY_PUBLISHER,
          generation:
            typeof publisher.generation === "number" ? publisher.generation : 0,
        });
        return;
      }

      const view = renderActivity(records);
      const hash = activityHash(view);
      const unchanged =
        publisher.active &&
        publisher.connection === "paired" &&
        publisher.hash === hash &&
        now - publisher.publishedAt < REFRESH_MS;
      if (unchanged && !force) return;

      const restart =
        !publisher.active || now - publisher.startedAt >= RESTART_MS || force;
      const operation = restart ? "start" : "update";
      const { generation, pendingMatches, signature } =
        activityMutationIdentity(publisher, operation, hash);
      if (!pendingMatches) {
        await atomicJson(this.publisherPath, {
          ...publisher,
          connection:
            publisher.connection === "paired" ? "paired" : "disconnected",
          generation,
          pendingSignature: signature,
        });
      }
      const operationKey = `pi-activity-${operation}-${generation}`;
      const connection = restart
        ? await startActivity(view, operationKey)
        : await updateActivity(view, operationKey);
      await atomicJson(this.publisherPath, {
        active: true,
        connection,
        generation,
        hash,
        pendingSignature: "",
        publishedAt: now,
        startedAt: restart ? now : publisher.startedAt,
        retryAt: connection === "paired" ? 0 : now + RETRY_MS,
      } satisfies PublisherState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const publisher = await readJson(this.publisherPath, EMPTY_PUBLISHER);
      const remoteIsInactive =
        /not found|unknown activity|already terminal|expired|\b404\b/i.test(
          message,
        );
      await atomicJson(this.publisherPath, {
        ...publisher,
        connection: "disconnected",
        ...(remoteIsInactive ? { active: false, hash: "" } : {}),
        retryAt: Date.now() + (remoteIsInactive ? HEARTBEAT_MS : RETRY_MS),
      });
    } finally {
      await release();
      await handle.close();
    }
  }

  async rename(ctx: ExtensionContext): Promise<void> {
    await this.update({ name: this.sessionName(ctx) });
  }

  async shutdown(preserveRecord = false): Promise<void> {
    this.stopTimers();
    if (preserveRecord) {
      this.record = null;
      void this.writes.catch(() => {});
      return;
    }
    try {
      await this.writes;
    } finally {
      this.record = null;
      await unlink(this.recordPath).catch(() => {});
      this.requestReconcile();
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
        "Numbered choices shown in a text-response prompt; custom action buttons are unavailable",
    }),
  ),
  expiresInSeconds: Type.Optional(
    Type.Integer({ minimum: 30, maximum: 86_400 }),
  ),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
});

export default function harkExtension(pi: ExtensionAPI): void {
  let activity: SessionActivity | null = null;
  let connection: HarkConnection = "disconnected";
  let waitingResponseCount = 0;
  let runHadError = false;
  const editorActivity = createActivityState();
  const currentActivity = (): string =>
    renderActivityDetail(editorActivity) || "thinking";
  const syncEditorIndicator = (): void => {
    const enabled = activity?.isEnabled() === true;
    const text = renderHarkWidgetStatus(connection, waitingResponseCount > 0);
    pi.events.emit(
      enabled ? "editor:set-label" : "editor:remove-label",
      enabled
        ? {
            key: "hark",
            text,
            position: "bottom",
            align: "left",
          }
        : { key: "hark" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    activity = new SessionActivity(pi, currentActivity, (nextConnection) => {
      connection = nextConnection;
      syncEditorIndicator();
    });
    await activity.start(ctx);
    syncEditorIndicator();
  });

  pi.on("agent_start", async () => {
    if (editorActivity.phase === "idle") runHadError = false;
    editorActivity.phase = "thinking";
    editorActivity.turnIndex = 0;
    editorActivity.activeTools.clear();
    editorActivity.startedAt = Date.now();
    await activity?.update({
      status: "working",
      activity: currentActivity(),
    });
  });

  pi.on("turn_start", async (event) => {
    editorActivity.turnIndex = event.turnIndex;
    editorActivity.phase =
      editorActivity.activeTools.size > 0 ? "tool" : "thinking";
    await activity?.update({ activity: currentActivity() });
  });

  pi.on("tool_execution_start", async (event) => {
    editorActivity.phase = "tool";
    editorActivity.activeTools.set(event.toolCallId, event.toolName);
    await activity?.update({ activity: currentActivity() });
  });

  pi.on("tool_execution_end", async (event) => {
    editorActivity.activeTools.delete(event.toolCallId);
    editorActivity.phase =
      editorActivity.activeTools.size > 0 ? "tool" : "thinking";
    if (event.isError) runHadError = true;
    await activity?.update({ activity: currentActivity() });
  });

  pi.on("message_start", async (event) => {
    if ("role" in event.message && event.message.role === "assistant") {
      editorActivity.phase =
        editorActivity.activeTools.size > 0 ? "tool" : "streaming";
      await activity?.update({ activity: currentActivity() });
    }
  });

  pi.on("agent_end", (event) => {
    if (
      event.messages.some(
        (message) =>
          message.role === "assistant" && message.stopReason === "error",
      )
    ) {
      runHadError = true;
    }
  });

  pi.on("agent_settled", async () => {
    editorActivity.phase = "idle";
    editorActivity.activeTools.clear();
    const finalStatus = runHadError ? "error" : "done";
    await activity?.update({
      status: finalStatus,
      activity: finalStatus,
    });
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    await activity?.rename(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    await activity?.shutdown(event.reason === "reload");
    activity = null;
    if (event.reason !== "reload") syncEditorIndicator();
  });

  pi.registerCommand("live-activity", {
    description: "Enable, reconnect, or disable this session's Live Activity",
    getArgumentCompletions: (prefix) => {
      const items = [
        {
          value: "on",
          label: "on",
          description: "Enable this session's Live Activity",
        },
        {
          value: "off",
          label: "off",
          description: "Disable this session's Live Activity",
        },
        {
          value: "reconnect",
          label: "reconnect",
          description: "Force a fresh connection to iph16",
        },
      ];
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off") {
        const disabled = await activity?.deactivate();
        syncEditorIndicator();
        ctx.ui.notify(
          disabled
            ? "Live Activity disabled"
            : "Live Activity already disabled",
          "info",
        );
        return;
      }
      if (action && action !== "on" && action !== "reconnect") {
        ctx.ui.notify("usage: /live-activity [on|off|reconnect]", "warning");
        return;
      }
      const enabled = await activity?.activate(true);
      if (!enabled) activity?.reconnect();
      syncEditorIndicator();
      ctx.ui.notify(
        enabled
          ? "Live Activity enabled"
          : "Live Activity reconnection requested",
        "info",
      );
    },
  });

  pi.registerTool({
    name: "live_activity_notify",
    label: "Live Activity Notify",
    description:
      "Send a notification to iph16. Can wait for approval, yes/no, text, or a numbered text choice.",
    promptSnippet:
      "Send an iPhone notification and optionally wait for a response",
    parameters: notifySchema,
    renderCall(args, theme) {
      const asks =
        args.actions?.length ||
        (args.response !== undefined && args.response !== "none");
      const preview = truncate(args.body || "", 72);
      return new Text(
        theme.fg("toolTitle", theme.bold("live activity ")) +
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
      await activity?.activate();
      syncEditorIndicator();
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

      if (response !== "none") {
        waitingResponseCount++;
        syncEditorIndicator();
      }
      let result: Awaited<ReturnType<typeof runHark>>;
      try {
        result = await runHark(
          args,
          signal,
          response === "none"
            ? COMMAND_TIMEOUT_MS
            : (timeoutSeconds + 5) * 1_000,
        );
      } finally {
        if (response !== "none") {
          waitingResponseCount--;
          syncEditorIndicator();
        }
      }
      if (result.code === 7) {
        throw new Error("iph16 did not accept the notification.");
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
              ? `Live Activity response: ${timedOut ? "pending" : String(interaction.status)}${
                  selectedAction
                    ? ` (${selectedAction})`
                    : typeof rawResponse === "string" && rawResponse
                      ? ` (${rawResponse})`
                      : ""
                }`
              : `Live Activity notification sent${
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

  const record = (
    name: string,
    status: SessionStatus,
    activity: string = status,
  ): SessionRecord => ({
    id: name,
    pid: 1,
    cwd: "/tmp",
    blocked: false,
    enabled: true,
    name,
    status,
    activity,
    activityAt: 1,
    updatedAt: 1,
  });

  describe("renderActivity", () => {
    test("summarizes and orders statuses", () => {
      expect(
        renderActivity([
          record("docs", "done"),
          record("build", "working", "read(index.ts) · 5s"),
          record("deploy", "error"),
        ]),
      ).toEqual({
        title: "build",
        status: "read(index.ts) · 5s",
        detail:
          "● build — read(index.ts) · 5s · ! deploy — error · ✓ docs — done",
        symbol: "warning",
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

    test("keeps records from Pi processes that have not reloaded yet", () => {
      expect(
        parseSessionRecord({
          id: "legacy",
          pid: 1,
          cwd: "/tmp",
          name: "older session",
          status: "working",
          updatedAt: 42,
        }),
      ).toMatchObject({
        blocked: false,
        enabled: false,
        activity: "working",
        activityAt: 42,
      });
    });
  });

  test("treats zero-device delivery as an authoritative activity mutation", () => {
    expect(isActivityMutationAccepted(7)).toBe(true);
    expect(isActivityMutationAccepted(1)).toBe(false);
  });

  test("renders live activity connection and response states", () => {
    expect(renderHarkWidgetStatus("paired", false)).toBe(
      "live activity paired to iph16",
    );
    expect(renderHarkWidgetStatus("disconnected", false)).toBe(
      "live activity disconnected from iph16",
    );
    expect(renderHarkWidgetStatus("paired", true)).toBe(
      "waiting for live activity response from iph16",
    );
  });

  test("reuses mutation generations only for retries", () => {
    const first = activityMutationIdentity(EMPTY_PUBLISHER, "update", "h1");
    expect(first).toMatchObject({ generation: 1, pendingMatches: false });
    expect(
      activityMutationIdentity(
        {
          ...EMPTY_PUBLISHER,
          generation: first.generation,
          pendingSignature: first.signature,
        },
        "update",
        "h1",
      ),
    ).toMatchObject({ generation: 1, pendingMatches: true });
    expect(
      activityMutationIdentity(
        { ...EMPTY_PUBLISHER, generation: 2 },
        "update",
        "h1",
      ),
    ).toMatchObject({ generation: 3, pendingMatches: false });
  });
}
