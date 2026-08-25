export type WorkflowGraphNodeKind =
  | "workflow"
  | "phase"
  | "parallel"
  | "pipeline"
  | "item"
  | "stage"
  | "agent";

export type WorkflowGraphNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "cached";

export interface WorkflowGraphNode {
  id: string;
  parentId?: string;
  kind: WorkflowGraphNodeKind;
  label: string;
  status: WorkflowGraphNodeStatus;
  order: number;
  phase?: string;
  draft?: boolean;
}

export type WorkflowGraphEvent =
  | { type: "node"; node: WorkflowGraphNode }
  | {
      type: "status";
      id: string;
      status: WorkflowGraphNodeStatus;
    };

export function applyWorkflowGraphEvent(
  graph: WorkflowGraphNode[],
  event: WorkflowGraphEvent,
): void {
  if (event.type === "node") {
    const index = graph.findIndex((node) => node.id === event.node.id);
    if (index < 0) graph.push({ ...event.node });
    else graph[index] = { ...graph[index], ...event.node };
    return;
  }
  const node = graph.find((candidate) => candidate.id === event.id);
  if (node) node.status = event.status;
}

function statusIcon(status: WorkflowGraphNodeStatus, theme: any): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "◐");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✕");
    case "cancelled":
      return theme.fg("muted", "−");
    case "cached":
      return theme.fg("accent", "◇");
    default:
      return theme.fg("dim", "○");
  }
}

function escapeGraphLabel(label: string): string {
  return label.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`;
  });
}

function kindLabel(node: WorkflowGraphNode, theme: any): string {
  if (node.kind === "workflow" || node.kind === "agent") return "";
  const label = node.draft ? `${node.kind} · draft` : node.kind;
  return ` ${theme.fg("dim", `[${label}]`)}`;
}

export function renderWorkflowGraph(
  graph: WorkflowGraphNode[],
  theme: any,
  maxNodes: number = Number.POSITIVE_INFINITY,
): string[] {
  if (graph.length === 0) return [theme.fg("dim", "○ waiting for workflow")];
  const ordered = [...graph].sort((a, b) => a.order - b.order);
  const byParent = new Map<string | undefined, WorkflowGraphNode[]>();
  for (const node of ordered) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }

  const lines: string[] = [];
  let rendered = 0;
  const visit = (node: WorkflowGraphNode, prefix: string, isLast: boolean) => {
    if (rendered >= maxNodes) return;
    const connector = node.parentId
      ? theme.fg("muted", isLast ? "╰── " : "├── ")
      : "";
    const labelColor =
      node.status === "failed"
        ? "error"
        : node.status === "running"
          ? "text"
          : "muted";
    lines.push(
      `${prefix}${connector}${statusIcon(node.status, theme)} ${theme.fg(labelColor, escapeGraphLabel(node.label))}${kindLabel(node, theme)}`,
    );
    rendered++;
    const children = byParent.get(node.id) ?? [];
    const childPrefix = node.parentId
      ? `${prefix}${isLast ? "    " : theme.fg("muted", "│   ")}`
      : prefix;
    for (let index = 0; index < children.length; index++) {
      visit(children[index]!, childPrefix, index === children.length - 1);
    }
  };

  const roots = byParent.get(undefined) ?? [];
  for (let index = 0; index < roots.length; index++)
    visit(roots[index]!, "", index === roots.length - 1);
  if (rendered < graph.length)
    lines.push(theme.fg("dim", `… ${graph.length - rendered} more nodes`));
  return lines;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("workflow graph", () => {
    const theme = { fg: (_color: string, text: string) => text };

    it("renders connected parent-child branches", () => {
      const lines = renderWorkflowGraph(
        [
          {
            id: "workflow",
            kind: "workflow",
            label: "demo",
            status: "running",
            order: 0,
          },
          {
            id: "parallel",
            parentId: "workflow",
            kind: "parallel",
            label: "parallel",
            status: "running",
            order: 1,
            draft: true,
          },
          {
            id: "a",
            parentId: "parallel",
            kind: "agent",
            label: "first",
            status: "completed",
            order: 2,
          },
          {
            id: "b",
            parentId: "parallel",
            kind: "agent",
            label: "second",
            status: "running",
            order: 3,
          },
        ],
        theme,
      );
      expect(lines.join("\n")).toContain("[parallel · draft]");
      expect(lines.join("\n")).toContain("├── ✓ first");
      expect(lines.join("\n")).toContain("╰── ◐ second");
    });

    it("escapes terminal controls in labels", () => {
      const lines = renderWorkflowGraph(
        [
          {
            id: "workflow",
            kind: "workflow",
            label: "unsafe\u001b[2J\nlabel",
            status: "running",
            order: 0,
          },
        ],
        theme,
      );
      expect(lines).toEqual(["◐ unsafe\\x1b[2J\\nlabel"]);
    });
  });
}
