import {
  createNodeIdentity,
  FleetAuthority,
  MeshNode,
  publicIdentity,
  reconcile,
} from "./fleet-mesh.ts";

const authority = new FleetAuthority();
const identities = ["mbp-m2", "lgo-z2e", "virtual-esp32"].map(createNodeIdentity);
const roster = identities.map(publicIdentity);
const nodes = Object.fromEntries(
  identities.map((identity) => [
    identity.id,
    new MeshNode({ identity, fleet: "home", authority, roster }),
  ]),
);

const portrait = authority.issueSet({
  fleet: "home",
  recipient: roster.find((identity) => identity.id === "virtual-esp32")!,
  resource: "display:portrait",
  revision: { epoch: 1, sequence: 13 },
  value: {
    blob: "sha256:799f4f040ea53e80e14a0c5a09b7843782630d8f70fda04f0864e470518e8e26",
    mediaType: "image/avif",
  },
});

nodes["mbp-m2"].ingest([portrait]);
console.log("mbp-m2 accepted a portrait update while virtual-esp32 is partitioned");

reconcile(nodes["mbp-m2"], nodes["lgo-z2e"]);
console.log("lgo-z2e learned the encrypted envelope");

reconcile(nodes["lgo-z2e"], nodes["virtual-esp32"]);
console.log("virtual-esp32 applied", nodes["virtual-esp32"].readResource("display:portrait"));

reconcile(nodes["mbp-m2"], nodes["lgo-z2e"]);
console.log("mbp-m2 received", nodes["mbp-m2"].records().find(
  (record) => record.kind === "receipt" && record.commandId === portrait.id,
));
