import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
