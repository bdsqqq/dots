import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Axiom } from "./axiom.ts";
import { IncidentStore } from "./state.ts";
import { main } from "./main.ts";
import { createEventLogger, type ServiceEvent } from "../../service-events/events.ts";

test("evaluation completion carries outcome, timing and counts without credentials or raw errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incident-events-"));
  const previous = process.exitCode;
  try {
    const rulesPath = join(directory, "rules.json");
    await writeFile(rulesPath, "[]");
    const database = join(directory, "incidents.sqlite");
    new IncidentStore(database).close();
    const config = { mounts: {}, rulesPath, database };
    const records: ServiceEvent[] = [];
    const events = createEventLogger("host-incidents", { sink: event => records.push(event) });
    const client = new Axiom({ query: "secret-query", ingest: "secret-ingest", org: "secret-org" }, async url => {
      return new Response(JSON.stringify(String(url).includes("/ingest") ? { ingested: 1, failed: 0 } : { series: [] }));
    });
    await main("poll", config, client, events);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "incidents.evaluate");
    assert.equal(records[0].outcome, "succeeded");
    assert.equal(records[0].context.observationCount, 0);
    assert.equal(records[0].context.queryErrorCount, 0);
    assert.equal(records[0].context.transitionCount, 0);
    assert.equal(records[0].context.ready, true);
    assert.ok(!JSON.stringify(records).includes("secret"));

    const offline = new Axiom({ query: "secret-query", ingest: "secret-ingest", org: "secret-org" }, async () => {
      throw new Error("private transport detail and secret-query");
    });
    await assert.rejects(main("poll", config, offline, events));
    assert.equal(records.length, 2);
    assert.equal(records[1].outcome, "failed");
    assert.equal(records[1].context.queryErrorCount, 1);
    assert.equal(records[1].context.errorCode, "UNEXPECTED_ERROR");
    assert.ok(!JSON.stringify(records).includes("private transport"));
    assert.ok(!JSON.stringify(records).includes(directory));
    assert.ok(!JSON.stringify(records).includes("secret"));
  } finally {
    process.exitCode = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
