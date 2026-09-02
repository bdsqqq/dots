import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { fleetCliMain } from "./fleet-cli-main.ts";
import { createNodeIdentity, FleetAuthority, publicIdentity } from "./fleet-mesh.ts";

const execFileAsync = promisify(execFile);

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

test("the executable composes explicit file configuration, runtime, client, and CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-cli-main-"));
  try {
    const authority = new FleetAuthority();
    const identity = createNodeIdentity("virtual-esp32");
    const configurationPath = join(directory, "fleet.json");
    await writeFile(
      configurationPath,
      JSON.stringify({
        version: 1,
        fleet: "home",
        authority: { id: authority.id, publicKey: authority.publicKey },
        nodes: [
          {
            identity,
            publicIdentity: publicIdentity(identity),
            statePath: "virtual-esp32.json",
          },
        ],
      }),
    );
    const output = capture();

    assert.equal(
      await fleetCliMain({
        argv: ["node", "list", "--json"],
        env: { FLEET_CONFIG: configurationPath },
        io: output.io,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(output.stdout[0]), [
      {
        fleet: "home",
        id: "virtual-esp32",
        kind: "fleet.node-summary",
        version: 1,
      },
    ]);
    assert.equal(output.stderr.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("help needs no secret configuration while execution fails closed without it", async () => {
  const help = capture();
  assert.equal(await fleetCliMain({ argv: ["--help"], env: {}, io: help.io }), 0);
  assert.match(help.stdout.join(""), /node list/);

  const execution = capture();
  assert.equal(
    await fleetCliMain({
      argv: ["node", "list", "--json"],
      env: {},
      io: execution.io,
    }),
    1,
  );
  assert.match(execution.stderr.join(""), /FLEET_CONFIG/);

  const escapedHelp = capture();
  assert.equal(
    await fleetCliMain({
      argv: ["node", "exists", "--", "--help"],
      env: {},
      io: escapedHelp.io,
    }),
    1,
  );
  assert.match(escapedHelp.stderr.join(""), /FLEET_CONFIG/);
  assert.equal(escapedHelp.stdout.length, 0);
});

test("the dedicated bin wrapper runs when Node receives a symlink path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleet-cli-bin-"));
  try {
    const link = join(directory, "fleet");
    await symlink(new URL("./fleet-bin.ts", import.meta.url), link);
    const { stdout } = await execFileAsync(process.execPath, [link, "--help"]);
    assert.match(stdout, /Usage: fleet/);
    assert.match(stdout, /node list/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
