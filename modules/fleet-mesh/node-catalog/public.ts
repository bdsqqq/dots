import { oc, type ContractRouterClient } from "@orpc/contract";
import { type } from "arktype";

import {
  NodeIdV1Schema,
  NoInputV1Schema,
  PublicIdentityV1Schema,
  type PublicIdentity,
} from "../fleet-protocol.ts";
export const FleetNodeSummaryV1Schema = type({
  "+": "reject",
  kind: "'fleet.node-summary'",
  version: "1",
  id: "string",
  fleet: "string",
});
export const FleetNodeSummaryListV1Schema = FleetNodeSummaryV1Schema.array();
export const FleetNodeDescriptionV1Schema = type({
  "+": "reject",
  kind: "'fleet.node-description'",
  version: "1",
  fleet: "string",
  identity: PublicIdentityV1Schema,
});
export const FleetNodePresenceV1Schema = type({
  "+": "reject",
  kind: "'fleet.node-presence'",
  version: "1",
  id: "string",
  exists: "boolean",
});
export const NodeNotFoundV1Schema = type({
  "+": "reject",
  kind: "'fleet.node-not-found'",
  version: "1",
  id: "string",
});

export type FleetNodeSummaryV1 = typeof FleetNodeSummaryV1Schema.infer;
export type FleetNodeDescriptionV1 = typeof FleetNodeDescriptionV1Schema.infer;
export type FleetNodePresenceV1 = typeof FleetNodePresenceV1Schema.infer;
export type NodeNotFoundV1 = typeof NodeNotFoundV1Schema.infer;

export const nodeCatalogSchemaCatalog = {
  "fleet.node-summary": { 1: FleetNodeSummaryV1Schema },
  "fleet.node-summary-list": { 1: FleetNodeSummaryListV1Schema },
  "fleet.node-description": { 1: FleetNodeDescriptionV1Schema },
  "fleet.node-presence": { 1: FleetNodePresenceV1Schema },
  "fleet.node-not-found": { 1: NodeNotFoundV1Schema },
} as const;

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

export interface FleetOperationMetadata {
  id?: string;
  version?: 1;
  summary?: string;
  cli?: {
    input: "none" | "scalar";
    argument?: string;
  };
}

const operation = oc.$meta<FleetOperationMetadata>({});

export const fleetContract = operation.router({
  node: {
    list: operation
      .input(NoInputV1Schema)
      .output(FleetNodeSummaryListV1Schema)
      .meta({
        id: "node.list",
        version: 1,
        summary: "list configured fleet nodes",
        cli: { input: "none" },
      }),
    describe: operation
      .input(NodeIdV1Schema)
      .output(FleetNodeDescriptionV1Schema)
      .errors({
        NODE_NOT_FOUND: {
          data: NodeNotFoundV1Schema,
        },
      })
      .meta({
        id: "node.describe",
        version: 1,
        summary: "describe one configured fleet node",
        cli: { input: "scalar", argument: "id" },
      }),
    exists: operation
      .input(NodeIdV1Schema)
      .output(FleetNodePresenceV1Schema)
      .meta({
        id: "node.exists",
        version: 1,
        summary: "check whether a fleet node is configured",
        cli: { input: "scalar", argument: "id" },
      }),
  },
});

export type FleetClient = ContractRouterClient<typeof fleetContract>;
