import { createRouterClient, implement } from "@orpc/server";

import {
  describeFleetNode,
  fleetNodeExists,
  listFleetNodes,
  nodeCatalogContract,
  type FleetNodeReader,
} from "./public.ts";

export function createNodeCatalogRouter(reader: FleetNodeReader) {
  const os = implement(nodeCatalogContract);
  return os.router({
    list: os.list.handler(() => listFleetNodes(reader)),
    describe: os.describe.handler(({ input, errors }) => {
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
    exists: os.exists.handler(({ input }) => fleetNodeExists(reader, input)),
  });
}

export function createNodeCatalogClient(reader: FleetNodeReader) {
  return createRouterClient(createNodeCatalogRouter(reader));
}
