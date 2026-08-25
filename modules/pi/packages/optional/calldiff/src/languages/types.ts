import type Parser from "tree-sitter";
import type { FunctionInfo, SourceLoc } from "../types.js";

export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;

export interface LanguageExtractor {
  /** Stable id, e.g. "typescript" | "python" | "go" */
  id: string;
  /** File extensions including dot, lowercase */
  extensions: string[];
  /** npm package providing the tree-sitter grammar */
  grammarPackage: string;
  /** Named export on the grammar package, if any (e.g. "typescript", "tsx") */
  grammarExport?: string;
  extract(file: string, source: string, tree: Tree): FunctionInfo[];
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

export function childByType(node: SyntaxNode, type: string): SyntaxNode | null {
  return namedChildren(node).find((c) => c.type === type) ?? null;
}

export function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Best-effort syntax labels for data crossing JS/TS function boundaries. */
export function dataParameters(params: SyntaxNode | null): string[] {
  if (!params) return [];
  if (params.type === "identifier") return [params.text];
  return namedChildren(params).map((parameter) => {
    const pattern =
      parameter.childForFieldName("pattern") ??
      parameter.childForFieldName("name") ??
      namedChildren(parameter).find((child) =>
        [
          "identifier",
          "object_pattern",
          "array_pattern",
          "rest_pattern",
          "assignment_pattern",
        ].includes(child.type),
      ) ??
      parameter;
    return collapseWs(pattern.text).replace(/^\.\.\./, "...");
  });
}

export function dataArguments(call: SyntaxNode): string[] {
  const args =
    call.childForFieldName("arguments") ??
    namedChildren(call).find((child) => child.type === "arguments");
  return args
    ? namedChildren(args).map((arg) =>
        /function|arrow_function|method_definition/.test(arg.type)
          ? "[callback]"
          : collapseWs(arg.text),
      )
    : [];
}

export function dataResult(call: SyntaxNode): string | undefined {
  let expression = call;
  while (
    expression.parent &&
    ["await_expression", "parenthesized_expression"].includes(
      expression.parent.type,
    )
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  if (!parent) return undefined;
  if (parent.type === "variable_declarator") {
    return collapseWs(
      (parent.childForFieldName("name") ?? parent.namedChild(0))?.text ?? "",
    );
  }
  if (parent.type === "assignment_expression") {
    return collapseWs(
      (parent.childForFieldName("left") ?? parent.namedChild(0))?.text ?? "",
    );
  }
  if (parent.type === "return_statement") return "return";
  return undefined;
}

export function dataReturns(body: SyntaxNode | null): string[] {
  if (!body) return [];
  if (body.type !== "statement_block") return [collapseWs(body.text)];
  const returns: string[] = [];
  const walk = (node: SyntaxNode): void => {
    if (node !== body && /function|arrow_function|method_definition/.test(node.type)) {
      return;
    }
    if (node.type === "return_statement") {
      const expression = node.namedChild(0);
      if (expression) returns.push(collapseWs(expression.text));
      return;
    }
    for (const child of namedChildren(node)) walk(child);
  };
  walk(body);
  return [...new Set(returns)];
}

/**
 * Call-site / branch span for a syntax node.
 * Uses tree-sitter 0-based rows → 1-based display lines.
 */
export function locFromNode(file: string, node: SyntaxNode): SourceLoc {
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return endLine > line ? { file, line, endLine } : { file, line };
}
