import { describe, expect, it } from "vitest";
import {
  buildCallTree,
  buildIndex,
  diffTrees,
  extractFunctions,
  findReachPaths,
  renderDiff,
  renderTree,
} from "../src/index.js";
import { inferEntries } from "../src/infer.js";

function tree(source: string, entry = "extension", depth = 12) {
  return buildCallTree(
    entry,
    buildIndex(extractFunctions("src/extension.ts", source)),
    depth,
  );
}

describe("callback contracts", () => {
  it("keeps pi.on callback work behind an explicit registration edge", () => {
    const result = tree(
      `export function extension(pi: any) { pi.on("session_start", () => helper()) }\nfunction helper() { leaf() }`,
    );
    const registration = result.children.find((n) => n.key === "pi.on")!;
    const edge = registration.children.find((n) => n.kind === "callback")!;
    expect(edge.label).toBe("⇢ listener [registers]");
    expect(edge.callback).toMatchObject({
      contractId: "pi.on",
      role: "listener",
      relation: "registers",
    });
    expect(edge.children[0]?.key).toBe("helper");
    expect(result.children.some((n) => n.kind === "callback")).toBe(false);
  });

  it.each([
    [
      `pi.registerCommand("review", { handler() { commandWork() } })`,
      "handler",
      "commandWork",
    ],
    [
      `pi.registerCommand("review", { handler: async () => commandWork() })`,
      "handler",
      "commandWork",
    ],
    [
      `pi.registerTool({ name: "finder", execute() { toolWork() } })`,
      "execute",
      "toolWork",
    ],
    [
      `new Promise((resolve) => { spawnProcess(); resolve() })`,
      "executor",
      "spawnProcess",
    ],
  ])("traverses %s", (registration, role, nested) => {
    const result = tree(
      `export function extension(pi: any) { ${registration} }`,
    );
    const edge = result.children
      .flatMap((n) => n.children)
      .find((n) => n.kind === "callback")!;
    expect(edge.callback?.role).toBe(role);
    expect(edge.children.some((n) => n.key === nested)).toBe(true);
    expect(result.children.some((n) => n.key === nested)).toBe(false);
    if (role === "execute") expect(edge.key).toContain("anchor=finder");
  });

  it("resolves named callbacks and ignores unknown API callbacks", () => {
    const result = tree(
      `function listener() { namedWork() }\nexport function extension(pi: any) { pi.on("turn", listener); unknown(() => hidden()) }`,
    );
    expect(
      result.children.find((n) => n.key === "pi.on")?.children[0]?.children[0]
        ?.key,
    ).toBe("namedWork");
    expect(renderTree(result, { color: false })).not.toContain("hidden");
  });

  it("keeps callback identity stable across line/body edits and nests the diff", () => {
    const before = tree(
      `export function extension(pi: any) { pi.on("turn", () => oldWork()) }`,
    );
    const after = tree(
      `\n\nexport function extension(pi: any) { pi.on("turn", () => newWork()) }`,
    );
    const diff = diffTrees(before, after);
    const edge = diff.children
      .find((n) => n.key === "pi.on")!
      .children.find((n) => n.kind === "callback")!;
    expect(edge.status).toBe("same");
    expect(edge.children.map((n) => [n.key, n.status])).toEqual([
      ["oldWork", "removed"],
      ["newWork", "added"],
    ]);
    expect(renderDiff(diff, { color: false })).toContain(
      "⇢ listener [registers]",
    );
  });

  it("reach traverses callbacks and nested contracts stay bounded", () => {
    const source = `function target() {}\nexport function extension(pi: any) { pi.on("outer", () => pi.on("inner", () => target())) }`;
    const index = buildIndex(extractFunctions("src/extension.ts", source));
    const paths = findReachPaths("extension", "target", index, 12);
    expect(paths).toHaveLength(1);
    expect(renderTree(paths[0]!, { color: false }).match(/⇢/g)).toHaveLength(2);
    expect(
      renderTree(buildCallTree("extension", index, 2), { color: false }).split(
        "\n",
      ).length,
    ).toBeLessThan(8);
  });

  it("indexes a named extension returned by a factory without attributing it to the factory", () => {
    const source = `function mutationTargets() {}\nexport function createExtension() { return function nestedExtension(pi: any) { pi.on("tool_call", () => mutationTargets()) } }`;
    const index = buildIndex(extractFunctions("src/extension.ts", source));
    expect(
      findReachPaths("createExtension", "mutationTargets", index, 12),
    ).toEqual([]);
    expect(
      findReachPaths("nestedExtension", "mutationTargets", index, 12),
    ).toHaveLength(1);
    expect(
      renderTree(buildCallTree("nestedExtension", index, 12), { color: false }),
    ).toContain("⇢ listener [registers]");
  });

  it("resolves a shadowing local named listener and reaches the listener itself", () => {
    const source = `function listener() { globalWork() }\nexport function extension(pi: any) { function listener() { localWork() } pi.on("turn", listener) }`;
    const index = buildIndex(extractFunctions("src/extension.ts", source));
    const rendered = renderTree(buildCallTree("extension", index, 12), {
      color: false,
    });
    expect(rendered).toContain("localWork");
    expect(rendered).not.toContain("globalWork");
    expect(findReachPaths("extension", "listener", index, 12)).toHaveLength(1);
  });

  it("diffs and infers a changed named callback target", () => {
    const before = buildIndex(
      extractFunctions(
        "src/extension.ts",
        `function beforeHandler() {}\nfunction afterHandler() {}\nexport function extension(pi: any) { pi.on("turn", beforeHandler) }`,
      ),
    );
    const after = buildIndex(
      extractFunctions(
        "src/extension.ts",
        `function beforeHandler() {}\nfunction afterHandler() {}\nexport function extension(pi: any) { pi.on("turn", afterHandler) }`,
      ),
    );
    const diff = diffTrees(
      buildCallTree("extension", before, 12),
      buildCallTree("extension", after, 12),
    );
    const callbacks = diff.children[0]!.children;
    expect(callbacks.map((node) => node.status)).toEqual(["removed", "added"]);
    expect(inferEntries(before, after, [], 12)).toContain("extension");
  });
});
