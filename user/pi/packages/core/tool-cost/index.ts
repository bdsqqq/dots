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

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("hasToolCost", () => {
    it("returns true for valid ToolCostDetails", () => {
      const valid: ToolCostDetails = { cost: 0.0023 };
      expect(hasToolCost(valid)).toBe(true);
    });

    it("returns true for object with cost number", () => {
      expect(hasToolCost({ cost: 0 })).toBe(true);
      expect(hasToolCost({ cost: 1.5 })).toBe(true);
      expect(hasToolCost({ cost: -0.001 })).toBe(true);
    });

    it("returns true for object with additional properties", () => {
      expect(hasToolCost({ cost: 0.5, turns: 3, model: "gpt-4" })).toBe(true);
    });

    it("returns false for null", () => {
      expect(hasToolCost(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(hasToolCost(undefined)).toBe(false);
    });

    it("returns false for non-objects", () => {
      expect(hasToolCost("string")).toBe(false);
      expect(hasToolCost(123)).toBe(false);
      expect(hasToolCost(true)).toBe(false);
    });

    it("returns false for object without cost", () => {
      expect(hasToolCost({})).toBe(false);
      expect(hasToolCost({ turns: 3 })).toBe(false);
      expect(hasToolCost({ model: "gpt-4" })).toBe(false);
    });

    it("returns false for object with non-number cost", () => {
      expect(hasToolCost({ cost: "0.002" })).toBe(false);
      expect(hasToolCost({ cost: null })).toBe(false);
      expect(hasToolCost({ cost: undefined })).toBe(false);
      expect(hasToolCost({ cost: true })).toBe(false);
    });

    it("narrowing works correctly", () => {
      const unknown: unknown = { cost: 0.5, turns: 2 };

      if (hasToolCost(unknown)) {
        // TypeScript should know unknown is ToolCostDetails
        const cost: number = unknown.cost;
        expect(cost).toBe(0.5);
      } else {
        // should not reach here
        expect(true).toBe(false);
      }
    });
  });
}
