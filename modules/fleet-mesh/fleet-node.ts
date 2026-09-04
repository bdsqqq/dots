import { createRouterClient } from "@orpc/server";

import { createDesiredStateRouter } from "./desired-state/local.ts";
import type { DesiredStateController } from "./desired-state/public.ts";
import type { FleetClient } from "./fleet-public.ts";
import { createNodeCatalogRouter } from "./node-catalog/local.ts";
import type { FleetNodeReader } from "./node-catalog/public.ts";

export * from "./daemon.ts";
export {
  createDesiredStateClient,
  createDesiredStateRouter,
  DesiredStateRevisionStateV1Schema,
  FileDesiredStateController,
  type DesiredStateRevisionStateV1,
  type FileDesiredStateControllerOptions,
} from "./desired-state/local.ts";
export * from "./fleet-daemon-config.ts";
export * from "./fleet-daemon-main.ts";
export {
  createNodeIdentity,
  decryptCommand,
  FleetAuthority,
  MeshNode,
  publicIdentity,
  reconcile,
  validateAuthorityPublicKey,
  validateNodeIdentityKeys,
  type CommandEnvelope,
  type JsonValue,
  type MeshNodeSnapshot,
  type MeshRecord,
  type NodeIdentity,
  type PublicIdentity,
  type ReceiptEnvelope,
  type ReceiptStatus,
  type ReconcileResult,
  type Revision,
} from "./fleet-mesh.ts";
export * from "./local-fleet-config.ts";
export * from "./local-fleet-runtime.ts";

const unavailableDesiredState: DesiredStateController = {
  set: async () => {
    throw new Error("desired-state control is not configured");
  },
  status: async () => {
    throw new Error("desired-state control is not configured");
  },
};

export function createFleetRouter(
  reader: FleetNodeReader,
  desiredState: DesiredStateController = unavailableDesiredState,
) {
  return {
    node: createNodeCatalogRouter(reader),
    "desired-state": createDesiredStateRouter(desiredState),
  };
}

export function createFleetClient(
  reader: FleetNodeReader,
  desiredState?: DesiredStateController,
): FleetClient {
  return createRouterClient(createFleetRouter(reader, desiredState));
}
