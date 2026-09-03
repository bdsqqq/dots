import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MeshNode,
  publicIdentity,
  type CommandEnvelope,
  type NodeIdentity,
  type ReceiptEnvelope,
} from "./fleet-mesh.ts";
import { validateV1MeshRecord } from "./fleet-protocol.ts";

interface ConformanceFixture {
  authority: {
    id: string;
    publicKey: string;
  };
  identity: NodeIdentity;
  command: CommandEnvelope;
  receipt: ReceiptEnvelope;
}

test("immutable v1 command and receipt ids and signatures survive schema extraction", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./v1-conformance.json", import.meta.url), "utf8"),
  ) as ConformanceFixture;
  const commandReference = fixture.command;
  const receiptReference = fixture.receipt;

  validateV1MeshRecord(fixture.command);
  validateV1MeshRecord(fixture.receipt);
  assert.equal(fixture.command, commandReference);
  assert.equal(fixture.receipt, receiptReference);
  assert.equal(
    fixture.command.id,
    "e0bb33698d9141c727a049d0c7b576092e7959f48dee9fce99909c5211010832",
  );
  assert.equal(
    fixture.command.signature,
    "A6furaAMo1TspHPBRo7xQtKRWQKzOHj1eaicNhNM16oYUP59Nc4nfWdSIN1qB4Vp7Jxd5OjzdGEPy1bVOdJLAA==",
  );

  const node = new MeshNode({
    identity: fixture.identity,
    fleet: "home",
    authority: fixture.authority,
    roster: [publicIdentity(fixture.identity)],
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  assert.equal(node.ingest([fixture.command]), 1);
  assert.deepEqual(node.receiptFor(fixture.command.id), fixture.receipt);
});
