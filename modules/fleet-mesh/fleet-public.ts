import type { ContractRouterClient } from "@orpc/contract";

import {
  desiredStateContract,
  desiredStateSchemaCatalog,
} from "./desired-state/public.ts";
import { fleetOperation } from "./fleet-operation.ts";
import { fleetProtocolSchemaCatalog } from "./fleet-protocol.ts";
import {
  nodeCatalogContract,
  nodeCatalogSchemaCatalog,
} from "./node-catalog/public.ts";

export {
  CommandNotFoundV1Schema,
  desiredStateContract,
  DesiredStateSetInputV1Schema,
  DesiredStateStatusV1Schema,
  DesiredStateSubmissionV1Schema,
  getDesiredStateStatus,
  setDesiredState,
  type CommandNotFoundV1,
  type DesiredStateController,
  type DesiredStateSetInputV1,
  type DesiredStateStatusV1,
  type DesiredStateSubmissionV1,
} from "./desired-state/public.ts";
export {
  CommandEnvelopeV1Schema,
  JsonValueV1Schema,
  MeshNodeSnapshotV1Schema,
  MeshRecordV1Schema,
  NodeIdV1Schema,
  NoInputV1Schema,
  PublicIdentityV1Schema,
  ReceiptEnvelopeV1Schema,
  RevisionV1Schema,
  validateV1JsonValue,
  validateV1MeshNodeSnapshot,
  validateV1MeshRecord,
  validateV1MeshRecords,
  validateV1Revision,
  type CommandEnvelope,
  type JsonValue,
  type MeshNodeSnapshot,
  type MeshRecord,
  type NodeIdV1,
  type NoInputV1,
  type PublicIdentity,
  type ReceiptEnvelope,
  type Revision,
} from "./fleet-protocol.ts";
export {
  describeFleetNode,
  fleetNodeExists,
  FleetNodeDescriptionV1Schema,
  FleetNodePresenceV1Schema,
  FleetNodeSummaryListV1Schema,
  FleetNodeSummaryV1Schema,
  listFleetNodes,
  NodeNotFoundV1Schema,
  type FleetNodeDescriptionV1,
  type FleetNodePresenceV1,
  type FleetNodeReader,
  type FleetNodeRecord,
  type FleetNodeSummaryV1,
  type NodeNotFoundV1,
} from "./node-catalog/public.ts";
export type { FleetOperationMetadata } from "./fleet-operation.ts";

export const fleetContract = fleetOperation.router({
  node: nodeCatalogContract,
  "desired-state": desiredStateContract,
});
export type FleetClient = ContractRouterClient<typeof fleetContract>;

/**
 * Schema ownership follows behavior; this root catalog only gives consumers one
 * stable lookup surface across the fleet vertical.
 */
export const fleetSchemaCatalog = {
  ...fleetProtocolSchemaCatalog,
  ...nodeCatalogSchemaCatalog,
  ...desiredStateSchemaCatalog,
} as const;
