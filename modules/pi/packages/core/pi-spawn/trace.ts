import { channel } from "node:diagnostics_channel";
import type { PiSpawnResult } from "./index";

export interface SpawnObservation {
  parentSessionId?: string;
  toolCallId?: string;
  childSessionId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: "ok" | "error" | "cancelled";
}

/** A process-local completion signal survives separately bundled tool extensions.
 * Only the spawn owner's identities cross this boundary, never child transcripts.
 */
export function observeSpawn(
  result: PiSpawnResult,
  startedAt: string,
  start: number,
): void {
  const sink = channel("bds.pi.spawn.completed.v1");
  if (!sink.hasSubscribers) return;
  const observation: SpawnObservation = {
    parentSessionId: result.lifecycle?.owner?.sessionId,
    toolCallId: result.lifecycle?.owner?.toolCallId,
    childSessionId: result.session?.sessionId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - start),
    outcome:
      result.lifecycle?.status === "cancelled" ||
      result.lifecycle?.status === "timed_out" ||
      result.stopReason === "aborted"
        ? "cancelled"
        : result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.lifecycle?.status === "failed"
          ? "error"
          : "ok",
  };
  sink.publish(observation);
}
