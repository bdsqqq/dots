import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

export const markdownShapes: Record<string, RegExp> = {
  spans: /bold italics strike inline link \(https:\/\/example\.com\)/,
  quote: /│ │ blockquote/,
  table: /│ ┌─+┬─+┐/,
  tableHeader: /│ │ state\s+│ result\s+│/,
  tableContent: /│ │ real\s+│ content\s+│/,
  tableDivider: /│ ├─+┼─+┤/,
  tableBottom: /│ └─+┴─+┘/,
  typescript: /│\s+const answer: number = 42;/,
  typescriptFence: /│ ```typescript/,
  diffFence: /│ ```diff/,
  diffRemove: /│\s+-old/,
  diffAdd: /│\s+\+new/,
  mermaid: /│ │ A ├─+▶│ B │/,
  mermaidTop: /│ ┌───┐\s+┌───┐/,
  mermaidBottom: /│ └───┘\s+└───┘/,
  longIdentifier: /│ LONG_IDENTIFIER_/,
  bullet: /│ - item/,
  nested: /│     - nested item/,
  ordered: /│ 1\. ordered/,
  taskDone: /│ - \[x\] done/,
  taskPending: /│ - \[ \] pending/,
  rule: /│ ─{20,}/,
};
export function markdownRegion(grid: string): string {
  const start = grid.lastIndexOf(" ● markdown sampler");
  assert.ok(start >= 0, "missing assistant markdown frame");
  const end = grid.indexOf("\n ╰────", start);
  assert.ok(end > start, "missing markdown footer");
  return grid.slice(start, end);
}
function styledToken(grid: string, token: string, attribute: number): boolean {
  let active = new Set<number>();
  const pieces = grid.split(/(\x1b\[[0-9;]*m)/);
  for (const piece of pieces) {
    if (piece.startsWith("\x1b[")) {
      const codes = piece.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) active.clear();
        else if (code === 38 || code === 48) {
          active.add(code);
          i += codes[i + 1] === 2 ? 4 : 2;
        } else if (code === 39) active.delete(38);
        else if ([1, 3, 4, 9].includes(code)) active.add(code);
        else if ([22, 23, 29].includes(code))
          active.delete(code === 22 ? 1 : code === 23 ? 3 : 9);
      }
    } else if (piece.includes(token) && active.has(attribute)) return true;
  }
  return false;
}
export function assertMarkdownGrid(grid: string, styled?: string): void {
  const region = markdownRegion(grid);
  for (const [name, pattern] of Object.entries(markdownShapes))
    assert.match(region, pattern, `missing markdown shape: ${name}`);
  const flat = region.replaceAll(/[\s│]/g, "");
  assert.ok(
    flat.includes("LONG_IDENTIFIER_" + "x".repeat(180)),
    "long identifier content/wrapping lost",
  );
  assert.ok(
    region.indexOf("```typescript") < region.indexOf("const answer") &&
      region.indexOf("const answer") < region.indexOf("```diff"),
    "code fence ordering lost",
  );
  assert.ok(
    region.indexOf("┌───────┬") < region.indexOf("│ state") &&
      region.indexOf("│ real") > region.indexOf("│ state"),
    "table content not inside table",
  );
  assert.ok(
    region.indexOf("│ - item") < region.indexOf("│     - nested item"),
    "nested list order lost",
  );
  assert.ok(
    region.indexOf("LONG_IDENTIFIER_") < region.lastIndexOf("│ ─") &&
      region.lastIndexOf("│ ─") < region.indexOf("MARKDOWN_END"),
    "rule not after wrapped identifier",
  );
  if (styled)
    for (const [token, attribute] of [
      ["bold", 1],
      ["italics", 3],
      ["strike", 9],
      ["inline", 38],
      ["link", 4],
    ] as const)
      assert.ok(
        styledToken(styled, token, attribute),
        `missing rendered span attribute: ${token}`,
      );
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("rejects a sentinel-only assistant substitute", () =>
    expect(() =>
      assertMarkdownGrid(" ● markdown sampler\n │ MARKDOWN_END\n ╰────"),
    ).toThrow());
  it("does not accept source markdown as rendered structures", () =>
    expect(() =>
      assertMarkdownGrid(
        " ● markdown sampler\n │ **bold** *italics* ~~strike~~\n │ MARKDOWN_END\n ╰────",
      ),
    ).toThrow());
}
