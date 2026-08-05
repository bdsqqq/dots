import type { PluginAPI, ThreadMessage } from "@ampcode/plugin";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  adaptAmpTurn,
  publishAmpMemorySession,
} from "../lib/pi-memory-adapter.ts";

export const description =
  "Feeds settled local Amp turns into the Pi-owned memory pipeline.";

const SETTLE_DELAY_MS = 1_000;
const LAUNCH_AGENT = "org.nix-community.home.pi-memory";
const memoryDataRoot = (): string =>
  resolve(
    (
      process.env.PI_MEMORY_DATA_DIR ||
      join(homedir(), ".local/share/pi-memory")
    ).replace(/^~(?=$|\/)/, homedir()),
  );

export default function piMemoryPlugin(amp: PluginAPI): void {
  if (amp.system.executor.kind !== "local") return;

  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleMaintenance = (): void => {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(async () => {
      wakeTimer = undefined;
      try {
        const result =
          await amp.$`/bin/launchctl start ${LAUNCH_AGENT}`;
        if (result.exitCode !== 0)
          amp.logger.log(
            `pi-memory wake failed (${result.exitCode}): ${result.stderr}`,
          );
      } catch (error) {
        amp.logger.log(
          `pi-memory wake failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, SETTLE_DELAY_MS);
  };

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
      scheduleMaintenance();
    } catch (error) {
      amp.logger.log(
        `Amp memory adapter failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  amp.onDispose(() => {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
  });
}
