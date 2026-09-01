import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { MeshNode, type MeshNodeSnapshot, type MeshRecord } from "./fleet-mesh.ts";

const MAX_GOSSIP_BYTES = 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_GOSSIP_BYTES) throw new Error("gossip request exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export async function readSnapshot(path: string): Promise<MeshNodeSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as MeshNodeSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSnapshot(path: string, snapshot: MeshNodeSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export interface MeshDaemon {
  url: string;
  contact(peerUrl: string): Promise<number>;
  stop(): Promise<void>;
}

export async function startMeshDaemon(options: {
  node: MeshNode;
  statePath: string;
  hostname?: string;
  port?: number;
}): Promise<MeshDaemon> {
  const hostname = options.hostname ?? "127.0.0.1";
  let save = Promise.resolve();
  const persist = () => {
    save = save.then(() => writeSnapshot(options.statePath, options.node.snapshot()));
    return save;
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/gossip") {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
        if (!Array.isArray(body)) {
          json(response, 400, { error: "gossip body must be a record array" });
          return;
        }
        const accepted = options.node.ingest(body as MeshRecord[]);
        await persist();
        json(response, 200, { accepted, records: options.node.records() });
        return;
      }
      if (request.method === "GET" && request.url === "/state") {
        json(response, 200, options.node.snapshot());
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await persist();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("daemon has no TCP address");
  const url = `http://${hostname}:${address.port}`;

  return {
    url,
    async contact(peerUrl: string): Promise<number> {
      const response = await fetch(new URL("/gossip", peerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options.node.records()),
      });
      if (!response.ok) throw new Error(`peer returned HTTP ${response.status}`);
      const result = (await response.json()) as { records?: unknown };
      if (!Array.isArray(result.records)) throw new Error("peer returned invalid gossip records");
      const accepted = options.node.ingest(result.records as MeshRecord[]);
      await persist();
      return accepted;
    },
    async stop(): Promise<void> {
      await persist();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
