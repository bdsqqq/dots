import { scope, type } from "arktype";

const fleetV1 = scope(
  {
    "#SafeInteger": "number.safe & number.integer",
    "#JsonObject": {
      "[string]": "JsonValueV1",
    },
    JsonValueV1: "null | boolean | SafeInteger | string | JsonObject | JsonValueV1[]",
    NoInputV1: "undefined",
    NodeIdV1: "string",
    RevisionV1: {
      "+": "reject",
      epoch: "SafeInteger",
      sequence: "SafeInteger",
    },
    PublicIdentityV1: {
      "+": "reject",
      id: "string",
      signingPublicKey: "string",
      encryptionPublicKey: "string",
    },
    CommandEnvelopeV1: {
      "+": "reject",
      kind: "'command'",
      id: "string",
      header: {
        "+": "reject",
        version: "1",
        fleet: "string",
        to: "string",
        resource: "string",
        operation: "'set'",
        revision: "RevisionV1",
        notBefore: "string | null",
        expiresAt: "string | null",
      },
      encryption: {
        "+": "reject",
        ephemeralPublicKey: "string",
        iv: "string",
        ciphertext: "string",
        authTag: "string",
      },
      authority: "string",
      signature: "string",
    },
    ReceiptEnvelopeV1: {
      "+": "reject",
      kind: "'receipt'",
      id: "string",
      commandId: "string",
      node: "string",
      resource: "string",
      revision: "RevisionV1",
      status: "'applied' | 'rejected'",
      reason: "'stale' | 'expired' | null",
      resultingRevision: "RevisionV1 | null",
      recordedAt: "string",
      signature: "string",
    },
    MeshRecordV1: "CommandEnvelopeV1 | ReceiptEnvelopeV1",
  },
).export();

function isStrictJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    const keySet = new Set<PropertyKey>(keys);
    if (keys.length !== value.length + 1 || !keySet.has("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      if (!keySet.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !isStrictJsonValue(descriptor.value)) {
        return false;
      }
    }
    return true;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isStrictJsonValue(descriptor.value)
    ) {
      return false;
    }
  }
  return true;
}

export const JsonValueV1Schema = fleetV1.JsonValueV1.narrow(
  (value, context) =>
    isStrictJsonValue(value) ||
    context.mustBe("a plain JSON value containing only safe integers"),
);
export const NoInputV1Schema = fleetV1.NoInputV1;
export const NodeIdV1Schema = fleetV1.NodeIdV1;
export const RevisionV1Schema = fleetV1.RevisionV1;
export const PublicIdentityV1Schema = fleetV1.PublicIdentityV1;
export const CommandEnvelopeV1Schema = fleetV1.CommandEnvelopeV1;
export const ReceiptEnvelopeV1Schema = fleetV1.ReceiptEnvelopeV1;
export const MeshRecordV1Schema = fleetV1.MeshRecordV1;
const ResourceStateV1Schema = type({
  "+": "reject",
  revision: RevisionV1Schema,
  value: JsonValueV1Schema,
  commandId: "string",
});
const CommandOutcomeV1Schema = type({
  "+": "reject",
  receiptId: "string",
  executions: "number.safe & number.integer",
});
export const MeshNodeSnapshotV1Schema = type({
  "+": "reject",
  version: "1",
  records: MeshRecordV1Schema.array(),
  resources: [["string", ResourceStateV1Schema], "[]"],
  outcomes: [["string", CommandOutcomeV1Schema], "[]"],
});
export type JsonValue = typeof JsonValueV1Schema.infer;
export type NoInputV1 = typeof NoInputV1Schema.infer;
export type NodeIdV1 = typeof NodeIdV1Schema.infer;
export type Revision = typeof RevisionV1Schema.infer;
export type PublicIdentity = typeof PublicIdentityV1Schema.infer;
export type CommandEnvelope = typeof CommandEnvelopeV1Schema.infer;
export type ReceiptEnvelope = typeof ReceiptEnvelopeV1Schema.infer;
export type MeshRecord = typeof MeshRecordV1Schema.infer;
export type MeshNodeSnapshot = typeof MeshNodeSnapshotV1Schema.infer;

export const fleetProtocolSchemaCatalog = {
  "fleet.json-value": { 1: JsonValueV1Schema },
  "fleet.no-input": { 1: NoInputV1Schema },
  "fleet.node-id": { 1: NodeIdV1Schema },
  "fleet.revision": { 1: RevisionV1Schema },
  "fleet.public-identity": { 1: PublicIdentityV1Schema },
  "fleet.command-envelope": { 1: CommandEnvelopeV1Schema },
  "fleet.receipt-envelope": { 1: ReceiptEnvelopeV1Schema },
  "fleet.mesh-record": { 1: MeshRecordV1Schema },
  "fleet.mesh-node-snapshot": { 1: MeshNodeSnapshotV1Schema },
} as const;

export function validateV1JsonValue(value: unknown): asserts value is JsonValue {
  const validated = JsonValueV1Schema.assert(value);
  if (validated !== value) throw new TypeError("JSON validation must preserve object identity");
}

export function validateV1Revision(value: unknown): asserts value is Revision {
  RevisionV1Schema.assert(value);
}

export function validateV1MeshRecord(value: unknown): asserts value is MeshRecord {
  MeshRecordV1Schema.assert(value);
}

export function validateV1MeshRecords(value: unknown): asserts value is MeshRecord[] {
  if (!Array.isArray(value)) throw new TypeError("mesh records must be an array");
  for (const record of value) validateV1MeshRecord(record);
}

export function validateV1MeshNodeSnapshot(
  value: unknown,
): asserts value is MeshNodeSnapshot {
  const validated = MeshNodeSnapshotV1Schema.assert(value);
  if (validated !== value) throw new TypeError("snapshot validation must preserve object identity");
  validateV1MeshRecords(validated.records);
}
