import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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
  supersessionBasis: Array<{
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

export function parseStoredPipelineInput(raw: string): PipelineInput {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid stored pipeline input");
  const input = value as Record<string, unknown>;
  const version = input.version;
  const expectedFields = [
    "batchId",
    "catalog",
    "createdAt",
    "evidence",
    "model",
    "pending",
    "promptVersion",
    "reviewSignals",
    "reasoning",
    "runId",
    "scope",
    "skills",
    "targets",
    "version",
    ...(version === 3 || version === 4
      ? ["observations", "rollbackEvidence"]
      : []),
    ...(version === 4 ? ["supersessionBasis"] : []),
  ];
  if (input.model === undefined)
    expectedFields.splice(expectedFields.indexOf("model"), 1);
  if (input.reasoning === undefined)
    expectedFields.splice(expectedFields.indexOf("reasoning"), 1);
  if (
    Object.keys(input).sort().join(",") !== expectedFields.sort().join(",") ||
    !(
      (version === 2 && input.promptVersion === 2) ||
      (version === 3 && input.promptVersion === 3) ||
      (version === 4 && input.promptVersion === 4)
    ) ||
    typeof input.runId !== "string" ||
    typeof input.batchId !== "string" ||
    typeof input.createdAt !== "string" ||
    typeof input.scope !== "string" ||
    (input.model !== undefined && typeof input.model !== "string") ||
    (input.reasoning !== undefined &&
      (typeof input.reasoning !== "string" ||
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          input.reasoning,
        ))) ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return false;
      const window = (item as { window?: unknown }).window;
      return (
        typeof window === "object" &&
        window !== null &&
        !Array.isArray(window) &&
        typeof (window as { windowId?: unknown }).windowId === "string" &&
        Array.isArray(
          (window as { checkpointEntryIds?: unknown }).checkpointEntryIds,
        ) &&
        (window as { checkpointEntryIds: unknown[] }).checkpointEntryIds.every(
          (id) => typeof id === "string",
        )
      );
    }) ||
    !Array.isArray(input.targets) ||
    !Array.isArray(input.pending) ||
    (version === 4 &&
      (!Array.isArray(input.supersessionBasis) ||
        !input.supersessionBasis.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).runId === "string" &&
            typeof (item as Record<string, unknown>).operation === "object" &&
            (item as Record<string, unknown>).operation !== null,
        ))) ||
    !Array.isArray(input.reviewSignals) ||
    !Array.isArray(input.skills) ||
    typeof input.catalog !== "object" ||
    input.catalog === null ||
    ((version === 3 || version === 4) &&
      (!Array.isArray(input.observations) ||
        !input.observations.every((item) => {
          try {
            const observation = parseTurnObservation(item);
            validateTurnObservationRefs(observation, input.catalog as Catalog);
            return true;
          } catch {
            return false;
          }
        }) ||
        !Array.isArray(input.rollbackEvidence) ||
        !input.rollbackEvidence.every((item) => {
          try {
            parseRollbackEvidence(item, input.catalog as Catalog);
            return true;
          } catch {
            return false;
          }
        })))
  )
    throw new Error("invalid stored pipeline input");
  return input as PipelineInput;
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
      const throughLeafId = evidence.checkpointFrontiers?.[checkpoint];
      if (!throughLeafId || !evidence.emittedEntryIds?.includes(throughLeafId))
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
      const path = join(ledger, `${identity}.json`);
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
      item.input.model ?? item.option.model,
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
        item.input.model ?? item.option.model,
        item.input.reasoning ?? item.option.reasoning ?? "low",
        item.option.autoApplyMemory !== false,
      )!;
      atomicWrite(
        join(item.dir, "critic-output.json"),
        `${JSON.stringify(parseBoundCriticOutput(raw, input), null, 2)}\n`,
      );
    }
  });

  const proposalsByConfig = new Map<
    MemoryConfig,
    import("./schema.js").Proposal[]
  >();
  for (const item of prepared) {
    const outputPath = join(item.dir, "output.json");
    const parsed = parsePipelineOutput(
      readFileSync(outputPath, "utf8"),
      item.input,
    ).parsed;
    const resultPath = join(item.dir, "result.json");
    if (parsed.action === "skip") {
      if (existsSync(resultPath)) {
        const result = parseStoredPipelineResult(
          readFileSync(resultPath, "utf8"),
          item.input,
        );
        if (result.action !== "skip")
          throw new Error("stored pipeline result does not match model output");
      }
      continue;
    }
    const proposals = materializeModelProposals({
      result: parsed,
      runId: item.input.runId,
      model: item.input.model ?? item.option.model,
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
      ...(existsSync(join(item.dir, "output-meta.json"))
        ? { digestVersion: 2 as const }
        : {}),
    });
    let preflight = proposals;
    if (existsSync(resultPath)) {
      const result = parseStoredPipelineResult(
        readFileSync(resultPath, "utf8"),
        item.input,
      );
      const found = result.proposalIds.map((id) =>
        findProposal(item.option.cfg, id),
      );
      const stored = found.map((item) => item.proposal);
      if (
        JSON.stringify(result.proposalIds) !==
          JSON.stringify(proposals.map((proposal) => proposal.id)) ||
        JSON.stringify(stored) !== JSON.stringify(proposals)
      )
        throw new Error("stored pipeline result does not match model output");
      preflight = proposals.filter(
        (_proposal, index) => !found[index]?.path.includes("/reviewed/"),
      );
    }
    if (preflight.length)
      proposalsByConfig.set(item.option.cfg, [
        ...(proposalsByConfig.get(item.option.cfg) ?? []),
        ...preflight,
      ]);
  }
  for (const [cfg, proposals] of proposalsByConfig)
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
