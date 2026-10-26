import type { IncidentStore, Transition } from "./state.ts";
import { notification } from "./axiom.ts";

type Transport = {
  accepted(event: Transition, now: number): Promise<boolean>;
  ingest(event: Record<string, unknown>): Promise<void>;
};

/**
 * Axiom ingestion has no documented idempotency key. An ambiguous attempt is
 * reconciled, never blindly retried: duplicate ingestion means duplicate email.
 * The heartbeat watchdog exposes unresolved attempts after fifteen minutes.
 */
export async function deliver(store: IncidentStore, transport: Transport, now: number, clock: () => number = () => now): Promise<{ sent: number; uncertain: number; errors: number }> {
  let errors = 0;
  let sent = 0;
  for (const event of store.uncertain().slice(0, 3)) {
    store.noteReconcile(event.eventId, clock());
    try {
      if (await transport.accepted(event, clock())) store.acknowledge(event.eventId);
    } catch { errors++; }
  }
  const blocked = new Set(store.uncertain().map(event => event.incidentId));
  const pending = store.pending();
  const unopened = new Set(pending.filter(event => event.action === "Open").map(event => event.incidentId));
  const ordered = pending.toSorted((a, b) => Number(b.kind.includes("critical disk")) - Number(a.kind.includes("critical disk")));
  for (const event of ordered) {
    const attemptedAt = clock();
    if (store.deliveryBudget(attemptedAt) === 0) break;
    if (blocked.has(event.incidentId) || (event.action === "Closed" && unopened.has(event.incidentId))) continue;
    store.noteAttempt(event.eventId, attemptedAt);
    try {
      await transport.ingest(notification(event));
      store.acknowledge(event.eventId);
      unopened.delete(event.incidentId);
      sent++;
    } catch {
      blocked.add(event.incidentId);
      errors++;
    }
  }
  return { sent, uncertain: store.uncertain().length, errors };
}
