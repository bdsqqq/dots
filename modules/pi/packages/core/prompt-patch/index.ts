import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
    // pi-ai owns strict wire-schema conversion and optional-null normalization.
    // rewriting parameters here makes optional fields required before execute.
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
  const { validateToolArguments } = await import("@earendil-works/pi-ai");
  const { convertResponsesTools } =
    await import("@earendil-works/pi-ai/api/openai-responses-shared");
  // Codex supplies strict:null, not the converter's default false.
  const codexOptions = {
    strict: null,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
  } as const;

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

    it("prefers strict sampling without changing the local tool contract", () => {
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
      expect(patched.parameters).toBe(tool.parameters);
      expect(patched.execute).toBe(tool.execute);
    });

    it("preserves an explicit constrained-sampling choice", () => {
      const patched = withPromptPatch(makeTool({ constrainedSampling: false }));
      expect(patched.constrainedSampling).toBe(false);
    });

    it("explicitly falls back on the Codex wire without weakening local uniqueness", () => {
      const tool = withPromptPatch(
        makeTool({
          parameters: Type.Object({
            output: Type.Optional(
              Type.Array(Type.String(), { uniqueItems: true }),
            ),
          }),
        }),
      );
      const original = JSON.stringify(tool.parameters);
      const [wire] = convertResponsesTools([tool], codexOptions);
      expect(wire).toMatchObject({
        type: "function",
        strict: false,
        parameters: tool.parameters,
      });
      expect(JSON.stringify(tool.parameters)).toBe(original);
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "duplicate",
          name: tool.name,
          arguments: { output: ["document", "document"] },
        }),
      ).toThrow();
    });

    for (const keyword of ["uniqueItems", "not"]) {
      it(`does not advertise unsupported ${keyword} as strict`, () => {
        const tool = withPromptPatch(
          makeTool({
            parameters: Type.Object({
              nested: Type.Object({
                output: Type.Array(Type.String(), { [keyword]: true }),
              }),
            }),
          }),
        );
        expect(convertResponsesTools([tool], codexOptions)[0]).toMatchObject({
          strict: false,
        });
        expect(() =>
          convertResponsesTools(
            [
              {
                ...tool,
                constrainedSampling: { type: "json_schema", strict: "require" },
              },
            ],
            codexOptions,
          ),
        ).toThrow(`Tool "test_tool"`);
      });
    }

    it("preserves upstream handling of schema annotations", () => {
      const tool = makeTool({
        parameters: Type.Object({
          output: Type.String({ default: "document" }),
        }),
        constrainedSampling: { type: "json_schema", strict: "require" },
      });
      expect(convertResponsesTools([tool], codexOptions)[0]).toMatchObject({
        strict: true,
        parameters: {
          properties: { output: { type: "string", default: "document" } },
        },
      });
    });

    it("checks schema keywords, not property names or literal data", () => {
      const tool = withPromptPatch(
        makeTool({
          parameters: Type.Object({
            uniqueItems: Type.Optional(Type.String()),
            not: Type.String({
              enum: ["uniqueItems", "not"],
              description: "uniqueItems is a value here",
            }),
          }),
        }),
      );
      expect(convertResponsesTools([tool], codexOptions)[0]).toMatchObject({
        strict: true,
        parameters: {
          required: ["uniqueItems", "not"],
          properties: {
            uniqueItems: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      });
    });

    type ToolArguments = Parameters<
      typeof validateToolArguments
    >[1]["arguments"];
    it.each<{
      name: string;
      parameters: ToolDefinition["parameters"];
      minimal: ToolArguments;
      placeholders: ToolArguments;
      explicit: ToolArguments;
      invalid: ToolArguments;
    }>([
      {
        name: "read",
        parameters: Type.Object({
          path: Type.String(),
          read_range: Type.Optional(
            Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }),
          ),
        }),
        minimal: { path: "/tmp/example" },
        placeholders: { path: "/tmp/example", read_range: null },
        explicit: { path: "/tmp/example", read_range: [1, 20] },
        invalid: { path: "/tmp/example", read_range: [1] },
      },
      {
        name: "web_search",
        parameters: Type.Object({
          objective: Type.String(),
          search_queries: Type.Optional(Type.Array(Type.String())),
          max_results: Type.Optional(Type.Number()),
        }),
        minimal: { objective: "mpv wayland transparency" },
        placeholders: {
          objective: "mpv wayland transparency",
          search_queries: null,
          max_results: null,
        },
        explicit: {
          objective: "mpv wayland transparency",
          search_queries: ["mpv background=none"],
          max_results: 5,
        },
        invalid: { objective: "mpv wayland transparency", max_results: {} },
      },
    ])("validates $name optional arguments before execution", (fixture) => {
      const patched = withPromptPatch(makeTool(fixture));
      const validate = (args: ToolArguments) =>
        validateToolArguments(patched, {
          type: "toolCall",
          id: "test",
          name: patched.name,
          arguments: args,
        });

      expect(validate(fixture.minimal)).toEqual(fixture.minimal);
      expect(validate(fixture.placeholders)).toEqual(fixture.minimal);
      expect(validate(fixture.explicit)).toEqual(fixture.explicit);
      expect(() => validate({})).toThrow();
      expect(() => validate(fixture.invalid)).toThrow();
    });

    it("normalizes only synthetic nulls through upstream validation", () => {
      const tool = makeTool({
        parameters: Type.Object({
          omitted: Type.Optional(Type.String()),
          nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          requiredNullable: Type.Union([Type.String(), Type.Null()]),
          rows: Type.Array(
            Type.Object({ omitted: Type.Optional(Type.String()) }),
          ),
        }),
      });
      const patched = withPromptPatch(tool);

      const validated = validateToolArguments(patched, {
        type: "toolCall",
        id: "test",
        name: patched.name,
        arguments: {
          omitted: null,
          nullable: null,
          requiredNullable: null,
          rows: [{ omitted: null }],
        },
      });

      expect(validated).toEqual({
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
