/**
 * temporary typed mirror of runtime agent/archetype metadata.
 *
 * pi runtime prompt/agent config currently lives in decrypted markdown under
 * `~/.pi/agent/agents`, which is good for runtime portability but weak as a
 * type-safe source for analysis tooling. this module mirrors only the
 * decision-relevant metadata we need for model evaluation until prompt
 * metadata is promoted to a typed in-repo source.
 *
 * @bdsqqq notes: user dislikes hardcoding roles/agents here. agreed. this is
 * a temporary compromise because parsing markdown prompts is brittle and the
 * runtime files are outside the package structure.
 */

import type {
  AgentId,
  AgentProfile,
  CandidateModel,
  DimensionId,
  ModelId,
  RoleId,
  RoleProfile,
} from "./types";

/**
 * candidate models for evaluation.
 *
 * this set is the initial consideration pool. models are matched to
 * artificial analysis data via `aaMatch` (slug or name).
 */
export const candidateModels: readonly CandidateModel[] = [
  {
    id: "gpt-5-4",
    providerModel: "openai/gpt-5.4",
    displayName: "GPT-5.4",
    aaMatch: { apiSlug: "gpt-5-4", siteSlugs: ["gpt-5-4"] },
    aliases: ["gpt5.4", "gpt-5.4"],
  },
  {
    id: "gpt-5-2",
    providerModel: "openai/gpt-5.2",
    displayName: "GPT-5.2",
    aaMatch: { apiSlug: "gpt-5-2", siteSlugs: ["gpt-5-2"] },
    aliases: ["gpt5.2", "gpt-5.2"],
  },
  {
    id: "gpt-5-4-mini",
    providerModel: "openai/gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    aaMatch: { apiSlug: "gpt-5-4-mini", siteSlugs: ["gpt-5-4-mini"] },
    aliases: ["gpt5.4-mini", "gpt-5.4-mini"],
  },
  {
    id: "gpt-5-4-nano",
    providerModel: "openai/gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
    aaMatch: { apiSlug: "gpt-5-4-nano", siteSlugs: ["gpt-5-4-nano"] },
    aliases: ["gpt5.4-nano", "gpt-5.4-nano"],
  },
  {
    id: "gemini-3-1-pro",
    providerModel: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    aaMatch: {
      apiSlug: "gemini-3-1-pro-preview",
      siteSlugs: ["gemini-3-1-pro-preview", "gemini-3-1-pro"],
    },
    aliases: ["gemini3.1pro", "gemini-3.1-pro"],
  },
  {
    id: "gemini-3-flash",
    providerModel: "google/gemini-3-flash-preview",
    displayName: "Gemini 3 Flash",
    // note: site uses "gemini-3-flash" for the non-reasoning variant
    // runtime uses "google/gemini-3-flash-preview" which maps to gemini-3-flash site data
    aaMatch: {
      apiSlug: "gemini-3-flash-preview",
      siteSlugs: ["gemini-3-flash"],
    },
    aliases: ["gemini3flash", "gemini-3-flash"],
  },
  {
    id: "claude-opus-4-6",
    providerModel: "anthropic/claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    aaMatch: {
      apiSlug: "claude-opus-4-6-adaptive",
      siteSlugs: ["claude-opus-4-6-adaptive", "claude-opus-4-6"],
    },
    aliases: ["claude-opus-4.6", "claudeopus4.6"],
  },
  {
    id: "claude-sonnet-4-6",
    providerModel: "anthropic/claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    aaMatch: {
      apiSlug: "claude-sonnet-4-6-adaptive",
      siteSlugs: ["claude-sonnet-4-6-adaptive", "claude-sonnet-4-6"],
    },
    aliases: ["claude-sonnet-4.6", "claudesonnet4.6"],
  },
  {
    id: "minimax-m2-7",
    providerModel: "minimax/m2-7",
    displayName: "MiniMax M2.7",
    aaMatch: { apiSlug: "minimax-m2-7", siteSlugs: ["minimax-m2-7"] },
    aliases: ["minimax-m2.7", "minimaxm2.7"],
  },
  {
    id: "kimi-k2",
    providerModel: "moonshot/kimi-k2",
    displayName: "Kimi K2",
    aaMatch: { apiSlug: "kimi-k2-5", siteSlugs: ["kimi-k2-5"] },
    aliases: ["kimik2", "kimi-k2-5"],
  },
  {
    id: "glm-5",
    providerModel: "z-ai/glm-5",
    displayName: "GLM-5",
    aaMatch: { apiSlug: "glm-5", siteSlugs: ["glm-5"] },
    aliases: ["glm5"],
  },
];

/**
 * role profiles derived from pi agent/tool usage patterns.
 *
 * each role defines what dimensions matter and optional guardrails.
 * presets are fuzzy weightings, not the primary output mechanism.
 */
export const roles: Record<RoleId, RoleProfile> = {
  dayToDay: {
    id: "dayToDay",
    description:
      "general workhorse: fast enough, cost-sensitive, still smart. covers default and task agents.",
    relevantDimensions: [
      "coding",
      "intelligence",
      "price",
      "outputSpeed",
      "ttft",
    ] as const,
    redFlagDimensions: ["hallucination"] as const,
    guardrails: {
      maxPricePer1mBlended: 5,
      minContextTokens: 128000,
    },
    presets: {
      balanced: {
        coding: 0.25,
        intelligence: 0.25,
        price: 0.25,
        outputSpeed: 0.15,
        ttft: 0.1,
      },
      cheap: { price: 0.5, coding: 0.2, intelligence: 0.2, outputSpeed: 0.1 },
      fast: { outputSpeed: 0.4, ttft: 0.3, coding: 0.2, price: 0.1 },
      "max-smarts": {
        intelligence: 0.4,
        coding: 0.3,
        price: 0.2,
        outputSpeed: 0.1,
      },
    },
  },
  deepReasoning: {
    id: "deepReasoning",
    description:
      "smarts required: oracle, code-review. needs intelligence, tool use, low hallucination.",
    relevantDimensions: [
      "coding",
      "intelligence",
      "toolCalling",
      "hallucination",
      "instructionFollowing",
    ] as const,
    redFlagDimensions: ["hallucination"] as const,
    guardrails: {
      minContextTokens: 128000,
      requireToolCalling: true,
      requireLowHallucination: true,
    },
    presets: {
      balanced: {
        intelligence: 0.3,
        coding: 0.25,
        toolCalling: 0.2,
        hallucination: 0.15,
        instructionFollowing: 0.1,
      },
      "max-smarts": {
        intelligence: 0.5,
        coding: 0.3,
        toolCalling: 0.15,
        hallucination: 0.05,
      },
    },
  },
  fastSummarization: {
    id: "fastSummarization",
    description:
      "large-context, summarization/extraction: handoff, read-session, read-web-page, look-at.",
    relevantDimensions: [
      "context",
      "longContextReasoning",
      "outputSpeed",
      "ttft",
      "price",
    ] as const,
    redFlagDimensions: [] as const,
    guardrails: {
      minContextTokens: 256000,
    },
    presets: {
      balanced: {
        context: 0.25,
        longContextReasoning: 0.2,
        outputSpeed: 0.25,
        ttft: 0.2,
        price: 0.1,
      },
      fast: {
        context: 0.1,
        longContextReasoning: 0.1,
        outputSpeed: 0.4,
        ttft: 0.3,
        price: 0.1,
      },
      cheap: {
        context: 0.2,
        longContextReasoning: 0.1,
        outputSpeed: 0.15,
        ttft: 0.05,
        price: 0.5,
      },
    },
  },
  fastSearch: {
    id: "fastSearch",
    description: "speed + search adequacy: finder. intelligence less critical.",
    relevantDimensions: ["outputSpeed", "ttft", "price"] as const,
    redFlagDimensions: [] as const,
    guardrails: {},
    presets: {
      balanced: { outputSpeed: 0.35, ttft: 0.35, price: 0.3 },
      fast: { outputSpeed: 0.5, ttft: 0.4, price: 0.1 },
      cheap: { price: 0.6, outputSpeed: 0.25, ttft: 0.15 },
    },
  },
  repoResearch: {
    id: "repoResearch",
    description:
      "larger repo understanding, cross-repo tracing: librarian. needs decent reasoning.",
    relevantDimensions: [
      "coding",
      "intelligence",
      "context",
      "longContextReasoning",
      "toolCalling",
      "price",
    ] as const,
    redFlagDimensions: ["hallucination"] as const,
    guardrails: {
      minContextTokens: 128000,
      requireToolCalling: true,
    },
    presets: {
      balanced: {
        coding: 0.2,
        intelligence: 0.2,
        context: 0.15,
        longContextReasoning: 0.2,
        toolCalling: 0.15,
        price: 0.1,
      },
      cheap: {
        price: 0.4,
        coding: 0.25,
        intelligence: 0.2,
        context: 0.05,
        longContextReasoning: 0.05,
        toolCalling: 0.05,
      },
    },
  },
};

/**
 * agent profiles mapping agents to roles with current model assignments.
 *
 * currentModel is derived from extension source code (see MODEL-EVALS-PLAN.md
 * lod 1 for the verified baseline).
 */
export const agents: Record<AgentId, AgentProfile> = {
  default: {
    id: "default",
    role: "dayToDay",
    label: "Default/Primary",
    currentModel: "gpt-5-4",
  },
  task: {
    id: "task",
    role: "dayToDay",
    label: "Task Sub-agent",
    currentModel: "inherits-default",
  },
  oracle: {
    id: "oracle",
    role: "deepReasoning",
    label: "Oracle",
    currentModel: "gemini-3-1-pro",
  },
  "code-review": {
    id: "code-review",
    role: "deepReasoning",
    label: "Code Review",
    currentModel: "gemini-3-1-pro",
  },
  finder: {
    id: "finder",
    role: "fastSearch",
    label: "Finder",
    currentModel: "gemini-3-flash",
  },
  librarian: {
    id: "librarian",
    role: "repoResearch",
    label: "Librarian",
    currentModel: "gpt-5-4",
  },
  handoff: {
    id: "handoff",
    role: "fastSummarization",
    label: "Handoff",
    currentModel: "gemini-3-flash",
  },
  "read-session": {
    id: "read-session",
    role: "fastSummarization",
    label: "Read Session",
    currentModel: "gemini-3-flash",
  },
  "read-web-page": {
    id: "read-web-page",
    role: "fastSummarization",
    label: "Read Web Page",
    currentModel: "gemini-3-flash",
  },
  "look-at": {
    id: "look-at",
    role: "fastSummarization",
    label: "Look At",
    currentModel: "gemini-3-flash",
  },
};

const validAgentIds = new Set<AgentId>(Object.keys(agents) as AgentId[]);

const validRoleIds = new Set<RoleId>(Object.keys(roles) as RoleId[]);

const modelIdSet = new Set<ModelId>(candidateModels.map((m) => m.id));
const modelAliasMap = new Map<string, ModelId>();
for (const model of candidateModels) {
  modelAliasMap.set(model.id.toLowerCase(), model.id);
  if (model.aliases) {
    for (const alias of model.aliases) {
      modelAliasMap.set(alias.toLowerCase(), model.id);
    }
  }
}

/**
 * resolve an agent selector string to an AgentId.
 *
 * accepts: agent id, agent file path (extracts agent name), or short name.
 * throws on invalid selector.
 */
export function resolveAgentSelector(input: string): AgentId {
  const normalized = input.toLowerCase().trim();

  // check if it's a direct agent id
  if (validAgentIds.has(normalized as AgentId)) {
    return normalized as AgentId;
  }

  // try to extract from file path like ~/.pi/agent/agents/agent.amp.oracle.md
  const fileName = normalized.split("/").pop() ?? "";
  const match = fileName.match(/agent\.amp\.(\w+)\.md$/);
  if (match && validAgentIds.has(match[1] as AgentId)) {
    return match[1] as AgentId;
  }

  // try matching on label lowercase
  for (const [id, profile] of Object.entries(agents)) {
    if (profile.label.toLowerCase() === normalized) {
      return id as AgentId;
    }
  }

  throw new Error(`unknown agent selector: ${input}`);
}

/**
 * resolve a model selector string to a ModelId.
 *
 * accepts: model id, alias, or partial match on display name.
 * returns null if not found.
 */
export function resolveModelSelector(input: string): ModelId | null {
  const normalized = input.toLowerCase().trim();

  // direct match
  if (modelIdSet.has(normalized)) {
    return normalized;
  }

  // alias match
  const aliasMatch = modelAliasMap.get(normalized);
  if (aliasMatch) {
    return aliasMatch;
  }

  // partial display name match
  for (const model of candidateModels) {
    if (model.displayName.toLowerCase().includes(normalized)) {
      return model.id;
    }
  }

  return null;
}

/**
 * get all dimensions relevant across all roles.
 */
export function getAllDimensions(): readonly DimensionId[] {
  const dims = new Set<DimensionId>();
  for (const role of Object.values(roles)) {
    for (const dim of role.relevantDimensions) {
      dims.add(dim);
    }
    if (role.redFlagDimensions) {
      for (const dim of role.redFlagDimensions) {
        dims.add(dim);
      }
    }
  }
  return [...dims] as readonly DimensionId[];
}

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  describe("candidateModels", () => {
    test("all models have unique ids", () => {
      const ids = candidateModels.map((m) => m.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    test("all models have aaMatch defined", () => {
      for (const model of candidateModels) {
        expect(model.aaMatch).toBeDefined();
        expect(
          model.aaMatch.apiSlug ||
            model.aaMatch.apiName ||
            model.aaMatch.siteSlugs?.length ||
            model.aaMatch.siteNames?.length,
        ).toBeTruthy();
      }
    });
  });

  describe("roles", () => {
    test("all roles have valid dimension references", () => {
      const validDims = new Set([
        "coding",
        "intelligence",
        "price",
        "outputSpeed",
        "ttft",
        "hallucination",
        "toolCalling",
        "context",
        "instructionFollowing",
        "longContextReasoning",
      ]);

      for (const role of Object.values(roles)) {
        for (const dim of role.relevantDimensions) {
          expect(
            validDims.has(dim),
            `unknown dimension ${dim} in role ${role.id}`,
          ).toBe(true);
        }
        if (role.redFlagDimensions) {
          for (const dim of role.redFlagDimensions) {
            expect(
              validDims.has(dim),
              `unknown red flag dimension ${dim} in role ${role.id}`,
            ).toBe(true);
          }
        }
      }
    });

    test("all preset weights sum approximately to 1", () => {
      for (const role of Object.values(roles)) {
        if (!role.presets) continue;
        for (const [_presetName, weights] of Object.entries(role.presets)) {
          const sum = Object.values(weights).reduce((a, b) => a + b, 0);
          expect(sum).toBeGreaterThanOrEqual(0.9);
          expect(sum).toBeLessThanOrEqual(1.1);
        }
      }
    });
  });

  describe("agents", () => {
    test("all agents reference valid roles", () => {
      for (const agent of Object.values(agents)) {
        expect(
          validRoleIds.has(agent.role),
          `agent ${agent.id} references invalid role ${agent.role}`,
        ).toBe(true);
      }
    });

    test("all currentModel values are valid or 'inherits-default'", () => {
      for (const agent of Object.values(agents)) {
        if (agent.currentModel === "inherits-default") continue;
        if (agent.currentModel === undefined) continue;
        expect(
          modelIdSet.has(agent.currentModel) ||
            agent.currentModel === "gpt-5-2",
          `agent ${agent.id} has invalid currentModel ${agent.currentModel}`,
        ).toBe(true);
      }
    });
  });

  describe("resolveAgentSelector", () => {
    test("resolves agent id", () => {
      expect(resolveAgentSelector("oracle")).toBe("oracle");
      expect(resolveAgentSelector("CODE-REVIEW")).toBe("code-review");
    });

    test("resolves agent file path", () => {
      expect(
        resolveAgentSelector("~/.pi/agent/agents/agent.amp.oracle.md"),
      ).toBe("oracle");
    });

    test("resolves by label", () => {
      expect(resolveAgentSelector("oracle")).toBe("oracle");
      expect(resolveAgentSelector("Code Review")).toBe("code-review");
    });

    test("throws on unknown selector", () => {
      expect(() => resolveAgentSelector("unknown-agent")).toThrow(
        "unknown agent selector",
      );
    });
  });

  describe("resolveModelSelector", () => {
    test("resolves model id", () => {
      expect(resolveModelSelector("gpt-5-4")).toBe("gpt-5-4");
    });

    test("resolves alias", () => {
      expect(resolveModelSelector("gpt5.4")).toBe("gpt-5-4");
      expect(resolveModelSelector("glm5")).toBe("glm-5");
    });

    test("resolves partial display name", () => {
      expect(resolveModelSelector("gemini 3.1")).toBe("gemini-3-1-pro");
    });

    test("returns null for unknown", () => {
      expect(resolveModelSelector("unknown-model")).toBeNull();
    });
  });

  describe("getAllDimensions", () => {
    test("returns all unique dimensions from roles", () => {
      const dims = getAllDimensions();
      expect(dims.length).toBeGreaterThan(0);
      expect(new Set(dims).size).toBe(dims.length);
    });
  });
}
