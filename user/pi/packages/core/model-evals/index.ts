/**
 * @bds_pi/model-evals
 *
 * benchmark-driven tooling for choosing models for pi sub-agents.
 *
 * this package provides:
 * - type definitions for model evaluation domain
 * - registry of candidates, roles, and agents
 * - aa data fetch/cache/normalize
 * - evaluation engine (guardrails, pareto frontier, presets)
 * - report rendering (md, json, table)
 * - cli orchestration
 *
 * @see MODEL-EVALS-PLAN.md for full design rationale
 */

export * from "./types";
export * from "./registry";
export * from "./aa";
export * from "./aa-site";
export * from "./supplements";
export * from "./evaluate";
export * from "./report";
export * from "./cli";
