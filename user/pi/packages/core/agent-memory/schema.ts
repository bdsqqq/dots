import { basename } from "node:path";
import { sha256, type CatalogEntry } from "./catalog.js";

export const MEMORY_KINDS = [
  "preference",
  "decision",
  "gotcha",
  "pattern",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryArtifact = {
  memoryId: string;
  title: string;
  kind: MemoryKind;
  scope: string;
  description: string;
  triggers: string[];
  keywords: string[];
  sources: string[];
  created: string;
  updated: string;
  body: string;
};

export type MemoryRef = {
  memoryId: string;
  path: string;
  sha256: string;
};

export type EvidenceRef = {
  windowId: string;
  sessionId: string;
  checkpointEntryIds: string[];
  throughLeafId: string;
  branchDigest: string;
  excerpt: string;
  excerptSha256: string;
};

export type MemoryOperation =
  | { type: "create"; artifact: MemoryArtifact }
  | { type: "update"; target: MemoryRef; artifact: MemoryArtifact }
  | {
      type: "merge";
      primary: MemoryRef;
      targets: MemoryRef[];
      artifact: MemoryArtifact;
    }
  | { type: "archive"; target: MemoryRef; reason: string }
  | {
      type: "retire";
      target: MemoryRef;
      reason: string;
      supersededBy?: string;
    };

export type SkillDraftOperation = {
  type: "skill-draft";
  mode: "create" | "update";
  skillName: string;
  targetPath: string;
  baseSha256?: string;
  files: Array<{ path: string; content: string; sha256: string }>;
};

export type Proposal = {
  version: 2;
  id: string;
  lane: "memory" | "skill";
  status: "pending";
  operation: MemoryOperation | SkillDraftOperation;
  supersedes: string[];
  evidence: EvidenceRef[];
  provenance: {
    runId: string;
    promptVersion: number;
    model: string;
    createdAt: string;
    migration?: boolean;
    corpusAware: boolean;
    autonomous?: boolean;
    source?: string;
  };
};

export const REVIEW_REASON_CODES = [
  "correct",
  "duplicate",
  "incorrect",
  "ephemeral",
  "unsafe",
  "wrong-scope",
  "other",
] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];
export type MemoryMutationActor =
  | "local-cli"
  | "background-reflection"
  | "remember-skill";

export type ReviewReceipt = {
  version: 1;
  reviewId: string;
  proposalId: string;
  decision: "accepted" | "edited" | "rejected" | "rolled-back";
  reason: { code: ReviewReasonCode; text: string };
  reviewedAt: string;
  reviewer: MemoryMutationActor;
  originalProposalSha256: string;
  editedProposalSha256?: string;
  transactionId?: string;
  mutationId?: string;
  historyCommit?: string;
  finalArtifacts: Array<{
    path: string;
    memoryId?: string;
    sha256: string;
    status: "active" | "archived" | "retired" | "approved-skill-draft";
  }>;
};

export type ModelProposal =
  | { action: "skip"; reason: string }
  | {
      action: "propose";
      proposals: Array<
        | {
            lane: "memory";
            operation:
              | {
                  type: "create";
                  artifact: Omit<
                    MemoryArtifact,
                    "memoryId" | "sources" | "created" | "updated"
                  >;
                }
              | {
                  type: "update";
                  targetId: string;
                  artifact: Omit<
                    MemoryArtifact,
                    "memoryId" | "sources" | "created" | "updated"
                  >;
                }
              | {
                  type: "merge";
                  primaryId: string;
                  targetIds: string[];
                  artifact: Omit<
                    MemoryArtifact,
                    "memoryId" | "sources" | "created" | "updated"
                  >;
                }
              | {
                  type: "archive" | "retire";
                  targetId: string;
                  reason: string;
                  supersededBy?: string;
                };
          }
        | {
            lane: "skill";
            operation: SkillDraftOperation;
          }
      >;
    };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(",") !== keys.slice().sort().join(","))
    throw new Error("invalid fields");
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`invalid ${name}`);
  return value.trim();
}

function singleLine(value: unknown, name: string, max: number): string {
  const result = boundedString(value, name, max);
  if (/[\r\n]/.test(result)) throw new Error(`invalid ${name}`);
  return result;
}

function strings(
  value: unknown,
  name: string,
  count: number,
  max: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > count ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.trim() &&
        item.length <= max &&
        !/[\r\n]/.test(item),
    )
  )
    throw new Error(`invalid ${name}`);
  return value.map((item) => String(item).trim());
}

function artifact(
  value: unknown,
): Omit<MemoryArtifact, "memoryId" | "sources" | "created" | "updated"> {
  if (!object(value)) throw new Error("invalid artifact");
  exactKeys(value, [
    "body",
    "description",
    "keywords",
    "kind",
    "scope",
    "title",
    "triggers",
  ]);
  const kind = singleLine(value.kind, "kind", 20);
  if (!MEMORY_KINDS.includes(kind as MemoryKind))
    throw new Error("invalid kind");
  return {
    title: singleLine(value.title, "title", 120),
    kind: kind as MemoryKind,
    scope: singleLine(value.scope, "scope", 500),
    description: singleLine(value.description, "description", 240),
    triggers: strings(value.triggers, "triggers", 20, 200),
    keywords: strings(value.keywords, "keywords", 30, 100),
    body: boundedString(value.body, "body", 8_000),
  };
}

function skillOperation(value: unknown): SkillDraftOperation {
  if (!object(value)) throw new Error("invalid skill operation");
  const operationKeys = Object.keys(value).sort().join(",");
  if (
    operationKeys !== "files,mode,skillName,targetPath,type" &&
    operationKeys !== "baseSha256,files,mode,skillName,targetPath,type"
  )
    throw new Error("invalid skill operation fields");
  if (
    value.type !== "skill-draft" ||
    (value.mode !== "create" && value.mode !== "update")
  )
    throw new Error("invalid skill operation");
  const skillName = singleLine(value.skillName, "skillName", 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName))
    throw new Error("invalid skill name");
  const targetPath = singleLine(value.targetPath, "targetPath", 200);
  if (targetPath !== `${skillName}/SKILL.md`)
    throw new Error("invalid skill target");
  const baseSha256 =
    value.baseSha256 === undefined
      ? undefined
      : singleLine(value.baseSha256, "baseSha256", 64);
  if (
    (value.mode === "update" &&
      (!baseSha256 || !/^[a-f0-9]{64}$/.test(baseSha256))) ||
    (value.mode === "create" && baseSha256 !== undefined)
  )
    throw new Error("invalid skill base hash");
  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 8
  )
    throw new Error("invalid skill files");
  const files = value.files.map((item) => {
    if (!object(item)) throw new Error("invalid skill file");
    const keys = Object.keys(item).sort().join(",");
    if (keys !== "content,path" && keys !== "content,path,sha256")
      throw new Error("invalid skill file fields");
    const path = singleLine(item.path, "skill file path", 240);
    if (
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > 20_000
    )
      throw new Error("invalid skill file content");
    const content = item.content;
    if (
      path.startsWith("/") ||
      path.includes("..") ||
      !path.startsWith(`${skillName}/`)
    )
      throw new Error("invalid skill file path");
    const contentHash = sha256(content);
    if (item.sha256 !== undefined && item.sha256 !== contentHash)
      throw new Error("invalid skill file hash");
    return { path, content, sha256: contentHash };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("duplicate skill file path");
  if (!files.some((file) => file.path === targetPath))
    throw new Error("skill target file is missing");
  return {
    type: "skill-draft",
    mode: value.mode,
    skillName,
    targetPath,
    ...(baseSha256 ? { baseSha256 } : {}),
    files,
  };
}

export function parseModelProposal(raw: string): ModelProposal {
  const value: unknown = JSON.parse(raw.trim());
  if (!object(value)) throw new Error("invalid proposal response");
  if (value.action === "skip") {
    exactKeys(value, ["action", "reason"]);
    return {
      action: "skip",
      reason: boundedString(value.reason, "skip reason", 500),
    };
  }
  if (
    value.action !== "propose" ||
    !Array.isArray(value.proposals) ||
    value.proposals.length < 1 ||
    value.proposals.length > 8
  )
    throw new Error("invalid proposals");
  exactKeys(value, ["action", "proposals"]);
  return {
    action: "propose",
    proposals: value.proposals.map((item) => {
      if (
        !object(item) ||
        (item.lane !== "memory" && item.lane !== "skill") ||
        !object(item.operation)
      )
        throw new Error("invalid proposal");
      exactKeys(item, ["lane", "operation"]);
      if (item.lane === "skill")
        return { lane: "skill", operation: skillOperation(item.operation) };
      const operation = item.operation;
      const type = operation.type;
      if (type === "create") {
        exactKeys(operation, ["artifact", "type"]);
        return {
          lane: "memory",
          operation: { type, artifact: artifact(operation.artifact) },
        };
      }
      if (type === "update") {
        exactKeys(operation, ["artifact", "targetId", "type"]);
        return {
          lane: "memory",
          operation: {
            type,
            targetId: singleLine(operation.targetId, "targetId", 100),
            artifact: artifact(operation.artifact),
          },
        };
      }
      if (type === "merge") {
        exactKeys(operation, ["artifact", "primaryId", "targetIds", "type"]);
        return {
          lane: "memory",
          operation: {
            type,
            primaryId: singleLine(operation.primaryId, "primaryId", 100),
            targetIds: strings(operation.targetIds, "targetIds", 8, 100),
            artifact: artifact(operation.artifact),
          },
        };
      }
      if (type === "archive" || type === "retire") {
        const allowed =
          type === "retire"
            ? ["reason", "supersededBy", "targetId", "type"]
            : ["reason", "targetId", "type"];
        exactKeys(operation, allowed);
        return {
          lane: "memory",
          operation: {
            type,
            targetId: singleLine(operation.targetId, "targetId", 100),
            reason: boundedString(operation.reason, "reason", 500),
            ...(type === "retire" && operation.supersededBy !== undefined
              ? {
                  supersededBy: singleLine(
                    operation.supersededBy,
                    "supersededBy",
                    100,
                  ),
                }
              : {}),
          },
        };
      }
      throw new Error("unsupported operation");
    }),
  };
}

export function memoryRef(entry: CatalogEntry): MemoryRef {
  return { memoryId: entry.memoryId, path: entry.path, sha256: entry.sha256 };
}

export function renderMemory(
  artifact: MemoryArtifact,
  reviewId: string,
  status: string = "active",
): string {
  return `---\nmemory_version: 2\nmemory_id: ${JSON.stringify(artifact.memoryId)}\nstatus: ${JSON.stringify(status)}\ntitle: ${JSON.stringify(artifact.title)}\nkind: ${artifact.kind}\nscope: ${JSON.stringify(artifact.scope)}\ndescription: ${JSON.stringify(artifact.description)}\ntriggers: ${JSON.stringify(artifact.triggers)}\nkeywords: ${JSON.stringify(artifact.keywords)}\nsources: ${JSON.stringify(artifact.sources)}\ncreated: ${JSON.stringify(artifact.created)}\nupdated: ${JSON.stringify(artifact.updated)}\nreview_id: ${JSON.stringify(reviewId)}\n---\n\n${artifact.body.trim()}\n`;
}

export function proposalFileName(proposal: Proposal): string {
  const type = proposal.operation.type;
  const label = type === "skill-draft" ? proposal.operation.skillName : type;
  return `${proposal.id.slice(0, 16)}-${basename(label).replace(/[^a-z0-9-]/gi, "-")}.json`;
}
