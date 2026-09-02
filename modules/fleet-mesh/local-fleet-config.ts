import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { NodeIdentityV1Schema } from "./fleet-node-schema.ts";
import { PublicIdentityV1Schema } from "./fleet-schema.ts";
import type { LocalFleetRuntimeOptions } from "./local-fleet-runtime.ts";

import { type } from "arktype";

const LocalFleetConfigurationV1Schema = type({
  "+": "reject",
  version: "1",
  fleet: "string",
  authority: {
    "+": "reject",
    id: "string",
    publicKey: "string",
  },
  nodes: [
    {
      "+": "reject",
      identity: NodeIdentityV1Schema,
      publicIdentity: PublicIdentityV1Schema,
      statePath: "string",
    },
    "[]",
  ],
});

export async function loadLocalFleetRuntimeOptions(
  path: string,
): Promise<LocalFleetRuntimeOptions> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const configuration = LocalFleetConfigurationV1Schema.assert(value);
  if (configuration !== value) {
    throw new TypeError("local fleet configuration validation must preserve object identity");
  }
  const directory = dirname(path);
  return {
    fleet: configuration.fleet,
    authority: { ...configuration.authority },
    nodes: configuration.nodes.map((node) => ({
      identity: { ...node.identity },
      publicIdentity: { ...node.publicIdentity },
      statePath: resolve(directory, node.statePath),
    })),
  };
}
