import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import {
  Type,
  type Static,
  type TInteger,
  type TObject,
  type TOptional,
  type TString,
  type TUnknown,
} from "typebox";
import { approveWorkflowRun } from "./approval.js";
import { renderWorkflowGraph, type WorkflowGraphNode } from "./graph.js";
import {
  aggregateUsage,
  JournalStore,
  ZERO_USAGE,
  type WorkflowRunJournal,
} from "./journal.js";
import {
  normalizeLimits,
  WorkflowRuntime,
  type WorkflowProgress,
} from "./runtime.js";
import {
  listWorkflowFiles,
  parseWorkflowSource,
  resolveWorkflowSource,
} from "./source.js";

const WorkflowParams: TObject<{
  script: TOptional<TString>;
  name: TOptional<TString>;
  scriptPath: TOptional<TString>;
  args: TOptional<TUnknown>;
  resumeFromRunId: TOptional<TString>;
  maxConcurrency: TOptional<TInteger>;
  maxAgents: TOptional<TInteger>;
}> = Type.Object({
  script: Type.Optional(
    Type.String({
      description:
        "Inline workflow JavaScript. Used after scriptPath and before name.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Workflow name resolved from project then global workflow directories.",
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path to a workflow JavaScript file. Takes precedence over script and name.",
    }),
  ),
  args: Type.Optional(
    Type.Unknown({ description: "Value exposed to the workflow as args." }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description: "Resume cached completed nodes from this workflow run.",
    }),
  ),
  maxConcurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 16,
      description: "Maximum concurrent child agents. Default 4; hard cap 16.",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description:
        "Maximum fresh direct child sessions created by agent(). Default 64; hard cap 1000.",
    }),
  ),
});

export type WorkflowParams = Static<typeof WorkflowParams>;

export interface WorkflowDetails {
  runId: string;
  status: WorkflowRunJournal["status"];
  workflow: string;
  usage: ReturnType<typeof aggregateUsage>;
  cached: number;
  journalFile: string;
  description: string;
  source: string;
  graph: WorkflowGraphNode[];
  children: Array<{
    nodeId: string;
    sessionId?: string;
    sessionFile?: string;
    phase?: string;
    label?: string;
    status: string;
  }>;
}

function progressText(progress: WorkflowProgress): string {
  const done = progress.completed + progress.failed;
  const cache = progress.cached ? `, ${progress.cached} cached` : "";
  return `${progress.runId.slice(0, 8)}: ${done}/${progress.total} settled, ${progress.running} running${cache}`;
}

function resultText(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value, null, 2) ?? "undefined");
  const max = 50 * 1024;
  const maxContentLines = 1998;
  const lines = text.split("\n");
  const lineTruncated = lines.length > maxContentLines;
  const candidate = lineTruncated
    ? lines.slice(0, maxContentLines).join("\n")
    : text;
  const byteTruncated = Buffer.byteLength(candidate, "utf8") > max;
  if (!lineTruncated && !byteTruncated) return text;
  const suffix =
    "\n\n[workflow result truncated; full node results remain in the run journal]";
  const target = max - Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = candidate.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(candidate.slice(0, middle), "utf8") <= target)
      low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(candidate[low - 1]!)) low--;
  return `${candidate.slice(0, low)}${suffix}`;
}

async function recentRuns(
  directory: string,
): Promise<
  Array<Pick<WorkflowRunJournal, "runId" | "status" | "workflow" | "updatedAt">>
> {
  try {
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const runs = await Promise.all(
      names.map(
        async (name) =>
          JSON.parse(
            await readFile(join(directory, name), "utf8"),
          ) as WorkflowRunJournal,
      ),
    );
    return runs
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function createWorkflowTool(): ToolDefinition<
  typeof WorkflowParams,
  WorkflowDetails
> {
  return {
    name: "workflow",
    label: "Workflow",
    description: [
      "Run a bounded JavaScript workflow that orchestrates persistent direct-child Pi sessions.",
      "Provide scriptPath, script, or name (precedence in that order).",
      "Scripts begin with `export const meta = { name, description, phases? }` and may use agent, parallel, pipeline, phase, args, and top-level return.",
      "Use resumeFromRunId to reuse completed nodes only when their stable key and inputs are unchanged.",
    ].join(" "),
    promptSnippet: "Run a bounded code-driven orchestration workflow",
    parameters: WorkflowParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const limits = normalizeLimits(params.maxConcurrency, params.maxAgents);
      const source = await resolveWorkflowSource(
        params,
        ctx.cwd,
        ctx.isProjectTrusted(),
      );
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile)
        throw new Error("workflow requires a persisted invoking session");
      const invokingSessionId = ctx.sessionManager.getSessionId();
      const directory = join(getAgentDir(), "workflow-runs");
      let store: JournalStore;

      if (params.resumeFromRunId) {
        store = await JournalStore.load(directory, params.resumeFromRunId);
        try {
          if (store.journal.invoking.sessionId !== invokingSessionId) {
            throw new Error(
              "workflow runs may be resumed only from their invoking session",
            );
          }
          const changedApproval =
            store.journal.workflow.scriptHash !== source.hash ||
            store.journal.limits.maxConcurrency !== limits.maxConcurrency ||
            store.journal.limits.maxAgents !== limits.maxAgents;
          if (ctx.mode !== "tui")
            throw new Error(
              "workflow execution requires interactive TUI source approval",
            );
          {
            const changeNote = changedApproval
              ? "script or limits changed since the original approval"
              : "fresh uncached work may create additional direct sessions";
            const confirmed = await approveWorkflowRun(
              ctx,
              source,
              limits,
              "resume",
              changeNote,
            );
            if (!confirmed) throw new Error("workflow cancelled before resume");
          }
          await store.mutate((journal) => {
            const resumedAt = new Date().toISOString();
            for (const node of journal.nodes) {
              if (node.status === "running") {
                node.status = "cancelled";
                node.error = "interrupted before workflow resume";
                node.finishedAt = resumedAt;
              }
            }
            journal.workflow = {
              ...source.meta,
              source: source.source,
              scriptHash: source.hash,
            };
            journal.limits = limits;
            journal.status = "running";
            delete journal.finishedAt;
          });
        } catch (error) {
          await store.release();
          throw error;
        }
      } else {
        if (ctx.mode !== "tui")
          throw new Error(
            "workflow execution requires interactive TUI source approval",
          );
        {
          const confirmed = await approveWorkflowRun(
            ctx,
            source,
            limits,
            "run",
          );
          if (!confirmed)
            throw new Error("workflow cancelled before execution");
        }
        store = await JournalStore.create(directory, {
          workflow: {
            ...source.meta,
            source: source.source,
            scriptHash: source.hash,
          },
          invoking: {
            sessionId: invokingSessionId,
            sessionFile: parentSessionFile,
            cwd: ctx.cwd,
          },
          limits,
          status: "running",
        });
      }

      let cached = 0;
      try {
        const runtime = new WorkflowRuntime(
          source,
          params.args,
          limits,
          store,
          parentSessionFile,
          ctx,
          signal,
          (progress) =>
            onUpdate?.({
              content: [{ type: "text", text: progressText(progress) }],
              details: makeDetails(store, progress.cached, progress.graph),
            }),
        );
        const output = await runtime.run();
        cached = output.cached;
        await store.mutate((journal) => {
          if (journal.nodes.some((node) => node.status === "running"))
            throw new Error("workflow cannot complete with running nodes");
          journal.status = "completed";
          journal.finishedAt = new Date().toISOString();
        });
        const details = makeDetails(store, cached, output.graph);
        return {
          content: [{ type: "text", text: resultText(output.value) }],
          details,
        };
      } catch (error) {
        if (!store.signal.aborted) {
          await store.mutate((journal) => {
            journal.status = signal?.aborted ? "cancelled" : "failed";
            journal.finishedAt = new Date().toISOString();
          });
        }
        throw error;
      } finally {
        await store.release();
      }
    },
    renderCall(args, theme) {
      const sourceLabel =
        args.scriptPath ?? args.name ?? (args.script ? "inline" : "...");
      let name = sourceLabel;
      let description: string | undefined;
      if (args.script) {
        try {
          const parsed = parseWorkflowSource(args.script);
          name = parsed.meta.name;
          description = parsed.meta.description;
        } catch {
          // Execution reports malformed source with full context.
        }
      }
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg("toolTitle", theme.bold("workflow ")) +
            theme.fg("accent", name),
          0,
          0,
        ),
      );
      if (description)
        container.addChild(new Text(theme.fg("dim", description), 0, 0));
      return container;
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const container = new Container();
      const details = result.details;
      if (!details) {
        const text = result.content[0];
        container.addChild(
          new Text(
            theme.fg(
              isPartial ? "warning" : "error",
              text?.type === "text"
                ? text.text
                : isPartial
                  ? "running"
                  : "failed",
            ),
            0,
            0,
          ),
        );
        return container;
      }
      container.addChild(
        new Text(
          theme.fg(
            details.status === "completed"
              ? "success"
              : details.status === "running"
                ? "warning"
                : "error",
            `${details.workflow} · ${details.status} · ${details.runId.slice(0, 8)}`,
          ),
          0,
          0,
        ),
      );
      for (const line of renderWorkflowGraph(
        details.graph,
        theme,
        expanded ? Number.POSITIVE_INFINITY : 128,
      ))
        container.addChild(new TruncatedText(line, 0, 0));
      if (expanded) {
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              `source ${details.source} · journal ${details.journalFile}`,
            ),
            0,
            0,
          ),
        );
        for (const child of details.children) {
          if (!child.sessionFile) continue;
          container.addChild(
            new TruncatedText(
              theme.fg(
                "dim",
                `  ${child.label ?? child.nodeId.slice(-8)} → ${child.sessionFile}`,
              ),
              0,
              0,
            ),
          );
        }
      }
      return container;
    },
  };
}

function makeDetails(
  store: JournalStore,
  cached: number,
  graph: WorkflowGraphNode[],
): WorkflowDetails {
  return {
    runId: store.journal.runId,
    status: store.journal.status,
    workflow: store.journal.workflow.name,
    usage: aggregateUsage(store.journal.nodes),
    cached,
    journalFile: store.file,
    description: store.journal.workflow.description,
    source: store.journal.workflow.source,
    graph,
    children: store.journal.nodes.map((node) => ({
      nodeId: node.nodeId,
      sessionId: node.childSessionId,
      sessionFile: node.childSessionFile,
      phase: node.phase,
      label: node.label,
      status: node.status,
    })),
  };
}

export function createWorkflowExtension(): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool(createWorkflowTool());
    pi.registerCommand("workflows", {
      description: "List available workflows and recent workflow runs",
      handler: async (_args, ctx) => {
        const [workflows, runs] = await Promise.all([
          listWorkflowFiles(ctx.cwd),
          recentRuns(join(getAgentDir(), "workflow-runs")),
        ]);
        const available = workflows.length ? workflows.join(", ") : "none";
        const history = runs.length
          ? runs
              .map(
                (run) =>
                  `${run.runId.slice(0, 8)} ${run.status} ${run.workflow.name}`,
              )
              .join("; ")
          : "none";
        ctx.ui.notify(`workflows: ${available}\nrecent: ${history}`, "info");
      },
    });
  };
}

const workflowExtension: (pi: ExtensionAPI) => void = createWorkflowExtension();

export default workflowExtension;

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const join = (...parts: string[]) => pathModule.join(...parts);
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  describe("workflow extension", () => {
    it("truncates multibyte results to the UTF-8 byte limit", () => {
      const output = resultText("🫠".repeat(20_000));
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(output).not.toContain("�");
      const lineOutput = resultText("line\n".repeat(3_000));
      expect(lineOutput.split("\n")).toHaveLength(2_000);
    });

    it("registers the workflow tool and workflows command", () => {
      const tools: unknown[] = [];
      const commands: string[] = [];
      createWorkflowExtension()({
        registerTool: (tool: unknown) => tools.push(tool),
        registerCommand: (name: string) => commands.push(name),
      } as unknown as ExtensionAPI);
      expect((tools[0] as { name: string }).name).toBe("workflow");
      expect(commands).toEqual(["workflows"]);
    });

    it("renders a live connected graph from partial tool results", () => {
      const tools: unknown[] = [];
      createWorkflowExtension()({
        registerTool: (tool: unknown) => tools.push(tool),
        registerCommand: () => undefined,
      } as unknown as ExtensionAPI);
      const tool = tools[0] as ToolDefinition<
        typeof WorkflowParams,
        WorkflowDetails
      >;
      const theme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const component = tool.renderResult!(
        {
          content: [{ type: "text", text: "running" }],
          details: {
            runId: "12345678-abcd",
            status: "running",
            workflow: "inspect",
            usage: { ...ZERO_USAGE },
            cached: 0,
            journalFile: "/tmp/run.json",
            description: "inspect in parallel",
            source: "inline",
            children: [],
            graph: [
              {
                id: "workflow",
                kind: "workflow",
                label: "inspect",
                status: "running",
                order: 0,
              },
              {
                id: "parallel",
                parentId: "workflow",
                kind: "parallel",
                label: "2 branches",
                status: "running",
                order: 1,
              },
              {
                id: "first",
                parentId: "parallel",
                kind: "agent",
                label: "first",
                status: "completed",
                order: 2,
              },
              {
                id: "second",
                parentId: "parallel",
                kind: "agent",
                label: "second",
                status: "running",
                order: 3,
              },
            ],
          },
        },
        { isPartial: true, expanded: false },
        theme as never,
        {} as never,
      );
      const output = component.render(100).join("\n");
      expect(output).toContain("├── ✓ first");
      expect(output).toContain("╰── ◐ second");
    });

    it("records native direct-parent lineage with temporary session managers", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "workflow-parent-"));
      try {
        const parentDir = join(cwd, "parent");
        const childDir = join(cwd, "child");
        const parent = SessionManager.create(cwd, parentDir);
        parent.appendSessionInfo("parent");
        const parentFile = parent.getSessionFile()!;
        const child = SessionManager.create(cwd, childDir, {
          parentSession: parentFile,
        });
        child.appendSessionInfo("child");
        expect(child.getHeader()?.parentSession).toBe(parentFile);
        expect(child.getSessionId()).not.toBe(parent.getSessionId());
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
}
