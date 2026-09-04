import { type } from "arktype";

import { fleetOperation } from "../fleet-operation.ts";
import { NodeNotFoundV1Schema } from "../node-catalog/public.ts";
import {
  JsonValueV1Schema,
  ReceiptEnvelopeV1Schema,
  RevisionV1Schema,
} from "../fleet-protocol.ts";

export const DesiredStateSetInputV1Schema = type({
  "+": "reject",
  nodeId: "string",
  resource: "string",
  value: JsonValueV1Schema,
  "notBefore?": "string",
  "expiresAt?": "string",
});
export const DesiredStateSubmissionV1Schema = type({
  "+": "reject",
  kind: "'fleet.desired-state-submission'",
  version: "1",
  commandId: "string",
  revision: RevisionV1Schema,
});
const PendingDesiredStateStatusV1Schema = type({
  "+": "reject",
  kind: "'fleet.desired-state-status'",
  version: "1",
  commandId: "string",
  state: "'pending'",
  receipt: "null",
});
const RecordedDesiredStateStatusV1Schema = type({
  "+": "reject",
  kind: "'fleet.desired-state-status'",
  version: "1",
  commandId: "string",
  state: "'recorded'",
  receipt: ReceiptEnvelopeV1Schema,
});
export const DesiredStateStatusV1Schema = PendingDesiredStateStatusV1Schema.or(
  RecordedDesiredStateStatusV1Schema,
);
export const CommandNotFoundV1Schema = type({
  "+": "reject",
  kind: "'fleet.command-not-found'",
  version: "1",
  commandId: "string",
});

export type DesiredStateSetInputV1 = typeof DesiredStateSetInputV1Schema.infer;
export type DesiredStateSubmissionV1 = typeof DesiredStateSubmissionV1Schema.infer;
export type DesiredStateStatusV1 = typeof DesiredStateStatusV1Schema.infer;
export type CommandNotFoundV1 = typeof CommandNotFoundV1Schema.infer;

export const desiredStateSchemaCatalog = {
  "fleet.desired-state-set-input": { 1: DesiredStateSetInputV1Schema },
  "fleet.desired-state-submission": { 1: DesiredStateSubmissionV1Schema },
  "fleet.desired-state-status": { 1: DesiredStateStatusV1Schema },
  "fleet.command-not-found": { 1: CommandNotFoundV1Schema },
} as const;

export interface DesiredStateController {
  set(
    input: DesiredStateSetInputV1,
  ): Promise<DesiredStateSubmissionV1 | undefined>;
  status(commandId: string): Promise<DesiredStateStatusV1 | undefined>;
}

export function setDesiredState(
  controller: DesiredStateController,
  input: DesiredStateSetInputV1,
): Promise<DesiredStateSubmissionV1 | undefined> {
  return controller.set(input);
}

export function getDesiredStateStatus(
  controller: DesiredStateController,
  commandId: string,
): Promise<DesiredStateStatusV1 | undefined> {
  return controller.status(commandId);
}

export const desiredStateContract = fleetOperation.router({
  set: fleetOperation
    .input(DesiredStateSetInputV1Schema)
    .output(DesiredStateSubmissionV1Schema)
    .errors({
      NODE_NOT_FOUND: {
        data: NodeNotFoundV1Schema,
      },
    })
    .meta({
      id: "desired-state.set",
      version: 1,
      summary: "set desired state for a fleet node resource",
      cli: { input: "json" },
    }),
  status: fleetOperation
    .input(type("string"))
    .output(DesiredStateStatusV1Schema)
    .errors({
      COMMAND_NOT_FOUND: {
        data: CommandNotFoundV1Schema,
      },
    })
    .meta({
      id: "desired-state.status",
      version: 1,
      summary: "get desired-state command status",
      cli: { input: "scalar", argument: "commandId" },
    }),
});
