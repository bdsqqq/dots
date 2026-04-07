/**
 * core types for model evaluation.
 *
 * these contracts define the evaluation domain: candidate models, role archetypes,
 * agents, dimensions we measure, and the evaluation output shape.
 */

export type ModelId = string;

export type AgentId =
  | "default"
  | "task"
  | "oracle"
  | "code-review"
  | "finder"
  | "librarian"
  | "handoff"
  | "read-session"
  | "read-web-page"
  | "look-at";

export type RoleId =
  | "dayToDay"
  | "deepReasoning"
  | "fastSummarization"
  | "fastSearch"
  | "repoResearch";

export type DimensionId =
  | "coding"
  | "intelligence"
  | "price"
  | "outputSpeed"
  | "ttft"
  | "hallucination"
  | "toolCalling"
  | "context"
  | "instructionFollowing"
  | "longContextReasoning";

/**
 * a model we are considering for assignment.
 *
 * `aaMatch` defines how to find this model in artificial analysis data.
 * matching is by `apiSlug`/`apiName` for the free api, or `siteSlugs`/`siteNames`
 * for site-scraped benchmarks. aliases allow flexible selector resolution
 * from cli args.
 */
export interface CandidateModel {
  id: ModelId;
  providerModel: string;
  displayName: string;
  aaMatch: {
    apiSlug?: string;
    apiName?: string;
    siteSlugs?: readonly string[];
    siteNames?: readonly string[];
  };
  aliases?: readonly string[];
}

/**
 * profile for a role archetype (e.g., dayToDay, deepReasoning).
 *
 * roles define what dimensions matter, which are red flags, and optional
 * guardrails that disqualify models. presets allow fuzzy weighting
 * without collapsing everything into one score.
 */
export interface RoleProfile {
  id: RoleId;
  description: string;
  relevantDimensions: readonly DimensionId[];
  redFlagDimensions?: readonly DimensionId[];
  guardrails?: {
    maxPricePer1mBlended?: number;
    minContextTokens?: number;
    requireToolCalling?: boolean;
    requireLowHallucination?: boolean;
  };
  presets?: Partial<
    Record<
      "balanced" | "cheap" | "fast" | "max-smarts",
      Partial<Record<DimensionId, number>>
    >
  >;
}

/**
 * profile for an agent that maps to a role.
 *
 * currentModel tracks the live assignment for comparison in reports.
 * "inherits-default" means the agent uses the parent/default model.
 */
export interface AgentProfile {
  id: AgentId;
  role: RoleId;
  label: string;
  currentModel?: ModelId;
}

/**
 * supplemental metric with provenance.
 *
 * used for dimensions not provided by artificial analysis (hallucination,
 * tool calling quality, context size, instruction following). confidence
 * levels surface uncertainty instead of hiding it.
 */
export interface SupplementalMetric<T = number | string | boolean> {
  value: T;
  confidence: "verified" | "hunch";
  source: string;
  note?: string;
}

/**
 * provenance for a normalized metric score.
 *
 * tracks where a metric came from: aa free api, aa site-scraped benchmark,
 * or manual fallback. used by inspect/report to show data sources.
 */
export interface MetricSource {
  source: string;
  confidence: "verified" | "hunch";
  note?: string;
}

/**
 * raw benchmark facts that don't belong in normalized comparison metrics.
 *
 * these are absolute values (token counts, raw rates) that guardrails may
 * check directly. metrics derive from these but stay normalized for ranking.
 */
export interface ModelFacts {
  contextWindowTokens?: number;
  hallucinationRate?: number;
  nonHallucinationRate?: number;
  terminalbenchHard?: number;
  tau2?: number;
  agenticIndex?: number;
  ifbench?: number;
  lcr?: number;
}

/**
 * a model with normalized metrics from aa plus supplements.
 *
 * `metrics` holds normalized comparison scores (higher is better for all).
 * `metricSources` tracks provenance for each metric dimension.
 * `facts` holds raw benchmark values for guardrails and inspect output.
 * `supplements` holds manual fallback data only.
 * `notes` accumulates callouts during evaluation.
 */
export interface EvaluatedModel {
  id: ModelId;
  providerModel: string;
  displayName: string;
  metrics: Partial<Record<DimensionId, number>>;
  metricSources: Partial<Record<DimensionId, MetricSource>>;
  facts: ModelFacts;
  supplements: Partial<Record<DimensionId, SupplementalMetric>>;
  notes: string[];
}

/**
 * result of evaluating a role against all candidates.
 *
 * frontier models are pareto-optimal on relevant dimensions. eligible
 * models pass guardrails. callouts surface tradeoffs without a single
 * weighted score. coverage shows data completeness per dimension.
 */
export interface RoleEvaluation {
  role: RoleProfile;
  models: readonly EvaluatedModel[];
  eligibleModelIds: readonly ModelId[];
  frontierModelIds: readonly ModelId[];
  rankedModelIds?: readonly ModelId[];
  callouts: readonly string[];
  coverage: Partial<Record<DimensionId, number>>;
}

export type PresetName = "balanced" | "cheap" | "fast" | "max-smarts";

export type OutputFormat = "md" | "json" | "table";
