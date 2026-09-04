import { oc } from "@orpc/contract";

export interface FleetOperationMetadata {
  id?: string;
  version?: 1;
  summary?: string;
  cli?: {
    input: "none" | "scalar" | "json";
    argument?: string;
  };
}

export const fleetOperation = oc.$meta<FleetOperationMetadata>({});
