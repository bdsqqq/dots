import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TObject, type TSchema, type TUnion } from "typebox";

function closeObjectSchemas<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(closeObjectSchemas(item, seen));
    return clone as T;
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<
    PropertyKey,
    unknown
  >;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) {
      descriptor.value = closeObjectSchemas(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  if (clone.type === "object") {
    if (clone.additionalProperties === undefined) {
      clone.additionalProperties = false;
    }
    const properties = clone.properties as Record<string, TSchema> | undefined;
    if (properties) {
      const originallyRequired = new Set(
        Array.isArray(clone.required) ? clone.required : [],
      );
      for (const [key, schema] of Object.entries(properties)) {
        if (!originallyRequired.has(key)) {
          properties[key] = Type.Union([schema, Type.Null()]);
        }
      }
      clone.required = Object.keys(properties);
    }
  }
  return clone as T;
}

function schemaAllowsNull(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const value = schema as Record<string, unknown>;
  if (value.const === null) return true;
  if (Array.isArray(value.enum) && value.enum.includes(null)) return true;
  if (value.type === "null") return true;
  if (Array.isArray(value.type) && value.type.includes("null")) return true;
  return [value.anyOf, value.oneOf].some(
    (variants) =>
      Array.isArray(variants) &&
      variants.some((item) => schemaAllowsNull(item)),
  );
}

function restoreOptionalArguments<T>(value: T, schema: unknown): T {
  if (value === null || typeof value !== "object") return value;
  const shape =
    schema !== null && typeof schema === "object"
      ? (schema as Record<string, unknown>)
      : undefined;

  if (Array.isArray(value)) {
    return value.map((item) =>
      restoreOptionalArguments(item, shape?.items),
    ) as T;
  }

  const properties = shape?.properties as Record<string, unknown> | undefined;
  const required = new Set(
    Array.isArray(shape?.required) ? (shape.required as string[]) : [],
  );
  const restored: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const propertySchema = properties?.[key];
    const syntheticNull =
      child === null &&
      propertySchema !== undefined &&
      !required.has(key) &&
      !schemaAllowsNull(propertySchema);
    if (!syntheticNull) {
      restored[key] = restoreOptionalArguments(child, propertySchema);
    }
  }
  return restored as T;
}

/**
 * derives promptSnippet and promptGuidelines from a tool's description
 * so tools don't need to define them manually. snippet = first paragraph,
 * guidelines = lines starting with "- ".
 */
export function withPromptPatch(tool: ToolDefinition): ToolDefinition {
  const snippet = (tool.description?.split("\n\n")[0] ?? "").trim();
  const guidelines = (tool.description ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  const patched: ToolDefinition = { ...tool };
  if (!patched.promptSnippet) patched.promptSnippet = snippet;
  if (!patched.promptGuidelines && guidelines.length > 0) {
    patched.promptGuidelines = guidelines;
  }
  if (patched.constrainedSampling === undefined) {
    const originalParameters = patched.parameters;
    patched.parameters = closeObjectSchemas(originalParameters);
    const execute = patched.execute.bind(patched);
    patched.execute = (toolCallId, params, signal, onUpdate, ctx) =>
      execute(
        toolCallId,
        restoreOptionalArguments(params, originalParameters),
        signal,
        onUpdate,
        ctx,
      );
    patched.constrainedSampling = {
      type: "json_schema",
      strict: "prefer",
    };
  }

  return patched;
}

if (import.meta.vitest) {
  const { describe, it, expect } = await import("vitest");
  const { Type } = await import("typebox");

  function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
      name: "test_tool",
      label: "Test Tool",
      description: "Test description.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
      ...overrides,
    };
  }

  describe("withPromptPatch", () => {
    it("extracts first paragraph as promptSnippet", () => {
      const tool = makeTool({
        description:
          "This is the first paragraph.\n\nThis is the second paragraph.",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("This is the first paragraph.");
    });

    it("extracts bullet points as promptGuidelines", () => {
      const tool = makeTool({
        description:
          "Description.\n\n- First guideline\n- Second guideline\n- Third guideline\n\nMore text.",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptGuidelines).toEqual([
        "- First guideline",
        "- Second guideline",
        "- Third guideline",
      ]);
    });

    it("handles description without paragraphs", () => {
      const tool = makeTool({ description: "Single line description" });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("Single line description");
      expect(patched.promptGuidelines).toBeUndefined();
    });

    it("handles description without guidelines", () => {
      const tool = makeTool({
        description:
          "First paragraph.\n\nSecond paragraph.\n\nNo bullets here.",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("First paragraph.");
      expect(patched.promptGuidelines).toBeUndefined();
    });

    it("preserves existing promptSnippet", () => {
      const tool = makeTool({
        description: "Auto-extracted snippet.\n\n- A guideline",
        promptSnippet: "Manual snippet",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("Manual snippet");
    });

    it("preserves existing promptGuidelines", () => {
      const tool = makeTool({
        description: "Description.\n\n- Auto guideline",
        promptGuidelines: ["- Manual guideline"],
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptGuidelines).toEqual(["- Manual guideline"]);
    });

    it("trims snippet whitespace", () => {
      const tool = makeTool({
        description:
          "  \n  Snippet with whitespace  \n\n\n  \nSecond paragraph  ",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("Snippet with whitespace");
    });

    it("handles multiline bullets", () => {
      const tool = makeTool({
        description:
          "Description.\n\n- First bullet\n  with continuation\n- Second bullet\n\nEnd.",
      });
      const patched = withPromptPatch(tool);
      expect(patched.promptGuidelines).toEqual([
        "- First bullet",
        "- Second bullet",
      ]);
    });

    it("does not mutate original tool", () => {
      const tool = makeTool({ description: "Description.\n\n- Guideline" });
      const patched = withPromptPatch(tool);
      expect(tool).not.toHaveProperty("promptSnippet");
      expect(tool).not.toHaveProperty("promptGuidelines");
      expect(patched).not.toBe(tool);
    });

    it("handles empty description gracefully", () => {
      const tool = makeTool({ description: "" });
      const patched = withPromptPatch(tool);
      expect(patched.promptSnippet).toBe("");
      expect(patched.promptGuidelines).toBeUndefined();
    });

    it("prefers strict JSON-schema sampling with closed object schemas", () => {
      const tool = makeTool({
        parameters: Type.Object({
          nested: Type.Object({ value: Type.String() }),
          optionalNested: Type.Optional(
            Type.Object({ value: Type.Optional(Type.String()) }),
          ),
        }),
      });
      const patched = withPromptPatch(tool);
      expect(patched.constrainedSampling).toEqual({
        type: "json_schema",
        strict: "prefer",
      });
      expect(patched.parameters).not.toBe(tool.parameters);
      type ClosedObject = TObject & { additionalProperties?: boolean };
      const parameters = patched.parameters as ClosedObject;
      expect(parameters.additionalProperties).toBe(false);
      expect(parameters.required).toEqual(["nested", "optionalNested"]);
      const nested = parameters.properties.nested as ClosedObject;
      expect(nested.additionalProperties).toBe(false);
      expect(nested.required).toEqual(["value"]);
      const optional = parameters.properties.optionalNested as TUnion;
      const optionalNested = optional.anyOf[0] as ClosedObject;
      expect(optionalNested.additionalProperties).toBe(false);
      expect(optionalNested.required).toEqual(["value"]);
      expect(
        (tool.parameters as ClosedObject).additionalProperties,
      ).toBeUndefined();
    });

    it("preserves an explicit constrained-sampling choice", () => {
      const patched = withPromptPatch(makeTool({ constrainedSampling: false }));
      expect(patched.constrainedSampling).toBe(false);
    });

    it("removes only synthetic optional null placeholders", async () => {
      let received: unknown;
      const tool = makeTool({
        parameters: Type.Object({
          omitted: Type.Optional(Type.String()),
          nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          requiredNullable: Type.Union([Type.String(), Type.Null()]),
          rows: Type.Array(
            Type.Object({ omitted: Type.Optional(Type.String()) }),
          ),
        }),
        async execute(_id, params, _signal, _onUpdate, _ctx) {
          received = params;
          return {
            content: [{ type: "text", text: "ok" }],
            details: undefined,
          };
        },
      });
      const patched = withPromptPatch(tool);

      await patched.execute(
        "id",
        {
          omitted: null,
          nullable: null,
          requiredNullable: null,
          rows: [{ omitted: null }],
        } as never,
        undefined,
        undefined,
        {} as never,
      );

      expect(received).toEqual({
        nullable: null,
        requiredNullable: null,
        rows: [{}],
      });
    });

    it("preserves all other tool properties", () => {
      const tool = makeTool({ description: "Desc.\n\n- Guide" });
      const patched = withPromptPatch(tool);
      expect(patched.name).toBe("test_tool");
      expect(patched.label).toBe(tool.label);
    });
  });
}
