import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSnapshot, startMeshDaemon } from "./daemon.ts";
import {
  createNodeIdentity,
  FleetAuthority,
  MeshNode,
  publicIdentity,
} from "./fleet-mesh.ts";

test("virtual daemons carry a command and receipt across separate HTTP contacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-mesh-daemon-"));
  const authority = new FleetAuthority();
  const identities = ["bridge", "relay", "virtual-esp32"].map(createNodeIdentity);
  const roster = identities.map(publicIdentity);
  const node = (index: number, snapshot?: Awaited<ReturnType<typeof readSnapshot>>) =>
    new MeshNode({ identity: identities[index], fleet: "home", authority, roster, snapshot });
  const bridgeNode = node(0);
  const relayNode = node(1);
  let espNode = node(2);
  const paths = identities.map((identity) => join(directory, `${identity.id}.json`));
  const daemons = [
    await startMeshDaemon({ node: bridgeNode, statePath: paths[0] }),
    await startMeshDaemon({ node: relayNode, statePath: paths[1] }),
    await startMeshDaemon({ node: espNode, statePath: paths[2] }),
  ];

  try {
    const command = authority.issueSet({
      fleet: "home",
      recipient: roster[2],
      resource: "display:portrait",
      revision: { epoch: 1, sequence: 1 },
      value: { blob: "sha256:portrait" },
    });
    bridgeNode.ingest([command]);

    await daemons[0].contact(daemons[1].url);
    await daemons[1].contact(daemons[2].url);
    await daemons[0].contact(daemons[1].url);

    assert.deepEqual(espNode.readResource("display:portrait")?.value, {
      blob: "sha256:portrait",
    });
    assert.equal(
      bridgeNode.records().some(
        (record) => record.kind === "receipt" && record.commandId === command.id,
      ),
      true,
    );

    await daemons[2].stop();
    const persisted = await readSnapshot(paths[2]);
    assert.ok(persisted);
    espNode = node(2, persisted);
    espNode.ingest([command]);
    assert.equal(espNode.executionCount(command.id), 1);
    assert.match(await readFile(paths[2], "utf8"), /display:portrait/);
  } finally {
    await Promise.allSettled(daemons.slice(0, 2).map((daemon) => daemon.stop()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP request and peer-response boundaries reject malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-mesh-boundary-"));
  const authority = new FleetAuthority();
  const identity = createNodeIdentity("bridge");
  const node = new MeshNode({
    identity,
    fleet: "home",
    authority,
    roster: [publicIdentity(identity)],
  });
  const daemon = await startMeshDaemon({
    node,
    statePath: join(directory, "bridge.json"),
  });
  let peerBody = JSON.stringify({
    records: [{ kind: "command", unexpected: true }],
  });
  const malformedPeer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(peerBody);
  });
  await new Promise<void>((resolve, reject) => {
    malformedPeer.once("error", reject);
    malformedPeer.listen(0, "127.0.0.1", resolve);
  });
  const address = malformedPeer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(new URL("/gossip", daemon.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ kind: "command", unexpected: true }]),
    });
    assert.equal(response.status, 400);
    assert.equal(node.records().length, 0);

    await assert.rejects(
      () => daemon.contact(`http://127.0.0.1:${address.port}`),
      /must be removed|must be a string/,
    );
    peerBody = JSON.stringify({ records: [], padding: "x".repeat(1024 * 1024) });
    await assert.rejects(
      () => daemon.contact(`http://127.0.0.1:${address.port}`),
      /peer gossip response exceeds 1 MiB/,
    );
    assert.equal(node.records().length, 0);
  } finally {
    await daemon.stop();
    await new Promise<void>((resolve, reject) =>
      malformedPeer.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed snapshot write does not poison later persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-mesh-persistence-"));
  const authority = new FleetAuthority();
  const identity = createNodeIdentity("bridge");
  const node = new MeshNode({
    identity,
    fleet: "home",
    authority,
    roster: [publicIdentity(identity)],
  });
  const statePath = join(directory, "bridge.json");
  const daemon = await startMeshDaemon({ node, statePath });

  try {
    await rm(statePath);
    await mkdir(statePath);
    const failed = await fetch(new URL("/gossip", daemon.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(failed.status, 400);

    await rm(statePath, { recursive: true });
    const recovered = await fetch(new URL("/gossip", daemon.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await readSnapshot(statePath), node.snapshot());
  } finally {
    await rm(statePath, { recursive: true, force: true });
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
