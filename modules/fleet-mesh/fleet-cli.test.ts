import assert from "node:assert/strict";
import test from "node:test";

import { runFleetCli, projectFleetOperations, type FleetCliIO } from "./fleet-cli.ts";
import { createFleetClient } from "./node-catalog/local.ts";
import type { FleetNodeReader } from "./node-catalog/public.ts";

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
  findConfiguredNode(id) {
    return this.listConfiguredNodes().find((node) => node.identity.id === id);
  },
};

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: FleetCliIO = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  };
  return { io, stdout, stderr };
}

test("projects every command from the public oRPC operation catalog", () => {
  assert.deepEqual(
    projectFleetOperations().map((operation) => operation.metadata.id),
    ["node.describe", "node.exists", "node.list"],
  );
});

test("no-input help and argv never expose or accept synthetic input", async () => {
  const help = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "list", "--help"],
      client: createFleetClient(reader),
      io: help.io,
    }),
    0,
  );
  assert.doesNotMatch(help.stdout.join(""), /--input|<id>/);

  const rejected = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "list", "unexpected"],
      client: createFleetClient(reader),
      io: rejected.io,
    }),
    2,
  );
  assert.match(rejected.stderr.join(""), /accepts no input/);
});

test("--json emits one stable array document for node.list", async () => {
  const output = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "list", "--json"],
      client: createFleetClient(reader),
      io: output.io,
    }),
    0,
  );

  assert.equal(output.stdout.length, 1);
  assert.deepEqual(JSON.parse(output.stdout[0]), [
    { fleet: "home", id: "alpha", kind: "fleet.node-summary", version: 1 },
    { fleet: "home", id: "zeta", kind: "fleet.node-summary", version: 1 },
  ]);
  assert.equal(output.stderr.length, 0);
});

test("scalar commands require one positional id and share the local client", async () => {
  const description = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "describe", "alpha", "--json"],
      client: createFleetClient(reader),
      io: description.io,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(description.stdout[0]), {
    fleet: "home",
    identity: {
      encryptionPublicKey: "alpha-encryption",
      id: "alpha",
      signingPublicKey: "alpha-signing",
    },
    kind: "fleet.node-description",
    version: 1,
  });

  const missing = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "describe"],
      client: createFleetClient(reader),
      io: missing.io,
    }),
    2,
  );
  assert.match(missing.stderr.join(""), /requires exactly one <id>/);
});

test("the third operation reaches the CLI without adapter wiring", async () => {
  const output = capture();
  assert.equal(
    await runFleetCli({
      argv: ["node", "exists", "missing", "--json"],
      client: createFleetClient(reader),
      io: output.io,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    exists: false,
    id: "missing",
    kind: "fleet.node-presence",
    version: 1,
  });
});

test("the option terminator preserves dash-prefixed scalar ids", async () => {
  for (const id of ["-n", "--json", "--help"]) {
    const output = capture();
    assert.equal(
      await runFleetCli({
        argv: ["node", "exists", "--", id],
        client: createFleetClient(reader),
        io: output.io,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(output.stdout[0]), {
      exists: false,
      id,
      kind: "fleet.node-presence",
      version: 1,
    });
  }
});
