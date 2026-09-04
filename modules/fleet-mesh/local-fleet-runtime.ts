import { readSnapshot } from "./daemon.ts";
import {
  FileDesiredStateController,
  type FileDesiredStateControllerOptions,
} from "./desired-state/local.ts";
import type { DesiredStateController } from "./desired-state/public.ts";
import {
  MeshNode,
  publicIdentity,
  validateAuthorityPublicKey,
  validateNodeIdentityKeys,
  type NodeIdentity,
  type PublicIdentity,
} from "./fleet-mesh.ts";
import type { FleetNodeReader, FleetNodeRecord } from "./node-catalog/public.ts";
import { PublicIdentityV1Schema } from "./fleet-protocol.ts";

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
  publicNodes?: readonly PublicIdentity[];
  desiredState?: Pick<
    FileDesiredStateControllerOptions,
    | "authorityPrivateKey"
    | "recipients"
    | "bridgeOrigin"
    | "revisionStatePath"
    | "fetch"
  >;
  clock?: () => Date;
}

interface LoadedFleetNode {
  record: FleetNodeRecord;
  node?: MeshNode;
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
  readonly desiredStateController: DesiredStateController | undefined;

  private constructor(
    nodes: ReadonlyMap<string, LoadedFleetNode>,
    desiredStateController: DesiredStateController | undefined,
  ) {
    this.#nodes = nodes;
    this.desiredStateController = desiredStateController;
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
      publicNodes: options.publicNodes?.map((identity) => ({
        id: identity.id,
        signingPublicKey: identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
      })),
      desiredState: options.desiredState
        ? {
            authorityPrivateKey: options.desiredState.authorityPrivateKey,
            recipients: options.desiredState.recipients.map((identity) => ({
              id: identity.id,
              signingPublicKey: identity.signingPublicKey,
              encryptionPublicKey: identity.encryptionPublicKey,
            })),
            bridgeOrigin: options.desiredState.bridgeOrigin,
            revisionStatePath: options.desiredState.revisionStatePath,
            fetch: options.desiredState.fetch,
          }
        : undefined,
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
    for (const identity of captured.publicNodes ?? []) {
      PublicIdentityV1Schema.assert(identity);
      if (ids.has(identity.id)) {
        throw new Error(`duplicate configured node id: ${identity.id}`);
      }
      ids.add(identity.id);
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

    const desiredStateController = captured.desiredState
      ? new FileDesiredStateController({
          fleet: captured.fleet,
          authority: captured.authority,
          ...captured.desiredState,
          clock: captured.clock,
        })
      : undefined;
    return new LocalFleetRuntime(
      new Map(
        [
          ...loaded,
          ...(captured.publicNodes ?? []).map((identity) => ({
            record: {
              fleet: captured.fleet,
              identity: { ...identity },
            },
          })),
        ].map((entry) => [entry.record.identity.id, entry]),
      ),
      desiredStateController,
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
