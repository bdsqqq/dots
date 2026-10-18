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

/** hard termination bounds synchronous store work as well as asynchronous retrieval. */
export class SessionMemoryWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: SessionWorkerResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
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
    timeoutMs: number = this.options.timeoutMs ??
      (request.kind === "capture" ? 30_000 : 5000),
  ): Promise<SessionWorkerResult> {
    if (this.closed) return Promise.reject(new Error("memory worker closed"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("memory worker queue full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`memory worker ${request.kind} deadline`));
        if (request.kind !== "check") this.close();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, request });
    });
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
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
    const store = (openedStore ??= new FileMemoryStore(data.store));
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
      // transport ACK is not eligibility: persisted context must still recheck
      // heads/suppression, using a check-only id that has no dispatch receipt.
      case "check":
        return Promise.all(
          request.deliveries.map(async (delivery) => {
            const original = await store.readDelivery(delivery.deliveryId);
            if (!original || !sameValue(original, delivery))
              return { kind: "discard", reason: "obsolete" } as const;
            return store.checkDelivery(
              {
                ...original,
                deliveryId: `${original.deliveryId}:context` as C.DeliveryId,
              },
              now(),
            );
          }),
        );
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
        for (let page = 0; page < 64; page++) {
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
          if (!result.bounded) return "captured";
        }
        throw new Error(
          "capture page budget exceeded; independent catch-up required",
        );
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
