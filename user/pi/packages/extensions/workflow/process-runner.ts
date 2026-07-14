import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import type { WorkflowGraphEvent } from "./graph.js";
import { WORKFLOW_RUNNER_SOURCE } from "./runner-source.js";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;

interface WireError {
  name: string;
  message: string;
}

interface AgentFrame {
  v: 1;
  type: "agent";
  id: string;
  prompt: string;
  options: unknown;
  phase?: string;
}

const AGENT_OUTCOME: unique symbol = Symbol("workflow-agent-outcome");

export interface WorkflowAgentOutcome {
  [AGENT_OUTCOME]: true;
  value: unknown;
  cached: boolean;
}

export function workflowAgentOutcome(
  value: unknown,
  cached: boolean,
): WorkflowAgentOutcome {
  return { [AGENT_OUTCOME]: true, value, cached };
}

interface RunnerFrame {
  v: 1;
  type: "ready" | "heartbeat" | "complete" | "fatal" | "agent" | "graph";
  id?: string;
  prompt?: string;
  options?: unknown;
  phase?: string;
  pending?: number;
  hasValue?: boolean;
  value?: unknown;
  error?: WireError;
  event?: WorkflowGraphEvent;
  cached?: boolean;
}

export interface ScriptAgentRequest {
  prompt: string;
  options: unknown;
  phase?: string;
}

export interface ScriptRunRequest {
  body: string;
  args: unknown;
  filename?: string;
  signal?: AbortSignal;
  agent: (request: ScriptAgentRequest) => Promise<unknown>;
  onGraphEvent?: (event: WorkflowGraphEvent) => void;
  onFatal?: (error: Error) => void;
}

export type RunnerLauncher = (
  signal?: AbortSignal,
) => Promise<ChildProcessWithoutNullStreams>;

function wireError(error: unknown): WireError {
  return {
    name:
      error &&
      typeof error === "object" &&
      typeof (error as { name?: unknown }).name === "string"
        ? (error as { name: string }).name
        : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function fromWireError(error: WireError | undefined): Error {
  return Object.assign(new Error(error?.message ?? "workflow runner failed"), {
    name: error?.name ?? "Error",
  });
}

function encodeFrame(frame: Record<string, unknown>): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(
      JSON.stringify({ v: PROTOCOL_VERSION, ...frame }),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `workflow values must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (payload.length > MAX_FRAME_BYTES)
    throw new Error(`workflow protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): RunnerFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: RunnerFrame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES)
        throw new Error("invalid workflow protocol frame length");
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      frames.push(JSON.parse(payload.toString("utf8")) as RunnerFrame);
    }
    return frames;
  }

  assertEmpty(): void {
    if (this.buffer.length > 0)
      throw new Error("workflow runner closed with a partial protocol frame");
  }
}

export const spawnWorkflowRunner: RunnerLauncher = async () =>
  spawn(
    process.execPath,
    ["--max-old-space-size=128", "--eval", WORKFLOW_RUNNER_SOURCE],
    {
      cwd: "/tmp",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: "/tmp",
        LANG: "C",
        NODE_NO_WARNINGS: "1",
        PATH: dirname(process.execPath),
        TMPDIR: "/tmp",
      },
    },
  );

export const spawnDirectRunner: RunnerLauncher = spawnWorkflowRunner;

function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export async function runWorkflowScript(
  request: ScriptRunRequest,
  launcher: RunnerLauncher = spawnWorkflowRunner,
): Promise<unknown> {
  if (request.signal?.aborted)
    throw new DOMException("workflow cancelled", "AbortError");
  const child = await launcher(request.signal);
  if (request.signal?.aborted) {
    killProcessGroup(child, "SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        child.once("close", () => resolve());
        child.once("error", () => resolve());
      }
    });
    throw new DOMException("workflow cancelled", "AbortError");
  }
  const decoder = new FrameDecoder();
  const brokerRequests = new Set<Promise<void>>();
  let ready = false;
  let runnerPending = 0;
  let lastHeartbeat = Date.now();
  let lastActivity = Date.now();
  let stderr = "";
  let terminal:
    | { ok: true; value: unknown }
    | { ok: false; error: Error }
    | undefined;
  let terminating = false;

  const write = (frame: Record<string, unknown>): void => {
    if (child.stdin.destroyed || !child.stdin.writable) return;
    lastActivity = Date.now();
    child.stdin.write(encodeFrame(frame));
  };

  const terminate = (error: Error): void => {
    if (terminating) return;
    terminating = true;
    terminal = { ok: false, error };
    request.onFatal?.(error);
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
  };

  const handleAgent = (frame: RunnerFrame): void => {
    if (
      typeof frame.id !== "string" ||
      typeof frame.prompt !== "string" ||
      (frame.phase !== undefined && typeof frame.phase !== "string") ||
      !frame.options ||
      typeof frame.options !== "object" ||
      Array.isArray(frame.options)
    ) {
      throw new Error("invalid workflow agent request");
    }
    const agentFrame = frame as AgentFrame;
    let operation!: Promise<void>;
    operation = request
      .agent({
        prompt: agentFrame.prompt,
        options: agentFrame.options,
        phase: agentFrame.phase,
      })
      .then(
        (result) => {
          const outcome =
            typeof result === "object" &&
            result !== null &&
            AGENT_OUTCOME in result
              ? (result as WorkflowAgentOutcome)
              : undefined;
          return write({
            type: "agent_result",
            id: agentFrame.id,
            ok: true,
            value: outcome?.value ?? result,
            cached: outcome?.cached,
          });
        },
        (error) =>
          write({
            type: "agent_result",
            id: agentFrame.id,
            ok: false,
            error: wireError(error),
          }),
      )
      .finally(() => brokerRequests.delete(operation));
    brokerRequests.add(operation);
    void operation.catch((error) =>
      terminate(error instanceof Error ? error : new Error(String(error))),
    );
  };

  const handleFrame = (frame: RunnerFrame): void => {
    if (terminal)
      throw new Error("workflow runner sent data after a terminal frame");
    if (
      !frame ||
      frame.v !== PROTOCOL_VERSION ||
      typeof frame.type !== "string"
    )
      throw new Error("invalid workflow protocol frame");
    if (frame.type === "ready") {
      if (ready) throw new Error("workflow runner sent duplicate ready frame");
      ready = true;
      write({
        type: "start",
        body: request.body,
        args: request.args,
        filename: request.filename,
      });
      return;
    }
    if (!ready) throw new Error("workflow runner sent data before ready");
    if (frame.type === "heartbeat") {
      if (!Number.isInteger(frame.pending) || Number(frame.pending) < 0)
        throw new Error("invalid workflow heartbeat");
      runnerPending = Number(frame.pending);
      lastHeartbeat = Date.now();
      return;
    }
    lastActivity = Date.now();
    if (frame.type === "graph") {
      if (!frame.event || typeof frame.event !== "object")
        throw new Error("invalid workflow graph event");
      request.onGraphEvent?.(frame.event);
      return;
    }
    if (frame.type === "agent") {
      handleAgent(frame);
      return;
    }
    if (frame.type === "complete") {
      if (frame.pending !== 0 || brokerRequests.size > 0)
        throw new Error("workflow runner completed with active agent requests");
      terminal = { ok: true, value: frame.hasValue ? frame.value : undefined };
      return;
    }
    if (frame.type === "fatal") {
      terminate(fromWireError(frame.error));
      return;
    }
    throw new Error(
      `unknown workflow protocol frame type: ${String(frame.type)}`,
    );
  };

  return await new Promise<unknown>((resolve, reject) => {
    const watchdog = setInterval(() => {
      if (terminal) return;
      const now = Date.now();
      if (now - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        terminate(new Error("workflow script stopped responding"));
      } else if (
        ready &&
        runnerPending === 0 &&
        brokerRequests.size === 0 &&
        now - lastActivity > IDLE_TIMEOUT_MS
      ) {
        terminate(new Error("workflow script made no progress"));
      }
    }, 250);
    watchdog.unref();

    const abort = () =>
      terminate(new DOMException("workflow cancelled", "AbortError"));
    request.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) handleFrame(frame);
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES)
        stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => terminate(error));
    child.on("close", async () => {
      clearInterval(watchdog);
      request.signal?.removeEventListener("abort", abort);
      let closeError: Error | undefined;
      try {
        decoder.assertEmpty();
      } catch (error) {
        closeError = error as Error;
      }
      if (!terminal || closeError) {
        closeError ??= new Error(
          `workflow runner exited before completion${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        );
        terminal = { ok: false, error: closeError };
        request.onFatal?.(closeError);
      }
      await Promise.allSettled([...brokerRequests]);
      if (terminal.ok) resolve(terminal.value);
      else reject(terminal.error);
    });
  });
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("workflow script runner", () => {
    it("keeps workflow globals in the runner and proxies agent calls", async () => {
      const prompts: string[] = [];
      const value = await runWorkflowScript(
        {
          body: `
            const result = await agent("work");
            let escapeError;
            try { result.constructor.constructor("return process")(); }
            catch (error) { escapeError = error.name; }
            return [typeof process, escapeError, result.value];
          `,
          args: null,
          agent: async ({ prompt }) => {
            prompts.push(prompt);
            return { value: "done" };
          },
        },
        spawnDirectRunner,
      );
      expect(value).toEqual(["undefined", "EvalError", "done"]);
      expect(prompts).toEqual(["work"]);
    });

    it("does not leak host promises through phase callbacks", async () => {
      const value = await runWorkflowScript(
        {
          body: `
            const result = await phase("test", async () => ({ value: "done" }));
            try { result.constructor.constructor("return process")(); }
            catch (error) { return [error.name, result.value]; }
          `,
          args: null,
          agent: async () => undefined,
        },
        spawnDirectRunner,
      );
      expect(value).toEqual(["EvalError", "done"]);
    });

    it("rejects unserializable agent options without leaking pending work", async () => {
      const value = await runWorkflowScript(
        {
          body: `
            const options = {};
            options.self = options;
            try { await agent("work", options); }
            catch (error) { return error.message; }
          `,
          args: null,
          agent: async () => undefined,
        },
        spawnDirectRunner,
      );
      expect(value).toContain("circular");
    });

    it("emits connected phase and parallel graph events", async () => {
      const events: WorkflowGraphEvent[] = [];
      await runWorkflowScript(
        {
          body: `
            return phase("inspect", () => parallel([
              () => agent("first", { label: "first" }),
              () => agent("second", { label: "second" })
            ]));
          `,
          args: null,
          onGraphEvent: (event) => events.push(event),
          agent: async ({ prompt }) => prompt,
        },
        spawnDirectRunner,
      );
      const nodes = events
        .filter(
          (event): event is Extract<WorkflowGraphEvent, { type: "node" }> =>
            event.type === "node",
        )
        .map((event) => event.node);
      const phase = nodes.find((node) => node.kind === "phase")!;
      const parallel = nodes.find((node) => node.kind === "parallel")!;
      const agents = nodes.filter((node) => node.kind === "agent");
      expect(phase.parentId).toBe("workflow");
      expect(parallel.parentId).toBe(phase.id);
      expect(agents.map((node) => node.parentId)).toEqual([
        parallel.id,
        parallel.id,
      ]);
    });

    it("preserves handled agent rejection semantics", async () => {
      const value = await runWorkflowScript(
        {
          body: `
            try { await agent("expected failure"); }
            catch { return "recovered"; }
          `,
          args: null,
          agent: async () => {
            throw new Error("expected failure");
          },
        },
        spawnDirectRunner,
      );
      expect(value).toBe("recovered");
    });

    it("rejects failed detached agents", async () => {
      await expect(
        runWorkflowScript(
          {
            body: 'agent("detached failure"); return "premature"',
            args: null,
            agent: async () => {
              throw new Error("detached failure");
            },
          },
          spawnDirectRunner,
        ),
      ).rejects.toThrow("detached failure");
    });

    it("rejects unobserved failures in derived agent chains", async () => {
      for (const body of [
        'agent("then failure").then(() => "ignored"); return "premature"',
        'agent("finally failure").finally(() => undefined); return "premature"',
      ]) {
        await expect(
          runWorkflowScript(
            {
              body,
              args: null,
              agent: async () => {
                throw new Error("derived failure");
              },
            },
            spawnDirectRunner,
          ),
        ).rejects.toThrow("derived failure");
      }
    });

    it("marks cached agent outcomes in the graph", async () => {
      const events: WorkflowGraphEvent[] = [];
      await runWorkflowScript(
        {
          body: 'return agent("cached")',
          args: null,
          onGraphEvent: (event) => events.push(event),
          agent: async () => workflowAgentOutcome("reused", true),
        },
        spawnDirectRunner,
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "status", status: "cached" }),
      );
    });

    it("bounds graph label and cumulative protocol bytes", async () => {
      const events: WorkflowGraphEvent[] = [];
      await runWorkflowScript(
        {
          body: 'return agent("bounded", { label: "🫠".repeat(100000) })',
          args: null,
          onGraphEvent: (event) => events.push(event),
          agent: async () => "done",
        },
        spawnDirectRunner,
      );
      const agentNode = events.find(
        (event) => event.type === "node" && event.node.kind === "agent",
      );
      expect(agentNode?.type).toBe("node");
      if (agentNode?.type === "node")
        expect(
          Buffer.byteLength(agentNode.node.label, "utf8"),
        ).toBeLessThanOrEqual(512);
      expect(Buffer.byteLength(JSON.stringify(events), "utf8")).toBeLessThan(
        1024 * 1024,
      );
    });

    it("bounds graph protocol events for large pipelines", async () => {
      const events: WorkflowGraphEvent[] = [];
      await runWorkflowScript(
        {
          body: `
            return pipeline(
              Array.from({ length: 3000 }, (_, index) => index),
              value => value
            );
          `,
          args: null,
          onGraphEvent: (event) => events.push(event),
          agent: async () => undefined,
        },
        spawnDirectRunner,
      );
      expect(events.length).toBeLessThanOrEqual(4000);
      expect(
        events.filter(
          (event) =>
            event.type === "node" && event.node.id === "workflow:overflow",
        ),
      ).toHaveLength(1);
    });

    it("accepts completion after an agent outlives a heartbeat", async () => {
      const value = await runWorkflowScript(
        {
          body: 'return agent("slow")',
          args: null,
          agent: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            return "done";
          },
        },
        spawnDirectRunner,
      );
      expect(value).toBe("done");
    });

    it("drains chained detached agents before completion", async () => {
      const prompts: string[] = [];
      const value = await runWorkflowScript(
        {
          body: 'agent("a").then(() => agent("b")); return "script-result"',
          args: null,
          agent: async ({ prompt }) => {
            prompts.push(prompt);
            return prompt;
          },
        },
        spawnDirectRunner,
      );
      expect(value).toBe("script-result");
      expect(prompts).toEqual(["a", "b"]);
    });

    it("aborts active agents when the runner exits abruptly", async () => {
      const controller = new AbortController();
      const pending = runWorkflowScript(
        {
          body: 'return agent("wait")',
          args: null,
          signal: controller.signal,
          onFatal: () => controller.abort(),
          agent: async () =>
            new Promise((_resolve, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("agent aborted")),
                { once: true },
              ),
            ),
        },
        async () => {
          const child = await spawnWorkflowRunner();
          setTimeout(() => killProcessGroup(child, "SIGKILL"), 100);
          return child;
        },
      );
      await expect(pending).rejects.toThrow("exited before completion");
    });

    it("aborts detached agents when the runner fails", async () => {
      const controller = new AbortController();
      const pending = runWorkflowScript(
        {
          body: 'agent("wait"); throw new Error("boom")',
          args: null,
          signal: controller.signal,
          onFatal: () => controller.abort(),
          agent: async () =>
            new Promise((_resolve, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("agent aborted")),
                { once: true },
              ),
            ),
        },
        spawnDirectRunner,
      );
      await expect(pending).rejects.toThrow("boom");
    });

    it("kills a runner whose asynchronous script is cancelled", async () => {
      const controller = new AbortController();
      const pending = runWorkflowScript(
        {
          body: "return new Promise(() => {})",
          args: null,
          signal: controller.signal,
          agent: async () => undefined,
        },
        spawnDirectRunner,
      );
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow("workflow cancelled");
    });
  });
}
