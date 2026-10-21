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
    lines.slice(last.index + 1, end).some((line) => /^ │ .*\S/.test(line)),
    "empty tool result",
  );
  return frame;
}

/** Native codemode budgets count visual content rows plus one omission row. */
export function assertBoundedCodemode(
  evidence: RenderEvidence,
  expanded: boolean,
): void {
  const call = evidence.callLines.map(stripVTControlCharacters);
  const result = evidence.resultLines.map(stripVTControlCharacters);
  assert.ok(call.length <= (expanded ? 14 : 1), "unbounded script view");
  // These fixture programs never emit these strings. Inspect observed result rows,
  // not echoed source, and reject shipped bookkeeping even when it is bounded.
  assert.ok(result.length <= (expanded ? 88 : 58), "unbounded output view");
  assert.ok(
    ![...call, ...result].some((line) =>
      /^(output · \d+ results? · \d+ console · \d+ images?|result \d+\/\d+ · (text|return))$/.test(
        line.trim(),
      ),
    ),
    "bookkeeping chrome",
  );
  assert.ok(
    result.filter((line) =>
      /^[✓✗⊘…] (?!shortened\b)[a-zA-Z_]/.test(line),
    ).length <=
      (expanded ? 12 : 8),
    "unbounded activity view",
  );
}

export function assertRawExport(
  value: any,
  expected: unknown,
  sentinel: string,
): void {
  const content = value?.resultEntry?.message?.content;
  assert.deepEqual(
    value,
    expected,
    "export changed original persisted call/result",
  );
  assert.ok(
    JSON.stringify(content)?.includes(sentinel),
    "export missing raw sentinel",
  );
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
  it("rejects the old unbounded expanded renderer and missing raw data", () => {
    const bounded = {
      callLines: ["codemode", "text(1)"],
      resultLines: ["", "answer"],
    };
    expect(() => assertBoundedCodemode(bounded, true)).not.toThrow();
    expect(() =>
      assertBoundedCodemode(
        {
          ...bounded,
          callLines: ["codemode", "script", ...Array(100).fill("code")],
        },
        true,
      ),
    ).toThrow(/unbounded script/);
    expect(() =>
      assertBoundedCodemode(
        { ...bounded, resultLines: ["", "output", ...Array(100).fill("data")] },
        true,
      ),
    ).toThrow(/unbounded output/);
    expect(() =>
      assertBoundedCodemode(
        {
          callLines: ["codemode"],
          resultLines: [
            "output · 4 results · 0 console · 0 images",
            "result 1/4 · text",
            "answer",
          ],
        },
        false,
      ),
    ).toThrow(/bookkeeping/);
    const raw = {
      resultEntry: {
        message: { content: [{ type: "text", text: "RAW_SENTINEL" }] },
      },
    };
    expect(() => assertRawExport(raw, raw, "RAW_SENTINEL")).not.toThrow();
    expect(() => assertRawExport(raw, raw, "MISSING_SENTINEL")).toThrow(
      /sentinel/,
    );
    expect(() => assertRawExport({}, raw, "RAW_SENTINEL")).toThrow(
      /original persisted/,
    );
  });
  it("counts activity independently of result and call omission rows", () => {
    const activity = Array(8).fill("✗ read ENOENT");
    const evidence = {
      callLines: ["codemode"],
      resultLines: [
        ...activity,
        "… 2 more calls (2 failed)",
        "… 2 more cal...",
        "",
        "result head",
        "… shortened · partial line edges …",
        "… shortened ·...",
        "result tail",
      ],
    };
    expect(() => assertBoundedCodemode(evidence, false)).not.toThrow();
    expect(() =>
      assertBoundedCodemode(
        { ...evidence, resultLines: ["✗ read ENOENT", ...evidence.resultLines] },
        false,
      ),
    ).toThrow(/unbounded activity/);
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
  it("accepts a single-character result without borrowing source", () => {
    expect(() =>
      assertToolGrid(" ✓ codemode\n │ A\n ╰────", 1, "codemode", "A", {
        callLines: ["codemode"],
        resultLines: ["A"],
      }),
    ).not.toThrow();
  });
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
