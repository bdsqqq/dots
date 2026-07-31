import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validateTranscript } from "@letta-ai/trajectory";
import {
  atomicWrite,
  contained,
  memoryScopeRank,
  scanCatalog,
  secureDir,
  sha256,
  type Catalog,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import type { SafeEvidence } from "./evidence.js";
import type { ReasoningLevel } from "./audit.js";
import {
  deduplicateTurnObservations,
  listVerifiedRollbackEvidence,
  parseRollbackEvidence,
  parseTurnObservation,
  validateTurnObservationRefs,
  type RollbackEvidence,
  type TurnObservation,
} from "./adaptation.js";
import { parseModelProposal, type Proposal } from "./schema.js";
import {
  applyMemoryProposal,
  assertNonOverlappingMemoryProposals,
  findProposal,
  listProposals,
  materializeModelProposals,
  readReviewReceipts,
  saveProposal,
  parseStoredProposalOperation,
} from "./workflow.js";

export type PipelineInputV2 = {
  version: 2;
  runId: string;
  batchId: string;
  promptVersion: 2;
  model?: string;
  reasoning?: ReasoningLevel;
  createdAt: string;
  scope: string;
  evidence: SafeEvidence[];
  catalog: Catalog;
  targets: Array<CatalogEntry & { body: string }>;
  pending: Array<{
    id: string;
    lane: string;
    operation: string;
    summary: string;
  }>;
  reviewSignals: Array<{
    decision: string;
    reasonCode: string;
    lane: string;
    operation: string;
  }>;
  skills: Array<{ name: string; description: string; sha256: string }>;
};
export type PipelineInputV3 = Omit<
  PipelineInputV2,
  "version" | "promptVersion"
> & {
  version: 3;
  promptVersion: 3;
  observations: TurnObservation[];
  rollbackEvidence: RollbackEvidence[];
};
export type PipelineInputV4 = Omit<
  PipelineInputV3,
  "version" | "promptVersion"
> & {
  version: 4;
  promptVersion: 4;
  supersessionBasis?: Array<{
    id: string;
    runId: string;
    operation: Proposal["operation"];
  }>;
};
export type PipelineInput = PipelineInputV2 | PipelineInputV3 | PipelineInputV4;

export type PipelineResult = {
  runId: string;
  action: "skip" | "propose";
  proposalIds: string[];
  coveredCheckpointIds: string[];
};

export type PipelineCriticInput = {
  version: 1;
  promptVersion: 1;
  runId: string;
  model: string;
  reasoning: ReasoningLevel;
  autonomousApply: boolean;
  reflectionInput: PipelineInput;
  reflectionOutput: ReturnType<typeof parseModelProposal>;
};

type PipelineCriticOutput = {
  version: 1;
  runId: string;
  criticInputSha256: string;
  decision: "allow-autonomous-apply" | "require-local-review";
  reason: string;
};

const HASH = /^[a-f0-9]{64}$/;
const MEMORY_ID = /^(?:mem_[a-f0-9]{24}|legacy:[a-f0-9]{24})$/;
const PROPOSAL_ID = /^prop_[a-f0-9]{32}$/;
const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function storedObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`invalid ${name}`);
  return value as Record<string, unknown>;
}

function storedExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  name: string,
): void {
  if (Object.keys(value).sort().join(",") !== keys.slice().sort().join(","))
    throw new Error(`invalid ${name} fields`);
}

function storedString(
  value: unknown,
  name: string,
  max: number,
  options: { allowEmpty?: boolean; singleLine?: boolean } = {},
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!options.allowEmpty && !value.length) ||
    (!options.allowEmpty && value !== value.trim()) ||
    (options.singleLine && /[\r\n]/.test(value))
  )
    throw new Error(`invalid ${name}`);
}

function storedHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new Error(`invalid ${name}`);
}

function storedStorageId(
  value: unknown,
  name: string,
): asserts value is string {
  storedString(value, name, 200, { singleLine: true });
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value === "." || value === "..")
    throw new Error(`invalid ${name}`);
}

function storedTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`invalid ${name}`);
}

function storedUniqueStrings(
  value: unknown,
  name: string,
  maxCount: number,
  maxLength: number,
  allowEmpty = true,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxCount
  )
    throw new Error(`invalid ${name}`);
  for (const item of value)
    storedString(item, name, maxLength, { singleLine: true });
  if (new Set(value).size !== value.length)
    throw new Error(`duplicate ${name}`);
}

function parseStoredEvidenceRef(value: unknown): void {
  const ref = storedObject(value, "pipeline evidence window");
  storedExactKeys(
    ref,
    [
      "branchDigest",
      "checkpointEntryIds",
      "excerpt",
      "excerptSha256",
      "sessionId",
      "throughLeafId",
      "windowId",
    ],
    "pipeline evidence window",
  );
  storedHash(ref.windowId, "pipeline window id");
  storedStorageId(ref.sessionId, "pipeline session id");
  storedUniqueStrings(
    ref.checkpointEntryIds,
    "pipeline checkpoint ids",
    100,
    200,
    false,
  );
  for (const checkpoint of ref.checkpointEntryIds)
    storedStorageId(checkpoint, "pipeline checkpoint id");
  storedString(ref.throughLeafId, "pipeline leaf id", 200, {
    singleLine: true,
  });
  storedHash(ref.branchDigest, "pipeline branch digest");
  storedString(ref.excerpt, "pipeline excerpt", 400, { allowEmpty: true });
  storedHash(ref.excerptSha256, "pipeline excerpt hash");
  if (sha256(ref.excerpt) !== ref.excerptSha256)
    throw new Error("pipeline excerpt hash mismatch");
}

function parseStoredSafeEvidence(
  value: unknown,
  allowLegacyFrontier: boolean,
): void {
  const evidence = storedObject(value, "pipeline evidence");
  storedExactKeys(
    evidence,
    [
      "records",
      "redactions",
      "tools",
      "version",
      "window",
      "workspace",
      ...(evidence.checkpointFrontiers === undefined
        ? []
        : ["checkpointFrontiers"]),
      ...(evidence.emittedEntryIds === undefined ? [] : ["emittedEntryIds"]),
    ],
    "pipeline evidence",
  );
  if (evidence.version !== 1)
    throw new Error("invalid pipeline evidence version");
  parseStoredEvidenceRef(evidence.window);
  storedString(evidence.workspace, "pipeline workspace", 2_000, {
    singleLine: true,
  });
  if (
    !Array.isArray(evidence.records) ||
    evidence.records.length > 201 ||
    JSON.stringify(evidence.records).length > 64_000
  )
    throw new Error("invalid pipeline records");
  validateTranscript(evidence.records, { partial: true });
  const records = evidence.records;
  const first = records[0];
  if (
    first?.role !== "meta" ||
    first.source !== "pi" ||
    records.some((record) => record.role === "reasoning")
  )
    throw new Error("invalid safe pipeline records");
  if (!Array.isArray(evidence.tools) || evidence.tools.length > 100)
    throw new Error("invalid pipeline tools");
  const toolNames = new Set<string>();
  for (const item of evidence.tools) {
    const tool = storedObject(item, "pipeline tool");
    storedExactKeys(
      tool,
      ["calls", "errors", "name", "successes"],
      "pipeline tool",
    );
    storedString(tool.name, "pipeline tool name", 200, { singleLine: true });
    if (toolNames.has(tool.name)) throw new Error("duplicate pipeline tool");
    toolNames.add(tool.name);
    for (const field of ["calls", "errors", "successes"] as const)
      if (!Number.isSafeInteger(tool[field]) || (tool[field] as number) < 0)
        throw new Error(`invalid pipeline tool ${field}`);
  }
  const redactions = storedObject(evidence.redactions, "pipeline redactions");
  for (const [name, count] of Object.entries(redactions)) {
    storedString(name, "pipeline redaction name", 100, { singleLine: true });
    if (!Number.isSafeInteger(count) || (count as number) < 1)
      throw new Error("invalid pipeline redaction count");
  }
  const window = evidence.window as { checkpointEntryIds: string[] };
  if (evidence.checkpointFrontiers !== undefined) {
    const frontiers = storedObject(
      evidence.checkpointFrontiers,
      "pipeline checkpoint frontiers",
    );
    storedExactKeys(
      frontiers,
      window.checkpointEntryIds,
      "pipeline checkpoint frontiers",
    );
    for (const frontier of Object.values(frontiers))
      storedString(frontier, "pipeline checkpoint frontier", 200, {
        singleLine: true,
      });
  }
  if (evidence.emittedEntryIds !== undefined)
    storedUniqueStrings(
      evidence.emittedEntryIds,
      "pipeline emitted entry ids",
      20_000,
      200,
    );
  if (
    (evidence.checkpointFrontiers === undefined) !==
      (evidence.emittedEntryIds === undefined) ||
    (!allowLegacyFrontier &&
      (evidence.checkpointFrontiers === undefined ||
        evidence.emittedEntryIds === undefined))
  )
    throw new Error("invalid pipeline evidence frontier fields");
  if (
    evidence.checkpointFrontiers !== undefined &&
    evidence.emittedEntryIds !== undefined &&
    Object.values(evidence.checkpointFrontiers as Record<string, string>).some(
      (frontier) =>
        !(evidence.emittedEntryIds as string[]).includes(frontier as string),
    )
  )
    throw new Error("pipeline checkpoint frontier is outside evidence");
}

function parseStoredCatalogEntry(value: unknown, target: boolean): void {
  const entry = storedObject(
    value,
    target ? "pipeline target" : "pipeline catalog entry",
  );
  storedExactKeys(
    entry,
    [
      "description",
      "keywords",
      "kind",
      "legacy",
      "memoryId",
      "path",
      "scope",
      "sha256",
      "status",
      "title",
      "triggers",
      "updated",
      ...(target ? ["body"] : []),
    ],
    target ? "pipeline target" : "pipeline catalog entry",
  );
  if (typeof entry.memoryId !== "string" || !MEMORY_ID.test(entry.memoryId))
    throw new Error("invalid pipeline memory id");
  storedString(entry.path, "pipeline memory path", 240, { singleLine: true });
  if (entry.path.startsWith("/") || entry.path.includes(".."))
    throw new Error("invalid pipeline memory path");
  storedString(entry.title, "pipeline memory title", 8_192, {
    singleLine: true,
  });
  storedString(entry.description, "pipeline memory description", 8_192, {
    singleLine: true,
  });
  storedString(entry.kind, "pipeline memory kind", 100, { singleLine: true });
  storedString(entry.scope, "pipeline memory scope", 500, { singleLine: true });
  storedUniqueStrings(entry.triggers, "pipeline memory triggers", 100, 500);
  storedUniqueStrings(entry.keywords, "pipeline memory keywords", 100, 500);
  if (entry.status !== "active")
    throw new Error("invalid pipeline memory status");
  storedHash(entry.sha256, "pipeline memory hash");
  storedString(entry.updated, "pipeline memory updated date", 40, {
    singleLine: true,
  });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.updated) ||
    new Date(`${entry.updated}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      entry.updated
  )
    throw new Error("invalid pipeline memory updated date");
  if (typeof entry.legacy !== "boolean")
    throw new Error("invalid pipeline memory legacy flag");
  if (target)
    storedString(entry.body, "pipeline target body", 12_000, {
      allowEmpty: true,
    });
}

function parseStoredCatalog(value: unknown): Catalog {
  const catalog = storedObject(value, "pipeline catalog");
  storedExactKeys(
    catalog,
    ["entries", "generatedAt", "version"],
    "pipeline catalog",
  );
  if (catalog.version !== 2)
    throw new Error("invalid pipeline catalog version");
  storedTimestamp(catalog.generatedAt, "pipeline catalog timestamp");
  if (!Array.isArray(catalog.entries) || catalog.entries.length > 100)
    throw new Error("invalid pipeline catalog entries");
  catalog.entries.forEach((entry) => parseStoredCatalogEntry(entry, false));
  const entries = catalog.entries as CatalogEntry[];
  if (
    new Set(entries.map((entry) => entry.memoryId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    throw new Error("duplicate pipeline catalog entry");
  return catalog as Catalog;
}

function parseStoredPipelineBase(
  input: Record<string, unknown>,
  version: 2 | 3 | 4,
): void {
  storedExactKeys(
    input,
    [
      "batchId",
      "catalog",
      "createdAt",
      "evidence",
      "pending",
      "promptVersion",
      "reviewSignals",
      "runId",
      "scope",
      "skills",
      "targets",
      "version",
      ...(input.model === undefined ? [] : ["model"]),
      ...(input.reasoning === undefined ? [] : ["reasoning"]),
      ...(version >= 3 ? ["observations", "rollbackEvidence"] : []),
      ...(version === 4 && input.supersessionBasis !== undefined
        ? ["supersessionBasis"]
        : []),
    ],
    `pipeline v${version}`,
  );
  if (input.version !== version || input.promptVersion !== version)
    throw new Error(`invalid pipeline v${version} version`);
  storedHash(input.runId, "pipeline run id");
  storedHash(input.batchId, "pipeline batch id");
  storedTimestamp(input.createdAt, "pipeline timestamp");
  storedString(input.scope, "pipeline scope", 500, { singleLine: true });
  if (input.model !== undefined)
    storedString(input.model, "pipeline model", 200, { singleLine: true });
  if (
    input.reasoning !== undefined &&
    !REASONING_LEVELS.includes(input.reasoning as ReasoningLevel)
  )
    throw new Error("invalid pipeline reasoning");
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.length > 100
  )
    throw new Error("invalid pipeline evidence");
  input.evidence.forEach((item) =>
    parseStoredSafeEvidence(item, version === 2),
  );
  const evidence = input.evidence as SafeEvidence[];
  if (
    new Set(evidence.map((item) => item.window.windowId)).size !==
    evidence.length
  )
    throw new Error("duplicate pipeline evidence id");
  const catalog = parseStoredCatalog(input.catalog);
  if (!Array.isArray(input.targets) || input.targets.length > 8)
    throw new Error("invalid pipeline targets");
  input.targets.forEach((target) => parseStoredCatalogEntry(target, true));
  const targets = input.targets as PipelineInput["targets"];
  if (new Set(targets.map((target) => target.memoryId)).size !== targets.length)
    throw new Error("duplicate pipeline target id");
  for (const target of targets) {
    const entry = catalog.entries.find(
      (candidate) => candidate.memoryId === target.memoryId,
    );
    const { body: _body, ...targetEntry } = target;
    if (
      !entry ||
      !Object.keys(entry).every(
        (key) =>
          JSON.stringify(entry[key as keyof CatalogEntry]) ===
          JSON.stringify(targetEntry[key as keyof CatalogEntry]),
      )
    )
      throw new Error("pipeline target is outside catalog");
  }
  if (!Array.isArray(input.pending) || input.pending.length > 20)
    throw new Error("invalid pipeline pending proposals");
  for (const value of input.pending) {
    const pending = storedObject(value, "pipeline pending proposal");
    storedExactKeys(
      pending,
      ["id", "lane", "operation", "summary"],
      "pipeline pending proposal",
    );
    if (typeof pending.id !== "string" || !PROPOSAL_ID.test(pending.id))
      throw new Error("invalid pipeline pending proposal id");
    if (pending.lane !== "memory" && pending.lane !== "skill")
      throw new Error("invalid pipeline pending proposal lane");
    storedString(pending.operation, "pipeline pending operation", 40, {
      singleLine: true,
    });
    storedString(pending.summary, "pipeline pending summary", 401, {
      singleLine: true,
    });
  }
  const pending = input.pending as PipelineInput["pending"];
  if (new Set(pending.map((item) => item.id)).size !== pending.length)
    throw new Error("duplicate pipeline pending proposal id");
  if (!Array.isArray(input.reviewSignals) || input.reviewSignals.length > 20)
    throw new Error("invalid pipeline review signals");
  for (const value of input.reviewSignals) {
    const signal = storedObject(value, "pipeline review signal");
    storedExactKeys(
      signal,
      ["decision", "lane", "operation", "reasonCode"],
      "pipeline review signal",
    );
    storedString(signal.decision, "pipeline review decision", 40, {
      singleLine: true,
    });
    storedString(signal.reasonCode, "pipeline review reason code", 40, {
      singleLine: true,
    });
    if (signal.lane !== "memory" && signal.lane !== "skill")
      throw new Error("invalid pipeline review lane");
    storedString(signal.operation, "pipeline review operation", 40, {
      singleLine: true,
    });
  }
  if (!Array.isArray(input.skills) || input.skills.length > 100)
    throw new Error("invalid pipeline skills");
  for (const value of input.skills) {
    const skill = storedObject(value, "pipeline skill");
    storedExactKeys(skill, ["description", "name", "sha256"], "pipeline skill");
    storedString(skill.name, "pipeline skill name", 80, { singleLine: true });
    storedString(skill.description, "pipeline skill description", 300, {
      singleLine: true,
    });
    storedHash(skill.sha256, "pipeline skill hash");
  }
  const skills = input.skills as PipelineInput["skills"];
  if (new Set(skills.map((item) => item.name)).size !== skills.length)
    throw new Error("duplicate pipeline skill name");
  if (version >= 3) {
    if (!Array.isArray(input.observations) || input.observations.length > 100)
      throw new Error("invalid pipeline observations");
    const observations = input.observations.map(parseTurnObservation);
    observations.forEach((item) => validateTurnObservationRefs(item, catalog));
    if (
      new Set(observations.map((item) => item.evidenceId)).size !==
      observations.length
    )
      throw new Error("duplicate pipeline observation id");
    if (
      !Array.isArray(input.rollbackEvidence) ||
      input.rollbackEvidence.length > 100
    )
      throw new Error("invalid pipeline rollback evidence");
    const rollbacks = input.rollbackEvidence.map((item) =>
      parseRollbackEvidence(item, catalog),
    );
    if (
      new Set(rollbacks.map((item) => item.evidenceId)).size !==
      rollbacks.length
    )
      throw new Error("duplicate pipeline rollback evidence id");
  }
}

function parseStoredPipelineInputV2(
  input: Record<string, unknown>,
): PipelineInputV2 {
  parseStoredPipelineBase(input, 2);
  return input as PipelineInputV2;
}

function parseStoredPipelineInputV3(
  input: Record<string, unknown>,
): PipelineInputV3 {
  parseStoredPipelineBase(input, 3);
  return input as PipelineInputV3;
}

function parseStoredPipelineInputV4(
  input: Record<string, unknown>,
): PipelineInputV4 {
  parseStoredPipelineBase(input, 4);
  if (input.supersessionBasis === undefined) {
    if ((input.pending as PipelineInput["pending"]).length !== 0)
      throw new Error("missing pipeline supersession basis");
    return input as PipelineInputV4;
  }
  if (
    !Array.isArray(input.supersessionBasis) ||
    input.supersessionBasis.length > 20
  )
    throw new Error("invalid pipeline supersession basis");
  for (const value of input.supersessionBasis) {
    const basis = storedObject(value, "pipeline supersession basis");
    storedExactKeys(
      basis,
      ["id", "operation", "runId"],
      "pipeline supersession basis",
    );
    if (typeof basis.id !== "string" || !PROPOSAL_ID.test(basis.id))
      throw new Error("invalid pipeline supersession id");
    storedString(basis.runId, "pipeline supersession run id", 200, {
      singleLine: true,
    });
    parseStoredProposalOperation(basis.operation);
  }
  const basis = input.supersessionBasis as NonNullable<
    PipelineInputV4["supersessionBasis"]
  >;
  if (new Set(basis.map((item) => item.id)).size !== basis.length)
    throw new Error("duplicate pipeline supersession id");
  const pendingIds = (input.pending as PipelineInput["pending"])
    .map((item) => item.id)
    .sort();
  if (
    JSON.stringify(basis.map((item) => item.id).sort()) !==
    JSON.stringify(pendingIds)
  )
    throw new Error("pipeline supersession basis does not match pending");
  return input as PipelineInputV4;
}

export function parseStoredPipelineInput(raw: string): PipelineInput {
  try {
    const input = storedObject(JSON.parse(raw), "stored pipeline input");
    if (input.version === 2) return parseStoredPipelineInputV2(input);
    if (input.version === 3) return parseStoredPipelineInputV3(input);
    if (input.version === 4) return parseStoredPipelineInputV4(input);
    throw new Error("unsupported pipeline input version");
  } catch (error) {
    throw new Error(
      `invalid stored pipeline input: ${
        error instanceof Error ? error.message : "unknown parse failure"
      }`,
    );
  }
}

export function frozenPipelineEvidence(input: PipelineInput): SafeEvidence[] {
  switch (input.version) {
    case 2:
    case 3:
    case 4:
      return input.evidence;
  }
}

export function parseStoredPipelineResult(
  raw: string,
  input: PipelineInput,
): PipelineResult {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid stored pipeline result");
  const record = value as Record<string, unknown>;
  const expectedCheckpoints = input.evidence.flatMap(
    (item) => item.window.checkpointEntryIds,
  );
  if (
    Object.keys(record).sort().join(",") !==
      "action,coveredCheckpointIds,proposalIds,runId" ||
    record.runId !== input.runId ||
    (record.action !== "skip" && record.action !== "propose") ||
    !Array.isArray(record.proposalIds) ||
    !record.proposalIds.every((id: unknown) => typeof id === "string") ||
    new Set(record.proposalIds).size !== record.proposalIds.length ||
    !Array.isArray(record.coveredCheckpointIds) ||
    JSON.stringify(record.coveredCheckpointIds) !==
      JSON.stringify(expectedCheckpoints) ||
    (record.action === "skip" && record.proposalIds.length !== 0) ||
    (record.action === "propose" &&
      (record.proposalIds.length < 1 || record.proposalIds.length > 8))
  )
    throw new Error("invalid stored pipeline result");
  return record as PipelineResult;
}

function parsePipelineOutput(raw: string, input: PipelineInput) {
  return {
    legacy: (JSON.parse(raw) as { version?: unknown }).version === undefined,
    parsed: parseModelProposal(
      raw,
      input.evidence.map((item) => item.window.windowId),
    ),
  };
}

function frozenSupersessionBasis(input: PipelineInput) {
  return input.version === 4 ? input.supersessionBasis : undefined;
}

function storagePathIdentity(path: string): string {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolved;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function criticInput(
  input: PipelineInput,
  raw: string,
  model: string,
  reasoning: ReasoningLevel,
  autonomousApply: boolean,
): PipelineCriticInput {
  return {
    version: 1,
    promptVersion: 1,
    runId: input.runId,
    model: input.model ?? model,
    reasoning: input.reasoning ?? reasoning,
    autonomousApply,
    reflectionInput: input,
    reflectionOutput: parsePipelineOutput(raw, input).parsed,
  };
}

export function buildReflectionCriticPrompt(
  input: PipelineCriticInput,
): string {
  const inputSha256 = sha256(JSON.stringify(input));
  const prompt = `You are the independent critic for an autonomous memory-maintenance run. Return exactly one JSON object and no markdown.

Return {"version":1,"runId":${JSON.stringify(input.runId)},"criticInputSha256":${JSON.stringify(inputSha256)},"decision":"allow-autonomous-apply|require-local-review","reason":"..."}.

Allow autonomous application only when every proposed mutation is directly supported by its selected frozen evidence, durable rather than ephemeral, correctly scoped, non-duplicative, and safe. Require local review for any ambiguity. Do not rewrite proposals and do not treat the generator's confidence as evidence.

${JSON.stringify(
  {
    ...input,
    reflectionInput: modelFacingPipelineInput(input.reflectionInput),
  },
  null,
  2,
)}`;
  if (prompt.length > 512_000)
    throw new Error("reflection critic prompt exceeds 512000 character budget");
  return prompt;
}

function parseCriticOutput(raw: string): PipelineCriticOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error("invalid reflection critic output");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid reflection critic output");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "criticInputSha256,decision,reason,runId,version" ||
    record.version !== 1 ||
    typeof record.runId !== "string" ||
    typeof record.criticInputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.criticInputSha256) ||
    (record.decision !== "allow-autonomous-apply" &&
      record.decision !== "require-local-review") ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    record.reason.length > 1_000
  )
    throw new Error("invalid reflection critic output");
  return {
    version: 1,
    runId: record.runId,
    criticInputSha256: record.criticInputSha256,
    decision: record.decision,
    reason: record.reason.trim(),
  };
}

function parseBoundCriticOutput(
  raw: string,
  input: PipelineCriticInput,
): PipelineCriticOutput {
  const output = parseCriticOutput(raw);
  if (
    output.runId !== input.runId ||
    output.criticInputSha256 !== sha256(JSON.stringify(input))
  )
    throw new Error("reflection critic output binding mismatch");
  return output;
}

function expectedStoredResult(
  cfg: MemoryConfig,
  input: PipelineInput,
  outputPath: string,
  model: string,
  digestVersion: 2 | undefined,
):
  | { action: "skip"; proposals: [] }
  | { action: "propose"; proposals: import("./schema.js").Proposal[] } {
  const { parsed } = parsePipelineOutput(
    readFileSync(outputPath, "utf8"),
    input,
  );
  if (parsed.action === "skip") return { action: "skip", proposals: [] };
  return {
    action: "propose",
    proposals: materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(cfg),
      ...(frozenSupersessionBasis(input)
        ? { supersessionBasis: frozenSupersessionBasis(input) }
        : {}),
      createdAt: input.createdAt,
      autonomous: true,
      ...(digestVersion === 2 ? { digestVersion } : {}),
    }),
  };
}

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

function score(entry: CatalogEntry, query: Set<string>): number {
  const haystack = words(
    [
      entry.title,
      entry.description,
      entry.scope,
      ...entry.triggers,
      ...entry.keywords,
    ].join(" "),
  );
  let result = entry.scope === "global" ? 1 : 0;
  for (const word of query) if (haystack.has(word)) result += 1;
  return result;
}

export function scopeCatalog(catalog: Catalog, workspaces: string[]): Catalog {
  return {
    ...catalog,
    entries: catalog.entries
      .filter((entry) =>
        workspaces.some(
          (workspace) => memoryScopeRank(entry.scope, workspace) > 0,
        ),
      )
      .sort(
        (a, b) =>
          b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path),
      )
      .slice(0, 100),
  };
}

export const PRODUCTION_TARGET_LIMIT = 8;

export function rankRetrieval(
  catalog: Catalog,
  queryText: string,
  workspaces: string[],
): CatalogEntry[] {
  const query = words(`${queryText} ${workspaces.join(" ")}`);
  return scopeCatalog(catalog, workspaces)
    .entries.map((entry) => ({ entry, score: score(entry, query) }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updated.localeCompare(a.entry.updated) ||
        a.entry.memoryId.localeCompare(b.entry.memoryId),
    )
    .slice(0, PRODUCTION_TARGET_LIMIT)
    .map(({ entry }) => entry);
}

function selectTargets(
  cfg: MemoryConfig,
  catalog: Catalog,
  evidence: SafeEvidence[],
): PipelineInput["targets"] {
  const query = evidence
    .flatMap((item) => [
      item.window.excerpt,
      ...item.tools.map((tool) => tool.name),
    ])
    .join(" ");
  const workspaces = evidence.map((item) => item.workspace);
  return rankRetrieval(catalog, query, workspaces).map((entry) => ({
    ...entry,
    body: readFileSync(
      contained(cfg.root, join(cfg.root, entry.path)),
      "utf8",
    ).slice(0, 12_000),
  }));
}

function skillDescriptions(root: string): PipelineInput["skills"] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const path = contained(root, join(root, entry.name, "SKILL.md"));
      if (!existsSync(path) || !statSync(path).isFile()) return undefined;
      const text = readFileSync(path, "utf8");
      const description = /^description:\s*["']?(.+?)["']?$/m
        .exec(text)?.[1]
        ?.trim();
      return description
        ? {
            name: entry.name,
            description: description.slice(0, 300),
            sha256: sha256(text),
          }
        : undefined;
    })
    .filter(
      (entry): entry is { name: string; description: string; sha256: string } =>
        entry !== undefined,
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100);
}

function operationSummary(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function freezePipelineInput(
  cfg: MemoryConfig,
  scope: string,
  evidence: SafeEvidence[],
  model: string,
  observations: TurnObservation[] = [],
  reasoning: ReasoningLevel = "low",
): PipelineInput {
  const fullCatalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const catalog = scopeCatalog(
    fullCatalog,
    evidence.map((item) => item.workspace),
  );
  const validatedObservations = deduplicateTurnObservations(observations);
  for (const observation of validatedObservations)
    validateTurnObservationRefs(observation, catalog);
  const scopedIds = new Set(catalog.entries.map((entry) => entry.memoryId));
  const pendingProposals = listProposals(cfg)
    .filter((proposal) => {
      const op = proposal.operation;
      if (op.type === "skill-draft") return true;
      if ("artifact" in op)
        return evidence.some(
          (item) => memoryScopeRank(op.artifact.scope, item.workspace) > 0,
        );
      return "target" in op && scopedIds.has(op.target.memoryId);
    })
    .slice(-20);
  const pending = pendingProposals.map((proposal) => ({
    id: proposal.id,
    lane: proposal.lane,
    operation: proposal.operation.type,
    summary: operationSummary(proposal.operation),
  }));
  const supersessionBasis = pendingProposals.map((proposal) => ({
    id: proposal.id,
    runId: proposal.provenance.runId,
    operation: proposal.operation,
  }));
  const reviewSignals = readReviewReceipts(cfg)
    .filter((review) => review.reviewer === "local-cli")
    .slice(-40)
    .flatMap((review) => {
      try {
        const proposal = findProposal(cfg, review.proposalId).proposal;
        const operation = proposal.operation;
        const relevant =
          proposal.lane === "skill" ||
          ("artifact" in operation &&
            evidence.some(
              (item) =>
                memoryScopeRank(operation.artifact.scope, item.workspace) > 0,
            )) ||
          ("target" in operation && scopedIds.has(operation.target.memoryId)) ||
          ("primary" in operation && scopedIds.has(operation.primary.memoryId));
        return relevant
          ? [
              {
                decision: review.decision,
                reasonCode: review.reason.code,
                lane: proposal.lane,
                operation: operation.type,
              },
            ]
          : [];
      } catch {
        return [];
      }
    })
    .slice(-20);
  const rollbackEvidence = listVerifiedRollbackEvidence(cfg, catalog);
  const windowIds = evidence.map((item) => item.window.windowId).sort();
  const batchId = sha256(`${scope}\0${windowIds.join("\0")}\0v4`);
  const contextHash = sha256(
    JSON.stringify({
      catalog: catalog.entries.map(({ memoryId, sha256: hash }) => [
        memoryId,
        hash,
      ]),
      pending,
      supersessionBasis,
      reviewSignals,
      observations: validatedObservations,
      rollbackEvidence,
      model,
      reasoning,
    }),
  );
  const evidenceHash = sha256(JSON.stringify(evidence));
  const runId = sha256(`${batchId}\0${evidenceHash}\0${contextHash}`);
  return {
    version: 4,
    runId,
    batchId,
    promptVersion: 4,
    model,
    reasoning,
    createdAt: new Date().toISOString(),
    scope,
    evidence,
    catalog,
    targets: selectTargets(cfg, catalog, evidence),
    pending,
    supersessionBasis,
    reviewSignals,
    observations: validatedObservations,
    rollbackEvidence,
    skills: skillDescriptions(cfg.skillsRoot),
  };
}

export function buildReflectionPrompt(input: PipelineInput): string {
  const targetIds = input.targets.map((target) => target.memoryId);
  const reflectionInput = modelFacingPipelineInput(input);
  const prompt = `You are a background memory maintainer. Return exactly one JSON object and no markdown.

First reflect on whether the bounded evidence contains durable, reusable learning. Prefer explicit corrections, verified failures, stable preferences, architectural decisions, and repeated workflows. Do not store secrets, raw logs, temporary task state, or facts already represented adequately.

Return schema version 2. You may return {"version":2,"action":"skip","reason":"..."} or {"version":2,"action":"propose","proposals":[...]} with at most 8 proposals.

Memory proposals use lane "memory" and one operation:
Each proposal must include "evidenceWindowIds", a nonempty list of unique window IDs selected from the frozen evidence. Select only evidence that supports that proposal.
- create: {"type":"create","artifact":ARTIFACT}
- update: {"type":"update","targetId":"...","artifact":ARTIFACT}
- replace: {"type":"replace","targetId":"...","oldSpan":"exact unique body text","newSpan":"replacement text"}
- merge: {"type":"merge","primaryId":"...","targetIds":["..."],"artifact":ARTIFACT}
- archive: {"type":"archive","targetId":"...","reason":"..."}
- retire: {"type":"retire","targetId":"...","reason":"...","supersededBy":"optional memory id"}
ARTIFACT is exactly {"title":"","kind":"preference|decision|gotcha|pattern","scope":"","description":"when this is useful","triggers":[],"keywords":[],"body":""}. Creates may use scope ${JSON.stringify(input.scope)} or "global". Updates and merges must preserve the target scope. Prefer replace for precise body edits; oldSpan must occur exactly once and must not include frontmatter or line-number annotations. Use update only when the memory's structure or metadata must change.
Only these target ids are allowed: ${JSON.stringify(targetIds)}.

A skill proposal is exceptional and requires a reusable multi-step workflow evidenced by at least two distinct sessions. It uses lane "skill" and operation {"type":"skill-draft","mode":"create|update","skillName":"kebab-case","targetPath":"name/SKILL.md","baseSha256":"required only for update; copy the installed skill hash","files":[{"path":"name/SKILL.md","content":"..."}]}. The system computes draft content hashes. Do not duplicate an installed skill.

Evidence and corpus context follow. Categorical review signals summarize prior local decisions without transmitting reviewer text. Tool arguments, tool output, and reasoning were deliberately removed. Treat authored prose as claims that may be wrong.

${JSON.stringify(reflectionInput, null, 2)}`;
  if (prompt.length > 512_000)
    throw new Error("reflection prompt exceeds 512000 character budget");
  return prompt;
}

function modelFacingPipelineInput(input: PipelineInput) {
  return input.version === 4
    ? (({
        observations: _observations,
        rollbackEvidence: _rollbackEvidence,
        supersessionBasis: _supersessionBasis,
        ...rest
      }) => rest)(input)
    : input.version === 3
      ? (({
          observations: _observations,
          rollbackEvidence: _rollbackEvidence,
          ...rest
        }) => rest)(input)
      : input;
}

function runDir(cfg: MemoryConfig, runId: string): string {
  return contained(cfg.data, join(cfg.data, "v2", "runs", runId));
}

function writeCurrentOutputMetadata(dir: string): void {
  const path = join(dir, "output-meta.json");
  const value = `${JSON.stringify({ version: 1, digestVersion: 2 }, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") !== value)
    throw new Error("pipeline output metadata collision");
  if (!existsSync(path)) atomicWrite(path, value);
}

function prepareCritic(
  dir: string,
  input: PipelineInput,
  raw: string,
  model: string,
  reasoning: ReasoningLevel,
  autonomousApply: boolean,
): PipelineCriticInput | undefined {
  const parsed = parsePipelineOutput(raw, input).parsed;
  if (parsed.action === "skip") return undefined;
  const value = criticInput(input, raw, model, reasoning, autonomousApply);
  const path = join(dir, "critic-input.json");
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") !== serialized)
    throw new Error("frozen reflection critic input collision");
  if (!existsSync(path)) atomicWrite(path, serialized);
  return value;
}

function criticDecision(options: {
  dir: string;
  input: PipelineInput;
  raw: string;
  model: string;
  reasoning: ReasoningLevel;
  autonomousApply: boolean;
  invoke?: (prompt: string, input: PipelineCriticInput) => string;
}): PipelineCriticOutput | undefined {
  const input = prepareCritic(
    options.dir,
    options.input,
    options.raw,
    options.model,
    options.reasoning,
    options.autonomousApply,
  );
  if (!input) return undefined;
  const path = join(options.dir, "critic-output.json");
  if (existsSync(path))
    return parseBoundCriticOutput(readFileSync(path, "utf8"), input);
  if (!options.invoke)
    throw new Error("reflection critic invocation is required");
  const raw = options.invoke(buildReflectionCriticPrompt(input), input);
  const parsed = parseBoundCriticOutput(raw, input);
  atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

function existingFrozenInput(
  cfg: MemoryConfig,
  fresh: PipelineInput,
): PipelineInput | undefined {
  const root = contained(cfg.data, join(cfg.data, "v2", "runs"));
  if (!existsSync(root)) return undefined;
  const evidenceHash = sha256(JSON.stringify(fresh.evidence));
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name, "input.json");
    if (!existsSync(path)) continue;
    const candidate = parseStoredPipelineInput(readFileSync(path, "utf8"));
    const legacyAnalysisExists =
      candidate.version === 4 ||
      existsSync(join(root, name, "output.json")) ||
      existsSync(join(root, name, "result.json"));
    if (
      legacyAnalysisExists &&
      (candidate.batchId === fresh.batchId ||
        ((candidate.version === 2 || candidate.version === 3) &&
          candidate.batchId ===
            sha256(
              `${fresh.scope}\0${fresh.evidence
                .map((item) => item.window.windowId)
                .sort()
                .join("\0")}\0v${candidate.version}`,
            ))) &&
      sha256(JSON.stringify(candidate.evidence)) === evidenceHash
    )
      return candidate;
  }
  return undefined;
}

function markLedger(
  cfg: MemoryConfig,
  input: PipelineInput,
  result: PipelineResult,
): void {
  const ledger = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  secureDir(ledger);
  for (const evidence of input.evidence)
    for (const checkpoint of evidence.window.checkpointEntryIds) {
      const throughLeafId =
        evidence.checkpointFrontiers?.[checkpoint] ??
        (input.version === 2 ? evidence.window.throughLeafId : undefined);
      if (
        !throughLeafId ||
        (evidence.emittedEntryIds !== undefined &&
          !evidence.emittedEntryIds.includes(throughLeafId))
      )
        throw new Error(
          `checkpoint frontier is outside frozen evidence ${checkpoint}`,
        );
      const record = {
        version: 2,
        sessionId: evidence.window.sessionId,
        checkpointEntryId: checkpoint,
        throughLeafId,
        branchDigest: evidence.window.branchDigest,
        runId: input.runId,
        action: result.action,
        proposalIds: result.proposalIds,
        coveredAt: new Date().toISOString(),
      };
      const identity = `${evidence.window.sessionId}--${checkpoint}`;
      const path = contained(ledger, join(ledger, `${identity}.json`));
      const value = `${JSON.stringify(record, null, 2)}\n`;
      if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, "utf8")) as {
          runId?: string;
        };
        if (previous.runId !== input.runId)
          throw new Error(`checkpoint ledger collision ${identity}`);
      } else atomicWrite(path, value);
    }
}

export type PipelineBatchOptions = {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  reasoning?: ReasoningLevel;
  observations?: TurnObservation[];
  invoke: (prompt: string, input: PipelineInput) => string;
  criticInvoke?: (prompt: string, input: PipelineCriticInput) => string;
  skipExternal?: boolean;
  autoApplyMemory?: boolean;
  deferApply?: boolean;
};

function preparePipelineBatch(options: PipelineBatchOptions): {
  input: PipelineInput;
  dir: string;
} {
  const fresh = freezePipelineInput(
    options.cfg,
    options.scope,
    options.evidence,
    options.model,
    options.observations,
    options.reasoning ?? "low",
  );
  const input = existingFrozenInput(options.cfg, fresh) || fresh;
  const dir = runDir(options.cfg, input.runId);
  secureDir(dir);
  const inputPath = join(dir, "input.json");
  const inputValue = `${JSON.stringify(input, null, 2)}\n`;
  if (existsSync(inputPath) && readFileSync(inputPath, "utf8") !== inputValue)
    throw new Error("frozen pipeline input collision");
  if (!existsSync(inputPath)) atomicWrite(inputPath, inputValue);
  if (
    ((input.model !== undefined && input.model !== options.model) ||
      (input.reasoning !== undefined &&
        input.reasoning !== (options.reasoning ?? "low"))) &&
    !existsSync(join(dir, "output.json")) &&
    !existsSync(join(dir, "result.json"))
  )
    throw new Error(
      input.model !== undefined && input.model !== options.model
        ? `frozen pipeline model ${input.model} does not match configured model ${options.model}`
        : `frozen pipeline reasoning ${input.reasoning} does not match configured reasoning ${options.reasoning ?? "low"}`,
    );
  return { input, dir };
}

export function processPipelineBatch(options: {
  cfg: MemoryConfig;
  scope: string;
  evidence: SafeEvidence[];
  model: string;
  reasoning?: ReasoningLevel;
  observations?: TurnObservation[];
  invoke: (prompt: string, input: PipelineInput) => string;
  criticInvoke?: (prompt: string, input: PipelineCriticInput) => string;
  skipExternal?: boolean;
  autoApplyMemory?: boolean;
  deferApply?: boolean;
}): PipelineResult {
  const { input, dir } = preparePipelineBatch(options);
  const outputPath = join(dir, "output.json");
  const outputMetadataPath = join(dir, "output-meta.json");
  const resultPath = join(dir, "result.json");
  if (existsSync(resultPath)) {
    const result = parseStoredPipelineResult(
      readFileSync(resultPath, "utf8"),
      input,
    );
    const stored = result.proposalIds.map(
      (id) => findProposal(options.cfg, id).proposal,
    );
    const frozenModel =
      input.model ?? stored[0]?.provenance.model ?? options.model;
    const expected = expectedStoredResult(
      options.cfg,
      input,
      outputPath,
      frozenModel,
      stored.every((proposal) => proposal.digestVersion === 2) ? 2 : undefined,
    );
    if (
      result.action !== expected.action ||
      JSON.stringify(result.proposalIds) !==
        JSON.stringify(expected.proposals.map((proposal) => proposal.id)) ||
      JSON.stringify(stored) !== JSON.stringify(expected.proposals)
    )
      throw new Error("stored pipeline result does not match model output");
    const verdict = criticDecision({
      dir,
      input,
      raw: readFileSync(outputPath, "utf8"),
      model: frozenModel,
      reasoning: input.reasoning ?? options.reasoning ?? "low",
      autonomousApply: options.autoApplyMemory !== false,
      invoke: options.criticInvoke,
    });
    for (const id of options.autoApplyMemory === false
      ? []
      : options.deferApply
        ? []
        : verdict?.decision !== "allow-autonomous-apply"
          ? []
          : result.proposalIds) {
      const proposal = findProposal(options.cfg, id).proposal;
      if (
        proposal.lane === "memory" &&
        proposal.provenance.autonomous === true &&
        proposal.provenance.runId === result.runId
      )
        applyMemoryProposal({
          cfg: options.cfg,
          id,
          actor: "background-reflection",
        });
    }
    markLedger(options.cfg, input, result);
    return result;
  }
  const outputExisted = existsSync(outputPath);
  if (
    !outputExisted &&
    !options.skipExternal &&
    ((input.model && input.model !== options.model) ||
      (input.reasoning && input.reasoning !== (options.reasoning ?? "low")))
  )
    throw new Error(`frozen pipeline configuration mismatch`);
  const raw = outputExisted
    ? readFileSync(outputPath, "utf8")
    : options.skipExternal
      ? '{"version":2,"action":"skip","reason":"external processing disabled"}'
      : options.invoke(buildReflectionPrompt(input), input);
  const { parsed } = parsePipelineOutput(raw, input);
  if (!outputExisted) {
    writeCurrentOutputMetadata(dir);
    atomicWrite(outputPath, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
  }
  const verdict = criticDecision({
    dir,
    input,
    raw,
    model: input.model ?? options.model,
    reasoning: input.reasoning ?? options.reasoning ?? "low",
    autonomousApply: options.autoApplyMemory !== false,
    invoke: options.criticInvoke,
  });
  const coveredCheckpointIds = input.evidence.flatMap(
    (item) => item.window.checkpointEntryIds,
  );
  const proposalIds: string[] = [];
  if (parsed.action === "propose") {
    const proposals = materializeModelProposals({
      result: parsed,
      runId: input.runId,
      model: input.model ?? options.model,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      scope: input.scope,
      evidence: input.evidence.map((item) => item.window),
      catalog: input.catalog,
      pending: listProposals(options.cfg),
      ...(frozenSupersessionBasis(input)
        ? { supersessionBasis: frozenSupersessionBasis(input) }
        : {}),
      createdAt: input.createdAt,
      autonomous: true,
      ...(!existsSync(outputMetadataPath) && input.model === undefined
        ? {}
        : { digestVersion: 2 }),
    });
    assertNonOverlappingMemoryProposals(options.cfg, proposals);
    for (const proposal of proposals) {
      saveProposal(options.cfg, proposal);
      proposalIds.push(proposal.id);
    }
  }
  const result: PipelineResult = {
    runId: input.runId,
    action: parsed.action,
    proposalIds,
    coveredCheckpointIds,
  };
  atomicWrite(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  if (parsed.action === "propose")
    for (const id of options.autoApplyMemory === false ||
    options.deferApply ||
    verdict?.decision !== "allow-autonomous-apply"
      ? []
      : proposalIds) {
      const proposal = findProposal(options.cfg, id).proposal;
      if (proposal.lane === "memory")
        applyMemoryProposal({
          cfg: options.cfg,
          id,
          actor: "background-reflection",
        });
    }
  markLedger(options.cfg, input, result);
  return result;
}

export function coveredCheckpointIds(cfg: MemoryConfig): Set<string> {
  const dir = contained(cfg.data, join(cfg.data, "v2", "ledger"));
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("v1-"))
      .map((name) => basename(name, ".json")),
  );
}

export function reflectionAutonomyState(
  cfg: MemoryConfig,
  runId: string,
  proposalId: string,
): "not-reflection" | "missing" | "allowed" | "local-review" {
  const dir = runDir(cfg, runId);
  const inputPath = join(dir, "input.json");
  if (!existsSync(inputPath)) return "not-reflection";
  const input = parseStoredPipelineInput(readFileSync(inputPath, "utf8"));
  if (input.runId !== runId)
    throw new Error("reflection autonomy run identity mismatch");
  const outputPath = join(dir, "output.json");
  if (!existsSync(outputPath)) return "missing";
  const outputRaw = readFileSync(outputPath, "utf8");
  const parsed = parsePipelineOutput(outputRaw, input);
  if (parsed.parsed.action !== "propose") return "missing";
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) return "missing";
  const result = parseStoredPipelineResult(
    readFileSync(resultPath, "utf8"),
    input,
  );
  if (!result.proposalIds.includes(proposalId)) return "missing";
  const stored = result.proposalIds.map((id) => findProposal(cfg, id).proposal);
  const model = input.model ?? stored[0]?.provenance.model;
  if (!model) return "missing";
  const expected = expectedStoredResult(
    cfg,
    input,
    outputPath,
    model,
    stored.every((proposal) => proposal.digestVersion === 2) ? 2 : undefined,
  );
  if (
    result.action !== expected.action ||
    JSON.stringify(result.proposalIds) !==
      JSON.stringify(expected.proposals.map((proposal) => proposal.id)) ||
    JSON.stringify(stored) !== JSON.stringify(expected.proposals)
  )
    throw new Error("reflection autonomy result does not match output");
  const criticInputPath = join(dir, "critic-input.json");
  if (!existsSync(criticInputPath)) return "missing";
  const expectedCritic = criticInput(
    input,
    outputRaw,
    model,
    input.reasoning ?? stored[0]?.provenance.reasoning ?? "low",
    true,
  );
  if (
    readFileSync(criticInputPath, "utf8") !==
    `${JSON.stringify(expectedCritic, null, 2)}\n`
  )
    return "local-review";
  const criticPath = join(dir, "critic-output.json");
  if (!existsSync(criticPath)) return "missing";
  return parseBoundCriticOutput(
    readFileSync(criticPath, "utf8"),
    expectedCritic,
  ).decision === "allow-autonomous-apply"
    ? "allowed"
    : "local-review";
}

export async function processPipelineBatches(
  options: Array<
    Omit<PipelineBatchOptions, "criticInvoke" | "invoke"> & {
      invoke: (
        prompt: string,
        input: PipelineInput,
      ) => string | Promise<string>;
      criticInvoke?: (
        prompt: string,
        input: PipelineCriticInput,
      ) => string | Promise<string>;
    }
  >,
  concurrencyValue: string | undefined = process.env.PI_MEMORY_CONCURRENCY,
): Promise<PipelineResult[]> {
  const parsedConcurrency =
    concurrencyValue === undefined ? 2 : Number(concurrencyValue);
  if (
    !Number.isInteger(parsedConcurrency) ||
    parsedConcurrency < 1 ||
    parsedConcurrency > 8
  )
    throw new Error("PI_MEMORY_CONCURRENCY must be an integer from 1 to 8");

  const prepared = options.map((option) => ({
    option,
    ...preparePipelineBatch(option as PipelineBatchOptions),
  }));
  const frozenModel = (item: (typeof prepared)[number]): string => {
    if (item.input.model) return item.input.model;
    const resultPath = join(item.dir, "result.json");
    if (!existsSync(resultPath)) return item.option.model;
    const result = parseStoredPipelineResult(
      readFileSync(resultPath, "utf8"),
      item.input,
    );
    return (
      (result.proposalIds[0]
        ? findProposal(item.option.cfg, result.proposalIds[0]).proposal
            .provenance.model
        : undefined) ?? item.option.model
    );
  };
  const runWave = async (
    worker: (index: number) => void | Promise<void>,
  ): Promise<void> => {
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(parsedConcurrency, prepared.length) },
        async () => {
          for (;;) {
            const index = next++;
            if (index >= prepared.length) return;
            await worker(index);
          }
        },
      ),
    );
  };
  const analyses = new Array<string | undefined>(prepared.length);
  await runWave(async (index) => {
    const item = prepared[index]!;
    const outputPath = join(item.dir, "output.json");
    const resultPath = join(item.dir, "result.json");
    if (existsSync(outputPath) || existsSync(resultPath)) return;
    analyses[index] = item.option.skipExternal
      ? '{"version":2,"action":"skip","reason":"external processing disabled"}'
      : await item.option.invoke(buildReflectionPrompt(item.input), item.input);
    parsePipelineOutput(analyses[index]!, item.input);
  });
  prepared.forEach((item, index) => {
    const raw = analyses[index];
    if (raw !== undefined) {
      const inputPath = join(item.dir, "input.json");
      const expected = `${JSON.stringify(item.input, null, 2)}\n`;
      if (
        !existsSync(inputPath) ||
        readFileSync(inputPath, "utf8") !== expected
      )
        throw new Error("frozen pipeline input changed during analysis");
      writeCurrentOutputMetadata(item.dir);
      atomicWrite(
        join(item.dir, "output.json"),
        `${JSON.stringify(JSON.parse(raw), null, 2)}\n`,
      );
    }
  });

  const critiques = new Array<string | undefined>(prepared.length);
  await runWave(async (index) => {
    const item = prepared[index]!;
    const outputPath = join(item.dir, "output.json");
    const raw = readFileSync(outputPath, "utf8");
    const input = prepareCritic(
      item.dir,
      item.input,
      raw,
      frozenModel(item),
      item.input.reasoning ?? item.option.reasoning ?? "low",
      item.option.autoApplyMemory !== false,
    );
    if (!input) return;
    const criticOutputPath = join(item.dir, "critic-output.json");
    if (existsSync(criticOutputPath)) {
      parseBoundCriticOutput(readFileSync(criticOutputPath, "utf8"), input);
      return;
    }
    if (!item.option.criticInvoke)
      throw new Error("reflection critic invocation is required");
    critiques[index] = await item.option.criticInvoke(
      buildReflectionCriticPrompt(input),
      input,
    );
    parseBoundCriticOutput(critiques[index]!, input);
  });
  prepared.forEach((item, index) => {
    const raw = critiques[index];
    if (raw !== undefined) {
      const input = prepareCritic(
        item.dir,
        item.input,
        readFileSync(join(item.dir, "output.json"), "utf8"),
        frozenModel(item),
        item.input.reasoning ?? item.option.reasoning ?? "low",
        item.option.autoApplyMemory !== false,
      )!;
      atomicWrite(
        join(item.dir, "critic-output.json"),
        `${JSON.stringify(parseBoundCriticOutput(raw, input), null, 2)}\n`,
      );
    }
  });

  const proposalsByMemoryRoot = new Map<
    string,
    { cfg: MemoryConfig; proposals: import("./schema.js").Proposal[] }
  >();
  for (const item of prepared) {
    const outputPath = join(item.dir, "output.json");
    const parsed = parsePipelineOutput(
      readFileSync(outputPath, "utf8"),
      item.input,
    ).parsed;
    const resultPath = join(item.dir, "result.json");
    const storedResult = existsSync(resultPath)
      ? parseStoredPipelineResult(readFileSync(resultPath, "utf8"), item.input)
      : undefined;
    if (parsed.action === "skip") {
      if (storedResult && storedResult.action !== "skip")
        throw new Error("stored pipeline result does not match model output");
      continue;
    }
    const found = storedResult
      ? storedResult.proposalIds.map((id) => findProposal(item.option.cfg, id))
      : [];
    const stored = found.map((candidate) => candidate.proposal);
    const proposals = materializeModelProposals({
      result: parsed,
      runId: item.input.runId,
      model:
        item.input.model ?? stored[0]?.provenance.model ?? frozenModel(item),
      ...(item.input.reasoning ? { reasoning: item.input.reasoning } : {}),
      scope: item.input.scope,
      evidence: item.input.evidence.map((evidence) => evidence.window),
      catalog: item.input.catalog,
      pending: listProposals(item.option.cfg),
      ...(frozenSupersessionBasis(item.input)
        ? { supersessionBasis: frozenSupersessionBasis(item.input) }
        : {}),
      createdAt: item.input.createdAt,
      autonomous: true,
      ...((
        storedResult
          ? stored.every((proposal) => proposal.digestVersion === 2)
          : existsSync(join(item.dir, "output-meta.json"))
      )
        ? { digestVersion: 2 as const }
        : {}),
    });
    let preflight = proposals;
    if (storedResult) {
      if (
        JSON.stringify(storedResult.proposalIds) !==
          JSON.stringify(proposals.map((proposal) => proposal.id)) ||
        JSON.stringify(stored) !== JSON.stringify(proposals)
      )
        throw new Error("stored pipeline result does not match model output");
      preflight = proposals.filter(
        (_proposal, index) => !found[index]?.path.includes("/reviewed/"),
      );
    }
    if (preflight.length) {
      const memoryRootId = storagePathIdentity(item.option.cfg.root);
      const group = proposalsByMemoryRoot.get(memoryRootId) ?? {
        cfg: item.option.cfg,
        proposals: [],
      };
      group.proposals.push(...preflight);
      proposalsByMemoryRoot.set(memoryRootId, group);
    }
  }
  for (const { cfg, proposals } of proposalsByMemoryRoot.values())
    assertNonOverlappingMemoryProposals(cfg, proposals);

  const results = prepared.map((item) =>
    processPipelineBatch({
      ...item.option,
      deferApply: true,
      invoke: () => {
        throw new Error("analysis output was not published");
      },
      criticInvoke: () => {
        throw new Error("critic output was not published");
      },
    }),
  );
  prepared.forEach((item, index) => {
    if (item.option.autoApplyMemory === false) return;
    const result = results[index]!;
    for (const id of result.proposalIds) {
      if (
        reflectionAutonomyState(item.option.cfg, result.runId, id) !== "allowed"
      )
        continue;
      const proposal = findProposal(item.option.cfg, id).proposal;
      if (proposal.lane === "memory")
        applyMemoryProposal({
          cfg: item.option.cfg,
          id,
          actor: "background-reflection",
        });
    }
  });
  return results;
}
