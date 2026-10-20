/** Offline child MODEL boundary. The child is real Pi and executes the production read tool. */
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";

export default function childFixture(pi: ExtensionAPI) {
  let turn = 0;
  pi.registerProvider("rendering-child", {
    api: "openai-completions",
    apiKey: "synthetic",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "deterministic",
        name: "synthetic child model",
        reasoning: false,
        input: ["text"],
        contextWindow: 16000,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await delay(350);
        const first = turn++ === 0;
        if (!first)
          assert.ok(
            context.messages.some(
              (m) =>
                m.role === "toolResult" &&
                m.toolName === "read" &&
                m.content.some(
                  (p) => p.type === "text" && p.text.includes("LOCAL_FIXTURE"),
                ),
            ),
            "child production read did not execute",
          );
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "child-read",
                  name: "read",
                  arguments: { path: "fixture.txt" },
                },
              ]
            : [{ type: "text", text: "SUBAGENT_FIXTURE" }],
          stopReason: first ? "toolUse" : "stop",
          usage: {
            input: 4,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 6,
            cost: {
              input: 0.004,
              output: 0.002,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.006,
            },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: first ? "toolUse" : "stop",
          message,
        });
        stream.end();
      })();
      return stream;
    },
  });
}
