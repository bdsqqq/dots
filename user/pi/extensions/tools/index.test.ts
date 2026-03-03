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
import { Type } from "@sinclair/typebox";

// Minimal valid tool for testing withPromptPatch
function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "Test description.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

describe("withPromptPatch", () => {
  it("extracts first paragraph as promptSnippet", () => {
    const tool = makeTool({
      description: "This is the first paragraph.\n\nThis is the second paragraph.",
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
    const tool = makeTool({
      description: "Single line description",
    });

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("Single line description");
    expect(patched.promptGuidelines).toBeUndefined();
  });

  it("handles description without guidelines", () => {
    const tool = makeTool({
      description: "First paragraph.\n\nSecond paragraph.\n\nNo bullets here.",
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
      description: "  \n  Snippet with whitespace  \n\n\n  \nSecond paragraph  ",
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

    // Note: continuation lines don't start with "- ", so they're not captured
    expect(patched.promptGuidelines).toEqual(["- First bullet", "- Second bullet"]);
  });

  it("does not mutate original tool", () => {
    const tool = makeTool({
      description: "Description.\n\n- Guideline",
    });

    const patched = withPromptPatch(tool);

    expect(tool).not.toHaveProperty("promptSnippet");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(patched).not.toBe(tool);
  });

  it("handles empty description gracefully", () => {
    const tool = makeTool({
      description: "",
    });

    const patched = withPromptPatch(tool);

    expect(patched.promptSnippet).toBe("");
    expect(patched.promptGuidelines).toBeUndefined();
  });

  it("preserves all other tool properties", () => {
    const tool = makeTool({
      description: "Desc.\n\n- Guide",
    });

    const patched = withPromptPatch(tool);

    expect(patched.name).toBe("test_tool");
    expect(patched.execute).toBe(tool.execute);
  });
});