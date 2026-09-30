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
  const message: Message = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  const context = { messages: [message] };
  const options: SimpleStreamOptions = {
    signal,
    maxTokens,
    reasoning: "low",
  };
  let response: AssistantMessage;
  if (complete) {
    // injected completions retain the compatibility auth contract; native calls
    // let the runtime resolve auth once, including ambient credentials and URLs.
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && !auth.headers)) return null;
    response = await complete(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });
  } else {
    response = await registry.streamSimple(model, context, options).result();
  }
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

  async function registryFor(
    provider: import("@earendil-works/pi-ai").Provider,
  ) {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        apiKey: provider.auth.apiKey && {
          ...provider.auth.apiKey,
          // registration refreshes availability; keep request auth out of that probe.
          check: async () => undefined,
        },
      },
    });
    return new ModelRegistry(runtime);
  }

  it("uses native request auth, endpoint and model headers without leaking thinking", async () => {
    const faux = fauxProvider();
    const resolve = vi.fn(async () => ({
      auth: {
        apiKey: "test",
        headers: { "x-auth": "resolved", "X-Model": "auth-default" },
        baseUrl: "https://resolved.invalid",
      },
      env: { REGION: "test-region" },
    }));
    const registry = await registryFor({
      ...faux.provider,
      auth: { apiKey: { name: "Test", resolve } },
    });
    const model = { ...faux.getModel(), headers: { "x-model": "override" } };
    const controller = new AbortController();
    faux.setResponses([
      (context, options, _state, requestModel) => {
        expect(context.messages).toEqual([
          {
            role: "user",
            content: [{ type: "text", text: "summarize" }],
            timestamp: expect.any(Number),
          },
        ]);
        expect(options).toMatchObject({
          apiKey: "test",
          headers: { "x-auth": "resolved", "x-model": "override" },
          env: { REGION: "test-region" },
          maxTokens: 100,
          reasoning: "low",
          signal: controller.signal,
        });
        expect(options?.headers).not.toHaveProperty("X-Model");
        expect(requestModel).toEqual({
          ...model,
          baseUrl: "https://resolved.invalid",
        });
        return fauxAssistantMessage([
          { type: "thinking", thinking: "private" },
          { type: "text", text: "sum" },
          { type: "text", text: "mary" },
        ]);
      },
    ]);
    expect(
      await completeBackgroundText(
        undefined,
        model,
        registry,
        "summarize",
        100,
        controller.signal,
      ),
    ).toBe("summary");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("accepts native ambient/keyless auth without requiring a key or headers", async () => {
    const faux = fauxProvider();
    const registry = await registryFor(faux.provider);
    faux.setResponses([fauxAssistantMessage("summary")]);
    expect(
      await completeBackgroundText(
        undefined,
        faux.getModel(),
        registry,
        "summarize",
        100,
      ),
    ).toBe("summary");
  });

  it.each(["aborted", "error", "length", "toolUse"] as const)(
    "returns null for a %s result",
    async (stopReason) => {
      const faux = fauxProvider();
      const registry = await registryFor(faux.provider);
      faux.setResponses([fauxAssistantMessage("incomplete", { stopReason })]);
      expect(
        await completeBackgroundText(
          undefined,
          faux.getModel(),
          registry,
          "summarize",
          100,
        ),
      ).toBeNull();
    },
  );

  it.each(["missing", "failed"] as const)(
    "returns null without streaming when auth is %s",
    async (kind) => {
      const faux = fauxProvider();
      const registry = await registryFor({
        ...faux.provider,
        auth: {
          apiKey: {
            name: "Test",
            resolve: async () => {
              if (kind === "failed") throw new Error("auth unavailable");
              return undefined;
            },
          },
        },
      });
      expect(
        await completeBackgroundText(
          undefined,
          faux.getModel(),
          registry,
          "summarize",
          100,
        ),
      ).toBeNull();
      expect(faux.state.callCount).toBe(0);
    },
  );

  it("returns null for an unavailable provider", async () => {
    const faux = fauxProvider();
    const registry = await registryFor(faux.provider);
    expect(
      await completeBackgroundText(
        undefined,
        { ...faux.getModel(), provider: "unregistered" },
        registry,
        "summarize",
        100,
      ),
    ).toBeNull();
    expect(faux.state.callCount).toBe(0);
  });

  it("cancels request-time auth without starting a provider stream", async () => {
    const faux = fauxProvider();
    const controller = new AbortController();
    const registry = await registryFor({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async ({ signal }) => {
            expect(signal).toBe(controller.signal);
            controller.abort();
            signal.throwIfAborted();
            return undefined;
          },
        },
      },
    });
    expect(
      await completeBackgroundText(
        undefined,
        faux.getModel(),
        registry,
        "summarize",
        100,
        controller.signal,
      ),
    ).toBeNull();
    expect(controller.signal.aborted).toBe(true);
    expect(faux.state.callCount).toBe(0);
  });

  it("returns null when cancelled during provider streaming", async () => {
    const faux = fauxProvider();
    const registry = await registryFor(faux.provider);
    const controller = new AbortController();
    faux.setResponses([
      () => {
        controller.abort();
        return fauxAssistantMessage("discard");
      },
    ]);
    expect(
      await completeBackgroundText(
        undefined,
        faux.getModel(),
        registry,
        "summarize",
        100,
        controller.signal,
      ),
    ).toBeNull();
    expect(faux.state.callCount).toBe(1);
  });

  it("preserves injected completion auth and prompt context", async () => {
    const faux = fauxProvider();
    const registry = await registryFor({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { headers: { "x-auth": "test" } } }),
        },
      },
    });
    const complete: BackgroundComplete = async (model, context, options) => {
      expect(model).toBe(faux.getModel());
      expect(context.messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "summarize" }] },
      ]);
      expect(options).toMatchObject({
        headers: { "x-auth": "test" },
        maxTokens: 100,
        reasoning: "low",
      });
      return fauxAssistantMessage("summary");
    };
    expect(
      await completeBackgroundText(
        complete,
        faux.getModel(),
        registry,
        "summarize",
        100,
      ),
    ).toBe("summary");
    expect(faux.state.callCount).toBe(0);
  });

  it("does not invoke an injected completion without compatibility auth", async () => {
    const faux = fauxProvider();
    const registry = await registryFor(faux.provider);
    const complete = vi.fn(async () => fauxAssistantMessage("discard"));
    expect(
      await completeBackgroundText(
        complete,
        faux.getModel(),
        registry,
        "summarize",
        100,
      ),
    ).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
}
