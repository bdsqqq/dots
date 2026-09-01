import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMeshDaemon } from "./daemon.ts";
import {
  createNodeIdentity,
  FleetAuthority,
  MeshNode,
  publicIdentity,
} from "./fleet-mesh.ts";

const directory = await mkdtemp(join(tmpdir(), "fleet-mesh-lab-"));
const authority = new FleetAuthority();
const identities = ["mbp-m2", "lgo-z2e", "virtual-esp32"].map(createNodeIdentity);
const roster = identities.map(publicIdentity);
const nodes = identities.map(
  (identity) => new MeshNode({ identity, fleet: "home", authority, roster }),
);
const daemons = await Promise.all(
  nodes.map((node) =>
    startMeshDaemon({ node, statePath: join(directory, `${node.id}.json`) }),
  ),
);

try {
  console.log("virtual nodes", Object.fromEntries(daemons.map((daemon, index) => [
    nodes[index].id,
    daemon.url,
  ])));
  const command = authority.issueSet({
    fleet: "home",
    recipient: roster[2],
    resource: "wifi:field-hotspot",
    revision: { epoch: 1, sequence: 1 },
    value: { ssid: "field-hotspot", credential: "encrypted-for-virtual-esp32" },
  });
  nodes[0].ingest([command]);

  console.log("contact: mbp-m2 ↔ lgo-z2e");
  await daemons[0].contact(daemons[1].url);
  console.log("contact: lgo-z2e ↔ virtual-esp32");
  await daemons[1].contact(daemons[2].url);
  console.log("virtual-esp32 state", nodes[2].readResource("wifi:field-hotspot"));
  console.log("contact: receipt returns over lgo-z2e ↔ mbp-m2");
  await daemons[0].contact(daemons[1].url);
  console.log("mbp-m2 receipt", nodes[0].records().find(
    (record) => record.kind === "receipt" && record.commandId === command.id,
  ));
  console.log("durable lab state", directory);
} finally {
  await Promise.all(daemons.map((daemon) => daemon.stop()));
  await rm(directory, { recursive: true, force: true });
}
