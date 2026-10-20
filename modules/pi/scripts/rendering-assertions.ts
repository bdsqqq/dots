import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
export type RenderEvidence = {
  callLines: string[];
  resultLines: string[];
  nativePreviewOnly?: boolean;
};
export function assertOfflineRenderingArgs(args: string[]): void {
  assert.ok(
    !args.includes("--live"),
    "live execution disabled: provider hooks do not bound transport submissions",
  );
}
const normalized = (text: string) =>
  stripVTControlCharacters(text)
    .replaceAll(/[\s│]/g, "")
    .toLowerCase();
export function toolResultRegion(
  frame: string,
  evidence: RenderEvidence,
): string {
  const rows = frame.split("\n");
  assert.ok(
    evidence.callLines.length > 0 &&
      (evidence.resultLines.length > 0 || evidence.nativePreviewOnly),
    "missing production call/result observation",
  );
  const result = rows.slice(evidence.callLines.length, -1);
  assert.equal(
    result.length,
    evidence.resultLines.length,
    "missing or duplicate rendered result rows",
  );
  for (let i = 0; i < result.length; i++)
    assert.equal(
      normalized(result[i]!),
      normalized(evidence.resultLines[i]!),
      "PTY result differs from production result component",
    );
  return result.join("\n");
}

/** Root chrome has one column of indentation; nested connectors cannot count as frames. */
export function assertToolGrid(
  grid: string,
  count: number,
  title: string,
  content: string,
  evidence: RenderEvidence,
): string {
  const lines = grid.split("\n");
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ [✓✕] /.test(line));
  const footers = lines.filter((line) => /^ ╰────\s*$/.test(line));
  assert.equal(headers.length, count, "missing or duplicate root tool header");
  assert.equal(footers.length, count, "missing or duplicate root tool footer");
  const last = headers.at(-1)!;
  const end = lines.findIndex(
    (line, index) => index > last.index && /^ ╰────\s*$/.test(line),
  );
  const frame = lines.slice(last.index, end + 1).join("\n");
  const normalize = (value: string) =>
    value.replaceAll(/[\s│]/g, "").toLowerCase();
  assert.ok(
    normalize(last.line).includes(normalize(title)),
    `direct renderer header missing ${title}`,
  );
  const actualResult = toolResultRegion(frame, evidence);
  assert.ok(
    normalize(
      evidence.nativePreviewOnly
        ? frame.split("\n").slice(0, evidence.callLines.length).join("\n")
        : actualResult,
    ).includes(normalize(content)),
    `latest tool frame missing actual content: ${content}`,
  );
  assert.ok(
    lines.slice(last.index + 1, end).some((line) => /^ │ .+\S/.test(line)),
    "empty tool result",
  );
  return frame;
}

export function assertLifecycle(events: any[], ids: string[]): void {
  for (const id of ids)
    for (const type of ["tool_execution_start", "tool_execution_end"])
      assert.equal(
        events.filter((event) => event.type === type && event.toolCallId === id)
          .length,
        1,
        `${type}: ${id}`,
      );
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  it("rejects missing and duplicate lifecycle events but permits distinct nested ids", () => {
    const events = [
      { type: "tool_execution_start", toolCallId: "root" },
      { type: "tool_execution_end", toolCallId: "root" },
      { type: "tool_execution_start", toolCallId: "root/1" },
    ];
    expect(() => assertLifecycle(events, ["root"])).not.toThrow();
    expect(() => assertLifecycle(events.slice(1), ["root"])).toThrow();
    expect(() => assertLifecycle([...events, events[1]], ["root"])).toThrow();
  });
  const evidence = {
    callLines: ["Delegate fixture"],
    resultLines: ["├ child", "SUBAGENT_FIXTURE"],
  };
  it("rejects live even with acknowledgement before any transport can run", () => {
    expect(() => assertOfflineRenderingArgs(["--live"])).toThrow(
      /transport submissions/,
    );
  });
  for (const title of [
    "$ printf SUCCESS",
    'codemode text("SUCCESS")',
    "web_search SUCCESS",
  ])
    it(`does not borrow echoed input from ${title}`, () => {
      const inputOnly = ` ✓ ${title}\n ╰────`;
      expect(() =>
        assertToolGrid(inputOnly, 1, title.split(" ")[0]!, "SUCCESS", {
          callLines: [title],
          resultLines: ["SUCCESS"],
        }),
      ).toThrow(/result/);
    });
  const valid =
    " ✓ Delegate fixture\n │ ├ child\n │ SUBAGENT_FIXTURE\n ╰────\n╰────────╯";
  it("accepts root chrome without counting child connectors or editor borders", () => {
    expect(
      assertToolGrid(valid, 1, "Delegate", "SUBAGENT_FIXTURE", evidence),
    ).toContain("child");
  });
  for (const [name, value] of [
    ["missing header", valid.replace(" ✓ Delegate fixture\n", "")],
    ["missing footer", valid.replace(" ╰────\n", "")],
    ["duplicate header", valid + "\n ✓ Delegate fixture"],
    ["duplicate footer", valid + "\n ╰────"],
    ["placeholder", valid.replace("SUBAGENT_FIXTURE", "Loading...")],
    ["bypassed renderer", valid.replace("Delegate", "codemode")],
  ] as [string, string][])
    it(`rejects ${name}`, () =>
      expect(() =>
        assertToolGrid(value, 1, "Delegate", "SUBAGENT_FIXTURE", evidence),
      ).toThrow());
  it("does not borrow successful content from an earlier tool", () => {
    expect(() =>
      assertToolGrid(
        valid + "\n ✓ Delegate next\n │ Loading...\n ╰────",
        2,
        "Delegate",
        "SUBAGENT_FIXTURE",
        evidence,
      ),
    ).toThrow();
  });
}
