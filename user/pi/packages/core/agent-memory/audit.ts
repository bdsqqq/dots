import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { atomicWrite, secureDir, sha256 } from "./catalog.js";

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ModelConfig = { model: string; reasoning: ReasoningLevel };
export type AuditKind =
  | "reflection"
  | "adaptation"
  | "corpus-doctor"
  | "maintenance-analysis"
  | "eval-replay";
export type AuditAttempt = {
  sessionId: string;
  sessionPath: string;
  status: "incomplete";
  createdAt: string;
};
export type AuditRecord = {
  version: 1;
  kind: AuditKind;
  identity: string;
  runId?: string;
  eventId?: string;
  promptSha256: string;
  sessionId: string;
  sessionPath: string | null;
  model: string;
  reasoning: ReasoningLevel;
  createdAt: string;
  attempt?: number;
  previousAttempts?: AuditAttempt[];
};

const HOME = homedir();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
class IncompleteAuditSessionError extends Error {}

export function modelConfig(): ModelConfig {
  const model = process.env.PI_MEMORY_MODEL || "openai-codex/gpt-5.6-luna";
  if (
    !model.includes("/") ||
    /:(?:off|minimal|low|medium|high|xhigh|max)$/.test(model)
  )
    throw new Error(
      "PI_MEMORY_MODEL must be an explicit provider/model without thinking shorthand",
    );
  const reasoning = process.env.PI_MEMORY_REASONING_LEVEL || "low";
  if (!REASONING_LEVELS.includes(reasoning as ReasoningLevel))
    throw new Error(
      `PI_MEMORY_REASONING_LEVEL must be one of ${REASONING_LEVELS.join(", ")}`,
    );
  return { model, reasoning: reasoning as ReasoningLevel };
}

export function auditSessionDir(_data?: string): string {
  const configured = process.env.PI_MEMORY_SESSION_DIR;
  return resolve(
    (configured || join(HOME, ".local/share/pi-memory/v2/pi-sessions")).replace(
      /^~(?=$|\/)/,
      HOME,
    ),
  );
}

function uuid(identity: string): string {
  const hex = sha256(`pi-memory-audit\0${identity}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function manifestPath(root: string, invocationId: string): string {
  return join(root, "audit-manifest", `${invocationId}.json`);
}

function attemptSessionId(
  kind: AuditKind,
  identity: string,
  attempt: number,
): string {
  return attempt === 0
    ? uuid(`${kind}\0${identity}`)
    : uuid(`${kind}\0${identity}\0attempt:${attempt}`);
}

function findSession(root: string, sessionId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (name === "audit-manifest") continue;
      const found = findSession(path, sessionId);
      if (found) return found;
    } else if (stat.isFile() && name.endsWith(`_${sessionId}.jsonl`))
      return path;
  }
  return undefined;
}

function parseRecord(raw: string): AuditRecord {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    value.version !== 1 ||
    ![
      "reflection",
      "adaptation",
      "corpus-doctor",
      "maintenance-analysis",
      "eval-replay",
    ].includes(String(value.kind)) ||
    typeof value.identity !== "string" ||
    typeof value.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.promptSha256) ||
    typeof value.sessionId !== "string" ||
    !(value.sessionPath === null || typeof value.sessionPath === "string") ||
    typeof value.model !== "string" ||
    !REASONING_LEVELS.includes(value.reasoning as ReasoningLevel) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.runId !== undefined && typeof value.runId !== "string") ||
    (value.eventId !== undefined && typeof value.eventId !== "string") ||
    (value.attempt !== undefined &&
      (!Number.isInteger(value.attempt) || Number(value.attempt) < 0)) ||
    (value.previousAttempts !== undefined &&
      (!Array.isArray(value.previousAttempts) ||
        !value.previousAttempts.every(
          (attempt) =>
            object(attempt) &&
            typeof attempt.sessionId === "string" &&
            typeof attempt.sessionPath === "string" &&
            attempt.status === "incomplete" &&
            typeof attempt.createdAt === "string" &&
            !Number.isNaN(Date.parse(attempt.createdAt)),
        )))
  )
    throw new Error("invalid audit manifest record");
  return value as AuditRecord;
}

export function prepareAuditInvocation(options: {
  data?: string;
  kind: AuditKind;
  identity: string;
  prompt: string;
  model: string;
  reasoning: ReasoningLevel;
  runId?: string;
  eventId?: string;
}): {
  record: AuditRecord;
  recoveredOutput?: string;
  args: string[];
  complete: () => { record: AuditRecord; output: string };
} {
  const root = auditSessionDir(options.data);
  secureDir(root);
  secureDir(join(root, "audit-manifest"));
  const promptSha256 = sha256(options.prompt);
  const invocationId = uuid(`${options.kind}\0${options.identity}`);
  const path = manifestPath(root, invocationId);
  let record: AuditRecord;
  let recoveredOutput: string | undefined;
  if (existsSync(path)) {
    record = parseRecord(readFileSync(path, "utf8"));
    const attempt = record.attempt ?? 0;
    const previousAttempts = record.previousAttempts ?? [];
    if (
      record.kind !== options.kind ||
      record.identity !== options.identity ||
      record.promptSha256 !== promptSha256 ||
      record.sessionId !==
        attemptSessionId(options.kind, options.identity, attempt) ||
      previousAttempts.length !== attempt ||
      previousAttempts.some(
        (previous, index) =>
          previous.sessionId !==
          attemptSessionId(options.kind, options.identity, index),
      ) ||
      record.runId !== options.runId ||
      record.eventId !== options.eventId
    )
      throw new Error("audit invocation identity collision");
    const sessionPath = findSession(root, record.sessionId);
    if (
      record.model !== options.model ||
      record.reasoning !== options.reasoning
    )
      throw new Error("audit invocation configuration drift");
    if (record.sessionPath) {
      if (!sessionPath || record.sessionPath !== sessionPath)
        throw new Error(`audit session missing for ${record.sessionId}`);
      recoveredOutput = inspectSession(sessionPath, record).output;
    } else if (sessionPath) {
      try {
        recoveredOutput = inspectSession(sessionPath, record).output;
        record = { ...record, sessionPath };
      } catch (error) {
        if (!(error instanceof IncompleteAuditSessionError)) throw error;
        const nextAttempt = attempt + 1;
        record = {
          ...record,
          attempt: nextAttempt,
          previousAttempts: [
            ...(record.previousAttempts ?? []),
            {
              sessionId: record.sessionId,
              sessionPath,
              status: "incomplete",
              createdAt: record.createdAt,
            },
          ],
          sessionId: attemptSessionId(
            options.kind,
            options.identity,
            nextAttempt,
          ),
          sessionPath: null,
          createdAt: new Date().toISOString(),
        };
      }
      atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
    }
  } else {
    record = {
      version: 1,
      kind: options.kind,
      identity: options.identity,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.eventId ? { eventId: options.eventId } : {}),
      promptSha256,
      sessionId: invocationId,
      sessionPath: null,
      model: options.model,
      reasoning: options.reasoning,
      createdAt: new Date().toISOString(),
    };
    atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  const shortIdentity = options.identity
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 12);
  const name = `pi-memory ${options.kind} ${shortIdentity}`;
  return {
    record,
    recoveredOutput,
    args: [
      "-p",
      "--session-dir",
      root,
      "--session-id",
      record.sessionId,
      "--name",
      name,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--model",
      record.model,
      "--thinking",
      record.reasoning,
    ],
    complete: () => {
      const sessionPath = findSession(root, record.sessionId);
      if (!sessionPath)
        throw new Error(`audit session ${record.sessionId} was not persisted`);
      const inspected = inspectSession(sessionPath, record);
      const complete = { ...record, sessionPath };
      atomicWrite(path, `${JSON.stringify(complete, null, 2)}\n`);
      return { record: complete, output: inspected.output };
    },
  };
}

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

function addUsage(total: Usage, value: unknown): void {
  if (!object(value)) return;
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ] as const) {
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
      throw new Error("invalid audit session usage");
    total[key] += amount;
  }
  const cost = value.cost;
  if (
    !object(cost) ||
    typeof cost.total !== "number" ||
    !Number.isFinite(cost.total) ||
    cost.total < 0
  )
    throw new Error("invalid audit session cost");
  total.cost += cost.total;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      object(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

function readSessionRecords(
  sessionPath: string,
  sessionId: string,
): Record<string, unknown>[] {
  const stat = lstatSync(sessionPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("invalid audit session file");
  const records = readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const header = records[0];
  if (!object(header) || header.type !== "session" || header.id !== sessionId)
    throw new Error("audit session header mismatch");
  const entries = records.slice(1);
  if (!entries.every(object)) throw new Error("invalid audit session entry");
  return entries;
}

function usageFromEntries(entries: Record<string, unknown>[]): Usage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  for (const entry of entries) {
    if (entry.type === "message" && object(entry.message))
      addUsage(usage, entry.message.usage);
    else if (entry.type === "compaction" || entry.type === "branch_summary")
      addUsage(usage, entry.usage);
  }
  return usage;
}

function mergeUsage(target: Usage, source: Usage): void {
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "cost",
  ] as const)
    target[key] += source[key];
}

function inspectSession(
  sessionPath: string,
  record: AuditRecord,
): { output: string; usage: Usage } {
  const records = readSessionRecords(sessionPath, record.sessionId);
  const [provider, ...modelParts] = record.model.split("/");
  const modelId = modelParts.join("/");
  const entries: Record<string, unknown>[] = [];
  for (const entry of records) {
    if (typeof entry.id !== "string")
      throw new Error("invalid audit session entry");
    entries.push(entry);
  }
  const usage = usageFromEntries(entries);
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
  if (byId.size !== entries.length)
    throw new Error("duplicate audit session entry id");
  const leaf = entries.at(-1);
  if (!leaf)
    throw new IncompleteAuditSessionError("audit session has no model output");
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let cursor: Record<string, unknown> | undefined = leaf;
  while (cursor) {
    const id = cursor.id as string;
    if (visited.has(id)) throw new Error("audit session ancestry cycle");
    visited.add(id);
    branch.push(cursor);
    if (cursor.parentId === null) break;
    if (typeof cursor.parentId !== "string")
      throw new Error("invalid audit session ancestry");
    cursor = byId.get(cursor.parentId);
    if (!cursor) throw new Error("invalid audit session ancestry");
  }
  const assistantEntry = branch.find(
    (entry) =>
      entry.type === "message" &&
      object(entry.message) &&
      entry.message.role === "assistant",
  );
  if (!assistantEntry)
    throw new IncompleteAuditSessionError("audit session has no model output");
  const users = branch.filter(
    (entry) =>
      entry.type === "message" &&
      object(entry.message) &&
      entry.message.role === "user",
  );
  const selectedModel = branch.find((entry) => entry.type === "model_change");
  const selectedThinking = branch.find(
    (entry) => entry.type === "thinking_level_change",
  );
  const assistant = assistantEntry.message as Record<string, unknown>;
  if (
    users.length !== 1 ||
    !object(users[0]!.message) ||
    sha256(messageText(users[0]!.message)) !== record.promptSha256
  )
    throw new Error("audit session prompt mismatch");
  if (
    !selectedModel ||
    selectedModel.provider !== provider ||
    selectedModel.modelId !== modelId ||
    !selectedThinking ||
    selectedThinking.thinkingLevel !== record.reasoning ||
    !assistant ||
    assistant.provider !== provider ||
    assistant.model !== modelId
  )
    throw new Error("audit session effective configuration mismatch");
  if (assistant.stopReason !== "stop")
    throw new IncompleteAuditSessionError(
      "audit session did not complete successfully",
    );
  const output = messageText(assistant);
  if (!output.trim())
    throw new IncompleteAuditSessionError("audit session has no model output");
  return { output, usage };
}

export function listAuditSessions(data?: string): Array<
  AuditRecord & {
    status: "pending" | "complete" | "missing";
    missingAttempts: number;
    usage: Usage;
  }
> {
  const root = auditSessionDir(data);
  const manifests = join(root, "audit-manifest");
  if (!existsSync(manifests)) return [];
  const names = readdirSync(manifests).sort();
  if (names.some((name) => !name.endsWith(".json")))
    throw new Error("invalid audit manifest entry");
  return names.map((name) => {
    const path = join(manifests, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error("invalid audit manifest entry");
    const record = parseRecord(readFileSync(path, "utf8"));
    if (basename(path, ".json") !== uuid(`${record.kind}\0${record.identity}`))
      throw new Error("audit manifest filename mismatch");
    const sessionPath = findSession(root, record.sessionId);
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    };
    let missingAttempts = 0;
    for (const attempt of record.previousAttempts ?? []) {
      const attemptPath = findSession(root, attempt.sessionId);
      if (!attemptPath || attemptPath !== attempt.sessionPath) {
        missingAttempts += 1;
        continue;
      }
      mergeUsage(
        usage,
        usageFromEntries(readSessionRecords(attemptPath, attempt.sessionId)),
      );
    }
    if (record.sessionPath === null) {
      if (sessionPath)
        mergeUsage(
          usage,
          usageFromEntries(readSessionRecords(sessionPath, record.sessionId)),
        );
      return {
        ...record,
        status: "pending" as const,
        missingAttempts,
        usage,
      };
    }
    if (!sessionPath || record.sessionPath !== sessionPath)
      return {
        ...record,
        status: "missing" as const,
        missingAttempts: missingAttempts + 1,
        usage,
      };
    mergeUsage(usage, inspectSession(sessionPath, record).usage);
    return {
      ...record,
      status: "complete" as const,
      missingAttempts,
      usage,
    };
  });
}

export function auditResumeCommand(data?: string): string {
  const root = auditSessionDir(data);
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`;
  return `pi --session-dir ${quote(root)} -r --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files`;
}
