/** Deterministic model boundary; all calls still execute through the production agent. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default async function renderingFixture(pi: ExtensionAPI) {
  const boundary = await import("./codemode-boundaries.mjs");
  const plan = JSON.parse(readFileSync(process.env.PI_RENDER_PLAN!, "utf8"));
  const log = (event: unknown) =>
    appendFileSync(plan.events, JSON.stringify(event) + "\n");
  (globalThis as any).__piRenderingObservation = (event: unknown) =>
    appendFileSync(
      plan.renders,
      JSON.stringify({ ...(event as any), viewport: process.stdout.columns }) +
        "\n",
    );
  let turn = 0;
  pi.on("tool_call", () => {
    globalThis.fetch = async (...args) => {
      await delay(350);
      return boundary.fixtureFetch(...args);
    };
  });
  // Synthetic spill metadata exercises stale-file reporting; real result content is unchanged.
  pi.on("tool_result", (event) => {
    const state = plan.states.findIndex(
      (s: any) => s.id === "codemode-head-tail",
    );
    const opaque = plan.states.findIndex(
      (s: any) => s.id === "codemode-opaque-json",
    );
    if (
      event.toolCallId === `sampler-${state}-0` ||
      event.toolCallId === `sampler-${opaque}-0`
    ) {
      const available = event.toolCallId === `sampler-${opaque}-0`;
      const path = `${plan.gates}/../${available ? "available" : "missing"}-spill.txt`;
      if (available)
        writeFileSync(path, "SYNTHETIC_SPILL_CONTENT_NOT_AUTO_COPIED");
      return {
        details: { ...(event.details as object), fullOutputPath: path },
      };
    }
  });
  pi.on("tool_execution_start", log);
  pi.on("tool_execution_update", log);
  pi.on("tool_execution_end", log);
  pi.registerCommand("fixture-snapshot", {
    description: "Persist the fixture branch for read-only comparison",
    handler: async (name, ctx) => {
      if (!["before", "after"].includes(name))
        throw new Error("unknown snapshot");
      writeFileSync(
        `${plan.gates}/../branch-${name}.json`,
        JSON.stringify(ctx.sessionManager.getBranch()),
      );
    },
  });
  pi.on("agent_end", () => log({ type: "settled" }));
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    writeFileSync(plan.inventory, JSON.stringify(tools, null, 2));
    pi.setActiveTools(tools.map((tool) => tool.name));
  });
  pi.registerProvider("rendering-fixture", {
    api: "openai-completions",
    apiKey: "synthetic",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "deterministic",
        name: "deterministic rendering sampler",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const index = turn++;
        log({ type: "gate", index });
        while (!existsSync(`${plan.gates}/${index}`)) await delay(25);
        const state = plan.states[index];
        const content: AssistantMessage["content"] = state?.calls
          ? state.calls.map((call: any, n: number) => ({
              type: "toolCall",
              id: `sampler-${index}-${n}`,
              name: call.name,
              arguments: call.args,
            }))
          : [{ type: "text", text: plan.markdown }];
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content,
          stopReason: state?.calls ? "toolUse" : "stop",
          usage: {
            input: 8,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: state?.calls ? "toolUse" : "stop",
          message,
        });
        stream.end();
      })().catch((error) => {
        log({ type: "fixture_error", error: String(error) });
        stream.end();
      });
      return stream;
    },
  });
}
