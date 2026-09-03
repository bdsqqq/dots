import assert from "node:assert/strict";
import test from "node:test";

import {
  IngestConflictFailure,
  LedgerBusyFailure,
  ingestLedger,
} from "./ingest.ts";
import {
  MemoryLedgerStore,
  syntheticBatch,
  syntheticCandidate,
  syntheticIdentity,
} from "./test-fixtures.ts";

const transferPolicy = { isEligibleAccountPair: () => false };

function observation(
  evidenceId: string,
  grade: "primary" | "secondary",
  overrides: Parameters<typeof syntheticCandidate>[0] = {},
) {
  const original = syntheticCandidate();
  return syntheticCandidate({
    ...overrides,
    evidence: {
      ...original.evidence,
      id: evidenceId,
      contentDigest: `content-${evidenceId}`,
      grade,
    },
    classification: overrides.classification ?? {
      ...original.classification,
      evidenceIds: [evidenceId],
    },
  });
}

test("incremental ingestion is idempotent and canonical ordering ignores arrival order", async () => {
  const first = observation("evidence-b", "primary", {
    providerTransactionId: "transaction-b",
  });
  const second = observation("evidence-a", "primary", {
    providerTransactionId: "transaction-a",
  });
  const left = new MemoryLedgerStore();
  const right = new MemoryLedgerStore();
  const dependencies = { identity: syntheticIdentity, transferPolicy };

  await ingestLedger(syntheticBatch([first, second]), { ...dependencies, store: left });
  await ingestLedger(syntheticBatch([second, first]), { ...dependencies, store: right });
  assert.deepEqual(left.snapshot, right.snapshot);
  const revision = left.revision;
  const replay = await ingestLedger(syntheticBatch([first, second]), {
    ...dependencies,
    store: left,
  });
  assert.equal(replay.duplicateCount, 2);
  assert.equal(left.revision, revision);
  assert.equal(left.writes, 1);
});

test("primary observations supersede listed secondary fields without erasing provenance", async () => {
  const store = new MemoryLedgerStore();
  const secondary = observation("secondary", "secondary", {
    bookedOn: "2026-01-11",
    occurredOn: null,
    normalizedCounterparty: "Secondary Name",
    normalizedReference: "secondary reference",
    status: "pending",
  });
  const primary = observation("primary", "primary", {
    bookedOn: "2026-01-10",
    occurredOn: "2026-01-09",
    normalizedCounterparty: "Canonical Name LLC",
    normalizedReference: null,
    status: "completed",
  });
  await ingestLedger(syntheticBatch([secondary]), {
    identity: syntheticIdentity,
    store,
    transferPolicy,
  });
  await ingestLedger(syntheticBatch([primary]), {
    identity: syntheticIdentity,
    store,
    transferPolicy,
  });
  assert.deepEqual(store.snapshot.transactions[0], {
    ...store.snapshot.transactions[0],
    bookedOn: "2026-01-10",
    occurredOn: "2026-01-09",
    normalizedCounterparty: "Canonical Name LLC",
    normalizedReference: "secondary reference",
    status: "completed",
  });
  assert.deepEqual(store.snapshot.transactions[0].evidenceIds, ["primary", "secondary"]);
});

test("equal-grade contradictions abort the entire batch", async () => {
  const store = new MemoryLedgerStore();
  await ingestLedger(syntheticBatch([observation("existing", "primary")]), {
    identity: syntheticIdentity,
    store,
    transferPolicy,
  });
  const before = structuredClone(store.snapshot);
  const writes = store.writes;
  await assert.rejects(
    () =>
      ingestLedger(
        syntheticBatch([
          observation("new-compatible", "primary", {
            providerTransactionId: "another-transaction",
          }),
          observation("contradiction", "primary", { bookedOn: "2026-01-12" }),
        ]),
        { identity: syntheticIdentity, store, transferPolicy },
      ),
    IngestConflictFailure,
  );
  assert.deepEqual(store.snapshot, before);
  assert.equal(store.writes, writes);
});

test("CAS retries are bounded and exhaustion is a retry-safe busy outcome", async () => {
  const recovering = new MemoryLedgerStore();
  recovering.conflictsRemaining = 2;
  const result = await ingestLedger(syntheticBatch([syntheticCandidate()]), {
    identity: syntheticIdentity,
    store: recovering,
    transferPolicy,
    maxCasAttempts: 3,
  });
  assert.equal(result.insertedCount, 1);

  const busy = new MemoryLedgerStore();
  busy.conflictsRemaining = 3;
  await assert.rejects(
    () =>
      ingestLedger(syntheticBatch([syntheticCandidate()]), {
        identity: syntheticIdentity,
        store: busy,
        transferPolicy,
        maxCasAttempts: 3,
      }),
    LedgerBusyFailure,
  );
  assert.equal(busy.writes, 0);
});
