import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";

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
        ?.streamSimple(model, normalizeContext(context), options)
        .result();
  if (!response || response.stopReason !== "stop") return null;
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

if (import.meta.vitest) {
  const { it, expect, vi } = import.meta.vitest;
  const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } =
    await import("@earendil-works/pi-ai");
  const { ModelRuntime, ModelRegistry } =
    await import("@earendil-works/pi-coding-agent");

  it("completes through a native provider without an injected completion callback", async () => {
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const registry = new ModelRegistry(runtime);
    const auth = vi.spyOn(registry, "getApiKeyAndHeaders").mockResolvedValue({
      ok: true,
      apiKey: "test",
    });
    faux.setResponses([
      (context, options) => {
        expect(context.messages).toMatchObject([
          { role: "user", content: [{ type: "text", text: "summarize" }] },
        ]);
        expect(options).toMatchObject({ maxTokens: 100, reasoning: "low" });
        return fauxAssistantMessage("summary");
      },
      fauxAssistantMessage("incomplete", { stopReason: "aborted" }),
    ]);
    try {
      expect(
        await completeBackgroundText(
          undefined,
          faux.getModel(),
          registry,
          "summarize",
          100,
        ),
      ).toBe("summary");
      expect(
        await completeBackgroundText(
          undefined,
          faux.getModel(),
          registry,
          "summarize",
          100,
        ),
      ).toBeNull();
      expect(faux.state.callCount).toBe(2);
    } finally {
      auth.mockRestore();
    }
  });
}
