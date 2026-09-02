import { oc, type ContractRouterClient } from "@orpc/contract";

import {
  FleetNodeDescriptionV1Schema,
  FleetNodePresenceV1Schema,
  FleetNodeSummaryListV1Schema,
  NoInputV1Schema,
  NodeIdV1Schema,
  NodeNotFoundV1Schema,
} from "./fleet-schema.ts";

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
