import type { PluginAPI, ThreadMessage } from "@ampcode/plugin";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  adaptAmpTurn,
  publishAmpMemorySession,
  publishMaintenanceWake,
} from "../lib/pi-memory-adapter.ts";

export const description =
  "Feeds settled local Amp turns into the Pi-owned memory pipeline.";

const memoryDataRoot = (): string =>
  resolve(
    (
      process.env.PI_MEMORY_DATA_DIR ||
      join(homedir(), ".local/share/pi-memory")
    ).replace(/^~(?=$|\/)/, homedir()),
  );

export default function piMemoryPlugin(amp: PluginAPI): void {
  if (amp.system.executor.kind !== "local") return;

  amp.on("agent.end", (event) => {
    try {
      const workspaceRoot = amp.system.workspaceRoot;
      if (workspaceRoot === null) return;
      const workspace = amp.helpers.filePathFromURI(workspaceRoot);
      const session = adaptAmpTurn({
        threadId: event.thread.id,
        messageId: event.id,
        workspace,
        status: event.status,
        messages: event.messages as ThreadMessage[],
      });
      if (!session) return;
      publishAmpMemorySession(
        join(memoryDataRoot(), "amp-sessions"),
        session,
      );
      publishMaintenanceWake(
        join(homedir(), ".local/state/pi-memory"),
        session.id,
      );
    } catch (error) {
      amp.logger.log(
        `Amp memory adapter failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
