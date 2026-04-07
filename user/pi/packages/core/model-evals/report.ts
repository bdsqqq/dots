/**
 * report rendering for model evaluations.
 *
 * LOD 24-32: decision-first, relational, skimmable output.
 * primary goal: surface "what changed, what wins, what hurts" without raw metric dumps.
 */

import type {
  AgentProfile,
  EvaluatedModel,
  ModelId,
  PresetName,
  RoleEvaluation,
  RoleId,
  RoleProfile,
  DimensionId,
} from "./types";
import {
  computeRoleLeaders,
  computeModelDeltas,
  buildModelVerdict,
  extractMeaningfulCaveats,
  computeDimensionRanks,
  computeRoleFit,
  DIMENSION_LABELS,
  type RoleLeaders,
} from "./evaluate";

/**
 * render a role evaluation as decision-first markdown.
 *
 * LOD 24-25: summary block, compare table, leaders, caveats.
 * NO raw metric dumps.
 */
export function renderMarkdown(
  target: RoleProfile | AgentProfile,
  evaluation: RoleEvaluation,
  preset?: PresetName,
  currentModelId?: ModelId,
  allModels?: readonly EvaluatedModel[],
): string {
  const lines: string[] = [];

  // header with role context
  const isAgent = "role" in target;
  const roleTitle = isAgent ? (target as AgentProfile).role : target.id;
  lines.push(`# ${target.id} → ${roleTitle}`, "");
  lines.push(`> ${evaluation.role.description}`, "");

  // find current model - check evaluation.models first, then allModels if provided
  // (current model may be ineligible due to guardrails)
  const current = currentModelId
    ? (evaluation.models.find((m) => m.id === currentModelId) ??
      allModels?.find((m) => m.id === currentModelId))
    : undefined;

  // compute leaders
  const leaders = computeRoleLeaders(
    evaluation.models,
    evaluation.role.relevantDimensions,
  );

  // summary block: current, best balanced, best budget, main tension
  lines.push("## summary", "");

  if (current) {
    lines.push(`**current:** ${current.displayName}`);
  }

  // find balanced winner (highest avg on relevant dims)
  const balancedWinner = findBalancedWinner(
    evaluation.models,
    evaluation.role.relevantDimensions,
  );
  if (balancedWinner) {
    lines.push(`**best balanced:** ${balancedWinner.displayName}`);
  }

  // find budget winner (best price among non-terrible models)
  const budgetWinner = findBudgetWinner(
    evaluation.models,
    evaluation.role.relevantDimensions,
  );
  if (budgetWinner) {
    lines.push(`**best budget:** ${budgetWinner.displayName}`);
  }

  // main tension: find frontier tradeoff
  const tension = buildMainTension(
    evaluation.models,
    evaluation.role.relevantDimensions,
    leaders,
  );
  if (tension) {
    lines.push(`**main tension:** ${tension}`);
  }
  lines.push("");

  // compare table: model | verdict | better than current | worse than current
  lines.push("## compare", "");

  const header = ["model", "verdict", "better", "worse"];
  const widths = [16, 18, 20, 20];
  lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" | "));
  lines.push(widths.map((w) => "─".repeat(w)).join("-+-"));

  // sort models: current first, then by frontier + verdict quality
  const sortedModels = sortModelsForDisplay(
    evaluation.models,
    evaluation.frontierModelIds,
    currentModelId,
    leaders,
    evaluation.role,
  );

  for (const model of sortedModels) {
    const verdict = buildModelVerdict({
      model,
      current,
      role: evaluation.role,
      leaders,
    });

    const deltas = computeModelDeltas(
      model,
      current,
      evaluation.role.relevantDimensions,
    );

    const name = model.displayName.slice(0, widths[0]!);
    const verdictStr = verdict.slice(0, widths[1]!);
    const betterStr =
      deltas.better.slice(0, 3).join(", ").slice(0, widths[2]!) || "—";
    const worseStr =
      deltas.worse.slice(0, 3).join(", ").slice(0, widths[3]!) || "—";

    lines.push(
      [name, verdictStr, betterStr, worseStr]
        .map((s, i) => s.padEnd(widths[i]!))
        .join(" | "),
    );
  }
  lines.push("");

  // leaders: who wins each dimension
  lines.push("## leaders", "");
  const leaderEntries: string[] = [];

  if (leaders.smarts?.length) {
    leaderEntries.push(
      `- **smarts:** ${leaders.smarts.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }
  if (leaders.tools?.length) {
    leaderEntries.push(
      `- **tools:** ${leaders.tools.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }
  if (leaders.hallucination?.length) {
    leaderEntries.push(
      `- **hallucination:** ${leaders.hallucination.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }
  if (leaders.price?.length) {
    leaderEntries.push(
      `- **price:** ${leaders.price.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }
  if (leaders.speed?.length) {
    leaderEntries.push(
      `- **speed:** ${leaders.speed.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }
  if (leaders.context?.length) {
    leaderEntries.push(
      `- **context:** ${leaders.context.map(idToName(evaluation.models)).join(" = ")}`,
    );
  }

  lines.push(...leaderEntries, "");

  // caveats: only meaningful caveats
  const caveats = extractMeaningfulCaveats(evaluation, evaluation.models);
  if (caveats.length > 0) {
    lines.push("## caveats", "");
    for (const caveat of caveats) {
      lines.push(`- ${caveat}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * render evaluation as json for machine consumption.
 */
export function renderJson(
  target: RoleProfile | AgentProfile,
  evaluation: RoleEvaluation,
  preset?: PresetName,
): string {
  const isRole = !("role" in target);
  return JSON.stringify(
    {
      target: {
        id: target.id,
        role: isRole ? target.id : (target as AgentProfile).role,
        label: !isRole ? (target as AgentProfile).label : undefined,
      },
      preset,
      frontier: evaluation.frontierModelIds,
      ranked: evaluation.rankedModelIds,
      eligible: evaluation.eligibleModelIds,
      callouts: evaluation.callouts,
      coverage: evaluation.coverage,
      models: evaluation.models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        metrics: m.metrics,
        facts: m.facts,
        metricSources: m.metricSources,
        supplements: Object.fromEntries(
          Object.entries(m.supplements).map(([k, v]) => [
            k,
            { value: v.value, confidence: v.confidence },
          ]),
        ),
      })),
    },
    null,
    2,
  );
}

/**
 * render as compact table for terminal.
 */
export function renderTable(evaluation: RoleEvaluation, top?: number): string {
  const lines: string[] = [];

  const models = top ? evaluation.models.slice(0, top) : evaluation.models;

  if (models.length === 0) {
    return "no eligible models";
  }

  // header
  const header = ["model", ...evaluation.role.relevantDimensions, "notes"];
  const widths = [20, ...evaluation.role.relevantDimensions.map(() => 10), 30];

  lines.push(header.map((h, i) => h.padEnd(widths[i] ?? 10)).join(" | "));
  lines.push(widths.map((w) => "─".repeat(w)).join("-+-"));

  // rows
  const frontierSet = new Set(evaluation.frontierModelIds);
  for (const model of models) {
    const frontier = frontierSet.has(model.id) ? "★" : " ";
    const name = `${frontier}${model.displayName}`.slice(0, widths[0]!);
    const dims = evaluation.role.relevantDimensions.map((dim, i) => {
      const v = model.metrics[dim];
      const width = widths[i + 1] ?? 10;
      return v !== undefined ? v.toFixed(1).padEnd(width) : "—".padEnd(width);
    });
    const notesWidth = widths[widths.length - 1] ?? 30;
    const notes = model.notes.slice(0, 2).join("; ").slice(0, notesWidth);

    lines.push([name, ...dims, notes.padEnd(notesWidth)].join(" | "));
  }

  // legend
  lines.push("");
  lines.push("★ = pareto frontier");

  return lines.join("\n");
}

/**
 * LOD 29: render dense --tldr matrix.
 *
 * structure: summary line + dense matrix with rank ordinals + take column.
 */
export function renderTldrMatrix(
  target: RoleProfile | AgentProfile,
  evaluation: RoleEvaluation,
  currentModelId?: ModelId,
  allModels?: readonly EvaluatedModel[],
): string {
  const lines: string[] = [];

  const isAgent = "role" in target;
  const roleTitle = isAgent ? (target as AgentProfile).role : target.id;
  lines.push(`# ${target.id} → ${roleTitle}`, "");

  // main tension line
  const leaders = computeRoleLeaders(
    evaluation.models,
    evaluation.role.relevantDimensions,
  );
  const tension = buildMainTension(
    evaluation.models,
    evaluation.role.relevantDimensions,
    leaders,
  );
  if (tension) {
    lines.push(`**main tension:** ${tension}`, "");
  }

  // find current model - may be ineligible
  const current = currentModelId
    ? (evaluation.models.find((m) => m.id === currentModelId) ??
      allModels?.find((m) => m.id === currentModelId))
    : undefined;

  // dense matrix
  const dims = evaluation.role.relevantDimensions.slice(0, 6); // max 6 dimensions
  const dimLabels = dims.map((d) => DIMENSION_LABELS[d] ?? d.slice(0, 6));

  const header = ["model", ...dimLabels, "take"];
  const widths = [14, ...dimLabels.map(() => 6), 24];

  lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" "));
  lines.push(widths.map((w) => "─".repeat(w)).join(" "));

  // compute ranks
  const ranks = computeDimensionRanks(evaluation.models, dims);

  // sort: current first, then by average rank
  const sortedModels = [...evaluation.models].sort((a, b) => {
    if (a.id === currentModelId) return -1;
    if (b.id === currentModelId) return 1;

    const aRanks = ranks.get(a.id);
    const bRanks = ranks.get(b.id);
    if (!aRanks || !bRanks) return 0;

    const aAvg = [...aRanks.values()].reduce((s, r) => s + r, 0) / aRanks.size;
    const bAvg = [...bRanks.values()].reduce((s, r) => s + r, 0) / bRanks.size;
    return aAvg - bAvg;
  });

  for (const model of sortedModels.slice(0, 8)) {
    const modelRanks = ranks.get(model.id);
    const name = model.displayName.slice(0, widths[0]!);

    const rankCells = dims.map((dim) => {
      const rank = modelRanks?.get(dim);
      const score = model.metrics[dim];
      if (rank !== undefined && score !== undefined) {
        return `#${rank}`.padEnd(widths[dims.indexOf(dim) + 1]!);
      }
      return "—".padEnd(widths[dims.indexOf(dim) + 1]!);
    });

    const verdict = buildModelVerdict({
      model,
      current,
      role: evaluation.role,
      leaders,
    });
    const take = verdict.slice(0, widths[widths.length - 1]!);

    lines.push([name, ...rankCells, take].join(" "));
  }

  return lines.join("\n");
}

/**
 * LOD 30: render portfolio matrix for report --all.
 *
 * single table showing all roles with current/best/budget picks.
 */
export function renderPortfolioMatrix(
  roles: Record<RoleId, RoleProfile>,
  evaluations: Map<string, RoleEvaluation>,
  agents: Record<string, AgentProfile>,
  allModels?: readonly EvaluatedModel[],
): string {
  const lines: string[] = [];

  lines.push("# model evals report", "");
  lines.push(`generated: ${new Date().toISOString()}`, "");

  // portfolio matrix
  lines.push("## portfolio", "");

  const header = [
    "role",
    "current",
    "likely best",
    "budget pick",
    "main tension",
  ];
  const widths = [16, 16, 16, 16, 32];
  lines.push(header.map((h, i) => h.padEnd(widths[i]!)).join(" | "));
  lines.push(widths.map((w) => "─".repeat(w)).join("-+-"));

  for (const [roleId, role] of Object.entries(roles)) {
    const eval_ = evaluations.get(roleId);
    if (!eval_) continue;

    // find current model for this role
    const agentsInRole = Object.values(agents).filter((a) => a.role === roleId);
    const currentModel = agentsInRole[0]?.currentModel;
    // check eval_.models first, then allModels (current may be ineligible)
    const current =
      currentModel && currentModel !== "inherits-default"
        ? (eval_.models.find((m) => m.id === currentModel) ??
          allModels?.find((m) => m.id === currentModel))
        : undefined;

    const balanced = findBalancedWinner(eval_.models, role.relevantDimensions);
    const budget = findBudgetWinner(eval_.models, role.relevantDimensions);
    const leaders = computeRoleLeaders(eval_.models, role.relevantDimensions);
    const tension = buildMainTension(
      eval_.models,
      role.relevantDimensions,
      leaders,
    );

    const row = [
      roleId.slice(0, widths[0]!),
      current?.displayName.slice(0, widths[1]!) ?? "—",
      balanced?.displayName.slice(0, widths[2]!) ?? "—",
      budget?.displayName.slice(0, widths[3]!) ?? "—",
      (tension ?? "").slice(0, widths[4]!),
    ];

    lines.push(row.map((s, i) => s.padEnd(widths[i]!)).join(" | "));
  }

  lines.push("");

  // cross-role patterns
  lines.push("## cross-role patterns", "");

  // find models that win multiple roles
  const modelRoleWins = new Map<string, string[]>();
  for (const [roleId, role] of Object.entries(roles)) {
    const eval_ = evaluations.get(roleId);
    if (!eval_) continue;

    const winner = findBalancedWinner(eval_.models, role.relevantDimensions);
    if (winner) {
      const existing = modelRoleWins.get(winner.id) ?? [];
      existing.push(roleId);
      modelRoleWins.set(winner.id, existing);
    }
  }

  for (const [modelId, roleIds] of modelRoleWins) {
    if (roleIds.length >= 2) {
      const model = [...evaluations.values()][0]?.models.find(
        (m) => m.id === modelId,
      );
      if (model) {
        lines.push(`- **${model.displayName}** wins: ${roleIds.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * LOD 30: render model inspect output.
 *
 * structure: fit, relative standing, raw facts, sources.
 */
export function renderInspectModel(
  model: EvaluatedModel,
  roles: Record<RoleId, RoleProfile>,
  allModels: readonly EvaluatedModel[],
): string {
  const lines: string[] = [];

  lines.push(`# ${model.displayName}`, "");
  lines.push(`> ${model.providerModel}`, "");

  // fit summary across roles
  const fit = computeRoleFit(model, roles, allModels);

  lines.push("## fit", "");
  if (fit.strong.length > 0) {
    lines.push(`- **strong for:** ${fit.strong.join(", ")}`);
  }
  if (fit.mixed.length > 0) {
    lines.push(`- **mixed for:** ${fit.mixed.join(", ")}`);
  }
  if (fit.risky.length > 0) {
    lines.push(`- **risky for:** ${fit.risky.join(", ")}`);
  }
  lines.push("");

  // relative standing: ordinal rank on each dimension
  lines.push("## relative standing", "");

  const dims = Object.keys(model.metrics) as DimensionId[];
  const ranks = computeDimensionRanks(allModels, dims);
  const modelRanks = ranks.get(model.id);

  for (const dim of dims) {
    const score = model.metrics[dim];
    const rank = modelRanks?.get(dim);
    if (score !== undefined && rank !== undefined) {
      const label = DIMENSION_LABELS[dim] ?? dim;
      lines.push(
        `- ${label}: #${rank} / ${allModels.length} (score: ${score.toFixed(0)})`,
      );
    }
  }
  lines.push("");

  // raw facts
  lines.push("## raw facts", "");
  const factEntries = Object.entries(model.facts).filter(
    ([, v]) => v !== undefined,
  );
  if (factEntries.length > 0) {
    for (const [key, value] of factEntries) {
      if (typeof value === "number") {
        lines.push(`- ${key}: ${value.toLocaleString()}`);
      } else {
        lines.push(`- ${key}: ${value}`);
      }
    }
  } else {
    lines.push("_(no raw facts available)_");
  }
  lines.push("");

  // sources: where each metric came from
  lines.push("## sources", "");
  for (const [dim, source] of Object.entries(model.metricSources)) {
    if (source) {
      const label = DIMENSION_LABELS[dim] ?? dim;
      lines.push(`- ${label}: ${source.source} (${source.confidence})`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// private helpers
// ============================================================

function idToName(models: readonly EvaluatedModel[]): (id: ModelId) => string {
  return (id: ModelId) => {
    const model = models.find((m) => m.id === id);
    return model?.displayName ?? id;
  };
}

function findBalancedWinner(
  models: readonly EvaluatedModel[],
  dimensions: readonly string[],
): EvaluatedModel | undefined {
  if (models.length === 0) return undefined;

  const scores = new Map<ModelId, number>();

  for (const model of models) {
    let sum = 0;
    let count = 0;
    for (const dim of dimensions) {
      const val = model.metrics[dim as keyof typeof model.metrics];
      if (val !== undefined) {
        sum += val;
        count++;
      }
    }
    if (count > 0) {
      scores.set(model.id, sum / count);
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const topId = sorted[0]?.[0];
  return topId ? models.find((m) => m.id === topId) : undefined;
}

function findBudgetWinner(
  models: readonly EvaluatedModel[],
  dimensions: readonly string[],
): EvaluatedModel | undefined {
  // find models with decent scores that have best price
  const viable = models.filter((m) => {
    // must have at least 60% avg score on relevant dims
    let sum = 0;
    let count = 0;
    for (const dim of dimensions) {
      const val = m.metrics[dim as keyof typeof m.metrics];
      if (val !== undefined && dim !== "price") {
        sum += val;
        count++;
      }
    }
    return count > 0 && sum / count >= 50;
  });

  if (viable.length === 0) return undefined;

  // sort by price (higher = cheaper in our normalized scale)
  viable.sort((a, b) => (b.metrics.price ?? 0) - (a.metrics.price ?? 0));
  return viable[0];
}

function buildMainTension(
  models: readonly EvaluatedModel[],
  dimensions: readonly string[],
  leaders: RoleLeaders,
): string | undefined {
  // find tension between top smarts and top price leaders
  const smartsLeader = leaders.smarts?.[0];
  const priceLeader = leaders.price?.[0];

  if (smartsLeader && priceLeader && smartsLeader !== priceLeader) {
    const smartsModel = models.find((m) => m.id === smartsLeader);
    const priceModel = models.find((m) => m.id === priceLeader);

    if (smartsModel && priceModel) {
      return `${smartsModel.displayName} wins smarts/tools, ${priceModel.displayName} wins price/hallucination`;
    }
  }

  // fallback: first callout
  return undefined;
}

function sortModelsForDisplay(
  models: readonly EvaluatedModel[],
  frontierIds: readonly ModelId[],
  currentId?: ModelId,
  leaders?: RoleLeaders,
  role?: RoleProfile,
): EvaluatedModel[] {
  return [...models].sort((a, b) => {
    // current first
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;

    // frontier second
    const aFrontier = frontierIds.includes(a.id);
    const bFrontier = frontierIds.includes(b.id);
    if (aFrontier && !bFrontier) return -1;
    if (!aFrontier && bFrontier) return 1;

    // then by average score on relevant dims
    if (role) {
      const aAvg = role.relevantDimensions.reduce(
        (s, d) => s + (a.metrics[d] ?? 0),
        0,
      );
      const bAvg = role.relevantDimensions.reduce(
        (s, d) => s + (b.metrics[d] ?? 0),
        0,
      );
      return bAvg - aAvg;
    }

    return 0;
  });
}

// ============================================================
// legacy exports for backward compatibility
// ============================================================



/**
 * render all roles as a combined markdown document (legacy).
 */
export function renderAllRoles(
  roles: Record<string, RoleProfile>,
  evaluations: Map<string, RoleEvaluation>,
  preset?: PresetName,
): string {
  const lines: string[] = [];

  lines.push("# model evaluation report", "");
  lines.push(`generated: ${new Date().toISOString()}`, "");
  lines.push("---", "");

  for (const [roleId, role] of Object.entries(roles)) {
    const evaluation = evaluations.get(roleId);
    if (evaluation) {
      lines.push(renderMarkdown(role, evaluation, preset));
      lines.push("---", "");
    }
  }

  return lines.join("\n");
}

/**
 * render coverage summary across all dimensions.
 */
export function renderCoverageSummary(
  models: readonly EvaluatedModel[],
  dimensions: readonly string[],
): string {
  const lines: string[] = [];
  lines.push("# coverage summary", "");
  lines.push("## comparison metrics (normalized 0-100 scores)", "");

  for (const dim of dimensions) {
    let metricCount = 0;
    let _verifiedCount = 0;

    for (const model of models) {
      if (model.metrics[dim as keyof typeof model.metrics] !== undefined) {
        metricCount++;
        const source =
          model.metricSources[dim as keyof typeof model.metricSources];
        if (source?.confidence === "verified") {
          _verifiedCount++;
        }
      }
    }

    const total = models.length;
    const metricPct = Math.round((metricCount / total) * 100);

    lines.push(`- ${dim}: ${metricPct}% (${metricCount}/${total})`);
  }

  lines.push("");
  lines.push("## raw facts", "");

  const factKeys = [
    "contextWindowTokens",
    "hallucinationRate",
    "ifbench",
    "lcr",
    "terminalbenchHard",
    "tau2",
    "agenticIndex",
  ] as const;

  for (const key of factKeys) {
    let count = 0;
    for (const model of models) {
      if (model.facts[key] !== undefined) {
        count++;
      }
    }
    const total = models.length;
    const pct = Math.round((count / total) * 100);
    lines.push(`- ${key}: ${pct}% (${count}/${total})`);
  }

  lines.push("");
  lines.push("## manual fallbacks", "");

  for (const dim of dimensions) {
    let supplementCount = 0;
    let _verifiedCount = 0;

    for (const model of models) {
      const supp = model.supplements[dim as keyof typeof model.supplements];
      if (supp) {
        supplementCount++;
        if (supp.confidence === "verified") {
          _verifiedCount++;
        }
      }
    }

    const total = models.length;
    const suppPct = Math.round((supplementCount / total) * 100);

    if (supplementCount > 0) {
      lines.push(`- ${dim}: ${suppPct}% (${supplementCount}/${total})`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// tests
// ============================================================

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  const makeModel = (
    id: string,
    metrics: Partial<Record<string, number>>,
  ): EvaluatedModel => ({
    id,
    providerModel: id,
    displayName: id.toUpperCase(),
    metrics,
    metricSources: {},
    facts: {},
    supplements: {},
    notes: [],
  });

  const testRole: RoleProfile = {
    id: "test" as RoleId,
    description: "test role",
    relevantDimensions: ["intelligence", "price"] as const,
  };

  const testEval: RoleEvaluation = {
    role: testRole,
    models: [
      makeModel("a", { intelligence: 100, price: 80 }),
      makeModel("b", { intelligence: 60, price: 90 }),
    ],
    eligibleModelIds: ["a", "b"],
    frontierModelIds: ["a"],
    callouts: ["a is on the frontier"],
    coverage: { intelligence: 1, price: 1 },
  };

  describe("renderMarkdown", () => {
    test("includes role description", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("test role");
    });

    test("includes summary section", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("## summary");
    });

    test("includes compare table", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("## compare");
      expect(md).toContain("verdict");
    });

    test("includes leaders section", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("## leaders");
    });
  });

  describe("renderJson", () => {
    test("produces valid json", () => {
      const json = renderJson(testRole, testEval);
      const parsed = JSON.parse(json);
      expect(parsed.target).toBeDefined();
      expect(parsed.frontier).toEqual(["a"]);
    });
  });

  describe("renderTable", () => {
    test("produces table output", () => {
      const table = renderTable(testEval);
      expect(table).toContain("model");
      expect(table).toContain("intelligence");
      expect(table).toContain("A");
    });

    test("handles empty models", () => {
      const emptyEval: RoleEvaluation = {
        ...testEval,
        models: [],
        eligibleModelIds: [],
        frontierModelIds: [],
      };
      expect(renderTable(emptyEval)).toBe("no eligible models");
    });
  });

  describe("renderTldrMatrix", () => {
    test("produces dense matrix with ranks", () => {
      const md = renderTldrMatrix(testRole, testEval);
      expect(md).toContain("main tension");
      expect(md).toContain("model");
    });
  });

  describe("renderCoverageSummary", () => {
    test("summarizes coverage", () => {
      const models = [makeModel("a", { intelligence: 50 }), makeModel("b", {})];
      const summary = renderCoverageSummary(models, ["intelligence", "price"]);
      expect(summary).toContain("- intelligence: 50% (1/2)");
      expect(summary).toContain("## comparison metrics");
    });
  });
}
