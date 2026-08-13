import pc from "picocolors";
import { formatSourceLoc, pickLoc } from "./loc.js";
import type { CallNode, DiffNode, DiffStatus, SourceLoc } from "./types.js";

function paint(status: DiffStatus, text: string): string {
  switch (status) {
    case "added":
      return pc.blue(text);
    case "removed":
      return pc.magenta(text);
    default:
      return text;
  }
}

function prefix(status: DiffStatus): string {
  switch (status) {
    case "added":
      return pc.blue("+");
    case "removed":
      return pc.magenta("-");
    default:
      return " ";
  }
}

export interface RenderOptions {
  /** When false, skip ANSI colors (useful for tests). Default: true */
  color?: boolean;
  /**
   * Append `file:line` (or `file:line-line`) after each label.
   * Default: false.
   */
  locs?: boolean;
  /** Append syntax-level arguments, parameters, and explicit returns. */
  dataFlow?: boolean;
}

type TreeLike = {
  label: string;
  kind?: CallNode["kind"];
  children: TreeLike[];
  status?: DiffStatus;
  file?: string;
  line?: number;
  endLine?: number;
  data?: CallNode["data"];
};

function renderAsciiTree(
  root: TreeLike,
  options: RenderOptions,
  withStatus: boolean,
): string {
  const useColor = options.color !== false;
  const showLocs = options.locs === true;
  const showDataFlow = options.dataFlow === true;

  const paintStatus = (status: DiffStatus, text: string): string =>
    useColor ? paint(status, text) : text;

  const statusPrefix = (status: DiffStatus): string => {
    if (!useColor) {
      switch (status) {
        case "added":
          return "+";
        case "removed":
          return "-";
        default:
          return " ";
      }
    }
    return prefix(status);
  };

  const locSuffix = (node: TreeLike): string => {
    if (!showLocs) return "";
    const loc = pickLoc(node);
    if (!loc.file || loc.line == null) return "";
    const text = `  ${formatSourceLoc(loc as SourceLoc)}`;
    return useColor ? pc.dim(text) : text;
  };

  const lines: string[] = [];

  const expression = (value: string): string =>
    value.length <= 120 ? value : `${value.slice(0, 117)}…`;

  const dataSuffix = (node: TreeLike): string => {
    if (!showDataFlow || !node.data) return "";
    const parts: string[] = [];
    const args = node.data.arguments ?? [];
    const params = node.data.parameters ?? [];
    if (args.length && params.length) {
      parts.push(
        `in: ${args.map((arg, index) => `${expression(arg)} → ${params[index] ?? "?"}`).join(", ")}`,
      );
    } else if (args.length) {
      parts.push(`in: ${args.map(expression).join(", ")}`);
    } else if (params.length) {
      parts.push(`in: ${params.join(", ")}`);
    }
    if (node.data.returns?.length) {
      const returned = node.data.returns.map(expression).join(" | ");
      parts.push(
        `out: ${returned}${node.data.result ? ` → ${node.data.result}` : ""}`,
      );
    } else if (node.data.result) {
      parts.push(`out: unknown → ${node.data.result}`);
    }
    if (!parts.length) return "";
    const text = `  [${parts.join("; ")}]`;
    return useColor ? pc.cyan(text) : text;
  };

  const walk = (
    node: TreeLike,
    indent: string,
    isLast: boolean,
    isRoot: boolean,
  ) => {
    const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const label = withStatus
      ? paintStatus(node.status ?? "same", node.label)
      : node.label;
    const suffix = `${dataSuffix(node)}${locSuffix(node)}`;
    const line = withStatus
      ? `${statusPrefix(node.status ?? "same")} ${indent}${branch}${label}${suffix}`
      : `${indent}${branch}${label}${suffix}`;
    lines.push(line);

    // Conditional arms omit the continuing │ rail — they are alternate paths,
    // not a nested stack that continues past the branch.
    const rail =
      node.kind === "branch" ? "   " : isLast || isRoot ? "   " : "│  ";
    const childIndent = isRoot ? "" : `${indent}${rail}`;

    node.children.forEach((child, index) => {
      walk(child, childIndent, index === node.children.length - 1, false);
    });
  };

  walk(root, "", true, true);
  return lines.join("\n");
}

/**
 * Render a callstack diff as an ASCII tree with +/- markers.
 */
export function renderDiff(
  root: DiffNode,
  options: RenderOptions = {},
): string {
  return renderAsciiTree(root, options, true);
}

/**
 * Render a single call tree as an ASCII tree (no +/- markers).
 */
export function renderTree(
  root: CallNode,
  options: RenderOptions = {},
): string {
  return renderAsciiTree(root, options, false);
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { buildCallTree } = await import("./calltree.js");
  const { buildIndex, extractFunctions } = await import("./extract.js");

  describe("data-flow rendering", () => {
    it("binds callback payloads and call arguments to parameters", () => {
      const source = `
        function mutationTargets(event: { input: unknown }) { return event.input }
        export function extension(pi: any) {
          pi.on("tool_call", (event) => {
            const targets = mutationTargets(event)
            return targets
          })
        }
      `;
      const index = buildIndex(extractFunctions("extension.ts", source));
      const output = renderTree(buildCallTree("extension", index, 12), {
        color: false,
        dataFlow: true,
      });

      expect(output).toContain('pi.on()  [in: "tool_call", [callback]]');
      expect(output).toContain("⇢ listener [registers]  [in: event");
      expect(output).toContain(
        "mutationTargets(event)  [in: event → event; out: event.input → targets]",
      );
    });
  });
}
