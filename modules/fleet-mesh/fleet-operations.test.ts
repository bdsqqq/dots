import assert from "node:assert/strict";
import test from "node:test";

import { ORPCError } from "@orpc/server";

import {
  describeFleetNode,
  fleetNodeExists,
  listFleetNodes,
  type FleetNodeReader,
} from "./fleet-operations.ts";
import { createFleetClient } from "./fleet-router.ts";

const reader: FleetNodeReader = {
  listConfiguredNodes: () => [
    {
      fleet: "home",
      identity: {
        id: "zeta",
        signingPublicKey: "zeta-signing",
        encryptionPublicKey: "zeta-encryption",
      },
    },
    {
      fleet: "home",
      identity: {
        id: "alpha",
        signingPublicKey: "alpha-signing",
        encryptionPublicKey: "alpha-encryption",
      },
    },
  ],
  findConfiguredNode: (id) =>
    reader.listConfiguredNodes().find((node) => node.identity.id === id),
};

test("plain use cases expose only explicit public read models", () => {
  assert.deepEqual(listFleetNodes(reader), [
    { kind: "fleet.node-summary", version: 1, id: "alpha", fleet: "home" },
    { kind: "fleet.node-summary", version: 1, id: "zeta", fleet: "home" },
  ]);
  assert.deepEqual(describeFleetNode(reader, "alpha"), {
    kind: "fleet.node-description",
    version: 1,
    fleet: "home",
    identity: {
      id: "alpha",
      signingPublicKey: "alpha-signing",
      encryptionPublicKey: "alpha-encryption",
    },
  });
  assert.deepEqual(fleetNodeExists(reader, "missing"), {
    kind: "fleet.node-presence",
    version: 1,
    id: "missing",
    exists: false,
  });
});

test("description projection cannot leak structurally compatible private identity fields", () => {
  const identityWithPrivateFields = {
    id: "alpha",
    signingPublicKey: "alpha-signing",
    encryptionPublicKey: "alpha-encryption",
    signingPrivateKey: "private-signing",
    encryptionPrivateKey: "private-encryption",
  };
  const permissiveReader: FleetNodeReader = {
    listConfiguredNodes: () => [{ fleet: "home", identity: identityWithPrivateFields }],
    findConfiguredNode: () => ({ fleet: "home", identity: identityWithPrivateFields }),
  };

  assert.deepEqual(describeFleetNode(permissiveReader, "alpha")?.identity, {
    id: "alpha",
    signingPublicKey: "alpha-signing",
    encryptionPublicKey: "alpha-encryption",
  });
});

test("the local oRPC client validates and invokes the shared contracts", async () => {
  const client = createFleetClient(reader);

  assert.deepEqual(await client.node.list(), listFleetNodes(reader));
  assert.deepEqual(await client.node.describe("zeta"), describeFleetNode(reader, "zeta"));
  assert.deepEqual(await client.node.exists("alpha"), {
    kind: "fleet.node-presence",
    version: 1,
    id: "alpha",
    exists: true,
  });
  await assert.rejects(
    () => client.node.describe("missing"),
    (error: unknown) => {
      assert.ok(error instanceof ORPCError);
      assert.equal(error.code, "NODE_NOT_FOUND");
      assert.deepEqual(error.data, {
        kind: "fleet.node-not-found",
        version: 1,
        id: "missing",
      });
      return true;
    },
  );
});

test("node.list rejects every runtime input except undefined", async () => {
  const client = createFleetClient(reader);
  const list = client.node.list as unknown as (input?: unknown) => Promise<unknown>;

  assert.deepEqual(await list(), listFleetNodes(reader));
  assert.deepEqual(await list(undefined), listFleetNodes(reader));
  for (const input of ["unexpected", null, { unexpected: true }]) {
    await assert.rejects(() => list(input));
  }
});
