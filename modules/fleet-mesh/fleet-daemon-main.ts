import {
  loadFleetDaemonConfiguration,
  type FleetDaemonPublicConfigurationV1,
} from "./fleet-daemon-config.ts";
import { startMeshDaemon, type MeshDaemon } from "./daemon.ts";
import { MeshNode, type PublicIdentity } from "./fleet-mesh.ts";
import { readSnapshot } from "./daemon.ts";

export interface FleetDaemonLog {
  info(message: string): void;
  error(message: string): void;
}

export interface RunningConfiguredFleetDaemon {
  node: MeshNode;
  daemon: MeshDaemon;
  contactNow(): Promise<void>;
  stop(): Promise<void>;
}

function peerError(peerId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `fleet peer ${peerId} contact failed: ${detail}`;
}

export async function startConfiguredFleetDaemon(options: {
  publicConfigurationPath: string;
  identityPath: string;
  log?: FleetDaemonLog;
}): Promise<RunningConfiguredFleetDaemon> {
  const log = options.log ?? console;
  const { publicConfiguration, identity, statePath } =
    await loadFleetDaemonConfiguration(
      options.publicConfigurationPath,
      options.identityPath,
    );
  const snapshot = await readSnapshot(statePath);
  const node = new MeshNode({
    identity,
    fleet: publicConfiguration.fleet,
    authority: publicConfiguration.authority,
    roster: publicConfiguration.roster as PublicIdentity[],
    snapshot,
  });
  const daemon = await startMeshDaemon({
    node,
    statePath,
    hostname: publicConfiguration.node.hostname,
    port: publicConfiguration.node.port,
  });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let round = Promise.resolve();
  const activeControllers = new Set<AbortController>();

  const performRound = async () => {
    for (const peer of publicConfiguration.peers) {
      if (stopped) return;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(
        () => controller.abort(new Error("fleet peer contact timed out")),
        publicConfiguration.contactTimeoutMs,
      );
      try {
        await daemon.contact(peer.url, { signal: controller.signal });
      } catch (error) {
        if (!stopped) log.error(peerError(peer.id, error));
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    }
  };

  const enqueueRound = () => {
    const next = round.then(performRound);
    round = next.catch(() => undefined);
    return next;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await enqueueRound();
      schedule();
    }, publicConfiguration.contactIntervalMs);
  };
  schedule();

  log.info(`fleet daemon ${node.id} listening on ${daemon.url}`);
  return {
    node,
    daemon,
    contactNow: enqueueRound,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const controller of activeControllers) controller.abort();
      await round;
      await daemon.stop();
    },
  };
}

interface FleetDaemonMainIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

function usage(): string {
  return [
    "usage: fleet-daemon --config <public-config.json> --identity <identity.json>",
    "",
    "runs one loopback fleet node with explicit autonomous peers",
    "",
  ].join("\n");
}

function parseArguments(argv: readonly string[]):
  | { help: true }
  | { help: false; publicConfigurationPath: string; identityPath: string } {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  if (
    argv.length === 4 &&
    argv[0] === "--config" &&
    argv[2] === "--identity"
  ) {
    return {
      help: false,
      publicConfigurationPath: argv[1],
      identityPath: argv[3],
    };
  }
  throw new Error("expected --config <path> --identity <path>");
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

export async function fleetDaemonMain(
  argv: readonly string[] = process.argv.slice(2),
  io: FleetDaemonMainIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let running: RunningConfiguredFleetDaemon | undefined;
  try {
    const arguments_ = parseArguments(argv);
    if (arguments_.help) {
      io.stdout(usage());
      return 0;
    }
    running = await startConfiguredFleetDaemon({
      publicConfigurationPath: arguments_.publicConfigurationPath,
      identityPath: arguments_.identityPath,
      log: {
        info: (message) => io.stdout(`${message}\n`),
        error: (message) => io.stderr(`${message}\n`),
      },
    });
    await waitForTermination();
    await running.stop();
    return 0;
  } catch (error) {
    await running?.stop().catch(() => undefined);
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
