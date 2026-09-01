import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeIdentity,
  decryptCommand,
  FleetAuthority,
  MeshNode,
  publicIdentity,
  reconcile,
  type CommandEnvelope,
  type MeshRecord,
  type NodeIdentity,
} from "./fleet-mesh.ts";

function fixture(now = new Date("2026-09-01T12:00:00Z")) {
  const authority = new FleetAuthority();
  const identities = ["bridge", "relay", "kitchen"].map(createNodeIdentity);
  const roster = identities.map(publicIdentity);
  const nodes = Object.fromEntries(
    identities.map((identity) => [
      identity.id,
      new MeshNode({
        identity,
        fleet: "home",
        authority,
        roster,
        clock: () => now,
      }),
    ]),
  ) as Record<"bridge" | "relay" | "kitchen", MeshNode>;
  return {
    authority,
    identities: Object.fromEntries(
      identities.map((identity) => [identity.id, identity]),
    ) as Record<"bridge" | "relay" | "kitchen", NodeIdentity>,
    nodes,
    setNow(value: Date) {
      now = value;
    },
  };
}

test("delivers through a relay and gossips the applied receipt back", () => {
  const { authority, identities, nodes } = fixture();
  const command = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 1 },
    value: { power: "off" },
  });

  nodes.bridge.ingest([command]);
  reconcile(nodes.bridge, nodes.relay);
  reconcile(nodes.relay, nodes.kitchen);
  reconcile(nodes.bridge, nodes.relay);

  assert.deepEqual(nodes.kitchen.readResource("light:kitchen")?.value, { power: "off" });
  assert.equal(nodes.kitchen.executionCount(command.id), 1);
  assert.equal(nodes.bridge.receiptFor(command.id)?.status, "applied");
});

test("replay returns the durable outcome without duplicate execution", () => {
  const { authority, identities, nodes } = fixture();
  const command = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 1 },
    value: { power: "off" },
  });

  nodes.kitchen.ingest([command, command]);
  const snapshot = nodes.kitchen.snapshot();
  const restarted = new MeshNode({
    identity: identities.kitchen,
    fleet: "home",
    authority,
    roster: Object.values(identities).map(publicIdentity),
    snapshot,
  });
  restarted.ingest([command]);

  assert.equal(restarted.executionCount(command.id), 1);
  assert.equal(restarted.receiptFor(command.id)?.status, "applied");
});

test("a late older command cannot overwrite newer desired state", () => {
  const { authority, identities, nodes } = fixture();
  const oldOn = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 40 },
    value: { power: "on" },
  });
  const newerOff = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 41 },
    value: { power: "off" },
  });

  nodes.kitchen.ingest([newerOff]);
  nodes.kitchen.ingest([oldOn]);

  assert.deepEqual(nodes.kitchen.readResource("light:kitchen")?.value, { power: "off" });
  assert.equal(nodes.kitchen.receiptFor(oldOn.id)?.status, "rejected");
  assert.equal(nodes.kitchen.receiptFor(oldOn.id)?.reason, "stale");
  assert.equal(nodes.kitchen.executionCount(oldOn.id), 0);
});

test("scheduled state waits and loses to a newer revision", () => {
  const { authority, identities, nodes, setNow } = fixture();
  const scheduled = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 5 },
    value: { power: "on" },
    notBefore: new Date("2026-09-01T12:15:00Z"),
  });
  const newer = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 6 },
    value: { power: "off" },
  });

  nodes.kitchen.ingest([scheduled]);
  assert.equal(nodes.kitchen.readResource("light:kitchen"), null);
  nodes.kitchen.ingest([newer]);
  setNow(new Date("2026-09-01T12:16:00Z"));
  nodes.kitchen.processPending();

  assert.deepEqual(nodes.kitchen.readResource("light:kitchen")?.value, { power: "off" });
  assert.equal(nodes.kitchen.receiptFor(scheduled.id)?.reason, "stale");
});

test("relays cannot decrypt destination payloads", () => {
  const { authority, identities } = fixture();
  const command = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "wifi:field",
    revision: { epoch: 1, sequence: 1 },
    value: { ssid: "field", password: "secret" },
  });

  assert.throws(() => decryptCommand(command, identities.relay), /addressed to kitchen/);
  assert.deepEqual(decryptCommand(command, identities.kitchen), {
    ssid: "field",
    password: "secret",
  });
});

test("rejects modified commands and forged receipts", () => {
  const { authority, identities, nodes } = fixture();
  const command = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 1 },
    value: { power: "off" },
  });
  const modified = structuredClone(command);
  modified.header.resource = "door:front";
  const forgedReceipt: MeshRecord = {
    kind: "receipt",
    id: "forged",
    commandId: command.id,
    node: "kitchen",
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 1 },
    status: "applied",
    reason: null,
    resultingRevision: { epoch: 1, sequence: 1 },
    recordedAt: "2026-09-01T12:00:00.000Z",
    signature: "forged",
  };

  assert.equal(nodes.kitchen.ingest([modified as CommandEnvelope, forgedReceipt]), 0);
  assert.equal(nodes.kitchen.readResource("door:front"), null);
});

test("reconciliation converges after nodes were partitioned", () => {
  const { authority, identities, nodes } = fixture();
  const portrait = authority.issueSet({
    fleet: "home",
    recipient: publicIdentity(identities.kitchen),
    resource: "display:portrait",
    revision: { epoch: 2, sequence: 9 },
    value: { blob: "sha256:portrait" },
  });

  nodes.bridge.ingest([portrait]);
  assert.equal(nodes.kitchen.readResource("display:portrait"), null);
  reconcile(nodes.bridge, nodes.relay);
  reconcile(nodes.relay, nodes.kitchen);

  assert.deepEqual(nodes.kitchen.readResource("display:portrait")?.value, {
    blob: "sha256:portrait",
  });
});
