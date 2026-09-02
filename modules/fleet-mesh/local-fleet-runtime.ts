import { readSnapshot } from "./daemon.ts";
import {
  MeshNode,
  publicIdentity,
  validateAuthorityPublicKey,
  validateNodeIdentityKeys,
  type NodeIdentity,
  type PublicIdentity,
} from "./fleet-mesh.ts";
import type { FleetNodeReader, FleetNodeRecord } from "./fleet-operations.ts";
import { PublicIdentityV1Schema } from "./fleet-schema.ts";

export interface LocalFleetNodeConfiguration {
  identity: NodeIdentity;
  publicIdentity: PublicIdentity;
  statePath: string;
}

export interface LocalFleetRuntimeOptions {
  fleet: string;
  authority: {
    id: string;
    publicKey: string;
  };
  nodes: readonly LocalFleetNodeConfiguration[];
  clock?: () => Date;
}

interface LoadedFleetNode {
  record: FleetNodeRecord;
  node: MeshNode;
}

function identitiesEqual(left: PublicIdentity, right: PublicIdentity): boolean {
  return (
    left.id === right.id &&
    left.signingPublicKey === right.signingPublicKey &&
    left.encryptionPublicKey === right.encryptionPublicKey
  );
}

export class LocalFleetRuntime implements FleetNodeReader {
  readonly #nodes: ReadonlyMap<string, LoadedFleetNode>;

  private constructor(nodes: ReadonlyMap<string, LoadedFleetNode>) {
    this.#nodes = nodes;
  }

  static async create(options: LocalFleetRuntimeOptions): Promise<LocalFleetRuntime> {
    const captured = {
      fleet: options.fleet,
      authority: {
        id: options.authority.id,
        publicKey: options.authority.publicKey,
      },
      nodes: options.nodes.map((configuration) => ({
        identity: {
          id: configuration.identity.id,
          signingPublicKey: configuration.identity.signingPublicKey,
          encryptionPublicKey: configuration.identity.encryptionPublicKey,
          signingPrivateKey: configuration.identity.signingPrivateKey,
          encryptionPrivateKey: configuration.identity.encryptionPrivateKey,
        },
        publicIdentity: {
          id: configuration.publicIdentity.id,
          signingPublicKey: configuration.publicIdentity.signingPublicKey,
          encryptionPublicKey: configuration.publicIdentity.encryptionPublicKey,
        },
        statePath: configuration.statePath,
      })),
      clock: options.clock,
    };
    validateAuthorityPublicKey(captured.authority.publicKey);
    const ids = new Set<string>();
    for (const configuration of captured.nodes) {
      PublicIdentityV1Schema.assert(configuration.publicIdentity);
      validateNodeIdentityKeys(configuration.identity);
      if (ids.has(configuration.publicIdentity.id)) {
        throw new Error(`duplicate configured node id: ${configuration.publicIdentity.id}`);
      }
      ids.add(configuration.publicIdentity.id);
    }

    const roster = captured.nodes.map((configuration) => ({
      ...configuration.publicIdentity,
    }));
    const loaded = await Promise.all(
      captured.nodes.map(async (configuration): Promise<LoadedFleetNode> => {
        const snapshot = await readSnapshot(configuration.statePath);
        const node = new MeshNode({
          identity: configuration.identity,
          fleet: captured.fleet,
          authority: captured.authority,
          roster,
          clock: captured.clock,
          snapshot,
        });
        const projectedIdentity = publicIdentity(node.identity);
        if (!identitiesEqual(configuration.publicIdentity, projectedIdentity)) {
          throw new Error(
            `configured public identity does not match runtime node: ${configuration.publicIdentity.id}`,
          );
        }
        return {
          record: {
            fleet: captured.fleet,
            identity: { ...configuration.publicIdentity },
          },
          node,
        };
      }),
    );

    return new LocalFleetRuntime(
      new Map(loaded.map((entry) => [entry.record.identity.id, entry])),
    );
  }

  listConfiguredNodes(): readonly FleetNodeRecord[] {
    return [...this.#nodes.values()].map(({ record }) => ({
      fleet: record.fleet,
      identity: { ...record.identity },
    }));
  }

  findConfiguredNode(id: string): FleetNodeRecord | undefined {
    const record = this.#nodes.get(id)?.record;
    return record
      ? {
          fleet: record.fleet,
          identity: { ...record.identity },
        }
      : undefined;
  }
}
