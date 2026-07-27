import { sha256 } from "./catalog.js";

export const TURN_RECEIPT_ENTRY_TYPE = "@bds_pi/agent-memory/turn-receipt";
export const INJECTION_ENTRY_TYPE = "@bds_pi/agent-memory/injection";
export const CHECKPOINT_ENTRY_TYPE = "@bds_pi/agent-memory/checkpoint";

export type MemoryRef = {
  memoryId: string;
  path: string;
  artifactSha256: string;
};

export type TurnReceipt = {
  version: 1;
  receiptId: string;
  sessionId: string;
  workspace: string;
  userEntryIds: string[];
  assistantEntryIds: string[];
  responseToReceiptId?: string;
  catalogSha256: string;
  exposures: Array<{
    kind: "injected" | "searched" | "opened" | "cited";
    memoryId: string;
    artifactSha256: string;
    toolCallId?: string;
    rank?: number;
  }>;
  outcomes: Array<{
    toolCallId: string;
    resultEntryId: string;
    toolName: string;
    result: "success" | "error" | "cancelled";
  }>;
  redactions: Record<string, number>;
  recordedAt: string;
};

export type InjectionReceipt = {
  version: 1;
  userEntryId: string;
  catalogSha256: string;
  refs: MemoryRef[];
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HASH = /^[a-f0-9]{64}$/;
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => key in value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;

export function canonicalTurnReceiptId(
  receipt: Omit<TurnReceipt, "receiptId">,
): string {
  return `turn_${sha256(canonical(receipt as unknown as Json)).slice(0, 32)}`;
}

export function parseInjectionReceipt(value: unknown): InjectionReceipt {
  if (
    !object(value) ||
    !keysAre(value, ["version", "userEntryId", "catalogSha256", "refs"])
  )
    throw new Error("invalid memory injection receipt");
  if (
    value.version !== 1 ||
    typeof value.userEntryId !== "string" ||
    !value.userEntryId ||
    typeof value.catalogSha256 !== "string" ||
    !HASH.test(value.catalogSha256) ||
    !Array.isArray(value.refs)
  )
    throw new Error("invalid memory injection receipt");
  const refs = value.refs.map((candidate) => {
    if (
      !object(candidate) ||
      !keysAre(candidate, ["memoryId", "path", "artifactSha256"]) ||
      typeof candidate.memoryId !== "string" ||
      !candidate.memoryId ||
      typeof candidate.path !== "string" ||
      !candidate.path ||
      typeof candidate.artifactSha256 !== "string" ||
      !HASH.test(candidate.artifactSha256)
    )
      throw new Error("invalid memory injection receipt");
    return candidate as MemoryRef;
  });
  if (
    new Set(refs.map((ref) => `${ref.memoryId}\0${ref.path}`)).size !==
    refs.length
  )
    throw new Error("invalid memory injection receipt");
  return {
    version: 1,
    userEntryId: value.userEntryId,
    catalogSha256: value.catalogSha256,
    refs,
  };
}

function isTurnExposure(
  exposure: unknown,
): exposure is TurnReceipt["exposures"][number] {
  if (!object(exposure)) return false;
  const required = ["kind", "memoryId", "artifactSha256"];
  const allowed = [...required, "toolCallId", "rank"];
  return (
    Object.keys(exposure).every((key) => allowed.includes(key)) &&
    required.every((key) => key in exposure) &&
    ["injected", "searched", "opened", "cited"].includes(
      String(exposure.kind),
    ) &&
    typeof exposure.memoryId === "string" &&
    exposure.memoryId.length > 0 &&
    typeof exposure.artifactSha256 === "string" &&
    HASH.test(exposure.artifactSha256) &&
    (exposure.toolCallId === undefined ||
      (typeof exposure.toolCallId === "string" &&
        exposure.toolCallId.length > 0)) &&
    (exposure.rank === undefined ||
      (Number.isInteger(exposure.rank) && Number(exposure.rank) >= 1))
  );
}

export function parseTurnReceipt(value: unknown): TurnReceipt {
  const required = [
    "version",
    "receiptId",
    "sessionId",
    "workspace",
    "userEntryIds",
    "assistantEntryIds",
    "catalogSha256",
    "exposures",
    "outcomes",
    "redactions",
    "recordedAt",
  ];
  if (!object(value)) throw new Error("invalid turn receipt");
  const allowed = [...required, "responseToReceiptId"];
  if (
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    !required.every((key) => key in value)
  )
    throw new Error("invalid turn receipt");
  if (
    value.version !== 1 ||
    typeof value.receiptId !== "string" ||
    !/^turn_[a-f0-9]{32}$/.test(value.receiptId) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.workspace !== "string" ||
    !value.workspace ||
    !strings(value.userEntryIds) ||
    !strings(value.assistantEntryIds) ||
    (value.responseToReceiptId !== undefined &&
      (typeof value.responseToReceiptId !== "string" ||
        !/^turn_[a-f0-9]{32}$/.test(value.responseToReceiptId))) ||
    typeof value.catalogSha256 !== "string" ||
    !HASH.test(value.catalogSha256) ||
    !Array.isArray(value.exposures) ||
    !Array.isArray(value.outcomes) ||
    !object(value.redactions) ||
    typeof value.recordedAt !== "string" ||
    Number.isNaN(Date.parse(value.recordedAt)) ||
    new Date(value.recordedAt).toISOString() !== value.recordedAt
  )
    throw new Error("invalid turn receipt");
  if (value.exposures.some((exposure) => !isTurnExposure(exposure)))
    throw new Error("invalid turn receipt");
  for (const outcome of value.outcomes) {
    if (
      !object(outcome) ||
      !keysAre(outcome, [
        "toolCallId",
        "resultEntryId",
        "toolName",
        "result",
      ]) ||
      typeof outcome.toolCallId !== "string" ||
      !outcome.toolCallId ||
      typeof outcome.resultEntryId !== "string" ||
      !outcome.resultEntryId ||
      typeof outcome.toolName !== "string" ||
      !outcome.toolName ||
      !["success", "error", "cancelled"].includes(String(outcome.result))
    )
      throw new Error("invalid turn receipt");
  }
  if (
    Object.values(value.redactions).some(
      (count) => !Number.isInteger(count) || Number(count) < 1,
    )
  )
    throw new Error("invalid turn receipt");
  const exposureItems = value.exposures as TurnReceipt["exposures"];
  const outcomeItems = value.outcomes as TurnReceipt["outcomes"];
  if (
    new Set(
      exposureItems.map(
        (exposure) =>
          `${exposure.kind}\0${exposure.memoryId}\0${exposure.toolCallId ?? ""}\0${exposure.rank ?? ""}`,
      ),
    ).size !== exposureItems.length ||
    new Set(outcomeItems.map((outcome) => outcome.toolCallId)).size !==
      outcomeItems.length
  )
    throw new Error("invalid turn receipt");
  const receipt = value as TurnReceipt;
  const { receiptId: _receiptId, ...identity } = receipt;
  if (canonicalTurnReceiptId(identity) !== receipt.receiptId)
    throw new Error("turn receipt id does not match content");
  return receipt;
}

export type TurnReceiptObservationDiagnostic = {
  kind: "malformed-exposure";
  count: number;
};

/** Parses receipt correlation strictly while quarantining exposure-only defects. */
export function parseTurnReceiptObservation(value: unknown): {
  receipt: TurnReceipt;
  diagnostics: TurnReceiptObservationDiagnostic[];
} {
  if (
    !object(value) ||
    typeof value.receiptId !== "string" ||
    !/^turn_[a-f0-9]{32}$/.test(value.receiptId) ||
    !Array.isArray(value.exposures)
  )
    throw new Error("invalid turn receipt");
  const { receiptId, ...rawIdentity } = value;
  const rawId = `turn_${sha256(canonical(rawIdentity as unknown as Json)).slice(
    0,
    32,
  )}`;
  if (receiptId !== rawId)
    throw new Error("turn receipt id does not match content");
  const exposures = value.exposures.filter(isTurnExposure);
  const sanitizedIdentity = { ...rawIdentity, exposures };
  const receipt = parseTurnReceipt({
    ...sanitizedIdentity,
    receiptId: `turn_${sha256(
      canonical(sanitizedIdentity as unknown as Json),
    ).slice(0, 32)}`,
  });
  return {
    receipt: { ...receipt, receiptId },
    diagnostics:
      exposures.length === value.exposures.length
        ? []
        : [
            {
              kind: "malformed-exposure",
              count: value.exposures.length - exposures.length,
            },
          ],
  };
}

export function validateTurnReceiptBinding(
  entries: Array<{
    type: string;
    id: string;
    customType?: unknown;
    data?: unknown;
    message?: unknown;
  }>,
  receiptEntryId: string,
  receipt: TurnReceipt,
  expected?: {
    sessionId?: string;
    workspace?: string;
    ancestryBoundaryId?: string;
  },
): void {
  if (
    (expected?.sessionId !== undefined &&
      receipt.sessionId !== expected.sessionId) ||
    (expected?.workspace !== undefined &&
      receipt.workspace !== expected.workspace)
  )
    throw new Error("turn receipt session binding does not match");
  const receiptIndex = entries.findIndex(
    (entry) => entry.id === receiptEntryId,
  );
  if (receiptIndex < 0) throw new Error("turn receipt is not on branch");
  let previous: TurnReceipt | undefined;
  let start = -1;
  for (let index = 0; index < receiptIndex; index++) {
    const entry = entries[index]!;
    if (
      entry.type === "custom" &&
      entry.customType === TURN_RECEIPT_ENTRY_TYPE
    ) {
      const candidate = parseTurnReceiptObservation(entry.data).receipt;
      if (candidate.sessionId === receipt.sessionId) {
        previous = candidate;
        start = index;
      }
    }
  }
  if (!previous) {
    const boundary = expected?.ancestryBoundaryId;
    if (boundary !== undefined) {
      start = entries.findIndex((entry) => entry.id === boundary);
      if (start < 0 || start >= receiptIndex)
        throw new Error("turn receipt ancestry boundary is not on branch");
    } else {
      const firstUser = entries.findIndex(
        (entry) => entry.id === receipt.userEntryIds[0],
      );
      if (firstUser < 0 || firstUser >= receiptIndex)
        throw new Error("turn receipt ancestry rebase is not on branch");
      start = firstUser - 1;
    }
  }
  const authored = entries.slice(start + 1, receiptIndex).flatMap((entry) => {
    if (!object(entry.message)) return [];
    return entry.message.role === "user" || entry.message.role === "assistant"
      ? [{ id: entry.id, role: entry.message.role }]
      : [];
  });
  const userEntryIds = authored
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.id);
  const assistantEntryIds = authored
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.id);
  if (
    canonical(userEntryIds as Json) !==
      canonical(receipt.userEntryIds as Json) ||
    canonical(assistantEntryIds as Json) !==
      canonical(receipt.assistantEntryIds as Json) ||
    (previous?.receiptId ?? undefined) !== receipt.responseToReceiptId
  )
    throw new Error("turn receipt branch binding does not match");
}
