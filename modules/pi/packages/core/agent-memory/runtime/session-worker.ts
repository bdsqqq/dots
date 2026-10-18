import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { LoadedSession } from "../../sessions/contracts.js";
import type * as C from "./contracts.js";
import { FileMemoryStore, type FileMemoryStoreConfig } from "./store.js";
import { LinkedSearchIndex } from "./index.js";
import { sharedRecallHandler } from "./recall.js";
import { catchUpNativeSources } from "./catch-up.js";
import {
  observeNativeProject,
  type NativeProjectContext,
} from "./project-context.js";
import { canonicalJSON, sha256, sameValue } from "./identity.js";
import type { MemoryConfiguration } from "./config.js";

export interface SessionWorkerOptions {
  readonly store: FileMemoryStoreConfig;
  /** built entry required by the host; source fixtures can supply their own bundled entry. */
  readonly entry?: URL;
  readonly timeoutMs?: number;
  /** replace only the retrieval boundary, in the worker's own module graph. */
  readonly indexModule?: string;
  readonly indexOptions?: unknown;
}
export function runtimeStoreConfiguration(
  config: MemoryConfiguration,
): FileMemoryStoreConfig {
  return {
    root: join(config.root, "runtime"),
    data: join(config.data, "runtime"),
    state: join(config.state, "runtime"),
    owner: config.ownerId,
    replicaId: hostname() as C.ReplicaId,
  };
}
export type SessionWorkerRequest =
  | { kind: "project-context"; cwd: string }
  | { kind: "recall"; intent: C.RecallIntent }
  | { kind: "recover"; target: C.RecallTarget; intent: C.RecallIntent }
  | { kind: "check"; deliveries: readonly C.RecallDelivery[] }
  | { kind: "ack"; deliveries: readonly C.RecallDelivery[] }
  | {
      kind: "capture";
      snapshot: LoadedSession;
      through: C.EntryId;
      scope: C.MemoryScope;
      project?: NativeProjectContext | null;
    };
export type SessionWorkerResult =
  | C.RecallOutcome
  | C.RecallDelivery
  | null
  | readonly C.DeliveryEligibility[]
  | "captured"
  | { kind: "project-context"; project: NativeProjectContext | null };

/** distribution-root resolution survives the bundler moving this class into a shared chunk. */
export function sessionWorkerEntry(moduleURL: string = import.meta.url): URL {
  const url = new URL(moduleURL);
  const distribution = url.pathname.lastIndexOf("/dist/");
  const source = url.pathname.lastIndexOf("/packages/");
  if (distribution >= 0)
    url.pathname = `${url.pathname.slice(0, distribution)}/dist/core/agent-memory-session-worker.js`;
  else if (source >= 0)
    url.pathname = `${url.pathname.slice(0, source)}/dist/core/agent-memory-session-worker.js`;
  else
    throw new Error(
      "supply the built memory worker entry outside a pi distribution",
    );
  return url;
}

/** foreground deadlines and explicit close can terminate synchronous worker I/O. */
export class SessionMemoryWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: SessionWorkerResult) => void;
      reject: (error: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      capture: boolean;
    }
  >();
  private sequence = 0;
  private closed = false;
  constructor(private readonly options: SessionWorkerOptions) {
    this.worker = new Worker(options.entry ?? sessionWorkerEntry(), {
      workerData: {
        memoryWorker: true,
        store: options.store,
        indexModule: options.indexModule,
        indexOptions: options.indexOptions,
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    this.worker.on(
      "message",
      (reply: { id: number; value?: SessionWorkerResult; error?: string }) => {
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(reply.id);
        this.updateReference();
        if (reply.error) pending.reject(new Error(reply.error));
        else pending.resolve(reply.value ?? null);
      },
    );
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", () => this.fail(new Error("memory worker closed")));
    this.worker.unref();
  }
  request(
    request: SessionWorkerRequest,
    timeoutMs: number | undefined = this.options.timeoutMs ??
      (request.kind === "check" ? 250 : undefined),
  ): Promise<SessionWorkerResult> {
    if (this.closed) return Promise.reject(new Error("memory worker closed"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("memory worker queue full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              this.updateReference();
              reject(new Error(`memory worker ${request.kind} deadline`));
              if (request.kind !== "check") this.close();
            }, timeoutMs);
      timer?.unref();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        capture: request.kind === "capture",
      });
      this.updateReference();
      this.worker.postMessage({ id, request });
    });
  }
  private updateReference(): void {
    // A pending promise cannot keep Node alive after CLI stdin closes. Finalized
    // ephemeral snapshots have no disk catch-up, so their capture owns liveness.
    if ([...this.pending.values()].some((p) => p.capture)) this.worker.ref();
    else this.worker.unref();
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.updateReference();
  }
  close(): void {
    if (this.closed) return;
    this.fail(new Error("memory worker closed"));
    void this.worker.terminate();
  }
}

export async function runSessionMemoryWorker(): Promise<void> {
  const data = workerData as {
    store: FileMemoryStoreConfig;
    indexModule?: string;
    indexOptions?: unknown;
  };
  let openedStore: FileMemoryStore | undefined;
  let openingStore: Promise<FileMemoryStore> | undefined;
  const index: C.SearchIndex = data.indexModule
    ? await (
        await import(data.indexModule)
      ).createSearchIndex(data.indexOptions)
    : new LinkedSearchIndex();
  const signal = new AbortController().signal;
  const now = (): string => new Date().toISOString();
  const execute = async (
    request: SessionWorkerRequest,
  ): Promise<SessionWorkerResult> => {
    if (request.kind === "project-context")
      return {
        kind: "project-context",
        project: observeNativeProject(request.cwd),
      };
    // A cold eligibility request owns the same short budget during opening as
    // during authentication. Never cache its expiring signal on the worker store.
    if (request.kind === "check") {
      const checkOptions = {
        signal: AbortSignal.any([signal, AbortSignal.timeout(150)]),
        contentionTimeoutMs: 150,
      };
      const ephemeral = !openedStore;
      const store =
        openedStore ?? (await FileMemoryStore.open(data.store, checkOptions));
      try {
        return await Promise.all(
          request.deliveries.map(async (delivery) => {
            const original = await store.readDelivery(
              delivery.deliveryId,
              checkOptions,
            );
            if (!original || !sameValue(original, delivery))
              return { kind: "discard", reason: "obsolete" } as const;
            // Transport ACK is not eligibility: accepted payloads must still
            // recheck current heads/suppression without minting a dispatch receipt.
            return store.checkDelivery(
              {
                ...original,
                deliveryId: `${original.deliveryId}:context` as C.DeliveryId,
              },
              now(),
              checkOptions,
            );
          }),
        );
      } finally {
        if (ephemeral) store.close();
      }
    }
    const store =
      openedStore ??
      (await (openingStore ??= FileMemoryStore.open(data.store, { signal })
        .then((store) => {
          openedStore = store;
          return store;
        })
        .finally(() => {
          openingStore = undefined;
        })));
    switch (request.kind) {
      case "recall":
        return sharedRecallHandler(request.intent, {
          store,
          index,
          signal,
          now,
        });
      case "recover": {
        for (let n = 0; n < 32; n++) {
          const delivery = await store.nextDelivery(request.target);
          if (!delivery) return null;
          const eligibility: C.DeliveryEligibility =
            delivery.intent.intentId !== request.intent.intentId ||
            delivery.intent.entryId !== request.intent.entryId ||
            delivery.intent.query !== request.intent.query ||
            !sameValue(delivery.intent.target, request.intent.target)
              ? { kind: "discard", reason: "obsolete" }
              : await store.checkDelivery(delivery, now());
          // returning to the parent is a peek, not native persistence.
          if (eligibility.kind === "eligible") return delivery;
          await store.recordDispatch(delivery.deliveryId, {
            kind: "discarded",
            deliveryId: delivery.deliveryId,
            reason: eligibility.reason,
          });
        }
        return null;
      }
      case "ack":
        for (const d of request.deliveries) {
          const original = await store.readDelivery(d.deliveryId);
          if (!original || !sameValue(original, d))
            throw new Error("untrusted memory receipt");
          await store.recordDispatch(d.deliveryId, {
            kind: "queued",
            deliveryId: d.deliveryId,
          });
        }
        return null;
      case "capture": {
        const project = observeNativeProject(
          request.snapshot.header.cwd,
          request.project,
        );
        const directory = join(data.store.state, "capture-progress");
        mkdirSync(directory, { recursive: true });
        const checkpoint = join(
          directory,
          `${sha256(
            canonicalJSON({
              source: request.snapshot.header.id,
              scope: request.scope,
              project,
            }),
          )}.json`,
        );
        for (;;) {
          signal.throwIfAborted();
          const result = await catchUpNativeSources({
            store,
            root: "",
            checkpoint,
            scope: request.scope,
            signal,
            snapshots: [request.snapshot],
            throughEntryId: request.through,
            project,
          });
          if (result.errors.length)
            throw new Error(
              `capture failed: ${result.errors.map((error) => error.reason).join("; ")}`,
            );
          if (!result.bounded) return "captured";
          if (!result.windows) throw new Error("capture made no progress");
        }
      }
    }
  };
  let captureTail: Promise<unknown> = Promise.resolve();
  parentPort!.on(
    "message",
    ({ id, request }: { id: number; request: SessionWorkerRequest }) => {
      // Native turn completions may overlap; one source checkpoint has one writer.
      const task =
        request.kind === "capture"
          ? (captureTail = captureTail
              .catch(() => undefined)
              .then(() => execute(request)))
          : execute(request);
      void task.then(
        (value) => parentPort!.postMessage({ id, value }),
        (error) => parentPort!.postMessage({ id, error: String(error) }),
      );
    },
  );
  parentPort!.on("close", () => openedStore?.close());
}
if (!isMainThread && workerData?.memoryWorker) await runSessionMemoryWorker();
