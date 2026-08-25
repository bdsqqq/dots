import type { FunctionIndex } from "./extract.js";
import { buildCallTree, resolveEntry } from "./calltree.js";
import { diffTrees, treeHasChanges } from "./diff.js";
import type { DiffNode } from "./types.js";

function calleeSet(
  index: FunctionIndex,
  key: string,
  maxDepth: number,
): string {
  const tree = buildCallTree(key, index, maxDepth);
  const parts: string[] = [];
  const walk = (node: typeof tree, depth: number) => {
    parts.push(`${"  ".repeat(depth)}${node.key}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 0);
  return parts.join("\n");
}

/**
 * Infer entrypoints: exported functions whose expanded call trees differ,
 * plus any explicitly requested entries.
 */
export function inferEntries(
  before: FunctionIndex,
  after: FunctionIndex,
  explicit: string[],
  maxDepth: number,
): string[] {
  if (explicit.length > 0) {
    const resolved: string[] = [];
    for (const entry of explicit) {
      const fromBefore = resolveEntry(entry, before);
      const fromAfter = resolveEntry(entry, after);
      const key = fromAfter ?? fromBefore;
      if (!key) {
        throw new Error(`Entrypoint not found: ${entry}`);
      }
      if (!resolved.includes(key)) resolved.push(key);
    }
    return resolved;
  }

  const keys = new Set([...before.keys(), ...after.keys()]);
  const candidates: string[] = [];

  for (const key of keys) {
    // Skip synthetic `new X` aliases for inference listing (still resolvable)
    if (key.startsWith("new ") || key.startsWith("@callback::")) continue;

    const b = before.get(key);
    const a = after.get(key);

    // Prefer exported / public-ish roots
    const interesting = Boolean(b?.exported || a?.exported);
    if (!interesting) continue;

    const beforeTree = b ? calleeSet(before, key, maxDepth) : "";
    const afterTree = a ? calleeSet(after, key, maxDepth) : "";

    if (beforeTree !== afterTree) {
      candidates.push(key);
    }
  }

  // If nothing exported changed, fall back to any function with a differing tree
  if (candidates.length === 0) {
    for (const key of keys) {
      if (key.startsWith("new ") || key.startsWith("@callback::")) continue;
      const beforeTree = before.has(key)
        ? calleeSet(before, key, maxDepth)
        : "";
      const afterTree = after.has(key) ? calleeSet(after, key, maxDepth) : "";
      if (beforeTree !== afterTree) candidates.push(key);
    }
  }

  // Prefer shallower / shorter names first for stable output
  return candidates.sort((a, b) => a.localeCompare(b));
}

export function diffEntry(
  key: string,
  before: FunctionIndex,
  after: FunctionIndex,
  maxDepth: number,
): DiffNode | null {
  const beforeKey = resolveEntry(key, before) ?? key;
  const afterKey = resolveEntry(key, after) ?? key;

  const hasBefore = before.has(beforeKey);
  const hasAfter = after.has(afterKey);

  if (!hasBefore && !hasAfter) return null;

  const beforeTree = hasBefore
    ? buildCallTree(beforeKey, before, maxDepth)
    : {
        key: afterKey,
        label: after.get(afterKey)?.label ?? afterKey,
        children: [] as [],
      };

  const afterTree = hasAfter
    ? buildCallTree(afterKey, after, maxDepth)
    : {
        key: beforeKey,
        label: before.get(beforeKey)?.label ?? beforeKey,
        children: [] as [],
      };

  // If function only on one side, mark root accordingly via empty opposite
  if (!hasBefore && hasAfter) {
    const diff = diffTrees(
      { key: afterKey, label: afterTree.label, children: [] },
      afterTree,
    );
    // Force root added
    return { ...diff, status: "added" };
  }

  if (hasBefore && !hasAfter) {
    const diff = diffTrees(beforeTree, {
      key: beforeKey,
      label: beforeTree.label,
      children: [],
    });
    return { ...diff, status: "removed" };
  }

  const diff = diffTrees(beforeTree, afterTree);
  if (!treeHasChanges(diff)) return null;
  return diff;
}
