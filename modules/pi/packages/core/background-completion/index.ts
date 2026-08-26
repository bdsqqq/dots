import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type BackgroundComplete = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export async function completeBackgroundText(
  complete: BackgroundComplete | undefined,
  model: Model<Api>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || (!auth.apiKey && !auth.headers)) return null;
  const message: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  const context = { messages: [message] };
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal,
    maxTokens,
    reasoning: "low",
  };
  const response = complete
    ? await complete(model, context, options)
    : await registry
        .getProvider(model.provider)
        ?.streamSimple(model, context, options)
        .result();
  if (!response || response.stopReason !== "stop") return null;
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}
