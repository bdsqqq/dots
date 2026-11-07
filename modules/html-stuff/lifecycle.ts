import { createHash } from "node:crypto";

export const READINESS_PATH = "/_html-stuff/ready";

/** Compatibility is about the served configuration, NOT process ownership or Serve-route adoption. */
export function configurationFingerprint(root: string, stateFile?: string, stateOrigin?: string): string {
  return createHash("sha256").update(JSON.stringify([root, stateFile ?? null, stateOrigin ?? null])).digest("hex");
}

export type ExistingBackend = "ready" | "degraded" | "unknown" | "absent";
export interface BackendObservation {
  state: "managed" | "adopted" | "adopted_degraded" | "port_conflict" | "recovery_exhausted";
  attempt: number;
  retryInMs: number;
}

export async function inspectBackend(
  origin: string,
  configuration: string,
  request: typeof fetch = fetch,
): Promise<ExistingBackend> {
  try {
    const response = await request(new URL(READINESS_PATH, origin), {
      redirect: "manual", signal: AbortSignal.timeout(2_000),
      headers: { "user-agent": "service-probe/1" },
    });
    // Small protocol response only; don't buffer an unknown listener's arbitrary body.
    const reader = response.body?.getReader();
    if (!reader) return "unknown";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) return "unknown";
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body?.service !== "html-stuff" || body.protocol !== 1 || body.configuration !== configuration
      || typeof body.ready !== "boolean") return "unknown";
    if (response.status === 200 && body.ready) return "ready";
    if (response.status === 503 && !body.ready) return "degraded";
    return "unknown";
  } catch {
    return "absent";
  }
}

/**
 * Wait for a compatible backend rather than restart-spamming launchd. No PID lookup or
 * signal is needed: a listener is never ours merely because it occupies our desired port.
 * Five bind attempts per launcher lifetime bound recovery, including adopted-backend loss.
 * Exhaustion parks the launcher until an operator resolves the conflict and restarts it.
 */
export async function acquireBackend<T>(dependencies: {
  start: () => T;
  inspect: () => Promise<ExistingBackend>;
  sleep: (milliseconds: number) => Promise<void>;
  observe: (observation: BackendObservation) => void;
}): Promise<T | null> {
  const { start, inspect, sleep, observe } = dependencies;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const server = start();
      observe({ state: "managed", attempt, retryInMs: 0 });
      return server;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EADDRINUSE") throw error;
    }
    let existing = await inspect();
    let lastState: ExistingBackend | undefined;
    while (existing === "ready" || existing === "degraded") {
      if (lastState !== existing) {
        observe({ state: existing === "ready" ? "adopted" : "adopted_degraded", attempt, retryInMs: 30_000 });
        lastState = existing;
      }
      await sleep(30_000);
      existing = await inspect();
    }
    const retryInMs = attempt < 5 ? 1000 * 2 ** (attempt - 1) : 0;
    observe({ state: "port_conflict", attempt, retryInMs });
    if (retryInMs) await sleep(retryInMs);
  }
  observe({ state: "recovery_exhausted", attempt: 5, retryInMs: 0 });
  return null;
}
