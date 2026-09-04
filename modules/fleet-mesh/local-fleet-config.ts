import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { NodeIdentityV1Schema } from "./fleet-mesh.ts";
import { PublicIdentityV1Schema } from "./fleet-protocol.ts";
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
  "publicNodes?": [PublicIdentityV1Schema, "[]"],
  "desiredState?": {
    "+": "reject",
    authorityPrivateKeyPath: "string",
    bridgeOrigin: "string",
    revisionStatePath: "string",
  },
});

export async function loadLocalFleetRuntimeOptions(
  path: string,
): Promise<LocalFleetRuntimeOptions> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const configuration = LocalFleetConfigurationV1Schema.assert(value);
  if (configuration !== value) {
    throw new TypeError("local fleet configuration validation must preserve object identity");
  }
  if (configuration.desiredState && !configuration.publicNodes?.length) {
    throw new TypeError("desiredState requires at least one publicNodes entry");
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
    publicNodes: configuration.publicNodes?.map((identity) => ({ ...identity })),
    desiredState: configuration.desiredState
      ? {
          authorityPrivateKey: await readFile(
            resolve(directory, configuration.desiredState.authorityPrivateKeyPath),
            "utf8",
          ),
          recipients: (configuration.publicNodes ?? []).map((identity) => ({
            ...identity,
          })),
          bridgeOrigin: configuration.desiredState.bridgeOrigin,
          revisionStatePath: resolve(
            directory,
            configuration.desiredState.revisionStatePath,
          ),
        }
      : undefined,
  };
}
