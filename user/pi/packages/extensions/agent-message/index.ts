/**
 * durable cross-session messages for pi agents.
 *
 * a filesystem mailbox is the shared primitive because pi sessions may live in
 * unrelated processes—or may not be running at all. active sessions watch and
 * drain their mailbox; resumed sessions drain anything that arrived offline.
 * the injected custom message carries the sender identity in both visible text
 * and structured details so agent-authored text cannot be mistaken for user
 * input.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, type TString, Type } from "typebox";
import {
  clearConfigCache,
  getEnabledExtensionConfig,
  setGlobalSettingsPath,
  type ExtensionConfigSchema,
} from "@bds_pi/config";
import {
  listMentionableSessions,
  resolveMentionableSession,
  type MentionableSession,
} from "@bds_pi/mentions";

const MESSAGE_VERSION = 1;
const MESSAGE_FILE = /^([0-9T:.Z_-]+)_([0-9a-f-]{36})\.json$/u;
const CLAIMED_MESSAGE_FILE =
  /^(.+\.json)\.processing-([0-9]+)-([0-9a-f-]{36})$/u;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_MESSAGE_CHARS = 64 * 1024;
const CLAIM_LEASE_MS = 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 30 * 1000;

export interface AgentMessage {
  version: 1;
  id: string;
  provenance: {
    kind: "pi-session";
    trust: "claimed-local";
    sessionId: string;
    sessionName?: string;
    workspace: string;
  };
  target: {
    sessionId: string;
  };
  createdAt: string;
  content: string;
}

type AgentMessageConfig = {
  queueDir: string;
  sessionsDirs: string[];
};

type AgentMessageExtensionDeps = {
  getEnabledExtensionConfig: typeof getEnabledExtensionConfig;
  listMentionableSessions: typeof listMentionableSessions;
  watch: typeof fs.watch;
};

const CONFIG_DEFAULTS: AgentMessageConfig = {
  queueDir: path.join(os.homedir(), ".pi", "agent", "agent-messages"),
  sessionsDirs: [path.join(os.homedir(), ".pi", "agent", "sessions")],
};

const DEFAULT_DEPS: AgentMessageExtensionDeps = {
  getEnabledExtensionConfig,
  listMentionableSessions,
  watch: fs.watch,
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAgentMessageConfig(
  value: Record<string, unknown>,
): value is AgentMessageConfig {
  return (
    nonEmptyString(value.queueDir) &&
    Array.isArray(value.sessionsDirs) &&
    value.sessionsDirs.length > 0 &&
    value.sessionsDirs.every(nonEmptyString)
  );
}

const AGENT_MESSAGE_CONFIG_SCHEMA: ExtensionConfigSchema<AgentMessageConfig> = {
  validate: isAgentMessageConfig,
};

function expandPath(value: string): string {
  return path.resolve(value.replace(/^~(?=$|\/)/u, os.homedir()));
}

function normalizeConfig(config: AgentMessageConfig): AgentMessageConfig {
  return {
    queueDir: expandPath(config.queueDir),
    sessionsDirs: [...new Set(config.sessionsDirs.map(expandPath))],
  };
}

function mailboxPath(queueDir: string, sessionId: string): string {
  return path.join(queueDir, sessionId);
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid agent message");
  const message = value as Partial<AgentMessage>;
  if (
    message.version !== MESSAGE_VERSION ||
    typeof message.id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(message.id) ||
    typeof message.createdAt !== "string" ||
    Number.isNaN(Date.parse(message.createdAt)) ||
    !nonEmptyString(message.content) ||
    message.content.length > MAX_MESSAGE_CHARS ||
    typeof message.provenance !== "object" ||
    message.provenance === null ||
    message.provenance.kind !== "pi-session" ||
    message.provenance.trust !== "claimed-local" ||
    !SESSION_ID.test(message.provenance.sessionId) ||
    !nonEmptyString(message.provenance.workspace) ||
    (message.provenance.sessionName !== undefined &&
      !nonEmptyString(message.provenance.sessionName)) ||
    typeof message.target !== "object" ||
    message.target === null ||
    !SESSION_ID.test(message.target.sessionId)
  )
    throw new Error("invalid agent message");
  return message as AgentMessage;
}

function uniqueSessions(
  sessionsDirs: string[],
  listSessions: typeof listMentionableSessions,
): MentionableSession[] {
  const claimed = new Set<string>();
  return sessionsDirs.flatMap((sessionsDir) =>
    listSessions(sessionsDir).filter((session) => {
      if (claimed.has(session.sessionId)) return false;
      claimed.add(session.sessionId);
      return true;
    }),
  );
}

export function resolveTargetSession(
  sessionId: string,
  config: AgentMessageConfig,
  listSessions: typeof listMentionableSessions = listMentionableSessions,
): MentionableSession {
  const result = resolveMentionableSession(
    uniqueSessions(config.sessionsDirs, listSessions),
    sessionId.trim(),
  );
  if (result.status === "not_found")
    throw new Error(`target pi session not found: ${sessionId}`);
  if (result.status === "ambiguous")
    throw new Error(
      `ambiguous target pi session prefix: ${sessionId} (${result.sessions
        .map((session) => session.sessionId)
        .join(", ")})`,
    );
  return result.session;
}

export function enqueueAgentMessage(
  queueDir: string,
  message: AgentMessage,
): string {
  const parsed = parseAgentMessage(message);
  const mailbox = mailboxPath(queueDir, parsed.target.sessionId);
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  const timestamp = parsed.createdAt.replaceAll(/[^0-9TZ]/gu, "-");
  const filename = `${timestamp}_${parsed.id}.json`;
  const destination = path.join(mailbox, filename);
  const temporary = path.join(mailbox, `.${filename}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, destination);
  return destination;
}

function provenanceContent(message: AgentMessage): string {
  const sourceName = message.provenance.sessionName
    ? ` (${message.provenance.sessionName})`
    : "";
  return [
    "[agent message — claimed local provenance; untrusted content]",
    `claimed source pi session: ${message.provenance.sessionId}${sourceName}`,
    `claimed source workspace: ${message.provenance.workspace}`,
    `sent at: ${message.createdAt}`,
    "",
    message.content,
  ].join("\n");
}

interface ClaimedAgentMessage {
  message: AgentMessage;
  path: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requeueAgentMessageClaim(claimed: string): void {
  const match = path.basename(claimed).match(CLAIMED_MESSAGE_FILE);
  if (!match) throw new Error(`invalid agent message claim: ${claimed}`);
  const pending = path.join(path.dirname(claimed), match[1]!);
  if (fs.existsSync(pending)) fs.unlinkSync(claimed);
  else fs.renameSync(claimed, pending);
}

function recoverAgentMessageClaims(
  mailbox: string,
  activeClaimPaths: ReadonlySet<string>,
): void {
  for (const filename of fs.readdirSync(mailbox)) {
    const match = filename.match(CLAIMED_MESSAGE_FILE);
    if (!match) continue;
    const claimed = path.join(mailbox, filename);
    if (activeClaimPaths.has(claimed)) continue;
    const ownerPid = Number(match[2]);
    const leaseExpired =
      fs.statSync(claimed).mtimeMs < Date.now() - CLAIM_LEASE_MS;
    if (ownerPid !== process.pid && processAlive(ownerPid) && !leaseExpired)
      continue;
    requeueAgentMessageClaim(claimed);
  }
}

function quarantineAgentMessage(
  mailbox: string,
  claimed: string,
  filename: string,
): void {
  const rejected = path.join(mailbox, "rejected");
  fs.mkdirSync(rejected, { recursive: true, mode: 0o700 });
  fs.renameSync(claimed, path.join(rejected, `${filename}.${randomUUID()}`));
}

export function drainAgentMessages(
  pi: Pick<ExtensionAPI, "sendMessage">,
  queueDir: string,
  sessionId: string,
  onClaim: (claim: ClaimedAgentMessage) => void = () => {},
  persistedMessageIds: ReadonlySet<string> = new Set(),
  activeClaimPaths: ReadonlySet<string> = new Set(),
  activeMessageIds: ReadonlySet<string> = new Set(),
): ClaimedAgentMessage[] {
  const mailbox = mailboxPath(queueDir, sessionId);
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  recoverAgentMessageClaims(mailbox, activeClaimPaths);
  const claims: ClaimedAgentMessage[] = [];
  const seenMessageIds = new Set(activeMessageIds);
  const files = fs
    .readdirSync(mailbox)
    .filter((filename) => MESSAGE_FILE.test(filename))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of files) {
    const pending = path.join(mailbox, filename);
    const claimed = `${pending}.processing-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(pending, claimed);
      const now = new Date();
      fs.utimesSync(claimed, now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const message = parseAgentMessage(
        JSON.parse(fs.readFileSync(claimed, "utf8")),
      );
      if (message.target.sessionId !== sessionId)
        throw new Error("agent message target does not match mailbox");
      if (persistedMessageIds.has(message.id)) {
        fs.unlinkSync(claimed);
        continue;
      }
      if (seenMessageIds.has(message.id)) {
        fs.unlinkSync(claimed);
        continue;
      }
      seenMessageIds.add(message.id);
      const claim = { message, path: claimed };
      claims.push(claim);
      onClaim(claim);
      pi.sendMessage(
        {
          customType: "agent-message",
          content: provenanceContent(message),
          display: true,
          details: {
            version: message.version,
            messageId: message.id,
            provenance: message.provenance,
            target: message.target,
            createdAt: message.createdAt,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      const claimedMessage = claims.find((claim) => claim.path === claimed);
      if (claimedMessage) {
        claims.splice(claims.indexOf(claimedMessage), 1);
        try {
          requeueAgentMessageClaim(claimed);
        } catch {}
        throw error;
      }
      try {
        quarantineAgentMessage(mailbox, claimed, filename);
      } catch (quarantineError) {
        console.error(
          "[@bds_pi/agent-message] failed to quarantine message:",
          quarantineError,
        );
      }
      console.error(
        `[@bds_pi/agent-message] rejected queued message ${filename}:`,
        error,
      );
    }
  }
  return claims;
}

const AGENT_MESSAGE_PARAMETERS: TObject<{
  sessionId: TString;
  message: TString;
}> = Type.Object({
  sessionId: Type.String({
    description:
      "Target pi session id or an unambiguous id prefix. Use search_sessions to find it.",
  }),
  message: Type.String({
    minLength: 1,
    maxLength: MAX_MESSAGE_CHARS,
    description: "Message to deliver to the target agent.",
  }),
});

type AgentMessageParams = Static<typeof AGENT_MESSAGE_PARAMETERS>;

export function createAgentMessageTool(
  config: AgentMessageConfig,
  listSessions: typeof listMentionableSessions = listMentionableSessions,
  getSessionName: () => string | undefined = () => undefined,
): ToolDefinition<typeof AGENT_MESSAGE_PARAMETERS, AgentMessage> {
  return {
    name: "agent_message",
    label: "Agent Message",
    description:
      "Send a durable message to another pi agent session. The message is queued while the target is inactive or busy, then delivered with explicit source-session provenance. Use search_sessions first when the target session id is unknown.",
    promptSnippet:
      "Queue a provenance-marked message for another pi agent session",
    parameters: AGENT_MESSAGE_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input: AgentMessageParams = params;
      const target = resolveTargetSession(
        input.sessionId,
        config,
        listSessions,
      );
      const sourceSessionId = ctx.sessionManager.getSessionId();
      if (target.sessionId === sourceSessionId)
        throw new Error("agent_message target must be a different pi session");
      const sourceSessionName = getSessionName();
      const message: AgentMessage = {
        version: MESSAGE_VERSION,
        id: randomUUID(),
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: sourceSessionId,
          ...(sourceSessionName ? { sessionName: sourceSessionName } : {}),
          workspace: ctx.cwd,
        },
        target: { sessionId: target.sessionId },
        createdAt: new Date().toISOString(),
        content: input.message.trim(),
      };
      enqueueAgentMessage(config.queueDir, message);
      return {
        content: [
          {
            type: "text",
            text: `queued agent message ${message.id} for session ${target.sessionId}${target.sessionName ? ` (${target.sessionName})` : ""}`,
          },
        ],
        details: message,
      };
    },
  };
}

function persistedAgentMessageIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as {
      type?: unknown;
      customType?: unknown;
      details?: unknown;
    };
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== "agent-message") continue;
    if (typeof entry.details !== "object" || entry.details === null) continue;
    const messageId = (entry.details as { messageId?: unknown }).messageId;
    if (typeof messageId === "string") ids.add(messageId);
  }
  return ids;
}

export function createAgentMessageExtension(
  deps: AgentMessageExtensionDeps = DEFAULT_DEPS,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const loaded = deps.getEnabledExtensionConfig(
      "@bds_pi/agent-message",
      CONFIG_DEFAULTS,
      { schema: AGENT_MESSAGE_CONFIG_SCHEMA },
    );
    if (!loaded.enabled) return;
    const config = normalizeConfig(loaded.config);
    let watcher: fs.FSWatcher | undefined;
    let initialDrainTimer: NodeJS.Timeout | undefined;
    let reconcileTimer: NodeJS.Timeout | undefined;
    let currentSessionId: string | undefined;
    let draining = false;
    let drainRequested = false;
    const claims = new Map<string, string>();
    const persistedMessageIds = new Set<string>();

    const drain = () => {
      if (!currentSessionId) return;
      if (draining) {
        drainRequested = true;
        return;
      }
      draining = true;
      try {
        drainAgentMessages(
          pi,
          config.queueDir,
          currentSessionId,
          (claim) => {
            claims.set(claim.message.id, claim.path);
          },
          persistedMessageIds,
          new Set(claims.values()),
          new Set(claims.keys()),
        );
      } catch (error) {
        console.error("[@bds_pi/agent-message] mailbox drain failed:", error);
      } finally {
        draining = false;
        if (drainRequested) {
          drainRequested = false;
          queueMicrotask(drain);
        }
      }
    };

    const stop = () => {
      if (initialDrainTimer) clearTimeout(initialDrainTimer);
      initialDrainTimer = undefined;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = undefined;
      watcher?.close();
      watcher = undefined;
      currentSessionId = undefined;
      drainRequested = false;
      for (const claim of claims.values()) {
        try {
          requeueAgentMessageClaim(claim);
        } catch (error) {
          console.error(
            "[@bds_pi/agent-message] failed to release mailbox claim:",
            error,
          );
        }
      }
      claims.clear();
      persistedMessageIds.clear();
    };

    pi.on("session_start", async (_event, ctx) => {
      stop();
      currentSessionId = ctx.sessionManager.getSessionId();
      for (const messageId of persistedAgentMessageIds(
        ctx.sessionManager.getEntries(),
      ))
        persistedMessageIds.add(messageId);
      const mailbox = mailboxPath(config.queueDir, currentSessionId);
      fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
      initialDrainTimer = setTimeout(drain, 0);
      initialDrainTimer.unref();
      reconcileTimer = setInterval(drain, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref();
      try {
        watcher = deps.watch(mailbox, () => drain());
        watcher.on("error", (error) => {
          console.error(
            "[@bds_pi/agent-message] mailbox watcher failed:",
            error,
          );
        });
      } catch (error) {
        console.error(
          "[@bds_pi/agent-message] mailbox watcher unavailable; polling:",
          error,
        );
      }
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!ctx.isIdle()) return;
      const persisted = persistedAgentMessageIds(
        ctx.sessionManager.getEntries(),
      );
      for (const messageId of persisted) {
        persistedMessageIds.add(messageId);
      }
      for (const [messageId, claim] of claims) {
        if (persisted.has(messageId)) fs.rmSync(claim, { force: true });
        else requeueAgentMessageClaim(claim);
        claims.delete(messageId);
      }
      queueMicrotask(drain);
    });

    pi.on("session_shutdown", async () => stop());
    pi.registerTool(
      createAgentMessageTool(config, deps.listMentionableSessions, () =>
        pi.getSessionName(),
      ),
    );
  };
}

const agentMessageExtension: (pi: ExtensionAPI) => void =
  createAgentMessageExtension();

export default agentMessageExtension;

if (import.meta.vitest) {
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;
  const tempDirs: string[] = [];

  function tempDir(label: string): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `pi-agent-message-${label}-`),
    );
    tempDirs.push(directory);
    return directory;
  }

  function session(
    sessionId: string,
    overrides: Partial<MentionableSession> = {},
  ): MentionableSession {
    return {
      sessionId,
      sessionName: "",
      workspace: "/workspace",
      filePath: `/sessions/${sessionId}.jsonl`,
      startedAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      firstUserMessage: "work",
      searchableText: "work",
      branchCount: 1,
      ...overrides,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    setGlobalSettingsPath(
      path.join(os.tmpdir(), `missing-agent-message-${randomUUID()}.json`),
    );
    for (const directory of tempDirs.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  describe("agent-message", () => {
    it("resolves exact ids ahead of ambiguous prefixes", () => {
      const alpha = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const alphabet = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
      const config = {
        queueDir: tempDir("queue"),
        sessionsDirs: ["/first", "/second"],
      };
      const listSessions = vi.fn((directory: string) =>
        directory === "/first"
          ? [session(alpha), session(alphabet)]
          : [session(alpha)],
      );

      expect(resolveTargetSession(alpha, config, listSessions).sessionId).toBe(
        alpha,
      );
      expect(() =>
        resolveTargetSession(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa",
          config,
          listSessions,
        ),
      ).toThrow("ambiguous target pi session prefix");
    });

    it("retains claims until persistence is acknowledged", () => {
      const queueDir = tempDir("drain");
      const sent: Array<{ message: any; options: any }> = [];
      const sourceSessionId = "11111111-1111-4111-8111-111111111111";
      const targetSessionId = "22222222-2222-4222-8222-222222222222";
      const sendMessage = vi.fn((message, options) =>
        sent.push({ message, options }),
      );
      for (const [id, createdAt, content] of [
        [
          "00000000-0000-4000-8000-000000000002",
          "2026-07-28T00:00:02.000Z",
          "second",
        ],
        [
          "00000000-0000-4000-8000-000000000001",
          "2026-07-28T00:00:01.000Z",
          "first",
        ],
      ] as const)
        enqueueAgentMessage(queueDir, {
          version: 1,
          id,
          provenance: {
            kind: "pi-session",
            trust: "claimed-local",
            sessionId: sourceSessionId,
            sessionName: "source work",
            workspace: "/source",
          },
          target: { sessionId: targetSessionId },
          createdAt,
          content,
        });
      const old = new Date(Date.now() - 2 * CLAIM_LEASE_MS);
      for (const filename of fs.readdirSync(
        mailboxPath(queueDir, targetSessionId),
      ))
        fs.utimesSync(
          path.join(mailboxPath(queueDir, targetSessionId), filename),
          old,
          old,
        );

      const claims = drainAgentMessages(
        { sendMessage } as any,
        queueDir,
        targetSessionId,
      );
      expect(claims).toHaveLength(2);
      expect(fs.statSync(claims[0]!.path).mtimeMs).toBeGreaterThan(
        Date.now() - 1_000,
      );
      expect(
        sent.map(({ message }) => message.content.split("\n").at(-1)),
      ).toEqual(["first", "second"]);
      expect(sent[0]?.message).toMatchObject({
        customType: "agent-message",
        display: true,
        details: {
          provenance: {
            kind: "pi-session",
            trust: "claimed-local",
            sessionId: sourceSessionId,
            sessionName: "source work",
            workspace: "/source",
          },
        },
      });
      expect(sent[0]?.options).toEqual({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(
        fs.readdirSync(mailboxPath(queueDir, targetSessionId)),
      ).toHaveLength(2);
      const secondSend = vi.fn();
      expect(
        drainAgentMessages(
          { sendMessage: secondSend } as any,
          queueDir,
          targetSessionId,
          undefined,
          new Set(),
          new Set(claims.map((claim) => claim.path)),
        ),
      ).toEqual([]);
      expect(secondSend).not.toHaveBeenCalled();
      for (const claim of claims) fs.rmSync(claim.path);
    });

    it("recovers abandoned claims and quarantines malformed messages", () => {
      const queueDir = tempDir("recover");
      const targetSessionId = "22222222-2222-4222-8222-222222222222";
      const mailbox = mailboxPath(queueDir, targetSessionId);
      fs.mkdirSync(mailbox, { recursive: true });
      const validFilename =
        "2026-07-28T00-00-00-000Z_00000000-0000-4000-8000-000000000001.json";
      const validMessage: AgentMessage = {
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: "11111111-1111-4111-8111-111111111111",
          workspace: "/source",
        },
        target: { sessionId: targetSessionId },
        createdAt: "2026-07-28T00:00:00.000Z",
        content: "recover me",
      };
      fs.writeFileSync(
        path.join(
          mailbox,
          `${validFilename}.processing-${process.pid}-00000000-0000-4000-8000-000000000002`,
        ),
        JSON.stringify(validMessage),
      );
      fs.writeFileSync(
        path.join(
          mailbox,
          "2026-07-28T00-00-01-000Z_00000000-0000-4000-8000-000000000003.json",
        ),
        "{bad json",
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const claims = drainAgentMessages(
        { sendMessage: vi.fn() } as any,
        queueDir,
        targetSessionId,
      );

      expect(claims).toHaveLength(1);
      expect(fs.readdirSync(path.join(mailbox, "rejected"))).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("rejected queued message"),
        expect.anything(),
      );
      fs.rmSync(claims[0]!.path);
    });

    it("removes already-persisted claims without redelivery", () => {
      const queueDir = tempDir("dedupe");
      const targetSessionId = "22222222-2222-4222-8222-222222222222";
      const message: AgentMessage = {
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: "11111111-1111-4111-8111-111111111111",
          workspace: "/source",
        },
        target: { sessionId: targetSessionId },
        createdAt: "2026-07-28T00:00:00.000Z",
        content: "already there",
      };
      enqueueAgentMessage(queueDir, message);
      const sendMessage = vi.fn();

      expect(
        drainAgentMessages(
          { sendMessage } as any,
          queueDir,
          targetSessionId,
          undefined,
          new Set([message.id]),
        ),
      ).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(fs.readdirSync(mailboxPath(queueDir, targetSessionId))).toEqual(
        [],
      );
    });

    it("does not deliver duplicate message ids", () => {
      const queueDir = tempDir("duplicate");
      const targetSessionId = "22222222-2222-4222-8222-222222222222";
      const message: AgentMessage = {
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: "11111111-1111-4111-8111-111111111111",
          workspace: "/source",
        },
        target: { sessionId: targetSessionId },
        createdAt: "2026-07-28T00:00:00.000Z",
        content: "first",
      };
      enqueueAgentMessage(queueDir, message);
      enqueueAgentMessage(queueDir, {
        ...message,
        createdAt: "2026-07-28T00:00:01.000Z",
        content: "duplicate",
      });
      const sendMessage = vi.fn();

      const claims = drainAgentMessages(
        { sendMessage } as any,
        queueDir,
        targetSessionId,
      );

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(claims).toHaveLength(1);
      expect(
        fs.readdirSync(mailboxPath(queueDir, targetSessionId)),
      ).toHaveLength(1);
      fs.rmSync(claims[0]!.path);
    });

    it("requeues dropped follow-ups and acknowledges persisted ones", async () => {
      const tools: ToolDefinition[] = [];
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const watcher = { close: vi.fn(), on: vi.fn() };
      const queueDir = tempDir("extension");
      const targetSessionId = "33333333-3333-4333-8333-333333333333";
      const message: AgentMessage = {
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        provenance: {
          kind: "pi-session",
          trust: "claimed-local",
          sessionId: "11111111-1111-4111-8111-111111111111",
          workspace: "/source",
        },
        target: { sessionId: targetSessionId },
        createdAt: "2026-07-28T00:00:00.000Z",
        content: "retry me",
      };
      enqueueAgentMessage(queueDir, message);
      const entries: unknown[] = [];
      const extension = createAgentMessageExtension({
        getEnabledExtensionConfig: vi.fn((_namespace, defaults) => ({
          enabled: true,
          config: {
            ...defaults,
            queueDir,
            sessionsDirs: ["/sessions"],
          },
        })) as typeof getEnabledExtensionConfig,
        listMentionableSessions: vi.fn(() => []),
        watch: vi.fn(() => watcher) as unknown as typeof fs.watch,
      });
      const sendMessage = vi.fn();
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
        on: (event: string, handler: (...args: any[]) => unknown) =>
          handlers.set(event, handler),
        sendMessage,
        getSessionName: () => "current work",
      } as unknown as ExtensionAPI;
      extension(pi);

      expect(tools.map((tool) => tool.name)).toEqual(["agent_message"]);
      expect([...handlers.keys()].sort()).toEqual([
        "agent_settled",
        "session_shutdown",
        "session_start",
      ]);
      await handlers.get("session_start")?.(
        {},
        {
          sessionManager: {
            getSessionId: () => targetSessionId,
            getEntries: () => entries,
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(sendMessage).toHaveBeenCalledOnce();

      handlers.get("agent_settled")?.(
        {},
        {
          isIdle: () => true,
          sessionManager: { getEntries: () => entries },
        },
      );
      await Promise.resolve();
      expect(sendMessage).toHaveBeenCalledTimes(2);

      entries.push({
        type: "custom_message",
        customType: "agent-message",
        details: { messageId: message.id },
      });
      handlers.get("agent_settled")?.(
        {},
        {
          isIdle: () => true,
          sessionManager: { getEntries: () => entries },
        },
      );
      expect(fs.readdirSync(mailboxPath(queueDir, targetSessionId))).toEqual(
        [],
      );

      await handlers.get("session_shutdown")?.();
      expect(watcher.close).toHaveBeenCalledOnce();
    });
  });
}
