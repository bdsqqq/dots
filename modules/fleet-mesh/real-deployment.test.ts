import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FleetDaemonPublicConfigurationV1 } from "./fleet-daemon-config.ts";
import {
  startConfiguredFleetDaemon,
  type RunningConfiguredFleetDaemon,
} from "./fleet-daemon-main.ts";
import {
  createNodeIdentity,
  FleetAuthority,
  publicIdentity,
  type NodeIdentity,
} from "./fleet-mesh.ts";

async function reserveDistinctPorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("test server has no TCP port"));
                return;
              }
              resolve(address.port);
            });
          }),
      ),
    );
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  }
}

async function waitFor(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

test("command relays to virtual ESP32 exactly once and its receipt survives replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-real-deployment-"));
  const authority = new FleetAuthority();
  const identities = {
    "mmn-m4": createNodeIdentity("mmn-m4"),
    relay: createNodeIdentity("relay"),
    "virtual-esp32": createNodeIdentity("virtual-esp32"),
  };
  const roster = Object.values(identities).map(publicIdentity);
  const [bridgePort, relayPort, espPort] = await reserveDistinctPorts(3);
  const ports = {
    "mmn-m4": bridgePort,
    relay: relayPort,
    "virtual-esp32": espPort,
  };
  const peerIds = {
    "mmn-m4": ["relay"],
    relay: ["mmn-m4", "virtual-esp32"],
    "virtual-esp32": ["relay"],
  } as const;
  const configurationPaths = new Map<string, string>();
  const identityPaths = new Map<string, string>();
  const statePaths = new Map<string, string>();
  const running = new Map<string, RunningConfiguredFleetDaemon>();
  const contactErrors: string[] = [];
  const log = {
    info: () => undefined,
    error: (message: string) => contactErrors.push(message),
  };

  try {
    for (const [id, identity] of Object.entries(identities) as [
      keyof typeof identities,
      NodeIdentity,
    ][]) {
      const statePath = join(directory, "state", `${id}.json`);
      const configuration: FleetDaemonPublicConfigurationV1 = {
        version: 1,
        fleet: "home",
        authority: { id: authority.id, publicKey: authority.publicKey },
        node: {
          id,
          hostname: "127.0.0.1",
          port: ports[id],
          statePath,
        },
        roster,
        peers: peerIds[id].map((peerId) => ({
          id: peerId,
          url: `http://127.0.0.1:${ports[peerId]}`,
        })),
        contactIntervalMs: 20,
        contactTimeoutMs: 250,
      };
      const configurationPath = join(directory, `${id}.json`);
      const identityPath = join(directory, `${id}-identity.json`);
      await Promise.all([
        writeFile(configurationPath, JSON.stringify(configuration)),
        writeFile(identityPath, JSON.stringify(identity)),
      ]);
      configurationPaths.set(id, configurationPath);
      identityPaths.set(id, identityPath);
      statePaths.set(id, statePath);
    }

    await Promise.all(
      [...configurationPaths].map(async ([id, publicConfigurationPath]) => {
        running.set(
          id,
          await startConfiguredFleetDaemon({
            publicConfigurationPath,
            identityPath: identityPaths.get(id)!,
            log,
          }),
        );
      }),
    );

    const bridge = running.get("mmn-m4")!;
    const relay = running.get("relay")!;
    const virtualEsp32 = running.get("virtual-esp32")!;
    const command = authority.issueSet({
      fleet: "home",
      recipient: publicIdentity(identities["virtual-esp32"]),
      resource: "wifi:field-hotspot",
      revision: { epoch: 1, sequence: 1 },
      value: {
        ssid: "field-hotspot",
        credential: "encrypted-for-virtual-esp32",
      },
    });

    const injection = await fetch(new URL("/gossip", bridge.daemon.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([command]),
    });
    assert.equal(injection.status, 200);

    await waitFor(() => {
      assert.equal(virtualEsp32.node.executionCount(command.id), 1);
      assert.equal(
        relay.node.records().some((record) => record.id === command.id),
        true,
      );
      assert.equal(relay.node.receiptFor(command.id)?.status, "applied");
      assert.equal(bridge.node.receiptFor(command.id)?.status, "applied");
    });
    assert.deepEqual(virtualEsp32.node.readResource("wifi:field-hotspot")?.value, {
      ssid: "field-hotspot",
      credential: "encrypted-for-virtual-esp32",
    });

    const health = await fetch(new URL("/health", bridge.daemon.url));
    assert.deepEqual(await health.json(), {
      kind: "fleet.mesh-daemon-health",
      version: 1,
      node: "mmn-m4",
    });
    assert.equal((await fetch(new URL("/state", bridge.daemon.url))).status, 404);

    await virtualEsp32.stop();
    running.delete("virtual-esp32");
    const restarted = await startConfiguredFleetDaemon({
      publicConfigurationPath: configurationPaths.get("virtual-esp32")!,
      identityPath: identityPaths.get("virtual-esp32")!,
      log,
    });
    running.set("virtual-esp32", restarted);
    assert.equal(restarted.node.executionCount(command.id), 1);
    await restarted.contactNow();
    assert.equal(restarted.node.executionCount(command.id), 1);
    assert.equal(restarted.node.receiptFor(command.id)?.status, "applied");
    assert.equal(statePaths.get("virtual-esp32")?.startsWith(directory), true);
    assert.equal(
      contactErrors.some((message) => message.includes("PRIVATE KEY")),
      false,
    );
  } finally {
    await Promise.allSettled([...running.values()].map((service) => service.stop()));
    await rm(directory, { recursive: true, force: true });
  }
});
