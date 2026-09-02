import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeIdentity,
  FleetAuthority,
  publicIdentity,
  type NodeIdentity,
} from "./fleet-mesh.ts";
import { listFleetNodes } from "./fleet-operations.ts";
import {
  LocalFleetRuntime,
  type LocalFleetNodeConfiguration,
} from "./local-fleet-runtime.ts";

function configuration(
  directory: string,
  identity: NodeIdentity,
): LocalFleetNodeConfiguration {
  return {
    identity,
    publicIdentity: publicIdentity(identity),
    statePath: join(directory, `${identity.id}.json`),
  };
}

test("missing snapshots create explicit fresh nodes and expose public configuration only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runtime-"));
  try {
    const authority = new FleetAuthority();
    const identities = ["zeta", "alpha"].map(createNodeIdentity);
    const runtime = await LocalFleetRuntime.create({
      fleet: "home",
      authority,
      nodes: identities.map((identity) => configuration(directory, identity)),
    });

    assert.deepEqual(listFleetNodes(runtime), [
      { kind: "fleet.node-summary", version: 1, id: "alpha", fleet: "home" },
      { kind: "fleet.node-summary", version: 1, id: "zeta", fleet: "home" },
    ]);
    const record = runtime.findConfiguredNode("alpha");
    assert.deepEqual(Object.keys(record?.identity ?? {}).sort(), [
      "encryptionPublicKey",
      "id",
      "signingPublicKey",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime construction rejects duplicate ids and identity mismatches atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runtime-"));
  try {
    const authority = new FleetAuthority();
    const identity = createNodeIdentity("alpha");
    const configured = configuration(directory, identity);

    await assert.rejects(
      () =>
        LocalFleetRuntime.create({
          fleet: "home",
          authority,
          nodes: [
            configured,
            { ...configured, statePath: join(directory, "other.json") },
          ],
        }),
      /duplicate configured node id: alpha/,
    );
    await assert.rejects(
      () =>
        LocalFleetRuntime.create({
          fleet: "home",
          authority,
          nodes: [
            {
              ...configured,
              publicIdentity: { ...configured.publicIdentity, signingPublicKey: "mismatch" },
            },
          ],
        }),
      /configured public identity does not match runtime node: alpha/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one malformed existing snapshot rejects the whole runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runtime-"));
  try {
    const authority = new FleetAuthority();
    const valid = configuration(directory, createNodeIdentity("alpha"));
    const malformed = configuration(directory, createNodeIdentity("zeta"));
    await writeFile(
      malformed.statePath,
      JSON.stringify({ version: 1, records: [], resources: [], outcomes: [], extra: true }),
    );

    await assert.rejects(
      () =>
        LocalFleetRuntime.create({
          fleet: "home",
          authority,
          nodes: [valid, malformed],
        }),
      /extra must be removed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime construction captures configuration before its first await", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runtime-"));
  try {
    const authority = new FleetAuthority();
    const configurations = ["alpha", "zeta"].map((id) =>
      configuration(directory, createNodeIdentity(id)),
    );
    const creating = LocalFleetRuntime.create({
      fleet: "home",
      authority,
      nodes: configurations,
    });

    configurations[1].identity.id = "alpha";
    configurations[1].publicIdentity.id = "alpha";

    assert.deepEqual(
      listFleetNodes(await creating).map((node) => node.id),
      ["alpha", "zeta"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime construction rejects crossed node keys and malformed authority keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-runtime-"));
  try {
    const authority = new FleetAuthority();
    const alpha = createNodeIdentity("alpha");
    const zeta = createNodeIdentity("zeta");
    const crossed = configuration(directory, {
      ...alpha,
      signingPrivateKey: zeta.signingPrivateKey,
      encryptionPrivateKey: zeta.encryptionPrivateKey,
    });

    await assert.rejects(
      () =>
        LocalFleetRuntime.create({
          fleet: "home",
          authority,
          nodes: [crossed],
        }),
      /public key does not match/,
    );
    await assert.rejects(
      () =>
        LocalFleetRuntime.create({
          fleet: "home",
          authority: { id: authority.id, publicKey: "not pem" },
          nodes: [configuration(directory, alpha)],
        }),
      /DECODER|unsupported|key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
