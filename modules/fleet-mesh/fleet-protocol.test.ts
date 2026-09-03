import assert from "node:assert/strict";
import test from "node:test";

import {
  fleetProtocolSchemaCatalog,
  MeshRecordV1Schema,
  RevisionV1Schema,
  validateV1JsonValue,
  validateV1MeshNodeSnapshot,
  validateV1MeshRecord,
  type MeshRecord,
} from "./fleet-protocol.ts";

function command(): MeshRecord {
  return {
    kind: "command",
    id: "command-id",
    header: {
      version: 1,
      fleet: "home",
      to: "kitchen",
      resource: "light:kitchen",
      operation: "set",
      revision: { epoch: 1, sequence: 2 },
      notBefore: null,
      expiresAt: null,
    },
    encryption: {
      ephemeralPublicKey: "public",
      iv: "iv",
      ciphertext: "ciphertext",
      authTag: "tag",
    },
    authority: "fleet-admin",
    signature: "signature",
  };
}

test("validates protocol records without replacing or mutating them", () => {
  const record = command();
  const before = structuredClone(record);

  validateV1MeshRecord(record);

  assert.equal(MeshRecordV1Schema.assert(record), record);
  assert.deepEqual(record, before);
});

test("rejects unknown protocol and snapshot fields", () => {
  const record = { ...command(), unexpected: true };
  assert.throws(() => validateV1MeshRecord(record), /unexpected must be removed/);

  const snapshot = {
    version: 1,
    records: [],
    resources: [],
    outcomes: [],
    unexpected: true,
  };
  assert.throws(() => validateV1MeshNodeSnapshot(snapshot), /unexpected must be removed/);
});

test("enforces recursive safe integers and plain JSON objects", () => {
  const value = { nested: [Number.MAX_SAFE_INTEGER, { minimum: Number.MIN_SAFE_INTEGER }] };
  validateV1JsonValue(value);

  assert.throws(
    () => validateV1JsonValue({ nested: [Number.MAX_SAFE_INTEGER + 1] }),
    /safe integers|at most 9007199254740991/,
  );
  assert.throws(() => validateV1JsonValue({ fraction: 0.5 }), /integer/);
  assert.throws(() => validateV1JsonValue(new Date()), /plain JSON/);

  const sparse = Array(2);
  assert.throws(() => validateV1JsonValue(sparse), /plain JSON/);
  const decorated = [1];
  Object.defineProperty(decorated, "extra", { value: 2, enumerable: true });
  assert.throws(() => validateV1JsonValue(decorated), /plain JSON/);
  assert.throws(
    () => validateV1JsonValue({ [Symbol("hidden")]: 1 }),
    /plain JSON/,
  );
});

test("owns stable ids and versions for protocol schemas", () => {
  assert.deepEqual(Object.keys(fleetProtocolSchemaCatalog), [
    "fleet.json-value",
    "fleet.no-input",
    "fleet.node-id",
    "fleet.revision",
    "fleet.public-identity",
    "fleet.command-envelope",
    "fleet.receipt-envelope",
    "fleet.mesh-record",
    "fleet.mesh-node-snapshot",
  ]);
  for (const versions of Object.values(fleetProtocolSchemaCatalog)) {
    assert.deepEqual(Object.keys(versions), ["1"]);
  }
});

test("ordinary exact schemas retain faithful JSON Schema conversion", () => {
  const schema = RevisionV1Schema.toJsonSchema();
  assert.ok("required" in schema);
  assert.ok("additionalProperties" in schema);
  assert.ok("properties" in schema);
  assert.deepEqual(schema.required, ["epoch", "sequence"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties?.epoch, {
    type: "integer",
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: Number.MIN_SAFE_INTEGER,
  });
});
