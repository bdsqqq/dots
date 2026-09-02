import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadFleetDaemonConfiguration,
  type FleetDaemonPublicConfigurationV1,
} from "./fleet-daemon-config.ts";
import { fleetDaemonMain } from "./fleet-daemon-main.ts";
import {
  createNodeIdentity,
  FleetAuthority,
  publicIdentity,
} from "./fleet-mesh.ts";

async function configurationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "fleet-daemon-config-"));
  const authority = new FleetAuthority();
  const identity = createNodeIdentity("bridge");
  const peer = createNodeIdentity("relay");
  const publicConfiguration: FleetDaemonPublicConfigurationV1 = {
    version: 1,
    fleet: "home",
    authority: { id: authority.id, publicKey: authority.publicKey },
    node: {
      id: identity.id,
      hostname: "127.0.0.1",
      port: 43_120,
      statePath: "state/bridge.json",
    },
    roster: [publicIdentity(identity), publicIdentity(peer)],
    peers: [{ id: peer.id, url: "http://127.0.0.1:43121" }],
    contactIntervalMs: 1_000,
    contactTimeoutMs: 500,
  };
  const publicConfigurationPath = join(directory, "bridge.json");
  const identityPath = join(directory, "bridge-identity.json");
  await Promise.all([
    writeFile(publicConfigurationPath, JSON.stringify(publicConfiguration)),
    writeFile(identityPath, JSON.stringify(identity)),
  ]);
  return {
    directory,
    identity,
    identityPath,
    publicConfiguration,
    publicConfigurationPath,
  };
}

test("loads one private identity beside a public daemon configuration", async () => {
  const fixture = await configurationFixture();
  try {
    const loaded = await loadFleetDaemonConfiguration(
      fixture.publicConfigurationPath,
      fixture.identityPath,
    );
    assert.deepEqual(loaded.identity, fixture.identity);
    assert.deepEqual(loaded.publicConfiguration, fixture.publicConfiguration);
    assert.equal(loaded.statePath, join(fixture.directory, "state/bridge.json"));
    assert.equal(JSON.stringify(loaded.publicConfiguration).includes("PRIVATE KEY"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed without disclosing malformed private identity content", async () => {
  const fixture = await configurationFixture();
  try {
    const marker = "DO-NOT-LOG-PRIVATE-CONTENT";
    await writeFile(fixture.identityPath, JSON.stringify({ unexpected: marker }));
    await assert.rejects(
      () =>
        loadFleetDaemonConfiguration(
          fixture.publicConfigurationPath,
          fixture.identityPath,
        ),
      (error: Error) => {
        assert.equal(error.message, "invalid private fleet identity configuration");
        assert.equal(error.message.includes(marker), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("the production entrypoint exposes help without reading configuration", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  assert.equal(
    await fleetDaemonMain(["--help"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    }),
    0,
  );
  assert.match(stdout.join(""), /one loopback fleet node/);
  assert.deepEqual(stderr, []);
});

test("daemon configuration rejects public binds and implicit peers", async () => {
  const fixture = await configurationFixture();
  try {
    for (const mutation of [
      (value: FleetDaemonPublicConfigurationV1) => {
        value.node.hostname = "0.0.0.0";
      },
      (value: FleetDaemonPublicConfigurationV1) => {
        value.peers = [];
      },
    ]) {
      const configuration = structuredClone(fixture.publicConfiguration);
      mutation(configuration);
      await writeFile(fixture.publicConfigurationPath, JSON.stringify(configuration));
      await assert.rejects(() =>
        loadFleetDaemonConfiguration(
          fixture.publicConfigurationPath,
          fixture.identityPath,
        ),
      );
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
