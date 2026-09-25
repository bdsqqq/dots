import { randomUUID } from "node:crypto";
import {
  createRemoteServiceBinding,
  createRemoteServiceEndpoint,
  defineService,
  isJsonValue,
  RemoteServiceProvider,
  replicatedState,
  type Context,
  type ReplicatedState,
  type JsonRepresentation,
} from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Client,
  createClientServiceTransport,
} from "@earendil-works/pi-client";
import type { SessionTarget } from "@earendil-works/pi-protocol";
import {
  ServerError,
  SessionNotFoundError,
  type ServerHost,
  type RoutedSessionHandle,
} from "@earendil-works/pi-server";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ minLength: 1 });
const json = Type.Cyclic(
  {
    value: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("value")),
      Type.Record(Type.String(), Type.Ref("value")),
    ]),
  },
  "value",
);
const modelSchema = Type.Object(
  { provider: text, id: text },
  { additionalProperties: false },
);
export interface SpawnModel {
  provider: string;
  id: string;
}
const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
const textContent = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});
const imageContent = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
const messageSchema = Type.Union([
  Type.Object({
    role: Type.Literal("user"),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Union([textContent, imageContent])),
    ]),
    timestamp: Type.Number(),
  }),
  Type.Object({
    role: Type.Literal("assistant"),
    timestamp: Type.Number(),
    api: text,
    provider: text,
    model: text,
    content: Type.Array(
      Type.Union([
        textContent,
        Type.Object({
          type: Type.Literal("thinking"),
          thinking: Type.String(),
          thinkingSignature: Type.Optional(Type.String()),
          redacted: Type.Optional(Type.Boolean()),
        }),
        Type.Object({
          type: Type.Literal("toolCall"),
          // Provider deltas may introduce the block before its identity/name.
          id: Type.String(),
          name: Type.String(),
          arguments: Type.Record(Type.String(), json),
          thoughtSignature: Type.Optional(Type.String()),
          namespace: Type.Optional(Type.String()),
        }),
      ]),
    ),
    usage: usageSchema,
    stopReason: Type.Union(
      (
        [
          "pending",
          "stop",
          "length",
          "toolUse",
          "error",
          "aborted",
          "deferred",
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
    errorMessage: Type.Optional(Type.String()),
    responseModel: Type.Optional(Type.String()),
    responseId: Type.Optional(Type.String()),
    providerThinkingLevel: Type.Optional(Type.String()),
    rawStopReason: Type.Optional(Type.String()),
    endTurn: Type.Optional(Type.Boolean()),
    deferred: Type.Optional(
      Type.Object({
        provider: Type.String(),
        modelId: Type.String(),
        api: Type.String(),
        id: Type.String(),
        expiresAt: Type.Optional(Type.Number()),
        pollAfterMs: Type.Optional(Type.Number()),
        data: Type.Optional(json),
      }),
    ),
    diagnostics: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.String(),
          timestamp: Type.Number(),
          details: Type.Optional(Type.Record(Type.String(), json)),
          error: Type.Optional(
            Type.Object({
              message: Type.String(),
              name: Type.Optional(Type.String()),
              stack: Type.Optional(Type.String()),
              code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
            }),
          ),
        }),
      ),
    ),
  }),
  Type.Object({
    role: Type.Literal("toolResult"),
    toolCallId: text,
    toolName: text,
    content: Type.Array(Type.Union([textContent, imageContent])),
    details: Type.Optional(json),
    usage: Type.Optional(usageSchema),
    isError: Type.Boolean(),
    timestamp: Type.Number(),
  }),
]);
const stateSchema = Type.Object({
  id: text,
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("turn"),
    Type.Literal("retry"),
    Type.Literal("compaction"),
  ]),
  messages: Type.Array(messageSchema),
});
export interface SpawnObservation {
  id: string;
  phase: "idle" | "turn" | "retry" | "compaction";
  messages: JsonRepresentation<Exclude<Message, { role: "system" }>>[];
}
const createSchema = Type.Object(
  {
    cwd: Type.Optional(text),
    model: Type.Optional(modelSchema),
    admissionRef: Type.Optional(text),
  },
  { additionalProperties: false },
);
export interface SpawnCreateRequest {
  cwd?: string;
  model?: SpawnModel;
  admissionRef?: string;
}
const catalogueSchema = Type.Array(
  Type.Object({
    id: text,
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    sessionName: Type.Optional(text),
    parentSessionId: Type.Optional(text),
    cwd: Type.Optional(text),
  }),
);
export interface SpawnCatalogueEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  sessionName?: string;
  parentSessionId?: string;
  cwd?: string;
}

/** Chord validates JSON, not application values. Validate both ends, including hydration. */
function checked<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!isJsonValue(value) || !Value.Check(schema, value))
    throw new ServerError(
      "service_invalid_value",
      "invalid pi-spawn service value",
    );
  return value;
}
export function observeSpawn(value: unknown): SpawnObservation {
  return checked(stateSchema, value);
}

interface SpawnManagement {
  list(context: Context): Promise<SpawnCatalogueEntry[]>;
  create(input: SpawnCreateRequest, context: Context): Promise<string>;
  attach(id: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}
interface SpawnExecution {
  observation: ReplicatedState<SpawnObservation>;
  prompt(text: string, context: Context): Promise<SpawnObservation>;
  abort(context: Context): Promise<void>;
  setModel(model: SpawnModel, context: Context): Promise<void>;
}
const SpawnManagementService = defineService<SpawnManagement>(
  "bds.pi-spawn.management",
);
const SpawnExecutionService = defineService<SpawnExecution>(
  "bds.pi-spawn.execution",
);

/** Local execution capability; routing and attachments deliberately live elsewhere. */
export interface SpawnExecutor {
  snapshot(): SpawnObservation;
  getPhase(): SpawnObservation["phase"];
  prompt(input: { text: string }): Promise<void>;
  abort(): Promise<void>;
  setModel(model: SpawnModel): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}
export interface SpawnCatalogue {
  listSessions(): Promise<SpawnCatalogueEntry[]>;
  createSession(
    input: SpawnCreateRequest & { id: string },
  ): Promise<SpawnExecutor>;
  openSession(id: string): Promise<SpawnExecutor>;
}

/**
 * The router retains handles after detachment. A handle therefore serializes
 * acquisition/retirement, not just creation, and reopens on renewed demand.
 * Upstream waits for admitted calls before release; disconnect cannot retire
 * the writer underneath an accepted prompt.
 */
function routedExecutor(
  open: () => Promise<SpawnExecutor>,
): RoutedSessionHandle {
  let runtime: SpawnExecutor | undefined;
  let provider: RemoteServiceProvider | undefined;
  let unsubscribe: (() => void) | undefined;
  let attachments = 0;
  let closed = false;
  let tail = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const retire = async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    provider?.dispose();
    provider = undefined;
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  };
  return {
    attachClient: () =>
      serial(async () => {
        if (closed) throw new Error("pi-spawn handle is closed");
        try {
          runtime ??= await open();
          const executor = runtime;
          if (!provider) {
            const observation = replicatedState(
              observeSpawn(executor.snapshot()),
            );
            const publish = () =>
              observation.replace(
                BACKGROUND_CONTEXT,
                observeSpawn(executor.snapshot()),
              );
            provider = new RemoteServiceProvider([SpawnExecutionService]);
            provider.provide(SpawnExecutionService, {
              observation,
              async prompt(input, context) {
                checked(text, input);
                context.abortSignal?.throwIfAborted();
                // Once accepted, only explicit abort cancels work. A dropped response
                // is not permission to discard a remotely running task or replay it.
                try {
                  await executor.prompt({ text: input });
                } finally {
                  publish();
                }
                return observeSpawn(executor.snapshot());
              },
              async abort() {
                await executor.abort();
                publish();
              },
              async setModel(input) {
                await executor.setModel(checked(modelSchema, input));
                publish();
              },
            });
            unsubscribe = executor.subscribe(publish);
          }
        } catch (error) {
          if (attachments === 0) {
            try {
              await retire();
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "pi-spawn acquisition and cleanup failed",
              );
            }
          }
          throw error;
        }
        const endpoint = createRemoteServiceEndpoint(provider);
        attachments += 1;
        let released = false;
        return {
          invokeService: (call, publish, context) =>
            endpoint.invoke(call, publish, context),
          release: () =>
            serial(async () => {
              if (released) return;
              released = true;
              endpoint.dispose();
              attachments -= 1;
              if (attachments === 0) await retire();
            }),
        };
      }),
    close: () =>
      serial(async () => {
        closed = true;
        await retire();
      }),
  };
}

/** Entry point for createUnixServer; no routing identifiers enter business results. */
export function createPiSpawnServerHost(catalogue: SpawnCatalogue): ServerHost {
  const created = new Map<string, SpawnExecutor>();
  return {
    serverServices: {
      attachClient(presentation) {
        const provider = new RemoteServiceProvider([SpawnManagementService]);
        provider.provide(SpawnManagementService, {
          async list() {
            return checked(catalogueSchema, await catalogue.listSessions());
          },
          async create(input, context) {
            const request = checked(createSchema, input);
            context.abortSignal?.throwIfAborted();
            const id = randomUUID();
            const executor = await catalogue.createSession({ ...request, id });
            created.set(id, executor);
            try {
              await presentation.attachSession(id, context);
            } finally {
              // Failed resolution must not strand the newly allocated writer.
              if (created.delete(id)) await executor.dispose();
            }
            return id;
          },
          async attach(id, context) {
            await presentation.attachSession(checked(text, id), context);
          },
          async detach(context) {
            await presentation.detachSession(context);
          },
        });
        const endpoint = createRemoteServiceEndpoint(provider);
        return {
          invokeService: (call, publish, context) =>
            endpoint.invoke(call, publish, context),
          release() {
            endpoint.dispose();
            provider.dispose();
          },
        };
      },
    },
    async resolveSession(id) {
      const entry = (await catalogue.listSessions()).find(
        (entry) => entry.id === id,
      );
      if (!entry) throw new SessionNotFoundError(id);
      return { ...entry, storageVersion: 3 };
    },
    async openSession(metadata, context) {
      context.abortSignal?.throwIfAborted();
      return routedExecutor(async () => {
        // Acquisition alone does not establish presentation demand. Leave the
        // initial writer with create() until attachClient actually claims it.
        const initial = created.get(metadata.id);
        if (initial) {
          created.delete(metadata.id);
          return initial;
        }
        return catalogue.openSession(metadata.id);
      });
    },
  };
}

const presenting = new WeakSet<Client>();

/** One presentation, not a reconnect/replay policy. The caller owns its Client. */
export class SpawnPresentation {
  readonly #client: Client;
  readonly #managementBinding;
  readonly #executionBinding;
  readonly #management: SpawnManagement;
  readonly #execution: SpawnExecution;
  readonly #disconnect: () => void;
  #target: SessionTarget | undefined;
  #disposed = false;
  #state: SpawnObservation | undefined;
  #unsubscribe: (() => void) | undefined;
  #listeners = new Set<(state: SpawnObservation) => void>();
  private constructor(client: Client) {
    this.#client = client;
    this.#managementBinding = createRemoteServiceBinding({
      services: [SpawnManagementService],
      transport: createClientServiceTransport(client, () => ({
        serverId: client.serverId,
      })),
    });
    this.#executionBinding = createRemoteServiceBinding({
      services: [SpawnExecutionService],
      bound: false,
      transport: createClientServiceTransport(client, () => this.#target),
    });
    this.#management = this.#managementBinding.use(SpawnManagementService);
    this.#execution = this.#executionBinding.use(SpawnExecutionService);
    this.#disconnect = client.onConnectionStateChange(({ state }) => {
      if (state !== "connected") {
        void this.#executionBinding.rebind(false, BACKGROUND_CONTEXT);
        void this.#managementBinding.rebind(false, BACKGROUND_CONTEXT);
      }
    });
  }
  static async attach(
    client: Client,
    request: { id: string } | SpawnCreateRequest,
  ): Promise<SpawnPresentation> {
    if (presenting.has(client) || client.attachment)
      throw new Error(
        "pi-spawn requires a client with no existing presentation",
      );
    presenting.add(client);
    try {
      if (!client.connected) await client.connect();
    } catch (error) {
      presenting.delete(client);
      throw error;
    }
    const presentation = new SpawnPresentation(client);
    try {
      await presentation.#managementBinding.ready(BACKGROUND_CONTEXT);
      if ("id" in request)
        await presentation.#management.attach(request.id, BACKGROUND_CONTEXT);
      else
        checked(
          text,
          await presentation.#management.create(request, BACKGROUND_CONTEXT),
        );
      presentation.#target = client.attachment;
      if (!presentation.#target)
        throw new Error("pi-spawn attachment was not installed");
      await presentation.#executionBinding.rebind(true, BACKGROUND_CONTEXT);
      await presentation.#executionBinding.ready(BACKGROUND_CONTEXT);
      presentation.#state = observeSpawn(
        presentation.#execution.observation.value,
      );
      presentation.#unsubscribe = presentation.#execution.observation.subscribe(
        (state) => {
          presentation.#state = observeSpawn(state);
          for (const listener of presentation.#listeners)
            listener(presentation.#state);
        },
      );
      return presentation;
    } catch (error) {
      try {
        await presentation.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "pi-spawn attachment and cleanup failed",
        );
      }
      throw error;
    }
  }
  get state(): SpawnObservation {
    if (!this.#state) throw new Error("pi-spawn observation is not hydrated");
    return this.#state;
  }
  get id(): string {
    return this.state.id;
  }
  subscribe(listener: (state: SpawnObservation) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async submit(text: string): Promise<SpawnObservation> {
    return observeSpawn(await this.#execution.prompt(text, BACKGROUND_CONTEXT));
  }
  async abort(): Promise<void> {
    await this.#execution.abort(BACKGROUND_CONTEXT);
  }
  async setModel(model: SpawnModel): Promise<void> {
    await this.#execution.setModel(model, BACKGROUND_CONTEXT);
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#listeners.clear();
    this.#disconnect();
    try {
      if (
        this.#client.connected &&
        this.#client.attachment?.attachmentId === this.#target?.attachmentId
      ) {
        await this.#management.detach(BACKGROUND_CONTEXT);
      }
    } finally {
      try {
        try {
          await this.#executionBinding.dispose(BACKGROUND_CONTEXT);
        } finally {
          await this.#managementBinding.dispose(BACKGROUND_CONTEXT);
        }
      } finally {
        presenting.delete(this.#client);
      }
    }
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  describe("pi-spawn observation validation", () => {
    it("accepts actual openai-completions tool names delivered in a later chunk", async () => {
      const { stream } =
        await import("@earendil-works/pi-ai/api/openai-completions");
      const { fauxProvider, normalizeContext } =
        await import("@earendil-works/pi-ai");
      const model = {
        ...fauxProvider().getModel(),
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
      };
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, type: "function", function: { arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      const snapshots: SpawnObservation[] = [];
      const events = stream(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "read", timestamp: 1 }],
        }),
        {
          apiKey: "fixture",
          fetch: async () =>
            new Response(
              new ReadableStream({
                async start(controller) {
                  for (const chunk of chunks) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify(chunk)}\n\n`,
                      ),
                    );
                    await new Promise((resolve) => setTimeout(resolve, 5));
                  }
                  controller.enqueue(
                    new TextEncoder().encode("data: [DONE]\n\n"),
                  );
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        },
      );
      for await (const event of events) {
        if ("partial" in event)
          snapshots.push(
            observeSpawn(
              JSON.parse(
                JSON.stringify({
                  id: "session",
                  phase: "turn",
                  messages: [event.partial],
                }),
              ),
            ),
          );
      }
      expect(
        snapshots.some((state) =>
          state.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "toolCall" &&
                  part.id === "" &&
                  part.name === "",
              ),
          ),
        ),
      ).toBe(true);
      expect((await events.result()).content).toEqual([
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ]);
    });
    it("retains direct pi-ai content, usage, and tool details", () => {
      const assistant = fauxAssistantMessage("answer");
      const value = {
        id: "session",
        phase: "idle",
        messages: [
          assistant,
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            timestamp: 1,
            content: [{ type: "text", text: "file" }],
            isError: false,
            details: { nested: [true, null, { count: 2 }] },
          },
        ],
      };
      expect(observeSpawn(value)).toEqual(value);
    });
    it("rejects malformed hydration rather than trusting a typed proxy", () => {
      const assistant = fauxAssistantMessage("answer");
      for (const value of [
        {
          id: "session",
          phase: "idle",
          messages: [{ ...assistant, usage: null }],
        },
        {
          id: "session",
          phase: "idle",
          messages: [{ ...assistant, stopReason: "success" }],
        },
        {
          id: "session",
          phase: "idle",
          messages: [{ ...assistant, timestamp: Number.NaN }],
        },
        {
          id: "session",
          phase: "idle",
          messages: [
            {
              ...assistant,
              diagnostics: [
                { type: "error", timestamp: 1, error: { message: false } },
              ],
            },
          ],
        },
        {
          id: "session",
          phase: "idle",
          messages: [{ ...assistant, deferred: { id: 123 } }],
        },
        {
          id: "session",
          phase: "idle",
          messages: [{ role: "user", content: undefined, timestamp: 1 }],
        },
        { id: "session", phase: "done", messages: [] },
      ])
        expect(() => observeSpawn(value)).toThrow(
          "invalid pi-spawn service value",
        );
    });
  });
}
