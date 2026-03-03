/**
 * unit tests for tool-cost — cost type guard.
 *
 * run: bun test user/pi/extensions/tools/lib/tool-cost.test.ts
 */

import { describe, it, expect } from "bun:test";
import { hasToolCost, type ToolCostDetails } from "./tool-cost";

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
