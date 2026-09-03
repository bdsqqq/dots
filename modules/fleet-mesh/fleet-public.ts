import { fleetProtocolSchemaCatalog } from "./fleet-protocol.ts";
import { nodeCatalogSchemaCatalog } from "./node-catalog/public.ts";

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
  fleetContract,
  fleetNodeExists,
  FleetNodeDescriptionV1Schema,
  FleetNodePresenceV1Schema,
  FleetNodeSummaryListV1Schema,
  FleetNodeSummaryV1Schema,
  listFleetNodes,
  NodeNotFoundV1Schema,
  type FleetClient,
  type FleetNodeDescriptionV1,
  type FleetNodePresenceV1,
  type FleetNodeReader,
  type FleetNodeRecord,
  type FleetNodeSummaryV1,
  type FleetOperationMetadata,
  type NodeNotFoundV1,
} from "./node-catalog/public.ts";

/**
 * Schema ownership follows behavior; this root catalog only gives consumers one
 * stable lookup surface across the fleet vertical.
 */
export const fleetSchemaCatalog = {
  ...fleetProtocolSchemaCatalog,
  ...nodeCatalogSchemaCatalog,
} as const;
