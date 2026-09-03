import assert from "node:assert/strict";
import test from "node:test";

import { applyIngestBatch } from "./ingest.ts";
import { emptyLedgerSnapshot } from "./state.ts";
import {
  syntheticBatch,
  syntheticCandidate,
  syntheticIdentity,
} from "./test-fixtures.ts";

const policy = {
  isEligibleAccountPair: (outgoing: string, incoming: string) =>
    outgoing === "reserve" && incoming === "operating",
};

function transferCandidate(
  id: string,
  accountAlias: string,
  direction: "incoming" | "outgoing",
  bookedOn: string,
) {
  return syntheticCandidate({
    accountAlias,
    direction,
    bookedOn,
    occurredOn: bookedOn,
    providerTransactionId: id,
    evidence: {
      ...syntheticCandidate().evidence,
      id: `evidence-${id}`,
      contentDigest: `content-${id}`,
    },
    classification: {
      ...syntheticCandidate().classification,
      value: "internal-transfer",
      confidence: "confirmed",
      evidenceIds: [`evidence-${id}`],
    },
  });
}

test("links one globally degree-one transfer at the inclusive three-day boundary", () => {
  const result = applyIngestBatch(
    emptyLedgerSnapshot(),
    syntheticBatch([
      transferCandidate("out", "reserve", "outgoing", "2026-01-01"),
      transferCandidate("in", "operating", "incoming", "2026-01-04"),
    ]),
    { identity: syntheticIdentity, transferPolicy: policy },
  );
  assert.equal(result.snapshot.transferLinks.length, 1);
});

test("leaves ambiguous and out-of-window transfer graphs unlinked", () => {
  const result = applyIngestBatch(
    emptyLedgerSnapshot(),
    syntheticBatch([
      transferCandidate("out-a", "reserve", "outgoing", "2026-01-01"),
      transferCandidate("out-b", "reserve", "outgoing", "2026-01-01"),
      transferCandidate("in-a", "operating", "incoming", "2026-01-02"),
      transferCandidate("in-late", "operating", "incoming", "2026-01-05"),
    ]),
    { identity: syntheticIdentity, transferPolicy: policy },
  );
  assert.deepEqual(result.snapshot.transferLinks, []);
});
