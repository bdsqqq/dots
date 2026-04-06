/**
 * Headless TUI rendering tests for look-at tool.
 *
 * Tests UI components by instantiating them directly and asserting
 * on their render() output - no tmux needed.
 *
 * Key insight: Mock the theme to strip ANSI codes, then assert on plain text.
 */

import { describe, it, expect } from "vitest";
import { Text, Container } from "@mariozechner/pi-tui";
import { createLookAtTool } from "../index";
import type { SingleResult } from "@bds_pi/sub-agent-render";

// Mock theme that strips ANSI codes for clean assertions
const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
};

describe("look_at tool rendering (headless TUI)", () => {
  const tool = createLookAtTool();

  describe("renderCall", () => {
    it("renders path and objective", () => {
      const args = {
        path: "/src/index.ts",
        objective: "find the main function",
        context: "debugging",
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("look_at");
      expect(lines[0]).toContain("/src/index.ts");
      expect(lines[0]).toContain("find the main function");
    });

    it("truncates long objectives", () => {
      const longObjective =
        "This is a very long objective that should be truncated because it exceeds the display limit";
      const args = {
        path: "/file.ts",
        objective: longObjective,
        context: "test",
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      // Text component may wrap, but the objective should be truncated
      const fullText = lines.join(" ");
      // Should contain ellipsis from truncation (60 char limit in code)
      expect(fullText).toContain("...");
    });

    it("shows reference file count when present", () => {
      const args = {
        path: "/main.png",
        objective: "compare",
        context: "test",
        referenceFiles: ["/before.png", "/after.png"],
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      expect(lines[0]).toContain("+2 refs");
    });

    it("uses singular 'ref' for single reference file", () => {
      const args = {
        path: "/main.png",
        objective: "compare",
        context: "test",
        referenceFiles: ["/before.png"],
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      expect(lines[0]).toContain("+1 ref");
      expect(lines[0]).not.toContain("+1 refs");
    });

    it("handles missing objective gracefully", () => {
      const args = {
        path: "/file.ts",
        context: "test",
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("look_at");
      expect(lines[0]).toContain("/file.ts");
    });

    it("handles missing path gracefully", () => {
      const args = {
        objective: "analyze",
        context: "test",
      };

      const rendered = tool.renderCall!(args, mockTheme) as Text;
      const lines = rendered.render(80);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("look_at");
    });
  });

  describe("renderResult", () => {
    it("renders simple text result when no details", () => {
      const result = {
        content: [{ type: "text", text: "The image shows a diagram with boxes." }],
      };

      const rendered = tool.renderResult!(result, { expanded: false }, mockTheme);
      const lines = rendered.render(80);

      expect(lines.length).toBeGreaterThanOrEqual(1);
      // Should contain the output text
      const fullText = lines.join("\n");
      expect(fullText).toContain("The image shows a diagram with boxes.");
    });

    it("renders agent tree when details present", () => {
      const details: SingleResult = {
        agent: "look_at",
        task: "analyze diagram",
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Analysis complete." }],
          } as any,
        ],
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.001,
        },
        model: "gemini-flash",
        stopReason: "stop",
      };

      const result = {
        content: [{ type: "text", text: "Analysis complete." }],
        details,
      };

      const rendered = tool.renderResult!(result, { expanded: false }, mockTheme);
      const lines = rendered.render(80);

      expect(lines.length).toBeGreaterThanOrEqual(1);
      // Should show success indicator
      const fullText = lines.join("\n");
      expect(fullText).toContain("✓");
    });

    it("renders error state when exitCode is non-zero", () => {
      const details: SingleResult = {
        agent: "look_at",
        task: "analyze file",
        exitCode: 1,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        stopReason: "error",
        errorMessage: "Failed to read file",
      };

      const result = {
        content: [{ type: "text", text: "Error occurred" }],
        details,
        isError: true,
      };

      const rendered = tool.renderResult!(result, { expanded: false }, mockTheme);
      const lines = rendered.render(80);

      const fullText = lines.join("\n");
      expect(fullText).toContain("✕");
    });

    it("shows usage stats in expanded mode", () => {
      const details: SingleResult = {
        agent: "look_at",
        task: "analyze",
        exitCode: 0,
        messages: [],
        usage: {
          input: 1500,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.002,
        },
        model: "gemini-flash",
        stopReason: "stop",
      };

      const result = {
        content: [{ type: "text", text: "Done" }],
        details,
      };

      const rendered = tool.renderResult!(result, { expanded: true }, mockTheme);
      const lines = rendered.render(80);

      const fullText = lines.join("\n");
      // Usage stats are rendered at the bottom
      expect(fullText).toMatch(/↑\d+/); // input tokens
      expect(fullText).toMatch(/↓\d+/); // output tokens
    });

    it("renders with collapsed state by default", () => {
      const details: SingleResult = {
        agent: "look_at",
        task: "task",
        exitCode: 0,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        stopReason: "stop",
      };

      const result = {
        content: [{ type: "text", text: "Done" }],
        details,
      };

      // expanded: false should show collapsed view
      const collapsed = tool.renderResult!(result, { expanded: false }, mockTheme);
      const expanded = tool.renderResult!(result, { expanded: true }, mockTheme);

      // Both should render successfully
      expect(collapsed.render(80).length).toBeGreaterThanOrEqual(1);
      expect(expanded.render(80).length).toBeGreaterThanOrEqual(1);
    });
  });
});
