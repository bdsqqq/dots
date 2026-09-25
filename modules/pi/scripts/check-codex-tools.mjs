/**
 * Opt-in acceptance check for every shipped tool, using existing Codex OAuth.
 * No tools execute, no session history is sent, no API-key billing fallback.
 * Run after build: node scripts/check-codex-tools.mjs --live [--built]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

if (!process.argv.includes("--live"))
  throw new Error("explicit --live required; uses existing Codex OAuth");
const { loadProviderContractTools } = await createJiti(import.meta.url).import(
  "../packages/core/prompt-patch/provider-contract.ts",
);
const tools = await loadProviderContractTools(process.argv.includes("--built"));
const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const signal = AbortSignal.timeout(60000);
const auth = await runtime.checkAuth("openai-codex", { signal });
assert.equal(
  auth?.type,
  "oauth",
  "existing Codex OAuth required; no API-key fallback",
);
const model = runtime.getModel("openai-codex", "gpt-6-astra");
assert.equal(model?.api, "openai-codex-responses");
assert.equal(new URL(model.baseUrl).hostname, "chatgpt.com");
let inventory;
const result = await runtime.complete(
  model,
  {
    systemPrompt: "Reply exactly OK. Do not call tools.",
    messages: [
      {
        role: "user",
        content: "Tool schema acceptance check.",
        timestamp: Date.now(),
      },
    ],
    tools,
  },
  {
    signal,
    transport: "sse",
    reasoningEffort: "low",
    toolChoice: "none",
    onPayload(payload) {
      assert.deepEqual(
        payload.tools.map((tool) => tool.name).sort(),
        tools.map((tool) => tool.name).sort(),
      );
      inventory = {
        model: model.id,
        tools: payload.tools.map(({ name, strict, type }) => ({
          name,
          strict,
          type,
        })),
        sha256: createHash("sha256")
          .update(JSON.stringify(payload.tools))
          .digest("hex"),
      };
    },
  },
);
assert.equal(
  result.stopReason,
  "stop",
  result.errorMessage ?? "no successful terminal completion",
);
assert.equal(
  result.content.some((part) => part.type === "toolCall"),
  false,
);
console.log(
  JSON.stringify(
    { ...inventory, stopReason: result.stopReason, response: result.content },
    null,
    2,
  ),
);
