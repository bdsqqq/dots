// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const PROTOCOL = "t3-control-v2";
const LIFECYCLE_CUSTOM_TYPE = "t3.thread-lifecycle.v1";
const SOCKET_PATH = NodePath.join(NodeOS.homedir(), ".pi", "agent", PROTOCOL, "supervisor.sock");
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type BridgeCommand =
  | {
      readonly type: "command";
      readonly commandId: string;
      readonly command: "send" | "steer" | "followUp";
      readonly text: string;
    }
  | {
      readonly type: "command";
      readonly commandId: string;
      readonly command: "abort" | "shutdown";
    }
  | {
      readonly type: "command";
      readonly commandId: string;
      readonly command: "setLifecycle";
      readonly lifecycle: {
        readonly version: 1;
        readonly sessionId: string;
        readonly override: "settled" | "active";
        readonly operationId: string;
      };
    };

export class CommandDeduper {
  readonly #seen = new Set<string>();

  accept(commandId: string): boolean {
    if (this.#seen.has(commandId)) return false;
    this.#seen.add(commandId);
    return true;
  }
}

export class JsonLineDecoder {
  #buffer = "";

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    const values: unknown[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        values.push(undefined);
      }
    }
    return values;
  }
}

export function parseBridgeCommand(value: unknown): BridgeCommand | undefined {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    typeof value.commandId !== "string" ||
    value.commandId === ""
  )
    return;
  if (value.command === "abort" || value.command === "shutdown") {
    return { type: "command", commandId: value.commandId, command: value.command };
  }
  if (
    value.command === "setLifecycle" &&
    isRecord(value.lifecycle) &&
    value.lifecycle.version === 1 &&
    typeof value.lifecycle.sessionId === "string" &&
    value.lifecycle.sessionId !== "" &&
    (value.lifecycle.override === "settled" || value.lifecycle.override === "active") &&
    typeof value.lifecycle.operationId === "string" &&
    value.lifecycle.operationId !== ""
  ) {
    return {
      type: "command",
      commandId: value.commandId,
      command: "setLifecycle",
      lifecycle: {
        version: 1,
        sessionId: value.lifecycle.sessionId,
        override: value.lifecycle.override,
        operationId: value.lifecycle.operationId,
      },
    };
  }
  if (
    (value.command === "send" || value.command === "steer" || value.command === "followUp") &&
    typeof value.text === "string"
  ) {
    return {
      type: "command",
      commandId: value.commandId,
      command: value.command,
      text: value.text,
    };
  }
}

export function lifecycleCommandError(
  command: Extract<BridgeCommand, { readonly command: "setLifecycle" }>,
  sessionId: string,
  isIdle: boolean,
): string | undefined {
  if (command.lifecycle.sessionId !== sessionId) {
    return "lifecycle session id does not match the active session";
  }
  if (command.lifecycle.override === "settled" && !isIdle) {
    return "a running pi session cannot be settled";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function messageText(value: unknown): string | undefined {
  if (!isRecord(value)) return;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return;
  const text = value.content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return text.length > 0 ? text.join("") : undefined;
}

type SessionManager = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
};

type ExtensionContext = {
  readonly mode: string;
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
};

type ExtensionApi = {
  on(
    name: string,
    handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>,
  ): void;
  sendUserMessage(
    text: string,
    options?: { deliverAs: "steer" | "followUp" },
  ): void | Promise<void>;
  appendEntry(customType: string, data: unknown): void;
};

type WireMessage = Record<string, unknown>;

export default function t3ControlExtension(pi: ExtensionApi): void {
  let active = false;
  let socket: NodeNet.Socket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;
  let eventId = 0;
  let currentContext: ExtensionContext | undefined;
  let pendingSteering: string[] = [];
  let pendingFollowUp: string[] = [];
  let userMessageSeen = false;
  const deduper = new CommandDeduper();

  const write = (message: WireMessage): void => {
    if (socket?.readyState === "open") socket.write(`${JSON.stringify(message)}\n`);
  };

  const receipt = (
    commandId: string,
    status: "accepted" | "submitted" | "duplicate" | "error",
    error?: string,
  ): void => {
    write({
      type: "receipt",
      protocol: PROTOCOL,
      commandId,
      status,
      ...(error === undefined ? {} : { error }),
    });
  };

  const dispatch = async (command: BridgeCommand): Promise<void> => {
    if (!deduper.accept(command.commandId)) {
      receipt(command.commandId, "duplicate");
      return;
    }
    const ctx = currentContext;
    if (ctx === undefined) return;
    try {
      if (command.command === "send") {
        pi.sendUserMessage(command.text);
        receipt(command.commandId, "submitted");
      } else if (command.command === "steer" || command.command === "followUp") {
        pi.sendUserMessage(command.text, { deliverAs: command.command });
        receipt(command.commandId, "submitted");
      } else if (command.command === "setLifecycle") {
        const error = lifecycleCommandError(
          command,
          ctx.sessionManager.getSessionId(),
          ctx.isIdle(),
        );
        if (error !== undefined) throw new Error(error);
        pi.appendEntry(LIFECYCLE_CUSTOM_TYPE, command.lifecycle);
        receipt(command.commandId, "accepted");
      } else {
        if (command.command === "abort") ctx.abort();
        else ctx.shutdown();
        receipt(command.commandId, "accepted");
      }
    } catch (error) {
      receipt(command.commandId, "error", error instanceof Error ? error.message : String(error));
    }
  };

  const scheduleReconnect = (): void => {
    if (!active || reconnectTimer !== undefined) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref();
  };

  const connect = (): void => {
    if (!active || currentContext === undefined) return;
    const candidate = NodeNet.createConnection(SOCKET_PATH);
    socket = candidate;
    const decoder = new JsonLineDecoder();
    candidate.setEncoding("utf8");
    candidate.on("connect", () => {
      if (socket !== candidate || currentContext === undefined) return;
      reconnectAttempt = 0;
      write({
        type: "register",
        protocol: PROTOCOL,
        sessionId: currentContext.sessionManager.getSessionId(),
        sessionFile: currentContext.sessionManager.getSessionFile() ?? null,
        cwd: currentContext.cwd,
        pid: process.pid,
        isStreaming: !currentContext.isIdle(),
        steering: pendingSteering,
        followUp: pendingFollowUp,
      });
    });
    candidate.on("data", (chunk: string) => {
      for (const value of decoder.push(chunk)) {
        const command = parseBridgeCommand(value);
        if (command !== undefined) void dispatch(command);
      }
    });
    candidate.on("error", () => candidate.destroy());
    candidate.on("close", () => {
      if (socket === candidate) socket = undefined;
      scheduleReconnect();
    });
  };

  const forward = (name: string, data: WireMessage = {}): void => {
    const ctx = currentContext;
    if (!active || ctx === undefined) return;
    eventId += 1;
    write({
      type: "event",
      protocol: PROTOCOL,
      sessionId: ctx.sessionManager.getSessionId(),
      eventId,
      event: name,
      data,
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = true;
    currentContext = ctx;
    connect();
  });
  pi.on("agent_start", () => forward("agent_start"));
  pi.on("agent_end", () => forward("agent_end"));
  pi.on("agent_settled", (_event, ctx) => {
    pendingSteering = [];
    pendingFollowUp = [];
    forward("queue_update", { steering: pendingSteering, followUp: pendingFollowUp });
    forward("agent_settled", { idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
  });
  pi.on("message_start", (event) => {
    const message = isRecord(event.message) ? event.message : undefined;
    const delivered = message?.role === "user" ? messageText(message) : undefined;
    if (delivered !== undefined) {
      const steeringIndex = pendingSteering.indexOf(delivered);
      const followUpIndex = pendingFollowUp.indexOf(delivered);
      let reconciled = false;
      if (steeringIndex >= 0) {
        pendingSteering.splice(steeringIndex, 1);
        reconciled = true;
      } else if (followUpIndex >= 0) {
        pendingFollowUp.splice(followUpIndex, 1);
        reconciled = true;
      } else if (userMessageSeen && pendingSteering.length > 0) {
        pendingSteering.shift();
        reconciled = true;
      } else if (userMessageSeen && pendingFollowUp.length > 0) {
        pendingFollowUp.shift();
        reconciled = true;
      }
      if (reconciled)
        forward("queue_update", { steering: pendingSteering, followUp: pendingFollowUp });
      userMessageSeen = true;
    }
    forward("message_start", { message: event.message });
  });
  pi.on("message_update", (event) =>
    forward("message_update", { update: event.assistantMessageEvent }),
  );
  pi.on("message_end", (event) => forward("message_end", { message: event.message }));
  pi.on("tool_execution_start", (event) =>
    forward("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    }),
  );
  pi.on("tool_execution_update", (event) =>
    forward("tool_execution_update", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    }),
  );
  pi.on("tool_execution_end", (event) =>
    forward("tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    }),
  );
  pi.on("input", (event) => {
    const text = typeof event.text === "string" ? event.text : "";
    if (event.streamingBehavior === "steer") pendingSteering.push(text);
    if (event.streamingBehavior === "followUp") pendingFollowUp.push(text);
    if (event.streamingBehavior !== undefined)
      forward("queue_update", {
        steering: pendingSteering,
        followUp: pendingFollowUp,
      });
  });
  pi.on("session_shutdown", () => {
    if (!active) return;
    write({
      type: "unregister",
      protocol: PROTOCOL,
      sessionId: currentContext?.sessionManager.getSessionId(),
    });
    active = false;
    currentContext = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    socket?.end();
    socket = undefined;
  });
}
