/**
 * unit tests for tools/index.ts — withPromptPatch.
 *
 * tests that tool descriptions are correctly parsed to extract
 * promptSnippet and promptGuidelines.
 *
 * run: bun test user/pi/extensions/tools/index.test.ts
 */

import { describe, it, expect } from "bun:test";
import { withPromptPatch } from "./index";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

describe("withPromptPatch", () => {
  it("extracts first paragraph as promptSnippet", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "This is the first paragraph.\n\nThis is the second paragraph.",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("This is the first paragraph.");
  });

  it("extracts bullet points as promptGuidelines", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description:
        "Description.\n\n- First guideline\n- Second guideline\n- Third guideline\n\nMore text.",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptGuidelines).toEqual([
      "- First guideline",
      "- Second guideline",
      "- Third guideline",
    ]);
  });

  it("handles description without paragraphs", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "Single line description",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("Single line description");
    expect(patched.promptGuidelines).toBeUndefined();
  });

  it("handles description without guidelines", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "First paragraph.\n\nSecond paragraph.\n\nNo bullets here.",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("First paragraph.");
    expect(patched.promptGuidelines).toBeUndefined();
  });

  it("preserves existing promptSnippet", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "Auto-extracted snippet.\n\n- A guideline",
      parameters: { type: "object", properties: {} },
      promptSnippet: "Manual snippet",
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("Manual snippet");
  });

  it("preserves existing promptGuidelines", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "Description.\n\n- Auto guideline",
      parameters: { type: "object", properties: {} },
      promptGuidelines: ["- Manual guideline"],
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptGuidelines).toEqual(["- Manual guideline"]);
  });

  it("trims snippet whitespace", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "  \n  Snippet with whitespace  \n\n\n  \nSecond paragraph  ",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("Snippet with whitespace");
  });

  it("handles multiline bullets", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description:
        "Description.\n\n- First bullet\n  with continuation\n- Second bullet\n\nEnd.",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    // Note: continuation lines don't start with "- ", so they're not captured
    expect(patched.promptGuidelines).toEqual(["- First bullet", "- Second bullet"]);
  });

  it("does not mutate original tool", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "Description.\n\n- Guideline",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(tool).not.toHaveProperty("promptSnippet");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(patched).not.toBe(tool);
  });

  it("handles empty description gracefully", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "",
      parameters: { type: "object", properties: {} },
    };

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("");
    expect(patched.promptGuidelines).toBeUndefined();
  });

  it("preserves all other tool properties", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "Desc.\n\n- Guide",
      parameters: { type: "object", properties: { foo: { type: "string" } } },
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    };

    const patched = withPromptPatch(tool);

    expect(patched.name).toBe("test_tool");
    expect(patched.parameters).toEqual({ type: "object", properties: { foo: { type: "string" } } });
    expect(patched.execute).toBe(tool.execute);
  });
});