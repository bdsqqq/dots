/**
 * lets pi agents message each other's sessions. like T3's thread send, the
 * message joins the target conversation as an ordinary message, attributed to
 * the sending session instead of the user: an idle target starts a turn, a
 * busy one receives it at its next step, the same as a steered user message.
 *
 * sessions live in unrelated processes or aren't running at all, so the
 * transport is a mailbox directory per target session. a message file stays
 * there until its id is in the target's transcript, so a closed session
 * receives it on resume, and a crash between persisting and deleting can't
 * deliver it twice. mail found during startup is appended without starting a
 * turn: the person resuming is present, and a run started before startup
 * finishes (`resources_discover`, after every `session_start` handler) would
 * make pi reject their first prompt as busy.
 *
 * escape in the TUI clears pi's queue, dropping our steers with it; an RPC
 * abort keeps them for the next run, even across a reload. so an aborted run
 * re-sends nothing, and the next run that completes, which has drained any
 * kept steers into its transcript, re-sends whatever is still missing as
 * transcript entries plus one continuation. sending from that boundary,
 * rather than after settling, keeps the batch in one turn instead of a run
 * per message. a reload right after an abort treats its mail the same way,
 * since pi's queue may still hold it.
 *
 * there is no cross-process claim: the same session open in two processes may
 * receive a message twice.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TObject, type TString, Type } from "typebox";
import { Check } from "typebox/value";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { resolveNativeSessionRoot } from "@bds_pi/sessions";
import { withPromptPatch } from "@bds_pi/prompt-patch";

const CUSTOM_TYPE = "agent-message";
const MAX_TEXT_CHARS = 64 * 1024;
/** fs.watch can miss events or be unavailable; polling bounds the delay. */
const POLL_MS = 30_000;

export interface AgentMessage {
  id: string;
  from: { sessionId: string; sessionName?: string; workspace: string };
  to: string;
  sentAt: string;
  text: string;
}

const agentMessageSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  from: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    sessionName: Type.Optional(Type.String()),
    workspace: Type.String(),
  }),
  to: Type.String({ minLength: 1 }),
  sentAt: Type.String(),
  text: Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS }),
});

function parseAgentMessage(value: unknown): AgentMessage | undefined {
  return Check(agentMessageSchema, value) ? value : undefined;
}

export type AgentMessageConfig = {
  queueDir: string;
  /** session roots searched for targets; empty means the running session's native root. */
  sessionsDirs: string[];
};

const CONFIG_DEFAULTS: AgentMessageConfig = {
  queueDir: path.join(getAgentDir(), "agent-messages"),
  sessionsDirs: [],
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const CONFIG_SCHEMA: ExtensionConfigSchema<AgentMessageConfig> = {
  validate: (value): value is AgentMessageConfig =>
    nonEmptyString(value.queueDir) &&
    Array.isArray(value.sessionsDirs) &&
    value.sessionsDirs.every(nonEmptyString),
};

const expandPath = (value: string): string =>
  path.resolve(value.replace(/^~(?=$|\/)/u, os.homedir()));

/** the only text the target model sees besides the message itself. */
export function formatAgentMessage(message: AgentMessage): string {
  const name = message.from.sessionName ? ` (${message.from.sessionName})` : "";
  return `message from pi session ${message.from.sessionId}${name}:\n\n${message.text}`;
}

/** imported session headers can carry any id; never let one leave the queue. */
function mailboxDir(queueDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId))
    throw new Error(`unsupported pi session id: ${sessionId}`);
  return path.join(queueDir, sessionId);
}

/** sortable by send time; the id suffix lets receivers skip in-flight files unread. */
const messageFileName = (message: AgentMessage): string =>
  `${message.sentAt.replaceAll(/[^0-9TZ]/gu, "-")}_${message.id}.json`;

export function postAgentMessage(
  queueDir: string,
  message: AgentMessage,
): string {
  const dir = mailboxDir(queueDir, message.to);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, messageFileName(message));
  // receivers ignore dotfiles, so they never read a partial write.
  const temporary = path.join(dir, `.${messageFileName(message)}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(message), {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
  return file;
}

/**
 * matches the header ids history_list reports. filenames usually embed the id
 * but imported and forked sessions keep other names. reading only the first
 * line avoids parsing gigabytes of history to resolve one id.
 */
export function findSessionId(
  roots: readonly string[],
  idOrPrefix: string,
): string {
  const query = idOrPrefix.trim().toLowerCase();
  if (!query) throw new Error("sessionId is required");
  const ids = new Set<string>();
  for (const root of roots)
    for (const file of sessionFiles(root)) {
      const id = headerSessionId(file);
      if (id?.toLowerCase().startsWith(query)) ids.add(id);
    }
  const matches = [...ids].sort();
  const exact = matches.find((id) => id.toLowerCase() === query);
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0)
    throw new Error(`no pi session matches ${idOrPrefix}`);
  throw new Error(
    `ambiguous pi session prefix ${idOrPrefix}: ${matches.join(", ")}`,
  );
}

/** native roots are flat or hold one directory per workspace. */
function sessionFiles(root: string): string[] {
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return list(root).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isFile()) return entry.name.endsWith(".jsonl") ? [file] : [];
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    return list(file)
      .filter((child) => child.isFile() && child.name.endsWith(".jsonl"))
      .map((child) => path.join(file, child.name));
  });
}

function headerSessionId(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .subarray(0, length)
      .toString("utf8")
      .split("\n", 1)[0]!;
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string"
      ? header.id
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const AGENT_MESSAGE_PARAMETERS: TObject<{
  sessionId: TString;
  message: TString;
}> = Type.Object({
  sessionId: Type.String({
    description: "Target pi session id or an unambiguous prefix.",
  }),
  message: Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS }),
});

export function createAgentMessageTool(
  config: AgentMessageConfig,
): ToolDefinition<typeof AGENT_MESSAGE_PARAMETERS, AgentMessage> {
  return {
    name: "agent_message",
    label: "Agent Message",
    description:
      "Send a message to another pi session. It joins that session's conversation attributed to this session: an idle session starts working on it, a busy one reads it at its next step, a closed one receives it when resumed. Use history_list to find session ids.",
    parameters: AGENT_MESSAGE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = params.message.trim();
      if (!text) throw new Error("message is empty");
      const roots = config.sessionsDirs.length
        ? config.sessionsDirs
        : [
            resolveNativeSessionRoot({
              cwd: ctx.cwd,
              sessionManager: ctx.sessionManager,
            }),
          ];
      const to = findSessionId(roots, params.sessionId);
      const sessionId = ctx.sessionManager.getSessionId();
      if (to === sessionId)
        throw new Error("agent_message target is the current session");
      const sessionName = ctx.sessionManager.getSessionName();
      const message: AgentMessage = {
        id: randomUUID(),
        from: {
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          workspace: ctx.cwd,
        },
        to,
        sentAt: new Date().toISOString(),
        text,
      };
      postAgentMessage(config.queueDir, message);
      return {
        content: [{ type: "text", text: `sent message to session ${to}` }],
        details: message,
      };
    },
  };
}

function loadConfig(): AgentMessageConfig | undefined {
  const { enabled, config } = getEnabledExtensionConfig(
    "@bds_pi/agent-message",
    CONFIG_DEFAULTS,
    { schema: CONFIG_SCHEMA },
  );
  if (!enabled) return undefined;
  return {
    queueDir: expandPath(config.queueDir),
    sessionsDirs: [...new Set(config.sessionsDirs.map(expandPath))],
  };
}

/**
 * omit `config` to read `@bds_pi/agent-message` settings, which can disable
 * the extension; a supplied config is used as-is.
 */
export function createAgentMessageExtension(
  config?: AgentMessageConfig,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const resolved = config ?? loadConfig();
    if (!resolved) return;
    const { queueDir } = resolved;
    pi.registerTool(withPromptPatch(createAgentMessageTool(resolved)));

    let sessionId: string | undefined;
    let transcript: () => readonly unknown[] = () => [];
    let watcher: fs.FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    let started = false;
    /** ids handed to pi and not yet in the transcript. */
    const sent = new Set<string>();
    /** what `sent` held when a run was aborted: possibly dropped with the queue. */
    const maybeDropped = new Set<string>();

    /** unacknowledged mail, oldest first; removes acknowledged and malformed files. */
    const pending = (): AgentMessage[] => {
      if (!sessionId) return [];
      const dir = mailboxDir(queueDir, sessionId);
      const persisted = deliveredIds(transcript());
      const messages: AgentMessage[] = [];
      try {
        const names = fs
          .readdirSync(dir)
          .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
          .sort();
        for (const name of names) {
          const file = path.join(dir, name);
          const id = name.slice(name.indexOf("_") + 1, -".json".length);
          if (persisted.has(id)) {
            fs.rmSync(file, { force: true });
            sent.delete(id);
            continue;
          }
          let message: AgentMessage | undefined;
          try {
            message = parseAgentMessage(
              JSON.parse(fs.readFileSync(file, "utf8")),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          }
          if (
            !message ||
            message.to !== sessionId ||
            messageFileName(message) !== name
          ) {
            console.error(`[@bds_pi/agent-message] rejected ${file}`);
            fs.renameSync(file, `${file}.rejected`);
            continue;
          }
          messages.push(message);
        }
      } catch (error) {
        console.error("[@bds_pi/agent-message] mailbox read failed:", error);
      }
      return messages;
    };

    const deliver = () => {
      const triggerTurn = started;
      for (const message of pending()) {
        if (sent.has(message.id)) continue;
        sent.add(message.id);
        pi.sendMessage(asCustomMessage(message), {
          deliverAs: "steer",
          triggerTurn,
        });
      }
    };

    const stop = () => {
      watcher?.close();
      watcher = undefined;
      clearInterval(poll);
      poll = undefined;
      sessionId = undefined;
      started = false;
      transcript = () => [];
      sent.clear();
      maybeDropped.clear();
    };

    pi.on("session_start", (event, ctx) => {
      stop();
      sessionId = ctx.sessionManager.getSessionId();
      transcript = () => ctx.sessionManager.getEntries();
      const dir = mailboxDir(queueDir, sessionId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        watcher = fs.watch(dir, () => deliver());
        watcher.on("error", (error) =>
          console.error("[@bds_pi/agent-message] watcher failed:", error),
        );
      } catch (error) {
        console.error("[@bds_pi/agent-message] watcher unavailable:", error);
      }
      poll = setInterval(() => deliver(), POLL_MS);
      poll.unref();
      if (event.reason === "reload" && lastRunAborted(ctx.sessionManager))
        for (const message of pending()) {
          sent.add(message.id);
          maybeDropped.add(message.id);
        }
      else deliver();
    });

    pi.on("resources_discover", () => {
      started = true;
    });

    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed" || maybeDropped.size === 0) return;
      const dropped = pending().filter((message) =>
        maybeDropped.has(message.id),
      );
      maybeDropped.clear();
      if (dropped.length === 0) return;
      return {
        entries: [
          ...event.entries,
          ...dropped.map((message) => ({
            type: "custom_message" as const,
            ...asCustomMessage(message),
          })),
        ],
        continue: true,
      };
    });

    pi.on("agent_settled", (event) => {
      if (event.aborted) for (const id of sent) maybeDropped.add(id);
      pending(); // removes mail this run acknowledged
    });

    pi.on("session_shutdown", stop);
  };
}

function lastRunAborted(
  sessionManager: ExtensionContext["sessionManager"],
): boolean {
  const last = sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
    .at(-1);
  return (
    last?.type === "message" &&
    last.message.role === "assistant" &&
    last.message.stopReason === "aborted"
  );
}

function asCustomMessage(message: AgentMessage) {
  return {
    customType: CUSTOM_TYPE,
    content: formatAgentMessage(message),
    display: true,
    details: message,
  };
}

function deliveredIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries as {
    type?: unknown;
    customType?: unknown;
    details?: { id?: unknown };
  }[])
    if (
      entry.type === "custom_message" &&
      entry.customType === CUSTOM_TYPE &&
      typeof entry.details?.id === "string"
    )
      ids.add(entry.details.id);
  return ids;
}

const agentMessageExtension: (pi: ExtensionAPI) => void =
  createAgentMessageExtension();

export default agentMessageExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } =
    await import("@earendil-works/pi-ai");

  /** fs events can lag under load; the fallback poll would take 30s. */
  const WATCH_WAIT = { timeout: 5_000 };
  const eventually = (assertion: () => unknown) =>
    vi.waitFor(assertion, WATCH_WAIT);

  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-message-")),
    );
    roots.push(root);
    return root;
  }

  /** a native session file exists once a session has a conversation. */
  function persistedSession(cwd: string, sessionDir?: string) {
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({ role: "user", content: "work", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("ok"));
    if (!fs.existsSync(manager.getSessionFile()!))
      throw new Error("fixture session was not persisted");
    return manager;
  }

  function sendTool(
    config: AgentMessageConfig,
    from: ReturnType<typeof SessionManager.create>,
    sessionId: string,
    message: string,
  ) {
    return createAgentMessageTool(config).execute(
      "call",
      { sessionId, message },
      undefined,
      undefined,
      { cwd: from.getCwd(), sessionManager: from } as never,
    );
  }

  async function receiver(
    root: string,
    manager: ReturnType<typeof SessionManager.create>,
    config: AgentMessageConfig,
    extensions: ((pi: ExtensionAPI) => void)[] = [],
  ) {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: manager.getCwd(),
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createAgentMessageExtension(config), ...extensions],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: manager.getCwd(),
      agentDir: root,
      settingsManager,
      resourceLoader,
      modelRuntime: runtime,
      model: faux.getModel(),
      sessionManager: manager,
    });
    return { session, faux };
  }

  function post(
    config: AgentMessageConfig,
    to: string,
    text: string,
    sentAt = new Date(),
  ) {
    return postAgentMessage(config.queueDir, {
      id: randomUUID(),
      from: { sessionId: "sender", workspace: "/sender" },
      to,
      sentAt: sentAt.toISOString(),
      text,
    });
  }

  const textOf = (message: { content?: unknown }): string =>
    typeof message.content === "string"
      ? message.content
      : (message.content as { text?: string }[])
          .map((part) => part.text ?? "")
          .join("");

  const lastUserText = (context: { messages: readonly any[] }) =>
    textOf(context.messages.filter((m) => m.role === "user").at(-1));

  describe("agent-message", () => {
    it("resolves targets by id or prefix in grouped and flat roots", async () => {
      const root = tempRoot();
      const flat = path.join(root, "flat");
      const grouped = path.join(root, "grouped");
      const cwd = path.join(root, "work");
      const a = persistedSession(cwd, flat);
      const b = persistedSession(cwd, path.join(grouped, "--work--"));
      // ids come from headers, whatever the filename; exact ids beat prefixes.
      for (const id of ["abcd", "abcdef", "abcxyz"])
        fs.writeFileSync(
          path.join(flat, `imported-${id}.jsonl`),
          `${JSON.stringify({ type: "session", id, cwd })}\n`,
        );
      fs.writeFileSync(path.join(flat, "2026_notes.jsonl"), "not json\n");
      fs.writeFileSync(
        path.join(flat, "escape.jsonl"),
        `${JSON.stringify({ type: "session", id: "../escape", cwd })}\n`,
      );
      const roots = [flat, grouped];
      const config = {
        queueDir: path.join(root, "queue"),
        sessionsDirs: roots,
      };

      expect(findSessionId(roots, b.getSessionId())).toBe(b.getSessionId());
      expect(
        findSessionId(roots, b.getSessionId().slice(0, -1).toUpperCase()),
      ).toBe(b.getSessionId());
      expect(findSessionId(roots, "abcd")).toBe("abcd");
      expect(findSessionId(roots, "abcx")).toBe("abcxyz");
      expect(() => findSessionId(roots, "abc")).toThrow("ambiguous");
      expect(() => findSessionId(roots, "")).toThrow("required");
      expect(() => findSessionId(roots, "notes")).toThrow(
        "no pi session matches",
      );
      await expect(sendTool(config, a, "../escape", "hi")).rejects.toThrow(
        "unsupported pi session id",
      );
      expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
      await expect(sendTool(config, a, a.getSessionId(), "hi")).rejects.toThrow(
        "current session",
      );
      await expect(sendTool(config, a, b.getSessionId(), "  ")).rejects.toThrow(
        "empty",
      );
    });

    it("starts a turn in an idle session, attributed to the sender", async () => {
      const root = tempRoot();
      const sessions = path.join(root, "sessions");
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const sender = persistedSession(cwd, sessions);
      sender.appendSessionInfo("planner");
      const target = persistedSession(cwd, sessions);
      const { session, faux } = await receiver(root, target, config);
      const seen: string[] = [];
      faux.setResponses([
        (context) => {
          seen.push(lastUserText(context));
          return fauxAssistantMessage("on it");
        },
      ]);
      try {
        await session.bindExtensions({});
        const sent = await sendTool(
          config,
          sender,
          target.getSessionId(),
          "review the diff",
        );
        await eventually(() => expect(seen).toHaveLength(1));
        await session.waitForIdle();
        expect(seen[0]).toBe(
          `message from pi session ${sender.getSessionId()} (planner):\n\nreview the diff`,
        );
        expect(
          target.getEntries().find((entry) => entry.type === "custom_message"),
        ).toMatchObject({ customType: CUSTOM_TYPE, details: sent.details });
        await eventually(() =>
          expect(
            fs.readdirSync(mailboxDir(config.queueDir, target.getSessionId())),
          ).toEqual([]),
        );
      } finally {
        session.dispose();
      }
    });

    it("reaches a busy session at its next step without waiting for the run", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux } = await receiver(root, target, config);
      const seen: string[] = [];
      let queuedMidRun = false;
      faux.setResponses([
        async () => {
          post(config, target.getSessionId(), "also check the tests");
          // the watcher, not settlement, must deliver it mid-run.
          await vi
            .waitFor(
              () => expect(session.agent.hasQueuedMessages()).toBe(true),
              WATCH_WAIT,
            )
            .then(
              () => (queuedMidRun = true),
              () => {},
            );
          return fauxAssistantMessage("working");
        },
        (context) => {
          seen.push(lastUserText(context));
          return fauxAssistantMessage("checked");
        },
      ]);
      try {
        await session.bindExtensions({});
        await session.prompt("start");
        expect(queuedMidRun).toBe(true);
        expect(seen).toEqual([
          "message from pi session sender:\n\nalso check the tests",
        ]);
      } finally {
        session.dispose();
      }
    });

    it.each([
      ["escape clears pi's queue", true],
      ["an rpc abort keeps it queued", false],
    ])(
      "delivers once after an aborted run when %s",
      async (_case, clearQueue) => {
        const root = tempRoot();
        const cwd = path.join(root, "work");
        const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
        const target = SessionManager.inMemory(cwd);
        const { session, faux } = await receiver(root, target, config);
        const seen: string[] = [];
        faux.setResponses([
          async () => {
            post(config, target.getSessionId(), "ping");
            await eventually(() =>
              expect(session.agent.hasQueuedMessages()).toBe(true),
            );
            if (clearQueue) session.clearQueue();
            void session.abort();
            return fauxAssistantMessage("interrupted");
          },
          (context) => {
            seen.push(lastUserText(context));
            return fauxAssistantMessage("next");
          },
          (context) => {
            seen.push(lastUserText(context));
            return fauxAssistantMessage("pong");
          },
        ]);
        try {
          await session.bindExtensions({});
          await session.prompt("start");
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 50));
          // the aborted run must not restart itself.
          expect(seen).toEqual([]);
          await session.prompt("carry on");
          await eventually(() =>
            expect(
              target.getEntries().filter((e) => e.type === "custom_message"),
            ).toHaveLength(1),
          );
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(
            target.getEntries().filter((e) => e.type === "custom_message"),
          ).toHaveLength(1);
          await eventually(() =>
            expect(
              fs.readdirSync(
                mailboxDir(config.queueDir, target.getSessionId()),
              ),
            ).toEqual([]),
          );
        } finally {
          session.dispose();
        }
      },
    );

    it("re-sends a batch escape dropped as one turn, once each", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux } = await receiver(root, target, config, [
        // a slow settle handler, like session-name's summary request.
        (pi) =>
          pi.on("agent_settled", () => new Promise((r) => setTimeout(r, 50))),
      ]);
      // peekQueuedMessages() shows only the head in one-at-a-time mode.
      const queuedTexts = () =>
        (session.agent as any).steeringQueue.messages.map(
          (m: any) => (m.details as AgentMessage | undefined)?.text,
        );
      faux.setResponses([
        async () => {
          const now = Date.now();
          post(config, target.getSessionId(), "first", new Date(now));
          post(config, target.getSessionId(), "second", new Date(now + 1));
          await eventually(() =>
            expect(queuedTexts()).toEqual(["first", "second"]),
          );
          session.clearQueue();
          void session.abort();
          return fauxAssistantMessage("interrupted");
        },
        ...[1, 2, 3].map(() => () => fauxAssistantMessage("ok")),
      ]);
      const delivered = () =>
        target
          .getEntries()
          .flatMap((e) =>
            e.type === "custom_message"
              ? [(e.details as AgentMessage).text]
              : [],
          );
      try {
        await session.bindExtensions({});
        await session.prompt("start");
        await session.waitForIdle();
        await session.prompt("carry on");
        await session.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 150));
        await session.waitForIdle();
        expect(delivered()).toEqual(["first", "second"]);
        // interrupted, "carry on", then one continuation for both messages.
        expect(faux.state.callCount).toBe(3);
      } finally {
        session.dispose();
      }
    });

    it("keeps a steer an rpc abort left queued across reload", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux } = await receiver(root, target, config);
      faux.setResponses([
        async () => {
          post(config, target.getSessionId(), "ping");
          await eventually(() =>
            expect(session.agent.hasQueuedMessages()).toBe(true),
          );
          void session.abort();
          return fauxAssistantMessage("interrupted");
        },
        () => fauxAssistantMessage("pong"),
      ]);
      const delivered = () =>
        target.getEntries().filter((e) => e.type === "custom_message");
      try {
        await session.bindExtensions({});
        await session.prompt("start");
        await session.waitForIdle();
        await session.reload();
        await session.prompt("carry on");
        await session.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(delivered()).toHaveLength(1);
      } finally {
        session.dispose();
      }
    });

    it("hands resumed mail to the startup prompt instead of racing it", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      post(config, target.getSessionId(), "while you were away");
      const dir = mailboxDir(config.queueDir, target.getSessionId());
      fs.writeFileSync(path.join(dir, "2026_bad.json"), "{");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { session, faux } = await receiver(root, target, config, [
        // a slower startup handler, like the editor's git status, during
        // which more mail arrives.
        (pi) =>
          pi.on("session_start", async () => {
            post(config, target.getSessionId(), "during startup");
            await new Promise((resolve) => setTimeout(resolve, 200));
          }),
      ]);
      const seen: string[][] = [];
      faux.setResponses([
        (context) => {
          seen.push(
            context.messages
              .filter((m: any) => m.role === "user")
              .map((m: any) => textOf(m)),
          );
          return fauxAssistantMessage("ok");
        },
      ]);
      try {
        await session.bindExtensions({});
        await session.prompt("startup prompt");
        await session.waitForIdle();
        expect(seen).toEqual([
          [
            "message from pi session sender:\n\nwhile you were away",
            "message from pi session sender:\n\nduring startup",
            "startup prompt",
          ],
        ]);
        await eventually(() =>
          expect(fs.readdirSync(dir)).toEqual(["2026_bad.json.rejected"]),
        );
      } finally {
        session.dispose();
      }
    });
  });
}
