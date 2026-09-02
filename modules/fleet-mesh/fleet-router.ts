import { createRouterClient, implement } from "@orpc/server";

import { fleetContract } from "./fleet-contract.ts";
import {
  describeFleetNode,
  fleetNodeExists,
  listFleetNodes,
  type FleetNodeReader,
} from "./fleet-operations.ts";

export function createFleetRouter(reader: FleetNodeReader) {
  const os = implement(fleetContract);
  return os.router({
    node: {
      list: os.node.list.handler(() => listFleetNodes(reader)),
      describe: os.node.describe.handler(({ input, errors }) => {
        const node = describeFleetNode(reader, input);
        if (!node) {
          throw errors.NODE_NOT_FOUND({
            data: {
              kind: "fleet.node-not-found",
              version: 1,
              id: input,
            },
          });
        }
        return node;
      }),
      exists: os.node.exists.handler(({ input }) => fleetNodeExists(reader, input)),
    },
  });
}

export function createFleetClient(reader: FleetNodeReader) {
  return createRouterClient(createFleetRouter(reader));
}
