import {
  type FleetNodeDescriptionV1,
  type FleetNodePresenceV1,
  type FleetNodeSummaryV1,
  type PublicIdentity,
} from "./fleet-schema.ts";

export interface FleetNodeRecord {
  fleet: string;
  identity: PublicIdentity;
}

export interface FleetNodeReader {
  listConfiguredNodes(): readonly FleetNodeRecord[];
  findConfiguredNode(id: string): FleetNodeRecord | undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function listFleetNodes(reader: FleetNodeReader): FleetNodeSummaryV1[] {
  return reader
    .listConfiguredNodes()
    .map(({ fleet, identity }) => ({
      kind: "fleet.node-summary" as const,
      version: 1 as const,
      id: identity.id,
      fleet,
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function describeFleetNode(
  reader: FleetNodeReader,
  id: string,
): FleetNodeDescriptionV1 | undefined {
  const node = reader.findConfiguredNode(id);
  if (!node) return undefined;
  return {
    kind: "fleet.node-description",
    version: 1,
    fleet: node.fleet,
    identity: {
      id: node.identity.id,
      signingPublicKey: node.identity.signingPublicKey,
      encryptionPublicKey: node.identity.encryptionPublicKey,
    },
  };
}

export function fleetNodeExists(reader: FleetNodeReader, id: string): FleetNodePresenceV1 {
  return {
    kind: "fleet.node-presence",
    version: 1,
    id,
    exists: reader.findConfiguredNode(id) !== undefined,
  };
}
