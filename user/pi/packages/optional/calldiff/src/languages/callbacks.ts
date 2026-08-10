import type { CallbackRelation, CallStep, FunctionInfo } from "../types.js";
import {
  locFromNode,
  namedChildren,
  type SyntaxNode,
  type Tree,
} from "./types.js";

type Collector = (
  file: string,
  statements: SyntaxNode[],
  className: string | null,
) => CallStep[];

type Contract =
  | {
      id: "pi.on";
      callee: "pi.on";
      callbackArg: 1;
      role: "listener";
      relation: "registers";
      anchorArg: 0;
    }
  | {
      id: "pi.registerCommand";
      callee: "pi.registerCommand";
      objectArg: 1;
      property: "handler";
      role: "handler";
      relation: "registers";
      anchorArg: 0;
    }
  | {
      id: "pi.registerTool";
      callee: "pi.registerTool";
      objectArg: 0;
      property: "execute";
      role: "execute";
      relation: "registers";
      anchorProperty: "name";
    }
  | {
      id: "Promise";
      callee: "Promise";
      callbackArg: 0;
      role: "executor";
      relation: "invokes";
    };

const CONTRACTS: readonly Contract[] = [
  {
    id: "pi.on",
    callee: "pi.on",
    callbackArg: 1,
    role: "listener",
    relation: "registers",
    anchorArg: 0,
  },
  {
    id: "pi.registerCommand",
    callee: "pi.registerCommand",
    objectArg: 1,
    property: "handler",
    role: "handler",
    relation: "registers",
    anchorArg: 0,
  },
  {
    id: "pi.registerTool",
    callee: "pi.registerTool",
    objectArg: 0,
    property: "execute",
    role: "execute",
    relation: "registers",
    anchorProperty: "name",
  },
  {
    id: "Promise",
    callee: "Promise",
    callbackArg: 0,
    role: "executor",
    relation: "invokes",
  },
];

const inlineCallbackTypes = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "method_definition",
]);
const namedNestedFunctionTypes = new Set([
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
]);
const functionBoundaryTypes = new Set([
  ...inlineCallbackTypes,
  ...namedNestedFunctionTypes,
]);

function argsOf(call: SyntaxNode): SyntaxNode[] {
  const args =
    call.childForFieldName("arguments") ??
    namedChildren(call).find((n) => n.type === "arguments");
  return args ? namedChildren(args) : [];
}

function literal(node: SyntaxNode | undefined): string | undefined {
  if (
    !node ||
    !["string", "string_fragment", "template_string"].includes(node.type)
  )
    return undefined;
  const value = node.text.replace(/^['"`]|['"`]$/g, "");
  return value || undefined;
}

function property(
  object: SyntaxNode | undefined,
  name: string,
): SyntaxNode | undefined {
  if (!object || object.type !== "object") return undefined;
  for (const member of namedChildren(object)) {
    const key = member.childForFieldName("key") ?? member.namedChild(0);
    if (key?.text !== name) continue;
    if (
      member.type === "method_definition" ||
      member.type === "method_signature"
    )
      return member;
    return (
      member.childForFieldName("value") ?? member.namedChild(1) ?? undefined
    );
  }
  return undefined;
}

function callbackBody(node: SyntaxNode): SyntaxNode[] {
  const body = node.childForFieldName("body") ?? namedChildren(node).at(-1);
  if (!body) return [];
  return body.type === "statement_block" ? namedChildren(body) : [body];
}

function calleeText(call: SyntaxNode): string | undefined {
  const callee =
    call.childForFieldName("function") ??
    call.childForFieldName("constructor") ??
    call.namedChild(0);
  return callee?.text;
}

/** Add explicit callback edges and synthetic definitions for the four built-in contracts. */
export function extractContractCallbacks(
  file: string,
  tree: Tree,
  functions: FunctionInfo[],
  collect: Collector,
): FunctionInfo[] {
  const nested: FunctionInfo[] = [];
  const added: FunctionInfo[] = [];
  const ordinals = new Map<string, number>();
  const nestedOwners = new Map<string, string>();

  const findCallStep = (
    steps: CallStep[],
    start: number,
    end: number,
  ): Extract<CallStep, { type: "call" }> | undefined => {
    for (const step of steps) {
      if (step.type === "call") {
        if (step.start === start && step.end === end) return step;
        const nested = findCallStep(
          [...(step.callbacks ?? []), ...(step.children ?? [])],
          start,
          end,
        );
        if (nested) return nested;
      } else if (step.type === "branch") {
        const nested = findCallStep(step.children, start, end);
        if (nested) return nested;
      }
    }
    return undefined;
  };

  const scan = (root: SyntaxNode, owner: FunctionInfo): void => {
    const walk = (node: SyntaxNode): void => {
      if (node !== root && functionBoundaryTypes.has(node.type)) return;
      if (node.type === "call_expression" || node.type === "new_expression") {
        const path = calleeText(node);
        const contract = CONTRACTS.find((c) => c.callee === path);
        if (contract) {
          const args = argsOf(node);
          const object =
            "objectArg" in contract ? args[contract.objectArg] : undefined;
          const candidate =
            "callbackArg" in contract
              ? args[contract.callbackArg]
              : property(object, contract.property);
          const anchor =
            "anchorArg" in contract
              ? literal(args[contract.anchorArg])
              : "anchorProperty" in contract
                ? literal(property(object, contract.anchorProperty))
                : undefined;
          if (candidate) addEdge(node, candidate, owner, contract, anchor);
        }
      }
      for (const child of namedChildren(node)) walk(child);
    };
    walk(root);
  };

  const addEdge = (
    call: SyntaxNode,
    callback: SyntaxNode,
    owner: FunctionInfo,
    contract: Contract,
    anchor: string | undefined,
  ): void => {
    const callStep = findCallStep(owner.steps, call.startIndex, call.endIndex);
    if (!callStep) return;
    const base = `${file}::${owner.key}::${contract.id}::${contract.role}`;
    const anchored = `${base}::${anchor ? `anchor=${encodeURIComponent(anchor)}` : "unanchored"}`;
    const ordinal = (ordinals.get(anchored) ?? 0) + 1;
    ordinals.set(anchored, ordinal);
    const identity = `${anchored}::ordinal=${ordinal}`;
    let target: string;
    if (callback.type === "identifier") {
      const local = nested.find(
        (fn) =>
          nestedOwners.get(fn.key) === owner.key &&
          fn.label.startsWith(`${callback.text}(`),
      );
      target = local?.key ?? callback.text;
    } else if (inlineCallbackTypes.has(callback.type)) {
      target = `@callback::${identity}`;
      const body = callbackBody(callback);
      const synthetic: FunctionInfo = {
        key: target,
        label: `${contract.role}${anchor ? ` (${anchor})` : ""}`,
        file,
        steps: collect(file, body, null),
        exported: false,
        start: callback.startIndex,
        end: callback.endIndex,
      };
      added.push(synthetic);
      scan(callback, synthetic);
    } else {
      return;
    }
    (callStep.callbacks ??= []).push({
      type: "callback",
      key: `@edge::${identity}::target=${encodeURIComponent(target)}`,
      callback: {
        contractId: contract.id,
        role: contract.role,
        relation: contract.relation as CallbackRelation,
        target,
      },
      ...locFromNode(file, call),
    });
  };

  const findNode = (
    node: SyntaxNode,
    start: number,
    end: number,
  ): SyntaxNode | undefined => {
    if (node.startIndex === start && node.endIndex === end) return node;
    for (const child of namedChildren(node)) {
      if (child.startIndex <= start && child.endIndex >= end) {
        const found = findNode(child, start, end);
        if (found) return found;
      }
    }
    return undefined;
  };

  const knownSpans = new Set(functions.map((fn) => `${fn.start}:${fn.end}`));
  const nestedKeyOrdinals = new Map<string, number>();
  const collectNamedNestedFunctions = (node: SyntaxNode): void => {
    if (namedNestedFunctionTypes.has(node.type)) {
      const name = node.childForFieldName("name");
      const span = `${node.startIndex}:${node.endIndex}`;
      if (name?.type === "identifier" && !knownSpans.has(span)) {
        const parameters = node.childForFieldName("parameters")?.text ?? "()";
        const body = callbackBody(node);
        const owner = [...functions, ...nested]
          .filter((fn) => fn.start < node.startIndex && fn.end > node.endIndex)
          .sort(
            (left, right) => left.end - left.start - (right.end - right.start),
          )[0];
        if (!owner) return;
        const baseKey = `@nested:${file}:${owner.key}.${name.text}`;
        const ordinal = (nestedKeyOrdinals.get(baseKey) ?? 0) + 1;
        nestedKeyOrdinals.set(baseKey, ordinal);
        const key = ordinal === 1 ? baseKey : `${baseKey}#${ordinal}`;
        nested.push({
          key,
          label: `${name.text}${parameters}`,
          file,
          steps: collect(file, body, null),
          exported: false,
          start: node.startIndex,
          end: node.endIndex,
        });
        nestedOwners.set(key, owner.key);
        knownSpans.add(span);
      }
    }
    for (const child of namedChildren(node)) collectNamedNestedFunctions(child);
  };
  collectNamedNestedFunctions(tree.rootNode);

  for (const fn of [...functions, ...nested]) {
    const node = findNode(tree.rootNode, fn.start, fn.end);
    if (node) scan(node, fn);
  }
  return [...functions, ...nested, ...added];
}
