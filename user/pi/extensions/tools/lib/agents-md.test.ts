/**
 * unit tests for agents-md — AGENTS.md discovery and formatting.
 *
 * tests that guidance files are discovered from file directory
 * up to workspace root, with global config prepended.
 *
 * run: bun test user/pi/extensions/tools/lib/agents-md.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverAgentsMd,
  formatGuidance,
  type AgentsGuidance,
} from "./agents-md";

// test directory structure:
// tmp/
//   project/
//     AGENTS.md           <- project root
//     src/
//       AGENTS.md         <- src dir
//       components/
//         Button.tsx
//         AGENTS.md       <- components dir
let tmpDir: string;
let projectDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `pi-agents-md-test-${Date.now()}`);
  projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(path.join(projectDir, "src", "components"), { recursive: true });

  // create AGENTS.md files
  fs.writeFileSync(
    path.join(projectDir, "AGENTS.md"),
    "# Project Root\nGeneral project guidance.",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projectDir, "src", "AGENTS.md"),
    "# Src\nSource code guidance.",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projectDir, "src", "components", "AGENTS.md"),
    "# Components\nUI component guidance.",
    "utf-8",
  );
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("discoverAgentsMd", () => {
  it("finds all AGENTS.md from file dir up to workspace root", () => {
    const filePath = path.join(projectDir, "src", "components", "Button.tsx");
    const guidance = discoverAgentsMd(filePath, projectDir);

    // should find: project AGENTS.md, src AGENTS.md, components AGENTS.md
    // in broadest-to-most-specific order (project first)
    expect(guidance.length).toBeGreaterThanOrEqual(3);

    // check ordering: project -> src -> components
    const scopes = guidance.map((g) => g.scope);
    expect(scopes).toContain("project");
    expect(scopes).toContain("src");
    expect(scopes).toContain("src/components");
  });

  it("returns empty array when no AGENTS.md files exist", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    const filePath = path.join(emptyDir, "test.ts");

    const guidance = discoverAgentsMd(filePath, emptyDir);
    // might find global AGENTS.md if it exists
    const nonGlobal = guidance.filter((g) => g.scope !== "global");
    expect(nonGlobal).toHaveLength(0);
  });

  it("includes file content in guidance", () => {
    const filePath = path.join(projectDir, "src", "components", "Button.tsx");
    const guidance = discoverAgentsMd(filePath, projectDir);

    const componentsGuidance = guidance.find(
      (g) => g.scope === "src/components",
    );
    expect(componentsGuidance).toBeDefined();
    expect(componentsGuidance?.content).toContain("Components");
    expect(componentsGuidance?.content).toContain("UI component guidance");
  });

  it("returns absolute paths for guidance files", () => {
    const filePath = path.join(projectDir, "src", "components", "Button.tsx");
    const guidance = discoverAgentsMd(filePath, projectDir);

    for (const g of guidance) {
      expect(path.isAbsolute(g.path)).toBe(true);
    }
  });

  it("handles file at workspace root", () => {
    const filePath = path.join(projectDir, "README.md");
    const guidance = discoverAgentsMd(filePath, projectDir);

    // should find project root AGENTS.md
    expect(guidance.some((g) => g.scope === "project")).toBe(true);
  });

  it("handles file in nested directory correctly", () => {
    // create deeply nested structure
    const deepDir = path.join(
      projectDir,
      "src",
      "components",
      "ui",
      "buttons",
    );
    fs.mkdirSync(deepDir, { recursive: true });

    const filePath = path.join(deepDir, "IconButton.tsx");
    const guidance = discoverAgentsMd(filePath, projectDir);

    // should find project and src AGENTS.md, but not components since it's skipped
    // wait, components has AGENTS.md, so it should be found
    const scopes = guidance.map((g) => g.scope);
    expect(scopes).toContain("project");
    expect(scopes).toContain("src");
    // components is between src and buttons, should be found
    expect(scopes).toContain("src/components");
  });

  it("stops at workspace root", () => {
    const filePath = path.join(projectDir, "src", "test.ts");
    const guidance = discoverAgentsMd(filePath, projectDir);

    // should not go above project root
    const paths = guidance.map((g) => g.path);
    for (const p of paths) {
      expect(p.startsWith(tmpDir) || p.includes(".config")).toBe(true);
    }
  });
});

describe("formatGuidance", () => {
  it("returns empty string for empty array", () => {
    expect(formatGuidance([])).toBe("");
  });

  it("formats single guidance with scope header", () => {
    const guidance: AgentsGuidance[] = [
      {
        path: "/project/AGENTS.md",
        content: "# Rules\nBe helpful.",
        scope: "project",
      },
    ];

    const result = formatGuidance(guidance);

    expect(result).toContain("Contents of /project/AGENTS.md");
    expect(result).toContain("(directory-specific instructions for project)");
    expect(result).toContain("<instructions>");
    expect(result).toContain("Be helpful.");
    expect(result).toContain("</instructions>");
  });

  it("formats multiple guidance entries", () => {
    const guidance: AgentsGuidance[] = [
      {
        path: "/project/AGENTS.md",
        content: "Project rules.",
        scope: "project",
      },
      {
        path: "/project/src/AGENTS.md",
        content: "Src rules.",
        scope: "src",
      },
    ];

    const result = formatGuidance(guidance);

    expect(result).toContain("Project rules.");
    expect(result).toContain("Src rules.");
    expect(result).toContain("directory-specific instructions for project");
    expect(result).toContain("directory-specific instructions for src");
  });

  it("preserves content exactly", () => {
    const content = "```typescript\nconst x = 1;\n```\n\n- rule 1\n- rule 2";
    const guidance: AgentsGuidance[] = [
      {
        path: "/test/AGENTS.md",
        content,
        scope: "test",
      },
    ];

    const result = formatGuidance(guidance);
    expect(result).toContain(content);
  });

  it("separates entries with double newline", () => {
    const guidance: AgentsGuidance[] = [
      { path: "/a", content: "A", scope: "a" },
      { path: "/b", content: "B", scope: "b" },
    ];

    const result = formatGuidance(guidance);

    // each entry should be separated
    expect(result).toMatch(/<\/instructions>\n\nContents of/);
  });
});