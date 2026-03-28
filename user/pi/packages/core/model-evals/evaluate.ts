/**
 * evaluation engine for model selection.
 *
 * core operations:
 * - apply guardrails to filter eligible models
 * - compute pareto frontier on relevant dimensions
 * - optionally rank with preset weights
 * - generate tradeoff callouts
 */

import type {
  EvaluatedModel,
  DimensionId,
  ModelId,
  PresetName,
  RoleEvaluation,
  RoleId,
  RoleProfile,
} from "./types";

/**
 * check if a model passes all guardrails for a role.
 *
 * guardrails are hard constraints: price ceiling, minimum context,
 * required capabilities. models failing any guardrail are ineligible.
 */
export function passesGuardrails(
  role: RoleProfile,
  model: EvaluatedModel
): boolean {
  const g = role.guardrails;
  if (!g) return true;

  // price ceiling check
  // price metric is normalized: 100 - actualPrice, so higher = cheaper
  // convert back: actualPrice = 100 - normalizedPrice
  if (g.maxPricePer1mBlended !== undefined) {
    const normalizedPrice = model.metrics.price;
    if (normalizedPrice !== undefined) {
      const actualPrice = 100 - normalizedPrice;
      if (actualPrice > g.maxPricePer1mBlended) {
        return false;
      }
    }
  }

  // minimum context check (use facts for raw token count)
  if (g.minContextTokens !== undefined) {
    const contextTokens = model.facts.contextWindowTokens;
    if (contextTokens !== undefined && contextTokens < g.minContextTokens) {
      return false;
    }
    // if context is missing, we don't fail on it
  }

  // tool calling requirement
  if (g.requireToolCalling) {
    const toolCallingScore = model.metrics.toolCalling;
    // fail if we have a score and it's below threshold (< 50 on 0-100 scale)
    if (toolCallingScore !== undefined && toolCallingScore < 50) {
      return false;
    }
    // if no score, check supplements for doc-based fallback
    const toolCallingSupp = model.supplements.toolCalling;
    if (toolCallingScore === undefined && toolCallingSupp?.confidence === "verified") {
      // fail if docs say tool calling is explicitly false
      if (toolCallingSupp.value === false) {
        return false;
      }
    }
    // pass if unknown or verified good
  }

  // low hallucination requirement
  if (g.requireLowHallucination) {
    const hallucinationScore = model.metrics.hallucination;
    // hallucination metric: normalized 0-100, higher = lower hallucination rate
    // fail if verified data shows high hallucination (score < 50)
    if (hallucinationScore !== undefined && hallucinationScore < 50) {
      return false;
    }
    // if no metric, check supplements for fallback
    const hallucinationSupp = model.supplements.hallucination;
    if (hallucinationScore === undefined && hallucinationSupp?.confidence === "verified") {
      // old supplements used 0-1 scale, fail if < 0.5
      if (typeof hallucinationSupp.value === "number" && hallucinationSupp.value < 0.5) {
        return false;
      }
    }
  }

  return true;
}

/**
 * apply guardrails and return eligible models.
 */
export function applyGuardrails(
  role: RoleProfile,
  models: readonly EvaluatedModel[]
): readonly EvaluatedModel[] {
  return models.filter((m) => passesGuardrails(role, m));
}

/**
 * compute the pareto frontier on given dimensions.
 *
 * a model dominates another if it is >= on all dims and > on at least one.
 * frontier = models that are not dominated by any other.
 *
 * note: higher values are better for all dimensions (price is inverted
 * during normalization).
 */
export function computeParetoFrontier(
  models: readonly EvaluatedModel[],
  dimensions: readonly DimensionId[]
): readonly ModelId[] {
  if (models.length === 0) return [];
  if (dimensions.length === 0) return models.map((m) => m.id);

  const modelMetrics = new Map<ModelId, number[]>();
  for (const model of models) {
    const values = dimensions.map((dim) => {
      const v = model.metrics[dim];
      return v ?? -Infinity; // missing = worst
    });
    modelMetrics.set(model.id, values);
  }

  const dominated = new Set<ModelId>();

  for (const modelA of models) {
    const metricsA = modelMetrics.get(modelA.id)!;
    for (const modelB of models) {
      if (modelA.id === modelB.id) continue;
      const metricsB = modelMetrics.get(modelB.id)!;

      // check if B dominates A
      let dominated_on_all = true;
      let strictly_better = false;

      for (let i = 0; i < dimensions.length; i++) {
        const bVal = metricsB[i] ?? -Infinity;
        const aVal = metricsA[i] ?? -Infinity;
        if (bVal < aVal) {
          dominated_on_all = false;
          break;
        }
        if (bVal > aVal) {
          strictly_better = true;
        }
      }

      if (dominated_on_all && strictly_better) {
        dominated.add(modelA.id);
        break;
      }
    }
  }

  return models.filter((m) => !dominated.has(m.id)).map((m) => m.id);
}

/**
 * rank models using preset weights.
 *
 * returns model ids sorted by weighted score descending.
 * models missing a dimension get -Infinity for that dimension.
 */
export function rankWithPreset(
  models: readonly EvaluatedModel[],
  presetWeights: Partial<Record<DimensionId, number>>
): readonly ModelId[] {
  const dims = Object.keys(presetWeights) as DimensionId[];
  if (dims.length === 0) return models.map((m) => m.id);

  const scores = new Map<ModelId, number>();

  for (const model of models) {
    let score = 0;
    for (const dim of dims) {
      const weight = presetWeights[dim] ?? 0;
      const value = model.metrics[dim];
      score += weight * (value ?? -Infinity);
    }
    scores.set(model.id, score);
  }

  return [...models]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .map((m) => m.id);
}

/**
 * generate human-readable tradeoff callouts.
 *
 * surfaces notable differences between models without collapsing into
 * a single score. highlights frontier position, price/speed/smarts
 * tradeoffs, and gaps in data coverage.
 */
export function buildTradeoffCallouts(
  role: RoleProfile,
  models: readonly EvaluatedModel[],
  frontierModelIds: readonly ModelId[],
  currentModelId?: ModelId
): readonly string[] {
  const callouts: string[] = [];
  const frontierSet = new Set(frontierModelIds);

  // build lookup maps
  const modelById = new Map<ModelId, EvaluatedModel>();
  for (const model of models) {
    modelById.set(model.id, model);
  }

  // if current model exists, compare it to frontier
  if (currentModelId && modelById.has(currentModelId)) {
    const current = modelById.get(currentModelId)!;
    const isFrontier = frontierSet.has(currentModelId);

    if (!isFrontier && frontierModelIds.length > 0) {
      // find the closest frontier model
      const frontierModels = frontierModelIds
        .map((id) => modelById.get(id)!)
        .filter(Boolean);

      if (frontierModels.length > 0) {
        // compare on key dimensions
        const price = current.metrics.price;
        const intelligence = current.metrics.intelligence;
        const speed = current.metrics.outputSpeed;

        const betterPrice = frontierModels.find(
          (f) => (f.metrics.price ?? Infinity) > (price ?? 0)
        );
        const betterSmarts = frontierModels.find(
          (f) => (f.metrics.intelligence ?? 0) > (intelligence ?? 0)
        );
        const betterSpeed = frontierModels.find(
          (f) => (f.metrics.outputSpeed ?? 0) > (speed ?? 0)
        );

        if (betterPrice && betterSmarts) {
          callouts.push(
            `${betterSmarts.displayName} is smarter than current ${current.displayName}, but ${betterPrice.displayName} is cheaper`
          );
        } else if (betterSmarts) {
          callouts.push(
            `${betterSmarts.displayName} scores higher on intelligence than current ${current.displayName}`
          );
        }
      }
    } else if (isFrontier) {
      callouts.push(`${current.displayName} is on the pareto frontier for this role`);
    }
  }

  // surface tradeoffs among frontier models
  if (frontierModelIds.length > 1) {
    const frontierModels = frontierModelIds
      .map((id) => modelById.get(id)!)
      .filter(Boolean);

    // find price/speed/smarts extremes
    const byPrice = [...frontierModels].sort(
      (a, b) => (b.metrics.price ?? 0) - (a.metrics.price ?? 0)
    );
    const byIntelligence = [...frontierModels].sort(
      (a, b) => (b.metrics.intelligence ?? 0) - (a.metrics.intelligence ?? 0)
    );
    const bySpeed = [...frontierModels].sort(
      (a, b) => (b.metrics.outputSpeed ?? 0) - (a.metrics.outputSpeed ?? 0)
    );

    const cheapest = byPrice[0];
    const smartest = byIntelligence[0];
    const fastest = bySpeed[0];

    if (cheapest && smartest && cheapest.id !== smartest.id) {
      const priceDiff = (smartest.metrics.price ?? 0) - (cheapest.metrics.price ?? 0);
      const intDiff = (smartest.metrics.intelligence ?? 0) - (cheapest.metrics.intelligence ?? 0);
      callouts.push(
        `${cheapest.displayName} is ~${priceDiff.toFixed(1)} points cheaper but scores ~${intDiff.toFixed(1)} points lower on intelligence than ${smartest.displayName}`
      );
    }

    if (fastest && smartest && fastest.id !== smartest.id) {
      callouts.push(
        `${fastest.displayName} is fastest on the frontier; ${smartest.displayName} is smartest`
      );
    }
  }

  // surface coverage gaps
  const dims = [...role.relevantDimensions];
  if (role.redFlagDimensions) {
    dims.push(...role.redFlagDimensions);
  }

  // check both metrics (aa-native) and supplements for coverage
  const missingDimensions = dims.filter((dim) => {
    return models.every((m) => !m.metrics[dim] && !m.supplements[dim]);
  });

  if (missingDimensions.length > 0) {
    callouts.push(
      `coverage gap: no data for ${missingDimensions.join(", ")}`
    );
  }

  return callouts;
}

/**
 * compute coverage ratio per dimension.
 *
 * returns the fraction of models that have data for each dimension.
 * aa metrics and supplements are counted separately.
 */
export function computeCoverage(
  models: readonly EvaluatedModel[],
  dimensions: readonly DimensionId[]
): Partial<Record<DimensionId, number>> {
  const coverage: Partial<Record<DimensionId, number>> = {};

  for (const dim of dimensions) {
    let count = 0;
    for (const model of models) {
      if (model.metrics[dim] !== undefined || model.supplements[dim] !== undefined) {
        count++;
      }
    }
    coverage[dim] = models.length > 0 ? count / models.length : 0;
  }

  return coverage;
}

/**
 * full evaluation for a role.
 *
 * applies guardrails, computes frontier, optionally ranks with preset,
 * generates callouts, and computes coverage.
 */
export function evaluateRole(
  role: RoleProfile,
  models: readonly EvaluatedModel[],
  preset?: PresetName,
  currentModelId?: ModelId
): RoleEvaluation {
  const eligible = applyGuardrails(role, models);
  const relevantDims = [...role.relevantDimensions];
  const frontier = computeParetoFrontier(eligible, relevantDims);

  let ranked: readonly ModelId[] | undefined;
  if (preset && role.presets?.[preset]) {
    ranked = rankWithPreset(eligible, role.presets[preset]!);
  }

  const callouts = buildTradeoffCallouts(role, eligible, frontier, currentModelId);

  const allDims = [...relevantDims];
  if (role.redFlagDimensions) {
    allDims.push(...role.redFlagDimensions);
  }
  const coverage = computeCoverage(models, allDims);

  return {
    role,
    models: eligible,
    eligibleModelIds: eligible.map((m) => m.id),
    frontierModelIds: frontier,
    rankedModelIds: ranked,
    callouts,
    coverage,
  };
}

/**
 * evaluate an agent by resolving its role and current model.
 */
export function evaluateAgent(
  agentId: ModelId,
  agents: Record<string, { role: string; currentModel?: string }>,
  roles: Record<string, RoleProfile>,
  models: readonly EvaluatedModel[],
  preset?: PresetName
): RoleEvaluation | null {
  const agent = agents[agentId];
  if (!agent) return null;

  const role = roles[agent.role];
  if (!role) return null;

  // resolve current model, handling inherits-default
  let currentModelId: ModelId | undefined;
  if (agent.currentModel && agent.currentModel !== "inherits-default") {
    currentModelId = agent.currentModel;
  } else if (agent.currentModel === "inherits-default") {
    const defaultAgent = agents["default"];
    if (defaultAgent?.currentModel && defaultAgent.currentModel !== "inherits-default") {
      currentModelId = defaultAgent.currentModel;
    }
  }

  return evaluateRole(role, models, preset, currentModelId);
}

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  // synthetic test data
  const makeModel = (
    id: string,
    metrics: Partial<Record<DimensionId, number>>,
    supplements: Partial<Record<DimensionId, { value: unknown; confidence: "verified" | "hunch"; source: string }>> = {},
    facts: { contextWindowTokens?: number } = {}
  ): EvaluatedModel => ({
    id,
    providerModel: id,
    displayName: id,
    metrics,
    metricSources: {},
    facts,
    supplements: Object.fromEntries(
      Object.entries(supplements).map(([k, v]) => [k, { ...v }])
    ),
    notes: [],
  });

  const testRole: RoleProfile = {
    id: "test" as RoleId,
    description: "test role",
    relevantDimensions: ["intelligence", "price", "outputSpeed"] as const,
    redFlagDimensions: ["hallucination"] as const,
    guardrails: {
      maxPricePer1mBlended: 10,
    },
    presets: {
      balanced: { intelligence: 0.4, price: 0.3, outputSpeed: 0.3 },
    },
  };

  describe("passesGuardrails", () => {
    test("passes when no guardrails", () => {
      const role: RoleProfile = { ...testRole, guardrails: undefined };
      const model = makeModel("a", {});
      expect(passesGuardrails(role, model)).toBe(true);
    });

    test("fails on price ceiling", () => {
      // priceScore = 80 means actualPrice = $20, which is > $10 limit
      const model = makeModel("a", { price: 80 });
      expect(passesGuardrails(testRole, model)).toBe(false);
    });

    test("passes under price ceiling", () => {
      // priceScore = 95 means actualPrice = $5, which is <= $10 limit
      const model = makeModel("a", { price: 95 });
      expect(passesGuardrails(testRole, model)).toBe(true);
    });

    test("passes when price is missing", () => {
      const model = makeModel("a", {});
      expect(passesGuardrails(testRole, model)).toBe(true);
    });

    test("fails on min context tokens", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { minContextTokens: 256000 },
      };
      const model = makeModel("a", {}, {}, { contextWindowTokens: 128000 });
      expect(passesGuardrails(role, model)).toBe(false);
    });

    test("passes min context tokens with sufficient context", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { minContextTokens: 256000 },
      };
      const model = makeModel("a", {}, {}, { contextWindowTokens: 400000 });
      expect(passesGuardrails(role, model)).toBe(true);
    });

    test("fails on low tool calling score", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { requireToolCalling: true },
      };
      const model = makeModel("a", { toolCalling: 40 });
      expect(passesGuardrails(role, model)).toBe(false);
    });

    test("passes tool calling with sufficient score", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { requireToolCalling: true },
      };
      const model = makeModel("a", { toolCalling: 60 });
      expect(passesGuardrails(role, model)).toBe(true);
    });

    test("fails on low hallucination score", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { requireLowHallucination: true },
      };
      const model = makeModel("a", { hallucination: 40 });
      expect(passesGuardrails(role, model)).toBe(false);
    });

    test("passes hallucination with sufficient score", () => {
      const role: RoleProfile = {
        ...testRole,
        guardrails: { requireLowHallucination: true },
      };
      const model = makeModel("a", { hallucination: 60 });
      expect(passesGuardrails(role, model)).toBe(true);
    });
  });

  describe("computeParetoFrontier", () => {
    const dims: DimensionId[] = ["intelligence", "price"];

    test("returns all when single model", () => {
      const models = [makeModel("a", { intelligence: 50, price: 50 })];
      expect(computeParetoFrontier(models, dims)).toEqual(["a"]);
    });

    test("finds frontier for dominated models", () => {
      const models = [
        makeModel("dominant", { intelligence: 100, price: 100 }),
        makeModel("dominated", { intelligence: 50, price: 50 }),
      ];
      expect(computeParetoFrontier(models, dims)).toEqual(["dominant"]);
    });

    test("keeps models with tradeoffs", () => {
      const models = [
        makeModel("smart-expensive", { intelligence: 100, price: 30 }),
        makeModel("dumb-cheap", { intelligence: 50, price: 80 }),
      ];
      const frontier = computeParetoFrontier(models, dims);
      expect(frontier).toHaveLength(2);
      expect(frontier).toContain("smart-expensive");
      expect(frontier).toContain("dumb-cheap");
    });

    test("handles missing dimensions", () => {
      const models = [
        makeModel("complete", { intelligence: 100, price: 100 }),
        makeModel("missing", { intelligence: 50 }),
      ];
      const frontier = computeParetoFrontier(models, dims);
      expect(frontier).toEqual(["complete"]);
    });
  });

  describe("rankWithPreset", () => {
    const weights = { intelligence: 0.5, price: 0.5 } as Record<DimensionId, number>;

    test("orders by weighted score", () => {
      const models = [
        makeModel("high", { intelligence: 100, price: 100 }),
        makeModel("low", { intelligence: 50, price: 50 }),
      ];
      expect(rankWithPreset(models, weights)).toEqual(["high", "low"]);
    });

    test("handles empty weights", () => {
      const models = [makeModel("a", {})];
      expect(rankWithPreset(models, {})).toEqual(["a"]);
    });
  });

  describe("computeCoverage", () => {
    const dims: DimensionId[] = ["intelligence", "price"];

    test("computes coverage correctly", () => {
      const models = [
        makeModel("a", { intelligence: 50 }),
        makeModel("b", { intelligence: 50, price: 50 }),
        makeModel("c", {}),
      ];
      const coverage = computeCoverage(models, dims);
      expect(coverage.intelligence).toBe(2 / 3);
      expect(coverage.price).toBe(1 / 3);
    });

    test("returns 0 for empty models", () => {
      const coverage = computeCoverage([], dims);
      expect(coverage.intelligence).toBe(0);
    });
  });

  describe("buildTradeoffCallouts", () => {
    test("no coverage gap when dimension in metrics", () => {
      const role: RoleProfile = {
        id: "test" as RoleId,
        description: "test",
        relevantDimensions: ["coding"] as const,
      };
      const models = [makeModel("a", { coding: 50 })];
      const callouts = buildTradeoffCallouts(role, models, ["a"]);
      expect(callouts.some((c) => c.includes("coverage gap"))).toBe(false);
    });

    test("no coverage gap when dimension in supplements", () => {
      const role: RoleProfile = {
        id: "test" as RoleId,
        description: "test",
        relevantDimensions: ["hallucination"] as const,
      };
      const models = [
        makeModel("a", {}, { hallucination: { value: 0.5, confidence: "hunch", source: "test" } }),
      ];
      const callouts = buildTradeoffCallouts(role, models, ["a"]);
      expect(callouts.some((c) => c.includes("coverage gap"))).toBe(false);
    });

    test("coverage gap when dimension missing from both", () => {
      const role: RoleProfile = {
        id: "test" as RoleId,
        description: "test",
        relevantDimensions: ["coding", "hallucination"] as const,
      };
      const models = [makeModel("a", {})];
      const callouts = buildTradeoffCallouts(role, models, ["a"]);
      expect(callouts.some((c) => c.includes("coverage gap: no data for coding, hallucination"))).toBe(true);
    });
  });

  describe("evaluateRole", () => {
    test("full evaluation flow", () => {
      // priceScore >= 90 means actualPrice <= $10, which passes guardrail
      const models = [
        makeModel("a", { intelligence: 100, price: 95, outputSpeed: 90 }),
        makeModel("b", { intelligence: 60, price: 92, outputSpeed: 70 }),
      ];
      const result = evaluateRole(testRole, models);

      expect(result.eligibleModelIds).toHaveLength(2);
      expect(result.frontierModelIds).toContain("a");
      expect(result.callouts.length).toBeGreaterThan(0);
    });

    test("applies preset ranking when provided", () => {
      // priceScore >= 90 means actualPrice <= $10, which passes guardrail
      const models = [
        makeModel("a", { intelligence: 100, price: 94 }),
        makeModel("b", { intelligence: 50, price: 91 }),
      ];
      const result = evaluateRole(testRole, models, "balanced");
      expect(result.rankedModelIds).toBeDefined();
      expect(result.rankedModelIds![0]).toBe("a");
    });
  });
}
