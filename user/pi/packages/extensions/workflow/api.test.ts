import { describe, expect, it } from "vitest";
import {
  codeReview,
  defineWorkflow,
  finder,
  lookAt,
  oracle,
  readSession,
  readWebPage,
} from "./api.js";

describe("workflow authoring API", () => {
  it("builds frozen serializable recipes and definitions", () => {
    const meta = {
      name: "demo",
      description: "demo",
      phases: ["inspect"],
      agents: ["finder"],
    } as const;
    const definition = defineWorkflow(meta, {
      run: (context) =>
        context.phase("inspect", () => context.agent(finder({ query: "one" }))),
    });
    const recipe = finder({ query: "one" });
    if (false) {
      // @ts-expect-error workflow recipe inputs are immutable after construction
      recipe.input.query = "two";
    }

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.meta.phases)).toBe(true);
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(JSON.parse(JSON.stringify(recipe))).toEqual({
      kind: "finder",
      input: { query: "one" },
    });
  });

  it("returns string recipes with frozen array inputs", () => {
    const recipe = oracle({ task: "inspect", files: ["a.ts", "b.ts"] });
    const stringRecipe: typeof recipe & { readonly __result?: string } = recipe;

    expect(stringRecipe.kind).toBe("oracle");
    expect(Object.isFrozen(recipe.input.files)).toBe(true);
    expect(
      [
        codeReview({ diff_description: "review" }),
        lookAt({ path: "a.png", objective: "inspect", context: "demo" }),
        readSession({ session_id: "session", goal: "extract" }),
        readWebPage({ url: "https://example.com", prompt: "answer" }),
      ].map((entry) => entry.kind),
    ).toEqual(["codeReview", "lookAt", "readSession", "readWebPage"]);
  });
});
