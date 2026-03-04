/**
 * auto session naming — generates a short title from the first user message.
 *
 * fires on the `input` event so the name appears while the agent is still
 * thinking. uses haiku for speed/cost. only names the session once.
 */

import {
  complete,
  type Api,
  type Model,
  type Message,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NAMING_MODEL = {
  provider: "openrouter",
  id: "anthropic/claude-haiku-4.5",
} as const;

export default function (pi: ExtensionAPI) {
  let named = false;

  pi.on("input", async (event, ctx) => {
    if (named) return;
    if (pi.getSessionName()) {
      named = true;
      return;
    }

    // skip slash commands and very short inputs
    const text = event.text.trim();
    if (text.startsWith("/") || text.length < 10) return;

    named = true;

    const model =
      ctx.modelRegistry.find(NAMING_MODEL.provider, NAMING_MODEL.id) ??
      ctx.model;
    if (!model) return;

    // fire and forget — don't block the input pipeline
    generateName(model, ctx.modelRegistry, text)
      .then((name) => {
        if (name) pi.setSessionName(name);
      })
      .catch(() => {});
  });

  pi.on("session_switch", async () => {
    named = false;
  });
}

async function generateName(
  model: Model<Api>,
  registry: { getApiKey(model: Model<Api>): Promise<string | undefined> },
  userMessage: string,
): Promise<string | null> {
  const apiKey = await registry.getApiKey(model);
  if (!apiKey) return null;

  const message: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Generate a 3-5 word title for a coding session that starts with this message. Return ONLY the title, no quotes, no punctuation, no explanation. Lowercase.\n\n${userMessage.slice(0, 500)}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { messages: [message] },
    { apiKey, maxTokens: 20 },
  );
  if (response.stopReason === "aborted") return null;

  const title = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return title || null;
}
