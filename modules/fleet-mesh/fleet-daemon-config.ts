import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { type } from "arktype";

import {
  NodeIdentityV1Schema,
  validateAuthorityPublicKey,
  validateNodeIdentityKeys,
  type NodeIdentity,
  type PublicIdentity,
} from "./fleet-mesh.ts";
import { PublicIdentityV1Schema } from "./fleet-protocol.ts";

const FleetDaemonPublicConfigurationV1Schema = type({
  "+": "reject",
  version: "1",
  fleet: "string",
  authority: {
    "+": "reject",
    id: "string",
    publicKey: "string",
  },
  node: {
    "+": "reject",
    id: "string",
    hostname: "string",
    port: "number",
    statePath: "string",
  },
  roster: [PublicIdentityV1Schema, "[]"],
  peers: [
    {
      "+": "reject",
      id: "string",
      url: "string",
    },
    "[]",
  ],
  contactIntervalMs: "number",
  contactTimeoutMs: "number",
});

export type FleetDaemonPublicConfigurationV1 =
  typeof FleetDaemonPublicConfigurationV1Schema.infer;

export interface LoadedFleetDaemonConfiguration {
  publicConfiguration: FleetDaemonPublicConfigurationV1;
  identity: NodeIdentity;
  statePath: string;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertPort(value: number): void {
  assertPositiveSafeInteger(value, "node.port");
  if (value > 65_535) throw new TypeError("node.port must not exceed 65535");
}

function assertPeerUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} must be an HTTP origin without credentials or a path`);
  }
}

function identitiesEqual(left: PublicIdentity, right: PublicIdentity): boolean {
  return (
    left.id === right.id &&
    left.signingPublicKey === right.signingPublicKey &&
    left.encryptionPublicKey === right.encryptionPublicKey
  );
}

export function validateFleetDaemonConfiguration(
  publicConfiguration: FleetDaemonPublicConfigurationV1,
  identity: NodeIdentity,
): void {
  validateAuthorityPublicKey(publicConfiguration.authority.publicKey);
  validateNodeIdentityKeys(identity);
  if (publicConfiguration.node.hostname !== "127.0.0.1") {
    throw new TypeError("fleet daemons must bind to 127.0.0.1");
  }
  assertPort(publicConfiguration.node.port);
  assertPositiveSafeInteger(
    publicConfiguration.contactIntervalMs,
    "contactIntervalMs",
  );
  assertPositiveSafeInteger(
    publicConfiguration.contactTimeoutMs,
    "contactTimeoutMs",
  );
  if (publicConfiguration.node.id !== identity.id) {
    throw new TypeError("private identity does not match the configured local node id");
  }

  const roster = new Map<string, PublicIdentity>();
  for (const entry of publicConfiguration.roster) {
    if (roster.has(entry.id)) throw new TypeError(`duplicate roster id: ${entry.id}`);
    roster.set(entry.id, entry);
  }
  const localPublicIdentity = roster.get(identity.id);
  if (!localPublicIdentity || !identitiesEqual(localPublicIdentity, identity)) {
    throw new TypeError("private identity does not match the public roster");
  }

  const peerIds = new Set<string>();
  for (const [index, peer] of publicConfiguration.peers.entries()) {
    if (peer.id === identity.id) throw new TypeError("a daemon cannot peer with itself");
    if (peerIds.has(peer.id)) throw new TypeError(`duplicate peer id: ${peer.id}`);
    if (!roster.has(peer.id)) throw new TypeError(`peer is absent from roster: ${peer.id}`);
    assertPeerUrl(peer.url, `peers[${index}].url`);
    peerIds.add(peer.id);
  }
  if (peerIds.size === 0) throw new TypeError("at least one explicit peer is required");
}

export async function loadFleetDaemonConfiguration(
  publicConfigurationPath: string,
  identityPath: string,
): Promise<LoadedFleetDaemonConfiguration> {
  const [publicText, identityText] = await Promise.all([
    readFile(publicConfigurationPath, "utf8"),
    readFile(identityPath, "utf8"),
  ]);
  const publicValue: unknown = JSON.parse(publicText);
  const identityValue: unknown = JSON.parse(identityText);
  const publicConfiguration = FleetDaemonPublicConfigurationV1Schema.assert(publicValue);
  let identity: NodeIdentity;
  try {
    identity = NodeIdentityV1Schema.assert(identityValue);
  } catch {
    throw new TypeError("invalid private fleet identity configuration");
  }
  if (publicConfiguration !== publicValue || identity !== identityValue) {
    throw new TypeError("fleet daemon validation must preserve object identity");
  }
  validateFleetDaemonConfiguration(publicConfiguration, identity);
  return {
    publicConfiguration,
    identity,
    statePath: resolve(dirname(publicConfigurationPath), publicConfiguration.node.statePath),
  };
}
