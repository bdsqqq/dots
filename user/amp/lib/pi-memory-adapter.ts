import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export type AmpThreadMessage =
  | {
      role: "user";
      id: number | string;
      content: ReadonlyArray<
        | { type: "text"; text: string }
        | {
            type: "tool_result";
            toolUseID: string;
            output?: unknown;
            status: "done" | "error" | "cancelled" | "running" | "pending";
          }
      >;
    }
  | {
      role: "assistant";
      id: number | string;
      content: ReadonlyArray<
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          }
      >;
    }
  | {
      role: "info";
      id: number | string;
      content: ReadonlyArray<{ type: "text"; text: string }>;
    };

type SyntheticEntry = {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
};

export type AmpMemorySession = {
  id: string;
  checkpointId: string;
  jsonl: string;
};

const MAX_TURN_BYTES = 4 * 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedId(value: number | string, label: string): string {
  const normalized = String(value);
  if (!normalized || normalized.length > 256)
    throw new Error(`invalid Amp ${label}`);
  return normalized;
}

function safeValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Converts one settled Amp turn into Pi's checkpoint v2 wire format. This
 * adapter only captures deterministic evidence; Pi owns validation, redaction,
 * reflection, evaluation, and tiering.
 */
export function adaptAmpTurn(options: {
  threadId: string;
  messageId: number | string;
  workspace: string;
  status: "done" | "error" | "cancelled";
  messages: readonly AmpThreadMessage[];
}): AmpMemorySession | undefined {
  if (options.status !== "done") return undefined;
  const threadId = boundedId(options.threadId, "thread ID");
  const messageId = boundedId(options.messageId, "message ID");
  const workspace = resolve(options.workspace);
  const serialized = JSON.stringify(options.messages);
  if (Buffer.byteLength(serialized) > MAX_TURN_BYTES)
    throw new Error("Amp turn exceeds 4 MiB");

  const sessionId = `amp-${sha256(`${threadId}\0${messageId}`)}`;
  const entries: SyntheticEntry[] = [];
  let parentId: string | null = null;
  let authoredUserTurns = 0;
  let lastAssistantId: string | undefined;

  const append = (
    sourceId: number | string,
    ordinal: number,
    value: Omit<SyntheticEntry, "id" | "parentId">,
  ): void => {
    const id = `amp-entry-${sha256(
      `${sessionId}\0${boundedId(sourceId, "entry ID")}\0${ordinal}\0${value.type}`,
    )}`;
    entries.push({ ...value, id, parentId });
    parentId = id;
  };

  for (const message of options.messages) {
    if (message.role === "info") continue;
    if (message.role === "user") {
      const text = message.content
        .flatMap((part) =>
          part.type === "text" && part.text.trim() ? [part.text] : [],
        )
        .join("\n");
      let ordinal = 0;
      if (text) {
        append(message.id, ordinal++, {
          type: "message",
          message: { role: "user", content: text },
        });
        authoredUserTurns += 1;
      }
      for (const part of message.content) {
        if (part.type !== "tool_result") continue;
        append(message.id, ordinal++, {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: boundedId(part.toolUseID, "tool call ID"),
            content: safeValue(part.output),
            isError: part.status === "error",
          },
        });
      }
      continue;
    }

    const content = message.content.flatMap((part) => {
      if (part.type === "text")
        return part.text.trim() ? [{ type: "text", text: part.text }] : [];
      if (part.type === "tool_use")
        return [
          {
            type: "toolCall",
            id: boundedId(part.id, "tool call ID"),
            name: boundedId(part.name, "tool name"),
            arguments: safeValue(part.input),
          },
        ];
      return [];
    });
    if (content.length === 0) continue;
    append(message.id, 0, {
      type: "message",
      message: { role: "assistant", content },
    });
    lastAssistantId = parentId ?? undefined;
  }

  if (
    authoredUserTurns === 0 ||
    !lastAssistantId ||
    parentId !== lastAssistantId
  )
    return undefined;

  const checkpointId = `amp-checkpoint-${sha256(
    `${sessionId}\0${lastAssistantId}`,
  )}`;
  entries.push({
    type: "custom",
    id: checkpointId,
    parentId,
    customType: "@bds_pi/agent-memory/checkpoint",
    data: {
      version: 2,
      sessionId,
      throughLeafId: lastAssistantId,
      acceptedUserTurns: authoredUserTurns,
    },
  });
  const rows = [
    { type: "session", id: sessionId, cwd: workspace },
    ...entries,
  ];
  return {
    id: sessionId,
    checkpointId,
    jsonl: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  };
}

/**
 * Publishes a completed turn without overwriting an existing identity. A
 * divergent duplicate means Amp reused an identity for different evidence and
 * must fail closed rather than silently changing a processed checkpoint.
 */
export function publishAmpMemorySession(
  root: string,
  session: AmpMemorySession,
): "created" | "existing" {
  const directory = resolve(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${session.id}.jsonl`);
  if (basename(target) !== `${session.id}.jsonl`)
    throw new Error("invalid Amp memory session path");
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === session.jsonl) return "existing";
    throw new Error(`Amp memory identity collision for ${session.id}`);
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, session.jsonl);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, target);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      readFileSync(target, "utf8") === session.jsonl
    ) {
      unlinkSync(temporary);
      return "existing";
    }
    try {
      unlinkSync(temporary);
    } catch {}
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Amp memory identity collision for ${session.id}`);
    throw error;
  }
  unlinkSync(temporary);
  const directoryFd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return "created";
}
