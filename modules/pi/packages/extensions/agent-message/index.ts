/**
 * lets pi agents message each other's sessions. like T3's thread send, the
 * message joins the target conversation as an ordinary message, attributed to
 * the sending session instead of the user: an idle target starts a turn, a
 * busy one receives it at its next step, the same as a steered user message.
 *
 * sessions live in unrelated processes or aren't running at all, so the
 * transport is a mailbox directory per target session. a message file stays
 * there until pi emits it into the target conversation (`message_end`), which
 * makes a closed session receive it on resume. escape clears pi's steering
 * queue, ours included, so anything undelivered when a run settles is sent
 * again; after an abort it is appended without starting a turn the user just
 * stopped.
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

const mailboxDir = (queueDir: string, sessionId: string): string =>
  path.join(queueDir, sessionId);

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
 * native session files are named `<timestamp>_<sessionId>.jsonl`, in a flat
 * root or one directory per workspace. matching names avoids parsing
 * gigabytes of history to resolve one id.
 */
export function findSessionId(
  roots: readonly string[],
  idOrPrefix: string,
): string {
  const query = idOrPrefix.trim().toLowerCase();
  if (!query) throw new Error("sessionId is required");
  const ids = new Set<string>();
  for (const root of roots)
    for (const name of sessionFileNames(root)) {
      const id = name.slice(name.indexOf("_") + 1, -".jsonl".length);
      if (id.toLowerCase().startsWith(query)) ids.add(id);
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

function sessionFileNames(root: string): string[] {
  const isSessionFile = (name: string) =>
    name.includes("_") && name.endsWith(".jsonl");
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return list(root).flatMap((entry) => {
    if (entry.isFile()) return isSessionFile(entry.name) ? [entry.name] : [];
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    return list(path.join(root, entry.name))
      .filter((child) => child.isFile() && isSessionFile(child.name))
      .map((child) => child.name);
  });
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
    let watcher: fs.FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    /** ids handed to pi that have not reached the conversation yet. */
    const inFlight = new Set<string>();

    const deliver = (triggerTurn = true) => {
      if (!sessionId) return;
      const dir = mailboxDir(queueDir, sessionId);
      try {
        const names = fs
          .readdirSync(dir)
          .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
          .sort();
        for (const name of names) {
          if (inFlight.has(name.slice(name.indexOf("_") + 1, -".json".length)))
            continue;
          const file = path.join(dir, name);
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
          inFlight.add(message.id);
          pi.sendMessage(
            {
              customType: CUSTOM_TYPE,
              content: formatAgentMessage(message),
              display: true,
              details: message,
            },
            { deliverAs: "steer", triggerTurn },
          );
        }
      } catch (error) {
        console.error("[@bds_pi/agent-message] delivery failed:", error);
      }
    };

    const stop = () => {
      watcher?.close();
      watcher = undefined;
      clearInterval(poll);
      poll = undefined;
      sessionId = undefined;
      inFlight.clear();
    };

    pi.on("session_start", (_event, ctx) => {
      stop();
      sessionId = ctx.sessionManager.getSessionId();
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
      deliver();
    });

    pi.on("message_end", (event) => {
      const { message } = event;
      if (message.role !== "custom" || message.customType !== CUSTOM_TYPE)
        return;
      const delivered = parseAgentMessage(message.details);
      if (!delivered) return;
      inFlight.delete(delivered.id);
      fs.rmSync(
        path.join(
          mailboxDir(queueDir, delivered.to),
          messageFileName(delivered),
        ),
        { force: true },
      );
    });

    pi.on("agent_settled", (event) => {
      inFlight.clear();
      deliver(!event.aborted);
    });

    pi.on("session_shutdown", stop);
  };
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
      extensionFactories: [createAgentMessageExtension(config)],
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

  const lastUserText = (context: { messages: readonly any[] }) => {
    const content = context.messages.filter((m) => m.role === "user").at(-1)
      ?.content as string | { type: string; text?: string }[];
    return typeof content === "string"
      ? content
      : content.map((part) => part.text ?? "").join("");
  };

  describe("agent-message", () => {
    it("resolves targets by id or prefix in grouped and flat roots", async () => {
      const root = tempRoot();
      const flat = path.join(root, "flat");
      const grouped = path.join(root, "grouped");
      const cwd = path.join(root, "work");
      const a = persistedSession(cwd, flat);
      const b = persistedSession(cwd, path.join(grouped, "--work--"));
      // names only matter for resolution; prove exact ids beat shared prefixes.
      for (const id of ["abcd", "abcdef", "abcxyz"])
        fs.writeFileSync(
          path.join(flat, `2026-11-21T00-00-00-000Z_${id}.jsonl`),
          "",
        );
      fs.writeFileSync(path.join(flat, "notes.jsonl"), "");
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
      const sent = await sendTool(
        config,
        sender,
        target.getSessionId(),
        "review the diff",
      );
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
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        await session.waitForIdle();
        expect(seen[0]).toBe(
          `message from pi session ${sender.getSessionId()} (planner):\n\nreview the diff`,
        );
        expect(
          target.getEntries().find((entry) => entry.type === "custom_message"),
        ).toMatchObject({ customType: CUSTOM_TYPE, details: sent.details });
        expect(
          fs.readdirSync(mailboxDir(config.queueDir, target.getSessionId())),
        ).toEqual([]);
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
          postAgentMessage(config.queueDir, {
            id: randomUUID(),
            from: { sessionId: "sender", workspace: cwd },
            to: target.getSessionId(),
            sentAt: new Date().toISOString(),
            text: "also check the tests",
          });
          // the watcher, not settlement, must deliver it mid-run.
          await vi
            .waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true))
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

    it("re-sends messages a run dropped, without restarting an aborted run", async () => {
      const root = tempRoot();
      const queueDir = path.join(root, "queue");
      const target = "target-session";
      const message: AgentMessage = {
        id: randomUUID(),
        from: { sessionId: "sender", workspace: root },
        to: target,
        sentAt: "2026-11-21T00:00:00.000Z",
        text: "hello",
      };
      const file = postAgentMessage(queueDir, message);
      fs.writeFileSync(
        path.join(mailboxDir(queueDir, target), "2026_bad.json"),
        "{",
      );
      const handlers = new Map<string, (...args: any[]) => void>();
      const sent: { options: unknown }[] = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
      createAgentMessageExtension({ queueDir, sessionsDirs: [] })({
        registerTool() {},
        on: (event: string, handler: (...args: any[]) => void) =>
          handlers.set(event, handler),
        sendMessage: (_message: unknown, options: unknown) =>
          sent.push({ options }),
      } as unknown as ExtensionAPI);

      handlers.get("session_start")!(
        {},
        {
          sessionManager: { getSessionId: () => target },
        },
      );
      handlers.get("agent_settled")!({ aborted: true });
      handlers.get("message_end")!({
        message: { role: "custom", customType: CUSTOM_TYPE, details: message },
      });
      handlers.get("session_shutdown")!();

      expect(sent.map((entry) => entry.options)).toEqual([
        { deliverAs: "steer", triggerTurn: true },
        { deliverAs: "steer", triggerTurn: false },
      ]);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(mailboxDir(queueDir, target))).toEqual([
        "2026_bad.json.rejected",
      ]);
    });
  });
}
