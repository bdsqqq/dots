#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type * from "./runtime/contracts.js";
export * from "./runtime/config.js";
export * from "./runtime/application.js";
export * from "./runtime/pi-source.js";
export * from "./runtime/project-context.js";
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
  StoreContentionError,
  type FileMemoryStoreConfig,
  type FileMemoryStoreOptions,
} from "./runtime/store.js";
export { handleMemoryJSON, memoryCLI } from "./runtime/cli.js";
// package managers launch the bin through a symlink; compare its actual module.
let executableURL = "";
try {
  if (process.argv[1])
    executableURL = pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* stdin/embedded hosts may have no filesystem entrypoint. */
}
if (executableURL === import.meta.url) {
  process.umask(0o077);
  const { memoryCLI } = await import("./runtime/cli.js");
  await memoryCLI().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
