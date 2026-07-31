import type { ReasoningLevel } from "./audit.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  memoryScopePath,
  PROMPT_CATALOG_MAX_ENTRIES,
  rankCatalog,
  renderedPromptCatalogEntryCount,
  scanCatalog,
  sha256,
  type CatalogEntry,
  type MemoryConfig,
} from "./catalog.js";
import { isHistoryInitialized, listHistory } from "./history.js";
import {
  canonicalProposalId,
  memoryRef,
  type EvidenceRef,
  type MemoryOperation,
  type MemoryPatch,
  type MemoryRef,
  type Proposal,
} from "./schema.js";
import type { SafeEvidence } from "./evidence.js";
import {
  frozenPipelineEvidence,
  parseStoredPipelineInput,
  type PipelineInput,
} from "./pipeline.js";

export type PathologyType =
  | "duplicate-exact"
  | "overlap-cluster"
  | "source-fragmentation"
  | "provenance-gap"
  | "oversized-artifact"
  | "prompt-pressure"
  | "rewrite-churn";

export type CorpusPathology = {
  version: 1;
  id: string;
  type: PathologyType;
  scope: string;
  metric: { name: string; value: number; threshold: number };
  basis: {
    historyCommit?: string;
    catalogSha256: string;
    targets: MemoryRef[];
  };
  allowedOperations: Array<"patch" | "deduplicate" | "archive" | "retire">;
};

export type CorpusHealthReport = {
  version: 1;
  catalogSha256: string;
  historyCommit?: string;
  pathologies: CorpusPathology[];
};

type Artifact = {
  entry: CatalogEntry;
  body: string;
  normalizedBody: string;
  tokens: Set<string>;
  sources: string[];
  lines: number;
};

const BODY_LIMIT = 6_000;
const LINE_LIMIT = 100;

function frontmatterArray(text: string, field: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
  const raw = frontmatter
    ? new RegExp(`^${field}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]
    : undefined;
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function pathology(
  report: Omit<CorpusPathology, "version" | "id">,
): CorpusPathology {
  const id = `health_${sha256(JSON.stringify(report)).slice(0, 24)}`;
  return { version: 1, id, ...report };
}

function targetBasis(
  catalogSha256: string,
  historyCommit: string | undefined,
  entries: CatalogEntry[],
): CorpusPathology["basis"] {
  return {
    ...(historyCommit ? { historyCommit } : {}),
    catalogSha256,
    targets: entries
      .map(memoryRef)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function scanCorpusHealth(cfg: MemoryConfig): CorpusHealthReport {
  const catalog = scanCatalog(cfg.root, "1970-01-01T00:00:00.000Z");
  const catalogSha256 = sha256(JSON.stringify(catalog));
  const history = isHistoryInitialized(cfg)
    ? listHistory(cfg, { limit: 10 })
    : [];
  const historyCommit = history[0]?.commit;
  const artifacts: Artifact[] = catalog.entries.map((entry) => {
    const text = readFileSync(join(cfg.root, entry.path), "utf8");
    const content = body(text);
    return {
      entry,
      body: content,
      normalizedBody: normalize(content),
      tokens: tokens(content),
      sources: [...new Set(frontmatterArray(text, "sources"))],
      lines: content.split("\n").filter((line) => line.trim()).length,
    };
  });
  const pathologies: CorpusPathology[] = [];
  const seenPairs = new Set<string>();

  for (let leftIndex = 0; leftIndex < artifacts.length; leftIndex++)
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < artifacts.length;
      rightIndex++
    ) {
      const left = artifacts[leftIndex]!;
      const right = artifacts[rightIndex]!;
      if (left.entry.scope !== right.entry.scope) continue;
      const pair = [left.entry, right.entry];
      const pairId = pair
        .map((entry) => entry.memoryId)
        .sort()
        .join(":");
      if (left.normalizedBody && left.normalizedBody === right.normalizedBody) {
        seenPairs.add(pairId);
        pathologies.push(
          pathology({
            type: "duplicate-exact",
            scope: left.entry.scope,
            metric: {
              name: "normalized-body-equality",
              value: 1,
              threshold: 1,
            },
            basis: targetBasis(catalogSha256, historyCommit, pair),
            allowedOperations: ["deduplicate", "archive", "retire"],
          }),
        );
        continue;
      }
      const overlap = jaccard(left.tokens, right.tokens);
      if (
        !seenPairs.has(pairId) &&
        Math.min(left.tokens.size, right.tokens.size) >= 12 &&
        overlap >= 0.8
      )
        pathologies.push(
          pathology({
            type: "overlap-cluster",
            scope: left.entry.scope,
            metric: { name: "token-jaccard", value: overlap, threshold: 0.8 },
            basis: targetBasis(catalogSha256, historyCommit, pair),
            allowedOperations: ["patch", "deduplicate", "archive", "retire"],
          }),
        );
    }

  const byScopeAndSource = new Map<
    string,
    { source: string; members: Artifact[] }
  >();
  for (const artifact of artifacts)
    for (const source of artifact.sources) {
      const key = JSON.stringify([artifact.entry.scope, source]);
      const group = byScopeAndSource.get(key) ?? { source, members: [] };
      group.members.push(artifact);
      byScopeAndSource.set(key, group);
    }
  for (const { source, members } of byScopeAndSource.values())
    if (
      members.length >= 3 &&
      members.some((left, index) =>
        members
          .slice(index + 1)
          .some((right) => jaccard(left.tokens, right.tokens) >= 0.5),
      )
    )
      pathologies.push(
        pathology({
          type: "source-fragmentation",
          scope: members[0]!.entry.scope,
          metric: {
            name: `memories-for-source:${source}`,
            value: members.length,
            threshold: 3,
          },
          basis: targetBasis(
            catalogSha256,
            historyCommit,
            members.map((member) => member.entry),
          ),
          allowedOperations: ["patch", "deduplicate", "archive", "retire"],
        }),
      );

  for (const artifact of artifacts) {
    const basis = targetBasis(catalogSha256, historyCommit, [artifact.entry]);
    if (!artifact.entry.legacy && artifact.sources.length === 0)
      pathologies.push(
        pathology({
          type: "provenance-gap",
          scope: artifact.entry.scope,
          metric: { name: "source-count", value: 0, threshold: 1 },
          basis,
          allowedOperations: [],
        }),
      );
    if (artifact.body.length > BODY_LIMIT || artifact.lines > LINE_LIMIT)
      pathologies.push(
        pathology({
          type: "oversized-artifact",
          scope: artifact.entry.scope,
          metric:
            artifact.body.length > BODY_LIMIT
              ? {
                  name: "body-characters",
                  value: artifact.body.length,
                  threshold: BODY_LIMIT,
                }
              : {
                  name: "nonblank-lines",
                  value: artifact.lines,
                  threshold: LINE_LIMIT,
                },
          basis,
          allowedOperations: artifact.sources.length ? ["patch"] : [],
        }),
      );
  }

  const scopes = new Set(catalog.entries.map((entry) => entry.scope));
  for (const scope of scopes) {
    const workspace = memoryScopePath(scope);
    const entries = workspace
      ? rankCatalog(catalog, workspace)
      : scope === "global"
        ? catalog.entries.filter((entry) => entry.scope === "global")
        : [];
    if (
      renderedPromptCatalogEntryCount(
        { ...catalog, entries },
        workspace ?? "/",
      ) < entries.length
    )
      pathologies.push(
        pathology({
          type: "prompt-pressure",
          scope,
          metric: {
            name: "eligible-catalog-entries",
            value: entries.length,
            threshold: PROMPT_CATALOG_MAX_ENTRIES,
          },
          basis: targetBasis(catalogSha256, historyCommit, entries),
          allowedOperations: [],
        }),
      );
  }

  const changed = new Map<string, number>();
  for (const entry of history)
    for (const change of entry.receipt.changes)
      changed.set(change.path, (changed.get(change.path) ?? 0) + 1);
  for (const [path, count] of changed)
    if (count >= 3) {
      const entry = catalog.entries.find(
        (candidate) => candidate.path === path,
      );
      if (entry)
        pathologies.push(
          pathology({
            type: "rewrite-churn",
            scope: entry.scope,
            metric: {
              name: "changes-in-last-ten-commits",
              value: count,
              threshold: 3,
            },
            basis: targetBasis(catalogSha256, historyCommit, [entry]),
            allowedOperations: [],
          }),
        );
    }

  return {
    version: 1,
    catalogSha256,
    ...(historyCommit ? { historyCommit } : {}),
    pathologies: pathologies.sort(
      (left, right) =>
        left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
    ),
  };
}

export function maintenanceProposals(
  report: CorpusHealthReport,
  createdAt: string = new Date().toISOString(),
): Proposal[] {
  const churned = new Set(
    report.pathologies
      .filter((item) => item.type === "rewrite-churn")
      .flatMap((item) => item.basis.targets.map((target) => target.memoryId)),
  );
  const claimed = new Set<string>();
  const proposals: Proposal[] = [];
  for (const pathology of report.pathologies) {
    if (
      pathology.type !== "duplicate-exact" ||
      pathology.basis.targets.length < 2 ||
      pathology.basis.targets.some(
        (target) =>
          churned.has(target.memoryId) || claimed.has(target.memoryId),
      )
    )
      continue;
    const [primary, ...targets] = pathology.basis.targets;
    if (!primary || targets.length === 0) continue;
    pathology.basis.targets.forEach((target) => claimed.add(target.memoryId));
    const proposal: Omit<Proposal, "id"> = {
      version: 2,
      digestVersion: 2,
      lane: "memory",
      status: "pending",
      operation: { type: "deduplicate", primary, targets },
      supersedes: [],
      evidence: [],
      provenance: {
        runId: `maintenance_${pathology.id}`,
        promptVersion: 2,
        model: "deterministic-corpus-doctor",
        createdAt,
        corpusAware: true,
        autonomous: true,
      },
    };
    proposals.push({ ...proposal, id: canonicalProposalId(proposal) });
  }
  return proposals;
}

export type MaintenanceDiagnostic = {
  pathologyId: string;
  type: PathologyType;
  code: "blocked-pathology" | "missing-authored-evidence" | "model-skip";
  message: string;
};

export type MaintenanceAnalysis = {
  report: CorpusHealthReport;
  proposals: Proposal[];
  diagnostics: MaintenanceDiagnostic[];
};

type MaintenanceDraft =
  | {
      type: "patch";
      pathologyId: string;
      target: MemoryRef;
      changes: MemoryPatch;
    }
  | {
      type: "deduplicate";
      pathologyId: string;
      primary: MemoryRef;
      targets: MemoryRef[];
    }
  | {
      type: "archive" | "retire";
      pathologyId: string;
      target: MemoryRef;
      reason: string;
    };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenInputs(cfg: MemoryConfig): PipelineInput[] {
  const root = join(cfg.data, "v2/runs");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = join(root, name, "input.json");
      if (!existsSync(path)) return [];
      try {
        const input = parseStoredPipelineInput(readFileSync(path, "utf8"));
        if (input.runId !== name)
          throw new Error("pipeline run directory identity mismatch");
        return [input];
      } catch (error) {
        throw new Error(`invalid frozen pipeline input ${name}`, {
          cause: error,
        });
      }
    });
}

function evidenceFor(
  inputs: PipelineInput[],
  sources: string[],
): { refs: EvidenceRef[]; evidence: SafeEvidence[] } {
  const requested = new Set(sources);
  const evidence = inputs
    .flatMap(frozenPipelineEvidence)
    .filter((item) =>
      item.window.checkpointEntryIds.some((checkpoint) =>
        requested.has(`pi://${item.window.sessionId}/${checkpoint}`),
      ),
    );
  const unique = [
    ...new Map(evidence.map((item) => [item.window.windowId, item])).values(),
  ];
  return { refs: unique.map((item) => item.window), evidence: unique };
}

function parseMaintenanceDrafts(raw: string): MaintenanceDraft[] {
  const value: unknown = JSON.parse(raw.trim());
  if (!object(value)) throw new Error("invalid maintenance response");
  if (value.action === "skip") {
    if (
      Object.keys(value).sort().join(",") !== "action,reason" ||
      typeof value.reason !== "string"
    )
      throw new Error("invalid maintenance skip");
    return [];
  }
  if (
    value.action !== "propose" ||
    !Array.isArray(value.proposals) ||
    value.proposals.length < 1 ||
    value.proposals.length > 8
  )
    throw new Error("invalid maintenance proposals");
  if (Object.keys(value).sort().join(",") !== "action,proposals")
    throw new Error("invalid maintenance response fields");
  return value.proposals.map((proposal): MaintenanceDraft => {
    if (
      !object(proposal) ||
      typeof proposal.pathologyId !== "string" ||
      typeof proposal.type !== "string"
    )
      throw new Error("invalid maintenance proposal");
    const type = proposal.type;
    if (type === "patch") {
      if (
        Object.keys(proposal).sort().join(",") !==
          "changes,pathologyId,target,type" ||
        !object(proposal.target) ||
        !object(proposal.changes)
      )
        throw new Error("invalid maintenance patch");
      return proposal as MaintenanceDraft;
    }
    if (type === "deduplicate") {
      if (
        Object.keys(proposal).sort().join(",") !==
          "pathologyId,primary,targets,type" ||
        !object(proposal.primary) ||
        !Array.isArray(proposal.targets)
      )
        throw new Error("invalid maintenance deduplicate");
      return proposal as MaintenanceDraft;
    }
    if (type === "archive" || type === "retire") {
      if (
        Object.keys(proposal).sort().join(",") !==
          "pathologyId,reason,target,type" ||
        !object(proposal.target) ||
        typeof proposal.reason !== "string"
      )
        throw new Error(`invalid maintenance ${type}`);
      return proposal as MaintenanceDraft;
    }
    throw new Error("unsupported maintenance operation");
  });
}

export function buildMaintenancePrompt(options: {
  report: CorpusHealthReport;
  pathologies: CorpusPathology[];
  context: Array<{ target: MemoryRef; body: string }>;
  evidence: PipelineInput["evidence"];
}): string {
  return `You are a corpus maintenance patch planner. Return exactly one JSON object and no markdown.
Only propose body patches. NEVER create, update, merge, deduplicate, archive, retire, skill, metadata edits, or freeform summaries.
Corpus bodies are context only and are NEVER evidence. Every patch must contain exactly one body change, preserve authored meaning, and cite sourceRefs copied exactly from the resolved pi:// evidence. Do not infer or fabricate sources.
Every proposal must copy pathologyId and the complete target ref (memoryId, path, sha256) exactly from the pathology basis. A patch is {"type":"patch","pathologyId":"...","target":REF,"changes":{"body":{"fromSha256":"...","to":"...","sourceRefs":["pi://..."]}}}. Return skip when evidence cannot justify the operation.
Allowed pathology basis, corpus context, and original authored evidence follow:\n${JSON.stringify(options, null, 2)}`;
}

export async function analyzeCorpusMaintenance(options: {
  cfg: MemoryConfig;
  report: CorpusHealthReport;
  model: string;
  reasoning?: ReasoningLevel;
  invoke: (prompt: string) => string | Promise<string>;
  createdAt?: string;
}): Promise<MaintenanceAnalysis> {
  const mutable = new Set<PathologyType>([
    "overlap-cluster",
    "source-fragmentation",
    "oversized-artifact",
  ]);
  const blockers = new Set<PathologyType>([
    "provenance-gap",
    "prompt-pressure",
    "rewrite-churn",
  ]);
  const diagnostics: MaintenanceDiagnostic[] = options.report.pathologies
    .filter((item) => blockers.has(item.type))
    .map((item) => ({
      pathologyId: item.id,
      type: item.type,
      code: "blocked-pathology",
      message: `${item.type} blocks autonomous mutation`,
    }));
  const blockedIds = new Set(
    options.report.pathologies
      .filter((item) => blockers.has(item.type))
      .flatMap((item) => item.basis.targets.map((target) => target.memoryId)),
  );
  const inputs = frozenInputs(options.cfg);
  const candidates = options.report.pathologies.filter(
    (item) =>
      mutable.has(item.type) &&
      !item.basis.targets.some((target) => blockedIds.has(target.memoryId)),
  );
  const resolved = candidates.map((pathology) => {
    const sources = pathology.basis.targets.flatMap((target) => {
      const text = readFileSync(join(options.cfg.root, target.path), "utf8");
      return frontmatterArray(text, "sources").filter((source) =>
        /^pi:\/\/[^/]+\/[^/]+$/.test(source),
      );
    });
    return {
      pathology,
      sources: [...new Set(sources)],
      ...evidenceFor(inputs, sources),
    };
  });
  for (const item of resolved)
    if (
      item.sources.length === 0 ||
      item.sources.some(
        (source) =>
          !item.evidence.some((evidence) =>
            evidence.window.checkpointEntryIds.some(
              (checkpoint) =>
                source === `pi://${evidence.window.sessionId}/${checkpoint}`,
            ),
          ),
      )
    )
      diagnostics.push({
        pathologyId: item.pathology.id,
        type: item.pathology.type,
        code: "missing-authored-evidence",
        message:
          "original authored evidence could not be resolved from frozen pipeline inputs",
      });
  const usable = resolved.filter(
    (item) =>
      !diagnostics.some(
        (diagnostic) => diagnostic.pathologyId === item.pathology.id,
      ),
  );
  if (usable.length === 0)
    return { report: options.report, proposals: [], diagnostics };
  const evidence = [
    ...new Map(
      usable
        .flatMap((item) => item.evidence)
        .map((item) => [item.window.windowId, item]),
    ).values(),
  ];
  const raw = await options.invoke(
    buildMaintenancePrompt({
      report: options.report,
      pathologies: usable.map((item) => item.pathology),
      context: usable.flatMap((item) =>
        item.pathology.basis.targets.map((target) => ({
          target,
          body: readFileSync(join(options.cfg.root, target.path), "utf8"),
        })),
      ),
      evidence,
    }),
  );
  const drafts = parseMaintenanceDrafts(raw);
  if (drafts.length === 0)
    return {
      report: options.report,
      proposals: [],
      diagnostics: [
        ...diagnostics,
        ...usable.map((item) => ({
          pathologyId: item.pathology.id,
          type: item.pathology.type,
          code: "model-skip" as const,
          message: "model skipped maintenance",
        })),
      ],
    };
  const createdAt = options.createdAt ?? new Date().toISOString();
  const claimed = new Set<string>();
  const proposals = drafts.map((draft): Proposal => {
    const item = usable.find(
      (candidate) => candidate.pathology.id === draft.pathologyId,
    );
    if (!item) throw new Error("maintenance proposal uses unknown pathology");
    if (!item.pathology.allowedOperations.includes(draft.type))
      throw new Error("maintenance operation is not allowed by pathology");
    const refs = new Map(
      item.pathology.basis.targets.map((target) => [target.memoryId, target]),
    );
    const exact = (ref: MemoryRef): MemoryRef => {
      const expected = refs.get(ref.memoryId);
      if (!expected || JSON.stringify(ref) !== JSON.stringify(expected))
        throw new Error(
          "maintenance proposal uses fabricated or stale target ref",
        );
      return expected;
    };
    if (draft.type !== "patch")
      throw new Error("model maintenance may only propose body patches");
    const target = exact(draft.target);
    const bodyChange = draft.changes.body;
    if (
      Object.keys(draft.changes).join(",") !== "body" ||
      !bodyChange ||
      Object.keys(bodyChange).sort().join(",") !== "fromSha256,sourceRefs,to" ||
      typeof bodyChange.to !== "string" ||
      !bodyChange.to.trim() ||
      !Array.isArray(bodyChange.sourceRefs)
    )
      throw new Error("invalid maintenance body patch");
    const allowedSources = new Set(item.sources);
    if (
      bodyChange.fromSha256 !==
        sha256(
          body(readFileSync(join(options.cfg.root, target.path), "utf8")),
        ) ||
      bodyChange.sourceRefs.length === 0 ||
      bodyChange.sourceRefs.some((source) => !allowedSources.has(source))
    )
      throw new Error(
        "maintenance patch uses fabricated source or stale body hash",
      );
    const operation: MemoryOperation = {
      type: "patch",
      target,
      changes: { body: bodyChange },
    };
    const ids = [target.memoryId];
    if (ids.some((id) => claimed.has(id)))
      throw new Error("maintenance proposals overlap");
    ids.forEach((id) => claimed.add(id));
    const refsForEvidence = item.refs;
    const proposal: Omit<Proposal, "id"> = {
      version: 2,
      digestVersion: 2,
      lane: "memory",
      status: "pending",
      operation,
      supersedes: [],
      evidence: refsForEvidence,
      provenance: {
        runId: `maintenance_${item.pathology.id}`,
        promptVersion: 3,
        model: options.model,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        createdAt,
        corpusAware: true,
        autonomous: true,
      },
    };
    return { ...proposal, id: canonicalProposalId(proposal) };
  });
  return { report: options.report, proposals, diagnostics };
}

export function assertFreshMaintenanceBasis(
  cfg: MemoryConfig,
  report: CorpusHealthReport,
): void {
  const fresh = scanCorpusHealth(cfg);
  if (
    fresh.catalogSha256 !== report.catalogSha256 ||
    fresh.historyCommit !== report.historyCommit
  )
    throw new Error("stale maintenance pathology basis");
}
