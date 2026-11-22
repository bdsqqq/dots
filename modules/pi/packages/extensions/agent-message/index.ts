/**
 * lets pi agents message each other's sessions. like T3's thread send, the
 * message joins the target conversation as an ordinary message, attributed to
 * the sending session instead of the user: an idle target starts a turn, a
 * busy one reads it at its next step, a closed one receives it when resumed.
 *
 * sessions live in unrelated processes or aren't running at all, so the
 * transport is a mailbox directory per target session. a message file stays
 * there until its id is in the target's transcript.
 *
 * mail never enters pi's steering queue: escape, "edit queued messages", RPC
 * aborts, and reloads each treat that queue differently, and an extension
 * can't see what they kept. a busy session gets mail written into its
 * transcript at the next turn end instead, with one continuation.
 *
 * when mail is shown, starts a turn, or waits is decided in ./delivery.ts,
 * whose inline model checker replays the races earlier versions shipped.
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
  type ToolDefinition,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { type TObject, type TString, Type } from "typebox";
import { Check } from "typebox/value";
import {
  getEnabledExtensionConfig,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import { resolveNativeSessionRoot } from "@bds_pi/sessions";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  agentSettled,
  agentStarted,
  closedDelivery,
  sessionStarted,
  starterMayRun,
  turnEnded,
  windowEnded,
  woke,
  type Delivery,
  type DeliveryState,
  type ReadMailbox,
} from "./delivery";

const CUSTOM_TYPE = "agent-message";
const MAX_TEXT_CHARS = 64 * 1024;
/** fs.watch can miss events or be unavailable; polling bounds the delay. */
const POLL_MS = 30_000;
/** pi exposes no "host submitted its startup prompt" signal; this outlasts it. */
const STARTUP_GRACE_MS = 5_000;
/** pi exposes no "settle handlers finished" signal; this outlasts them. */
const STOP_WINDOW_MS = 60_000;

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
  startupGraceMs: number = STARTUP_GRACE_MS,
  stopWindowMs: number = STOP_WINDOW_MS,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const resolved = config ?? loadConfig();
    if (!resolved) return;
    const { queueDir } = resolved;
    pi.registerTool(withPromptPatch(createAgentMessageTool(resolved)));

    let sessionId: string | undefined;
    let transcript: () => readonly unknown[] = () => [];
    let isIdle = () => false;
    let watcher: fs.FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    let window: NodeJS.Timeout | undefined;
    let state: DeliveryState = closedDelivery;

    /** removes acknowledged and malformed files. */
    const readMailbox: ReadMailbox<AgentMessage> = () => {
      if (!sessionId) return { unacked: [], persisted: new Set() };
      const dir = mailboxDir(queueDir, sessionId);
      const persisted = deliveredIds(transcript());
      const unacked: AgentMessage[] = [];
      const names = fs
        .readdirSync(dir)
        .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
        .sort();
      for (const name of names) {
        const file = path.join(dir, name);
        const id = name.slice(name.indexOf("_") + 1, -".json".length);
        if (persisted.has(id)) {
          fs.rmSync(file, { force: true });
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
        unacked.push(message);
      }
      return { unacked, persisted };
    };

    const apply = (delivery: Delivery<AgentMessage>) => {
      state = delivery.state;
      if (delivery.error)
        console.error(
          "[@bds_pi/agent-message] delivery failed:",
          delivery.error,
        );
      try {
        // appending while idle persists immediately.
        for (const message of delivery.append)
          pi.sendMessage(asCustomMessage(message), { triggerTurn: false });
        if (delivery.start)
          pi.sendMessage(asCustomMessage(delivery.start), {
            triggerTurn: true,
          });
      } catch (error) {
        console.error("[@bds_pi/agent-message] delivery failed:", error);
      }
    };

    const wake = () => apply(woke(state, isIdle(), readMailbox));

    const openAfter = (ms: number) => {
      clearTimeout(window);
      window = setTimeout(
        () => apply(windowEnded(state, isIdle(), readMailbox)),
        ms,
      );
      window.unref();
    };

    const stop = () => {
      watcher?.close();
      watcher = undefined;
      clearInterval(poll);
      poll = undefined;
      clearTimeout(window);
      sessionId = undefined;
      transcript = () => [];
      isIdle = () => false;
      state = closedDelivery;
    };

    pi.on("session_start", (_event, ctx) => {
      stop();
      sessionId = ctx.sessionManager.getSessionId();
      transcript = () => ctx.sessionManager.getEntries();
      isIdle = () => ctx.isIdle();
      const dir = mailboxDir(queueDir, sessionId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        watcher = fs.watch(dir, wake);
        watcher.on("error", (error) =>
          console.error("[@bds_pi/agent-message] watcher failed:", error),
        );
      } catch (error) {
        console.error("[@bds_pi/agent-message] watcher unavailable:", error);
      }
      poll = setInterval(wake, POLL_MS);
      poll.unref();
      apply(sessionStarted(isIdle(), readMailbox));
      openAfter(startupGraceMs);
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (
        event.messageType === "custom" &&
        event.message.customType === CUSTOM_TYPE &&
        !starterMayRun(state)
      )
        ctx.abort();
    });

    pi.on("agent_start", () => {
      clearTimeout(window);
      state = agentStarted(state);
    });

    pi.on("turn_end", (event: TurnEndEvent) => {
      const delivery = turnEnded(
        state,
        event.outcome === "completed",
        readMailbox,
      );
      state = delivery.state;
      if (delivery.error)
        console.error(
          "[@bds_pi/agent-message] delivery failed:",
          delivery.error,
        );
      if (delivery.append.length === 0) return;
      return {
        entries: [
          ...event.entries,
          ...delivery.append.map((message) => ({
            type: "custom_message" as const,
            ...asCustomMessage(message),
          })),
        ],
        continue: true,
      };
    });

    pi.on("agent_settled", (event) => {
      clearTimeout(window);
      apply(agentSettled(state, event.aborted, isIdle(), readMailbox));
      if (state.phase === "stopped") openAfter(stopWindowMs);
    });

    pi.on("session_shutdown", stop);
  };
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
  const {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
    InMemoryCredentialStore,
  } = await import("@earendil-works/pi-ai");

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
    startupGraceMs = 0,
    before: ((pi: ExtensionAPI) => void)[] = [],
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
      extensionFactories: [
        ...before,
        createAgentMessageExtension(config, startupGraceMs),
        ...extensions,
      ],
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
    await session.bindExtensions({});
    // let a zero grace elapse; longer ones are what the test is about.
    await new Promise((resolve) => setTimeout(resolve, 10));
    /** the runtime emits shutdown before disposing; watchers must not outlive it. */
    const close = async () => {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    };
    const agentEntries = () =>
      manager
        .getEntries()
        .flatMap((e) =>
          e.type === "custom_message" && e.customType === CUSTOM_TYPE
            ? [(e.details as AgentMessage).text]
            : [],
        );
    return { session, faux, close, agentEntries };
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
      const { session, faux, close } = await receiver(root, target, config);
      const seen: string[] = [];
      faux.setResponses([
        (context) => {
          seen.push(lastUserText(context));
          return fauxAssistantMessage("on it");
        },
      ]);
      try {
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
        await close();
      }
    });

    it("reaches a busy session at its next step, without pi's queue", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux, close, agentEntries } = await receiver(
        root,
        target,
        config,
      );
      const seen: string[] = [];
      faux.setResponses([
        async () => {
          post(config, target.getSessionId(), "also check the tests");
          // the watcher fires while busy; mail must wait for the boundary.
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(session.agent.hasQueuedMessages()).toBe(false);
          return fauxAssistantMessage(fauxToolCall("missing_tool", {}), {
            stopReason: "toolUse",
          });
        },
        (context) => {
          // the tool turn ended mid-run: mail is already in context.
          seen.push(lastUserText(context));
          return fauxAssistantMessage("checked");
        },
        () => fauxAssistantMessage("extra"),
      ]);
      try {
        await session.prompt("start");
        await session.waitForIdle();
        expect(seen).toEqual([
          "message from pi session sender:\n\nalso check the tests",
        ]);
        expect(agentEntries()).toEqual(["also check the tests"]);
        expect(faux.state.callCount).toBe(2);
      } finally {
        await close();
      }
    });

    it("answers mail that arrived during a failed turn", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux, close } = await receiver(root, target, config);
      const seen: string[] = [];
      faux.setResponses([
        async () => {
          post(config, target.getSessionId(), "are you there?");
          await new Promise((resolve) => setTimeout(resolve, 100));
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "provider down",
          });
        },
        (context) => {
          seen.push(lastUserText(context));
          return fauxAssistantMessage("yes");
        },
      ]);
      try {
        await session.prompt("start");
        await eventually(() => expect(seen).toHaveLength(1));
        await session.waitForIdle();
        expect(seen).toEqual([
          "message from pi session sender:\n\nare you there?",
        ]);
      } finally {
        await close();
      }
    });

    it.each([
      ["escape clears pi's queue", "escape"],
      ["an rpc abort", "rpc"],
      ["an rpc abort and a reload", "reload"],
      ["edit-queued clears pi's queue without aborting", "edit"],
    ] as const)(
      "delivers each message exactly once after %s",
      async (_case, action) => {
        const root = tempRoot();
        const cwd = path.join(root, "work");
        const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
        const target = SessionManager.inMemory(cwd);
        const { session, faux, close, agentEntries } = await receiver(
          root,
          target,
          config,
          [
            // a slow settle handler, like session-name's summary request.
            (pi) =>
              pi.on(
                "agent_settled",
                () => new Promise((r) => setTimeout(r, 50)),
              ),
          ],
        );
        faux.setResponses([
          async () => {
            const now = Date.now();
            post(config, target.getSessionId(), "first", new Date(now));
            post(config, target.getSessionId(), "second", new Date(now + 1));
            await new Promise((resolve) => setTimeout(resolve, 100));
            await session.prompt("queued by the user", {
              streamingBehavior: "steer",
            });
            if (action !== "rpc" && action !== "reload") session.clearQueue();
            if (action !== "edit") void session.abort();
            return fauxAssistantMessage("first turn");
          },
          ...[1, 2, 3, 4].map(() => () => fauxAssistantMessage("ok")),
        ]);
        try {
          await session.prompt("start");
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (action === "reload") await session.reload();
          if (action !== "edit") {
            // the user stopped the run: show the mail, don't act on it.
            expect(agentEntries()).toEqual(["first", "second"]);
            expect(faux.state.callCount).toBe(1);
            await session.prompt("carry on");
          }
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 150));
          await session.waitForIdle();
          expect(agentEntries()).toEqual(["first", "second"]);
          expect(
            fs.readdirSync(mailboxDir(config.queueDir, target.getSessionId())),
          ).toEqual([]);
        } finally {
          await close();
        }
      },
    );

    it("runs mail arriving while idle as one turn", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux, close, agentEntries } = await receiver(
        root,
        target,
        config,
      );
      faux.setResponses([
        () => fauxAssistantMessage("done"),
        () => fauxAssistantMessage("read both"),
        () => fauxAssistantMessage("extra"),
      ]);
      try {
        await session.prompt("start");
        await session.waitForIdle();
        const now = Date.now();
        post(config, target.getSessionId(), "first", new Date(now));
        post(config, target.getSessionId(), "second", new Date(now + 1));
        await eventually(() => expect(agentEntries()).toHaveLength(2));
        await session.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 150));
        await session.waitForIdle();
        expect(agentEntries()).toEqual(["first", "second"]);
        expect(faux.state.callCount).toBe(2);
      } finally {
        await close();
      }
    });

    it("starts a turn for mail held by the startup grace once it ends", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      const { session, faux, close, agentEntries } = await receiver(
        root,
        target,
        config,
        [
          (pi) =>
            pi.on("session_start", () => {
              post(config, target.getSessionId(), "during startup");
            }),
        ],
        300,
      );
      faux.setResponses([() => fauxAssistantMessage("on it")]);
      try {
        await eventually(() => expect(faux.state.callCount).toBe(1));
        await session.waitForIdle();
        expect(agentEntries()).toEqual(["during startup"]);
      } finally {
        await close();
      }
    });

    it.each([
      ["after", false],
      ["before", true],
    ])(
      "starts one run for mail arriving in a settle handler %s ours",
      async (_order, first) => {
        const root = tempRoot();
        const cwd = path.join(root, "work");
        const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
        const target = SessionManager.inMemory(cwd);
        let releaseSettle: (() => void) | undefined;
        let settles = 0;
        // pi defers runs started from settle handlers; mail landing then is
        // sent once from settle and again by the watcher unless tracked.
        const slowSettle = (pi: ExtensionAPI) =>
          pi.on("agent_settled", async () => {
            if (settles++ > 0) return;
            post(config, target.getSessionId(), "mid-settle");
            await new Promise<void>((resolve) => (releaseSettle = resolve));
          });
        const { session, faux, close, agentEntries } = await receiver(
          root,
          target,
          config,
          first ? [] : [slowSettle],
          0,
          first ? [slowSettle] : [],
        );
        faux.setResponses(
          [1, 2, 3, 4].map(() => () => fauxAssistantMessage("ok")),
        );
        try {
          const run = session.prompt("start");
          await eventually(() => expect(releaseSettle).toBeDefined());
          await new Promise((resolve) => setTimeout(resolve, 200));
          releaseSettle!();
          await run;
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 200));
          await session.waitForIdle();
          expect(agentEntries()).toEqual(["mid-settle"]);
        } finally {
          await close();
        }
      },
    );

    it.each([
      ["an earlier", true],
      ["a later", false],
    ])(
      "doesn't undo an abort for mail arriving in %s settle handler",
      async (_order, first) => {
        const root = tempRoot();
        const cwd = path.join(root, "work");
        const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
        const target = SessionManager.inMemory(cwd);
        let settles = 0;
        const slowSettle = (pi: ExtensionAPI) =>
          pi.on("agent_settled", async () => {
            if (settles++ > 0) return;
            post(config, target.getSessionId(), "while stopping");
            await new Promise((resolve) => setTimeout(resolve, 300));
          });
        const { session, faux, close, agentEntries } = await receiver(
          root,
          target,
          config,
          first ? [] : [slowSettle],
          0,
          first ? [slowSettle] : [],
        );
        faux.setResponses([
          () => {
            void session.abort();
            return fauxAssistantMessage("interrupted");
          },
          () => fauxAssistantMessage("should not run"),
        ]);
        try {
          await session.prompt("start");
          await session.waitForIdle();
          await new Promise((resolve) => setTimeout(resolve, 100));
          await session.waitForIdle();
          expect(agentEntries()).toEqual(["while stopping"]);
          expect(faux.state.callCount).toBe(1);
        } finally {
          await close();
        }
      },
    );

    it("doesn't run mail queued behind a prompt the user then stops", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      let session!: Awaited<ReturnType<typeof receiver>>["session"];
      let settles = 0;
      // pi defers both the prompt and our starter, then runs them in order.
      const promptMidSettle = (pi: ExtensionAPI) =>
        pi.on("agent_settled", async () => {
          if (settles++ > 0) return;
          void session.prompt("next");
          post(config, target.getSessionId(), "queued behind next");
        });
      const started = await receiver(root, target, config, [], 0, [
        promptMidSettle,
      ]);
      session = started.session;
      const { faux, close, agentEntries } = started;
      faux.setResponses([
        () => fauxAssistantMessage("done"),
        () => {
          void session.abort();
          return fauxAssistantMessage("stopped");
        },
        () => fauxAssistantMessage("should not run"),
      ]);
      try {
        await session.prompt("start");
        await session.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 150));
        await session.waitForIdle();
        expect(agentEntries()).toEqual(["queued behind next"]);
        expect(faux.state.callCount).toBe(2);
      } finally {
        await close();
      }
    });

    it("hands startup mail to the startup prompt instead of racing it", async () => {
      const root = tempRoot();
      const cwd = path.join(root, "work");
      const config = { queueDir: path.join(root, "queue"), sessionsDirs: [] };
      const target = SessionManager.inMemory(cwd);
      post(config, target.getSessionId(), "while you were away");
      const dir = mailboxDir(config.queueDir, target.getSessionId());
      fs.writeFileSync(path.join(dir, "2026_bad.json"), "{");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const seen: string[][] = [];
      const { session, faux, close } = await receiver(
        root,
        target,
        config,
        [
          // slow startup handlers, like the editor's git status, during and
          // after which more mail arrives.
          (pi) => {
            pi.on("session_start", async () => {
              post(config, target.getSessionId(), "during startup");
              await new Promise((resolve) => setTimeout(resolve, 100));
            });
            pi.on("resources_discover", async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              post(config, target.getSessionId(), "during discovery");
              await new Promise((resolve) => setTimeout(resolve, 100));
            });
          },
        ],
        1_000,
      );
      const userTexts = (context: any) =>
        context.messages
          .filter((m: any) => m.role === "user")
          .map((m: any) => textOf(m));
      faux.setResponses(
        [1, 2].map(() => (context: any) => {
          seen.push(userTexts(context));
          return fauxAssistantMessage("ok");
        }),
      );
      const mail = (text: string) =>
        `message from pi session sender:\n\n${text}`;
      try {
        await session.prompt("startup prompt");
        await session.waitForIdle();
        // backlog is context for the prompt; mid-startup mail waits for the
        // run's next boundary instead of starting a run of its own.
        expect(seen).toEqual([
          [mail("while you were away"), "startup prompt"],
          [
            mail("while you were away"),
            "startup prompt",
            mail("during startup"),
            mail("during discovery"),
          ],
        ]);
        await eventually(() =>
          expect(fs.readdirSync(dir)).toEqual(["2026_bad.json.rejected"]),
        );
      } finally {
        await close();
      }
    });
  });
}
