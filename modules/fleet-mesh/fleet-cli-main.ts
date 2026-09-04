#!/usr/bin/env node

import { runFleetCli, type FleetCliIO } from "./fleet-cli.ts";
import { createFleetClient } from "./fleet-node.ts";
import { LocalFleetRuntime } from "./local-fleet-runtime.ts";
import { loadLocalFleetRuntimeOptions } from "./local-fleet-config.ts";

export interface FleetCliMainOptions {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  io?: FleetCliIO;
}

const processIO: FleetCliIO = {
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function fleetCliMain(options: FleetCliMainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const io = options.io ?? processIO;

  const delimiter = argv.indexOf("--");
  const controlArguments = delimiter === -1 ? argv : argv.slice(0, delimiter);
  if (argv.length === 0 || controlArguments.includes("--help")) {
    return runFleetCli({ argv, io });
  }

  const configurationPath = env.FLEET_CONFIG;
  if (!configurationPath) {
    io.stderr("FLEET_CONFIG must name an explicit local fleet configuration file\n");
    return 1;
  }

  try {
    const runtime = await LocalFleetRuntime.create(
      await loadLocalFleetRuntimeOptions(configurationPath),
    );
    return runFleetCli({
      argv,
      client: createFleetClient(runtime, runtime.desiredStateController),
      io,
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
