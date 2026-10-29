import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Axiom, credentials, observations, type Configuration } from "./axiom.ts";
import { deliver } from "./delivery.ts";
import { IncidentStore } from "./state.ts";

type RuntimeConfiguration = Configuration & { database: string };

export async function main(command: string, config: RuntimeConfiguration): Promise<void> {
  const client = new Axiom(credentials());
  const now = Date.now();
  const snapshot = await observations(client, config, now);
  if (command === "probe") {
    console.log(JSON.stringify({ observedAt: new Date(now).toISOString(), ...snapshot }));
    if (snapshot.errors.length) process.exitCode = 1;
    return;
  }
  if (command !== "poll" && command !== "init") throw new Error("expected probe, init, or poll");
  if (command === "init" && existsSync(config.database)) throw new Error("incident database already exists; refusing to replace state");
  if (command === "poll" && !existsSync(config.database)) throw new Error("incident database missing; explicit initialization required");
  if (command === "init" && snapshot.errors.length) throw new Error("cannot initialize from incomplete evidence");
  const store = new IncidentStore(config.database, { sourceMaxAgeMs: 15 * 60_000 });
  try {
    if (command === "init") {
      // Explicit handoff, not normal startup. The caller must review/report
      // these already-open incidents before detaching the old notification routes.
      const adopted = snapshot.observations.filter(observation => observation.status === "bad");
      for (const observation of adopted) store.seedOpen(observation);
      console.log(JSON.stringify({ operation: "host-incidents.initialize", observedAt: new Date(now).toISOString(), adopted }));
      return;
    }
    const transitions = snapshot.observations.flatMap(observation => {
      const event = store.observe(observation);
      return event ? [event] : [];
    });
    // Query latency must not backdate attempts and replenish the delivery
    // budget while a notification is only now being submitted.
    const delivery = await deliver(store, client, Date.now(), Date.now);
    const healthy = snapshot.errors.length === 0 && delivery.errors === 0 && !store.overdue(Date.now());
    await client.ingest({ source: "host-incidents-heartbeat", healthy, evaluatedAt: new Date(now).toISOString(), observations: snapshot.observations.length, uncertain: delivery.uncertain });
    console.log(JSON.stringify({ operation: "host-incidents.evaluate", observedAt: new Date(now).toISOString(), outcome: healthy ? "healthy" : "degraded", observationCount: snapshot.observations.length, queryErrors: snapshot.errors, transitions, delivery }));
    if (!healthy) process.exitCode = 1;
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.env.HOST_INCIDENT_CONFIG ?? process.argv[3];
  try {
    if (!configPath) throw new Error("HOST_INCIDENT_CONFIG is required");
    await main(process.argv[2] ?? "poll", JSON.parse(readFileSync(configPath, "utf8")) as RuntimeConfiguration);
  } catch (error) {
    console.error(JSON.stringify({ operation: "host-incidents.evaluate", outcome: "failed", error: error instanceof Error ? error.message : "unknown failure" }));
    process.exitCode = 1;
  }
}
