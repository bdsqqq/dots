import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fixtureFetch } from "./codemode-boundaries.mjs";

// A deterministic LLM boundary, not a replacement for any extension tool.
export default function fixture(pi) {
  const plan = JSON.parse(readFileSync(process.env.PI_CODEMODE_PLAN, "utf8"));
  pi.on("tool_call", () => {
    globalThis.fetch = fixtureFetch;
  });
  let turn = 0;
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const names = tools.filter((t) =>
      JSON.stringify(t.sourceInfo).includes(plan.extensionRoot),
    );
    assert.deepEqual(names.map((t) => t.name).sort(), plan.expected);
    assert.equal(names.length, 29);
    for (const tool of names) {
      assert.equal(tool.exposure, "codemode", tool.name);
      assert.ok(
        JSON.stringify(tool.sourceInfo).includes(plan.extensionRoot),
        `${tool.name} did not load from the worktree: ${JSON.stringify(tool.sourceInfo)}`,
      );
    }
    writeFileSync(plan.inventory, JSON.stringify(tools));
  });
  pi.registerProvider("codemode-fixture", {
    api: "openai-completions",
    apiKey: "fixture-only",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "deterministic",
        name: "deterministic",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          assert.ok(
            context.messages.some(
              (m) =>
                m.role === "system" &&
                m.toolsAdded?.some((t) => t.name === "codemode"),
            ),
          );
          const first = turn++ === 0;
          if (!first) {
            const result = context.messages.findLast(
              (m) => m.role === "toolResult" && m.toolName === "codemode",
            );
            assert.ok(result && !result.isError, JSON.stringify(result));
            assert.ok(
              result.content.some(
                (p) =>
                  p.type === "text" && p.text.includes("CODEMODE_VERIFIED"),
              ),
              JSON.stringify(result),
            );
            writeFileSync(plan.result, JSON.stringify(result));
          }
          const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: first
              ? [
                  {
                    type: "toolCall",
                    id: "fixture-codemode",
                    name: "codemode",
                    arguments: { code: plan.code },
                  },
                ]
              : [{ type: "text", text: "CODEMODE_VERIFIED" }],
            stopReason: first ? "toolUse" : "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
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
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        } catch (error) {
          writeFileSync(plan.failure, String(error.stack));
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [],
              stopReason: "error",
              errorMessage: String(error),
              timestamp: Date.now(),
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          });
          stream.end();
        }
      });
      return stream;
    },
  });
}
