/**
 * report rendering for model evaluations.
 *
 * outputs: markdown, json, and compact table formats.
 * primary goal: surface tradeoffs, not collapse into one score.
 */

import type {
  AgentProfile,
  EvaluatedModel,
  ModelId,
  OutputFormat,
  PresetName,
  RoleEvaluation,
  RoleId,
  RoleProfile,
} from "./types";

/**
 * render a role evaluation as markdown.
 *
 * structure: role description, frontier models, callouts, coverage gaps.
 * designed for human decision-making, not machine consumption.
 */
export function renderMarkdown(
  target: RoleProfile | AgentProfile,
  evaluation: RoleEvaluation,
  preset?: PresetName
): string {
  const lines: string[] = [];

  // header
  const isRole = !("role" in target);
  const title = isRole ? target.id : `${target.id} (${(target as AgentProfile).role})`;
  lines.push(`# ${title}`, "");
  lines.push(`> ${evaluation.role.description}`, "");

  // frontier
  if (evaluation.frontierModelIds.length > 0) {
    lines.push("## frontier", "");
    for (const id of evaluation.frontierModelIds) {
      const model = evaluation.models.find((m) => m.id === id);
      if (model) {
        lines.push(`- **${model.displayName}** (${model.providerModel})`);
        lines.push(`  - metrics: ${formatMetrics(model)}`);
      }
    }
    lines.push("");
  }

  // ranked if preset
  if (preset && evaluation.rankedModelIds) {
    lines.push(`## ranked (${preset})`, "");
    for (const id of evaluation.rankedModelIds) {
      const model = evaluation.models.find((m) => m.id === id);
      if (model) {
        lines.push(`${model.displayName}: ${formatMetrics(model)}`);
      }
    }
    lines.push("");
  }

  // callouts
  if (evaluation.callouts.length > 0) {
    lines.push("## tradeoffs", "");
    for (const callout of evaluation.callouts) {
      lines.push(`- ${callout}`);
    }
    lines.push("");
  }

  // coverage
  lines.push("## coverage", "");
  const coverageEntries = Object.entries(evaluation.coverage);
  for (const [dim, ratio] of coverageEntries) {
    const pct = Math.round((ratio as number) * 100);
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    lines.push(`- ${dim}: ${bar} ${pct}%`);
  }

  return lines.join("\n");
}

/**
 * render evaluation as json for machine consumption.
 */
export function renderJson(
  target: RoleProfile | AgentProfile,
  evaluation: RoleEvaluation,
  preset?: PresetName
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
          ])
        ),
      })),
    },
    null,
    2
  );
}

/**
 * render as compact table for terminal.
 */
export function renderTable(
  evaluation: RoleEvaluation,
  top?: number
): string {
  const lines: string[] = [];

  const models = top
    ? evaluation.models.slice(0, top)
    : evaluation.models;

  if (models.length === 0) {
    return "no eligible models";
  }

  // header
  const header = ["model", ...evaluation.role.relevantDimensions, "notes"];
  const widths = [20, ...evaluation.role.relevantDimensions.map(() => 10), 30];

  lines.push(
    header.map((h, i) => h.padEnd(widths[i] ?? 10)).join(" | ")
  );
  lines.push(
    widths.map((w) => "─".repeat(w)).join("-+-")
  );

  // rows
  const frontierSet = new Set(evaluation.frontierModelIds);
  for (const model of models) {
    const frontier = frontierSet.has(model.id) ? "★" : " ";
    const name = `${frontier}${model.displayName}`.slice(0, widths[0]);
    const dims = evaluation.role.relevantDimensions.map((dim, i) => {
      const v = model.metrics[dim];
      const width = widths[i + 1] ?? 10;
      return v !== undefined ? v.toFixed(1).padEnd(width) : "—".padEnd(width);
    });
    const notesWidth = widths[widths.length - 1] ?? 30;
    const notes = model.notes.slice(0, 2).join("; ").slice(0, notesWidth);

    lines.push(
      [name, ...dims, notes.padEnd(notesWidth)].join(" | ")
    );
  }

  // legend
  lines.push("");
  lines.push("★ = pareto frontier");

  return lines.join("\n");
}

/**
 * format metrics as a compact string.
 */
function formatMetrics(model: EvaluatedModel): string {
  const parts: string[] = [];
  for (const [dim, value] of Object.entries(model.metrics)) {
    if (value !== undefined) {
      parts.push(`${dim}=${value.toFixed(1)}`);
    }
  }
  return parts.join(", ") || "none";
}

/**
 * render all roles as a combined markdown document.
 */
export function renderAllRoles(
  roles: Record<string, RoleProfile>,
  evaluations: Map<string, RoleEvaluation>,
  preset?: PresetName
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
  dimensions: readonly string[]
): string {
  const lines: string[] = [];
  lines.push("# coverage summary", "");
  lines.push("## comparison metrics (normalized 0-100 scores)", "");

  for (const dim of dimensions) {
    let metricCount = 0;
    let verifiedCount = 0;

    for (const model of models) {
      if (model.metrics[dim as keyof typeof model.metrics] !== undefined) {
        metricCount++;
        const source = model.metricSources[dim as keyof typeof model.metricSources];
        if (source?.confidence === "verified") {
          verifiedCount++;
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
    let verifiedCount = 0;

    for (const model of models) {
      const supp = model.supplements[dim as keyof typeof model.supplements];
      if (supp) {
        supplementCount++;
        if (supp.confidence === "verified") {
          verifiedCount++;
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

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  const makeModel = (
    id: string,
    metrics: Partial<Record<string, number>>
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

    test("includes frontier models", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("## frontier");
      expect(md).toContain("A");
    });

    test("includes callouts", () => {
      const md = renderMarkdown(testRole, testEval);
      expect(md).toContain("## tradeoffs");
      expect(md).toContain("a is on the frontier");
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

  describe("renderCoverageSummary", () => {
    test("summarizes coverage", () => {
      const models = [
        makeModel("a", { intelligence: 50 }),
        makeModel("b", {}),
      ];
      const summary = renderCoverageSummary(models, ["intelligence", "price"]);
      expect(summary).toContain("- intelligence: 50% (1/2)");
      expect(summary).toContain("## comparison metrics");
    });
  });
}
