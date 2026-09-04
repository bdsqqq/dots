import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  copyFile,
  type FileHandle,
  mkdtemp,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNodeIdentity,
  FleetAuthority,
  publicIdentity,
  validV1ReceiptRecord,
} from "../fleet-mesh.ts";
import type {
  CommandEnvelope,
  MeshRecord,
  ReceiptEnvelope,
} from "../fleet-protocol.ts";

const CONFIG_OFFSET = 0x250000;
const CONFIG_SIZE = 0x10000;
const firmwareImage = process.env.FLEET_FIRMWARE_IMAGE;
const qemu = process.env.FLEET_QEMU;

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server has no TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  const waitForExit = (timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer);
        child.off("exit", complete);
        child.off("close", complete);
        resolve();
      };
      const timer = setTimeout(() => {
        child.off("exit", complete);
        child.off("close", complete);
        reject(new Error("QEMU did not stop"));
      }, timeoutMs);
      child.once("exit", complete);
      child.once("close", complete);
    });
  const gracefulExit = waitForExit(5_000);
  child.kill("SIGTERM");
  try {
    await gracefulExit;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forcedExit = waitForExit(5_000);
    child.kill("SIGKILL");
    await forcedExit;
  }
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`condition was not met within ${timeoutMs}ms`);
}

function receiptFor(
  records: readonly MeshRecord[],
  command: CommandEnvelope,
): ReceiptEnvelope | undefined {
  return records.find(
    (record): record is ReceiptEnvelope =>
      record.kind === "receipt" && record.commandId === command.id,
  );
}

test(
  "QEMU synchronizes UTC before command outcomes and advances pending schedules",
  {
    skip:
      firmwareImage && qemu
        ? false
        : "set FLEET_FIRMWARE_IMAGE and FLEET_QEMU for the isolated guest test",
    timeout: 120_000,
  },
  async () => {
    assert.ok(firmwareImage);
    assert.ok(qemu);
    const directory = await mkdtemp(join(tmpdir(), "fleet-clock-qemu-"));
    const logPath = join(directory, "qemu.log");
    const packetCapturePath = join(directory, "qemu.pcap");
    const observerRecords: MeshRecord[] = [];
    const observer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const records: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(Array.isArray(records));
        observerRecords.splice(
          0,
          observerRecords.length,
          ...(records as MeshRecord[]),
        );
        const body = '{"accepted":0,"records":[]}';
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        });
        response.end(body);
      });
    });
    let guest: ChildProcess | undefined;
    let guestError: Error | undefined;
    let log: FileHandle | undefined;
    let failed = false;
    try {
      const observerPort = await listen(observer);
      const healthProbe = createServer();
      const guestPort = await listen(healthProbe);
      await close(healthProbe);

      const authority = new FleetAuthority("fleet-admin");
      const identity = createNodeIdentity("clock-guest");
      const peer = createNodeIdentity("peer-observer");
      const configuration = {
        version: 1,
        fleet: "home",
        authority: {
          id: authority.id,
          publicKey: authority.publicKey,
        },
        identity,
        roster: [publicIdentity(identity), publicIdentity(peer)],
        peers: [
          {
            id: peer.id,
            url: `http://10.0.2.2:${observerPort}`,
          },
        ],
        contactIntervalMs: 250,
        contactTimeoutMs: 200,
      };
      const payload = Buffer.from(JSON.stringify(configuration));
      assert.ok(payload.length + 4 <= CONFIG_SIZE);
      const flash = join(directory, "flash.bin");
      await copyFile(firmwareImage, flash);
      await chmod(flash, 0o600);
      const handle = await open(flash, "r+");
      try {
        const partition = Buffer.alloc(CONFIG_SIZE, 0xff);
        partition.writeUInt32LE(payload.length);
        payload.copy(partition, 4);
        await handle.write(partition, 0, partition.length, CONFIG_OFFSET);
      } finally {
        await handle.close();
      }

      log = await open(logPath, "w");
      guest = spawn(
        qemu,
        [
          "-nographic",
          "-machine",
          "esp32s3",
          "-drive",
          `file=${flash},if=mtd,format=raw`,
          "-nic",
          `user,id=clock-net,model=open_eth,hostfwd=tcp:127.0.0.1:${guestPort}-:80`,
          "-object",
          `filter-dump,id=clock-pcap,netdev=clock-net,file=${packetCapturePath}`,
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      guest.once("error", (error) => {
        guestError = error;
      });

      await waitFor(async () => {
        if (guestError) throw guestError;
        if (guest && guest.exitCode !== null) {
          throw new Error(`QEMU exited before health with ${guest.exitCode}`);
        }
        const response = await fetch(`http://127.0.0.1:${guestPort}/health`);
        return response.ok ? true : undefined;
      }, 30_000);
      await waitFor(async () => {
        const text = await readFile(logPath, "utf8");
        return text.includes("wall clock synchronized at") ? true : undefined;
      }, 60_000);

      const post = async (records: readonly MeshRecord[]) => {
        const response = await fetch(`http://127.0.0.1:${guestPort}/gossip`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(records),
        });
        assert.equal(response.status, 200);
        return (await response.json()) as {
          accepted: number;
          records: MeshRecord[];
        };
      };
      const recipient = publicIdentity(identity);
      const plain = authority.issueSet({
        fleet: "home",
        recipient,
        resource: "clock:plain",
        revision: { epoch: Date.now(), sequence: 0 },
        value: true,
      });
      const plainResponse = await post([plain]);
      const plainReceipt = receiptFor(plainResponse.records, plain);
      assert.ok(plainReceipt);
      assert.equal(plainReceipt.status, "applied");
      assert.equal(validV1ReceiptRecord(plainReceipt, plain, recipient), true);
      assert.ok(Math.abs(Date.parse(plainReceipt.recordedAt) - Date.now()) < 60_000);

      const expired = authority.issueSet({
        fleet: "home",
        recipient,
        resource: "clock:expired",
        revision: { epoch: Date.now(), sequence: 1 },
        value: true,
        expiresAt: new Date(Date.now() - 1_000),
      });
      const expiredResponse = await post([expired]);
      const expiredReceipt = receiptFor(expiredResponse.records, expired);
      assert.ok(expiredReceipt);
      assert.equal(expiredReceipt.status, "rejected");
      assert.equal(expiredReceipt.reason, "expired");
      assert.equal(validV1ReceiptRecord(expiredReceipt, expired, recipient), true);

      const notBefore = new Date(Date.now() + 3_000);
      const scheduled = authority.issueSet({
        fleet: "home",
        recipient,
        resource: "clock:scheduled",
        revision: { epoch: Date.now(), sequence: 2 },
        value: true,
        notBefore,
      });
      const scheduledResponse = await post([scheduled]);
      assert.equal(receiptFor(scheduledResponse.records, scheduled), undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(receiptFor(observerRecords, scheduled), undefined);

      const scheduledReceipt = await waitFor(async () => {
        const candidate = receiptFor(observerRecords, scheduled);
        return candidate;
      }, 8_000);
      assert.equal(scheduledReceipt.status, "applied");
      assert.equal(
        validV1ReceiptRecord(scheduledReceipt, scheduled, recipient),
        true,
      );
      assert.ok(Date.parse(scheduledReceipt.recordedAt) >= notBefore.getTime());

      const replay = await post([scheduled]);
      assert.equal(replay.accepted, 0);
      assert.deepEqual(receiptFor(replay.records, scheduled), scheduledReceipt);
    } catch (error) {
      failed = true;
      console.error(await readFile(logPath, "utf8").catch(() => ""));
      if (process.env.FLEET_KEEP_FAILED_QEMU === "1") {
        console.error(`QEMU failure artifacts: ${directory}`);
      }
      throw error;
    } finally {
      let cleanupError: unknown;
      if (guest) {
        try {
          await stop(guest);
        } catch (error) {
          cleanupError = error;
        }
      }
      const cleanup = await Promise.allSettled([log?.close(), close(observer)]);
      cleanupError ??= cleanup.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )?.reason;
      if (!failed || process.env.FLEET_KEEP_FAILED_QEMU !== "1") {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (!failed && cleanupError) throw cleanupError;
    }
  },
);
