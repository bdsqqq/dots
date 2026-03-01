/**
 * shared cost contract for tool result details.
 *
 * any tool that incurs costs includes `cost: number` in its
 * details object. editor/index.ts uses the type guard to narrow
 * details at the session read boundary — no casting needed.
 *
 * sub-agent tools satisfy this via SingleResult & ToolCostDetails.
 * direct-cost tools (web_search) return { cost } directly.
 */

export interface ToolCostDetails {
  cost: number;
}

export function hasToolCost(v: unknown): v is ToolCostDetails {
  return (
    v != null &&
    typeof v === "object" &&
    "cost" in v &&
    typeof (v as Record<string, unknown>).cost === "number"
  );
}
