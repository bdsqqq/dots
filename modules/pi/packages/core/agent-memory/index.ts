#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export type * from "./runtime/contracts.js";
export * from "./runtime/config.js";
export * from "./runtime/application.js";
export * from "./runtime/pi-source.js";
export * from "./runtime/catch-up.js";
export * from "./runtime/legacy-import.js";
export * from "./runtime/peer-auth.js";
export * from "./runtime/replica.js";
export * from "./runtime/replica-transport.js";
export * from "./runtime/session-worker.js";
export { capture } from "./runtime/capture.js";
export { runReconciliation, reconcile } from "./runtime/reconcile.js";
export { nativeConsolidationModel } from "./runtime/model.js";
export {
  sharedRecallHandler,
  sharedDispatchHandler,
} from "./runtime/recall.js";
export { LinkedSearchIndex } from "./runtime/index.js";
export {
  FileMemoryStore,
  type FileMemoryStoreConfig,
} from "./runtime/store.js";
export { handleMemoryJSON, memoryCLI } from "./runtime/cli.js";
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.umask(0o077);
  const { memoryCLI } = await import("./runtime/cli.js");
  await memoryCLI().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
