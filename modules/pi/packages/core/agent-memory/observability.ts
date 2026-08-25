import { AsyncLocalStorage } from "node:async_hooks";
import {
  createWideEvent,
  type PiWideEvent,
  type WideEventOutcome,
} from "@bds_pi/log";

type Fields = Record<string, unknown>;
type NonFailureOutcome = Exclude<WideEventOutcome, "failure">;

type WideEventFactory = (options: {
  service: string;
  operation: string;
  operationId?: string;
  correlation?: unknown;
  fields?: Fields;
}) => Pick<PiWideEvent, "error" | "finish" | "id" | "set">;

export type MemoryOperationResult = {
  outcome?: NonFailureOutcome;
  fields?: Fields;
};

export type MemoryOperationSpec<T> = {
  operation: `memory.${string}`;
  operationId?: string;
  correlation?: unknown;
  fields?: Fields;
  result?: (value: T) => MemoryOperationResult;
};

const factoryScope = new AsyncLocalStorage<WideEventFactory>();
let defaultFactory: WideEventFactory = createWideEvent;

function reportLoggingFailure(action: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`[pi-memory/log] ${action}: ${name}`);
}

function errorFields(error: unknown): Fields {
  const fields: Fields = {
    errorType: error instanceof Error ? error.name : typeof error,
  };
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    fields.errorCode = error.code.slice(0, 80);
  return fields;
}

export function attachMemoryOperationError(
  event: Pick<PiWideEvent, "error">,
  error: unknown,
): void {
  callSafely("cannot attach operation error", () =>
    event.error(new Error("memory operation failed"), errorFields(error)),
  );
}

function callSafely(action: string, call: () => void): void {
  try {
    call();
  } catch (error) {
    reportLoggingFailure(action, error);
  }
}

/**
 * Observability is intentionally subordinate to memory mutation: logger
 * initialization, enrichment, and persistence failures never alter the domain
 * result. Fields must remain bounded metadata; persisted bodies belong in the
 * hash-bound memory store, not in logs.
 */
export function observeMemoryOperation<T>(
  spec: MemoryOperationSpec<T>,
  operation: () => Promise<T>,
): Promise<T>;
export function observeMemoryOperation<T>(
  spec: MemoryOperationSpec<T>,
  operation: () => T,
): T;
export function observeMemoryOperation<T>(
  spec: MemoryOperationSpec<T>,
  operation: () => T | Promise<T>,
): T | Promise<T> {
  let event: ReturnType<WideEventFactory> | undefined;
  try {
    event = (factoryScope.getStore() ?? defaultFactory)({
      service: "pi-memory",
      operation: spec.operation,
      operationId: spec.operationId,
      correlation: spec.correlation,
      fields: spec.fields,
    });
  } catch (error) {
    reportLoggingFailure("cannot create operation event", error);
  }

  let value: T | Promise<T>;
  try {
    value = operation();
  } catch (error) {
    if (event) {
      attachMemoryOperationError(event, error);
      callSafely("cannot finish failed operation", () =>
        event.finish("failure", errorFields(error)),
      );
    }
    throw error;
  }

  if (
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    return value.then(
      (resolved) => {
        finishSuccess(event, spec, resolved);
        return resolved;
      },
      (error: unknown) => {
        if (event) {
          attachMemoryOperationError(event, error);
          callSafely("cannot finish failed operation", () =>
            event.finish("failure", errorFields(error)),
          );
        }
        throw error;
      },
    );
  }

  finishSuccess(event, spec, value as T);
  return value;
}

function finishSuccess<T>(
  event: ReturnType<WideEventFactory> | undefined,
  spec: MemoryOperationSpec<T>,
  value: T,
): void {
  if (!event) return;
  let terminal: MemoryOperationResult = {};
  if (spec.result)
    try {
      terminal = spec.result(value);
    } catch (error) {
      reportLoggingFailure("cannot derive operation fields", error);
    }
  callSafely("cannot finish operation", () =>
    event.finish(terminal.outcome ?? "success", terminal.fields),
  );
}

/** Isolates logger fault injection and event capture across concurrent tests. */
export function withMemoryWideEventFactory<T>(
  factory: WideEventFactory,
  operation: () => T,
): T {
  return factoryScope.run(factory, operation);
}

/** Prevents mutation unit tests from writing production log files. */
export function setMemoryWideEventFactoryForTests(
  factory: WideEventFactory,
): void {
  if (!process.env.VITEST)
    throw new Error("test wide-event factory requires vitest");
  defaultFactory = factory;
}
