import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPromptCatalog, scanCatalog } from "./catalog.js";

function note(overrides = ""): string {
  return `---\nmemory_version: 2\nmemory_id: "mem_one"\nstatus: "active"\ntitle: "Scoped gotcha"\nkind: gotcha\nscope: "work/project"\ndescription: "Use when touching project tooling"\ntriggers: ["tooling"]\nkeywords: ["project"]\nupdated: "2026-07-25"\n${overrides}---\n\nbody\n`;
}

describe("memory catalog", () => {
  it("scans only safe root-level agent memories", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-catalog-"));
    writeFileSync(join(root, "2026-07-25-note--source__agent.md"), note());
    mkdirSync(join(root, ".archive"));
    writeFileSync(join(root, ".archive/hidden--source__agent.md"), note());
    symlinkSync(
      join(root, "2026-07-25-note--source__agent.md"),
      join(root, "linked--source__agent.md"),
    );
    const catalog = scanCatalog(root, "2026-07-25T00:00:00.000Z");
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      memoryId: "mem_one",
      title: "Scoped gotcha",
    });
  });

  it("renders a bounded, scope-aware pointer catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-catalog-"));
    writeFileSync(join(root, "2026-07-25-note--source__agent.md"), note());
    const rendered = renderPromptCatalog(
      scanCatalog(root),
      "/home/work/project",
      30,
      400,
    );
    expect(rendered).toContain("Scoped gotcha");
    expect(rendered.length).toBeLessThanOrEqual(400);
    expect(rendered).not.toContain("body");
  });
});
