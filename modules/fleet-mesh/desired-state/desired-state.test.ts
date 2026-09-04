import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ORPCError, traverseContractProcedures } from "@orpc/server";

import {
  createNodeIdentity,
  FleetAuthority,
  MeshNode,
  publicIdentity,
  type NodeIdentity,
} from "../fleet-mesh.ts";
import {
  validateV1MeshRecords,
  type MeshRecord,
  type PublicIdentity,
  type ReceiptEnvelope,
  type Revision,
} from "../fleet-protocol.ts";
import {
  createDesiredStateClient,
  DesiredStateRevisionStateV1Schema,
  FileDesiredStateController,
  type FileDesiredStateControllerOptions,
} from "./local.ts";
import {
  CommandNotFoundV1Schema,
  desiredStateContract,
  desiredStateSchemaCatalog,
  DesiredStateSetInputV1Schema,
  DesiredStateStatusV1Schema,
  DesiredStateSubmissionV1Schema,
  getDesiredStateStatus,
  setDesiredState,
  type DesiredStateController,
} from "./public.ts";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function pem(key: KeyObject, format: "pkcs8" | "spki"): string {
  return key.export({ format: "pem", type: format }).toString();
}

function authorityKeys() {
  const keys = generateKeyPairSync("ed25519");
  return {
    id: "fleet-admin",
    privateKey: pem(keys.privateKey, "pkcs8"),
    publicKey: pem(keys.publicKey, "spki"),
  };
}

class FakeBridge {
  readonly bridge: MeshNode;
  readonly recipient: MeshNode;
  readonly submissions: MeshRecord[][] = [];
  readonly fetch: typeof globalThis.fetch;
  responseRecords: ((records: MeshRecord[]) => MeshRecord[]) | undefined;
  acceptedOverride: number | undefined;

  constructor(
    authority: { id: string; publicKey: string },
    recipientIdentity: NodeIdentity,
  ) {
    const bridgeIdentity = createNodeIdentity("bridge");
    const roster = [publicIdentity(bridgeIdentity), publicIdentity(recipientIdentity)];
    this.bridge = new MeshNode({
      identity: bridgeIdentity,
      fleet: "home",
      authority,
      roster,
      clock: () => NOW,
    });
    this.recipient = new MeshNode({
      identity: recipientIdentity,
      fleet: "home",
      authority,
      roster,
      clock: () => NOW,
    });
    this.fetch = async (input, init) => {
      assert.equal(
        new URL(input instanceof Request ? input.url : input).pathname,
        "/gossip",
      );
      assert.equal(init?.method, "POST");
      assert.equal(typeof init?.body, "string");
      const records: unknown = JSON.parse(init.body as string);
      validateV1MeshRecords(records);
      this.submissions.push(structuredClone(records));
      const accepted = this.bridge.ingest(records);
      const returned = this.responseRecords?.(this.bridge.records()) ??
        this.bridge.records();
      return new Response(
        JSON.stringify({
          accepted: this.acceptedOverride ?? accepted,
          records: returned,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
  }

  deliver(): void {
    this.recipient.ingest(this.bridge.records());
    this.bridge.ingest(this.recipient.records());
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fleet-desired-state-"));
  const authority = authorityKeys();
  const recipientIdentity = createNodeIdentity("kitchen");
  const recipient = publicIdentity(recipientIdentity);
  const bridge = new FakeBridge(authority, recipientIdentity);
  const revisionStatePath = join(directory, "revision.json");
  const options: FileDesiredStateControllerOptions = {
    fleet: "home",
    authority: { id: authority.id, publicKey: authority.publicKey },
    authorityPrivateKey: authority.privateKey,
    recipients: [recipient],
    bridgeOrigin: "http://bridge.test",
    revisionStatePath,
    fetch: bridge.fetch,
    clock: () => NOW,
  };
  return { directory, authority, recipient, bridge, revisionStatePath, options };
}

function assertLater(left: Revision, right: Revision): void {
  assert.ok(
    right.epoch > left.epoch ||
      (right.epoch === left.epoch && right.sequence > left.sequence),
  );
}

function schemaReceipt(): ReceiptEnvelope {
  return {
    kind: "receipt",
    id: "receipt",
    commandId: "command",
    node: "kitchen",
    resource: "light:kitchen",
    revision: { epoch: 1, sequence: 0 },
    status: "applied",
    reason: null,
    resultingRevision: { epoch: 1, sequence: 0 },
    recordedAt: NOW.toISOString(),
    signature: "signature",
  };
}

test("desired-state schemas are exact, recursive, relational, and cataloged", () => {
  const input = {
    nodeId: "kitchen",
    resource: "display:portrait",
    value: { page: 2, layers: [null, true, "ink"] },
    notBefore: NOW.toISOString(),
  };
  assert.equal(DesiredStateSetInputV1Schema.assert(input), input);
  assert.throws(() =>
    DesiredStateSetInputV1Schema.assert({ ...input, extra: true }),
  );
  assert.throws(() =>
    DesiredStateSetInputV1Schema.assert({
      ...input,
      value: { unsafe: Number.MAX_SAFE_INTEGER + 1 },
    }),
  );
  DesiredStateSubmissionV1Schema.assert({
    kind: "fleet.desired-state-submission",
    version: 1,
    commandId: "command",
    revision: { epoch: 1, sequence: 2 },
  });
  DesiredStateStatusV1Schema.assert({
    kind: "fleet.desired-state-status",
    version: 1,
    commandId: "command",
    state: "pending",
    receipt: null,
  });
  DesiredStateStatusV1Schema.assert({
    kind: "fleet.desired-state-status",
    version: 1,
    commandId: "command",
    state: "recorded",
    receipt: schemaReceipt(),
  });
  assert.throws(() =>
    DesiredStateStatusV1Schema.assert({
      kind: "fleet.desired-state-status",
      version: 1,
      commandId: "command",
      state: "pending",
      receipt: schemaReceipt(),
    }),
  );
  assert.throws(() =>
    DesiredStateStatusV1Schema.assert({
      kind: "fleet.desired-state-status",
      version: 1,
      commandId: "command",
      state: "recorded",
      receipt: null,
    }),
  );
  CommandNotFoundV1Schema.assert({
    kind: "fleet.command-not-found",
    version: 1,
    commandId: "missing",
  });
  assert.deepEqual(Object.keys(desiredStateSchemaCatalog), [
    "fleet.desired-state-set-input",
    "fleet.desired-state-submission",
    "fleet.desired-state-status",
    "fleet.command-not-found",
  ]);
  for (const versions of Object.values(desiredStateSchemaCatalog)) {
    assert.deepEqual(Object.keys(versions), ["1"]);
  }

  const metadata = new Map<string, unknown>();
  traverseContractProcedures(
    { router: desiredStateContract, path: [] },
    ({ contract, path }) => metadata.set(path.join("."), contract["~orpc"].meta),
  );
  assert.deepEqual(metadata.get("set"), {
    id: "desired-state.set",
    version: 1,
    summary: "set desired state for a fleet node resource",
    cli: { input: "json" },
  });
  assert.deepEqual(metadata.get("status"), {
    id: "desired-state.status",
    version: 1,
    summary: "get desired-state command status",
    cli: { input: "scalar", argument: "commandId" },
  });
});

test("plain use cases remain independently callable", async () => {
  const submission = {
    kind: "fleet.desired-state-submission" as const,
    version: 1 as const,
    commandId: "command",
    revision: { epoch: 1, sequence: 0 },
  };
  const pending = {
    kind: "fleet.desired-state-status" as const,
    version: 1 as const,
    commandId: "command",
    state: "pending" as const,
    receipt: null,
  };
  const controller: DesiredStateController = {
    set: async (input) => (input.nodeId === "kitchen" ? submission : undefined),
    status: async (commandId) => (commandId === "command" ? pending : undefined),
  };
  assert.equal(
    await setDesiredState(controller, {
      nodeId: "kitchen",
      resource: "light:kitchen",
      value: true,
    }),
    submission,
  );
  assert.equal(
    await setDesiredState(controller, {
      nodeId: "missing",
      resource: "light:kitchen",
      value: true,
    }),
    undefined,
  );
  assert.equal(await getDesiredStateStatus(controller, "command"), pending);
  assert.equal(await getDesiredStateStatus(controller, "missing"), undefined);
});

test("local oRPC binding exposes typed node and command not-found errors", async () => {
  const controller: DesiredStateController = {
    set: async (input) =>
      input.nodeId === "kitchen"
        ? {
            kind: "fleet.desired-state-submission",
            version: 1,
            commandId: "command",
            revision: { epoch: 1, sequence: 0 },
          }
        : undefined,
    status: async () => undefined,
  };
  const client = createDesiredStateClient(controller);
  assert.deepEqual(
    await client.set({
      nodeId: "kitchen",
      resource: "light:kitchen",
      value: true,
    }),
    {
      kind: "fleet.desired-state-submission",
      version: 1,
      commandId: "command",
      revision: { epoch: 1, sequence: 0 },
    },
  );
  await assert.rejects(
    () =>
      client.set({
        nodeId: "missing",
        resource: "light:kitchen",
        value: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ORPCError);
      assert.equal(error.code, "NODE_NOT_FOUND");
      assert.deepEqual(error.data, {
        kind: "fleet.node-not-found",
        version: 1,
        id: "missing",
      });
      return true;
    },
  );
  await assert.rejects(
    () => client.status("missing"),
    (error: unknown) => {
      assert.ok(error instanceof ORPCError);
      assert.equal(error.code, "COMMAND_NOT_FOUND");
      assert.deepEqual(error.data, {
        kind: "fleet.command-not-found",
        version: 1,
        commandId: "missing",
      });
      return true;
    },
  );
});

test("constructor rejects authority mismatch and non-exact or duplicate recipients", async () => {
  const context = await fixture();
  try {
    const other = authorityKeys();
    assert.throws(
      () =>
        new FileDesiredStateController({
          ...context.options,
          authority: {
            ...context.options.authority,
            publicKey: other.publicKey,
          },
        }),
      /public key does not match private key/,
    );
    assert.throws(
      () =>
        new FileDesiredStateController({
          ...context.options,
          recipients: [context.recipient, context.recipient],
        }),
      /duplicate recipient id/,
    );
    assert.throws(() =>
      new FileDesiredStateController({
        ...context.options,
        recipients: [
          { ...context.recipient, privateKey: "nope" } as PublicIdentity,
        ],
      }),
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test(
  "file controller persists increasing revisions and includes authenticated bridge history",
  async () => {
    const context = await fixture();
    try {
      const authority = new FleetAuthority(
        context.authority.id,
        context.authority.privateKey,
      );
      const bridgeRevision = { epoch: NOW.getTime() + 1000, sequence: 7 };
      const existing = authority.issueSet({
        fleet: "home",
        recipient: context.recipient,
        resource: "light:kitchen",
        revision: bridgeRevision,
        value: false,
      });
      assert.equal(context.bridge.bridge.ingest([existing]), 1);

      const firstController = new FileDesiredStateController(context.options);
      const first = await firstController.set({
        nodeId: "kitchen",
        resource: "light:kitchen",
        value: true,
      });
      assert.ok(first);
      assertLater(bridgeRevision, first.revision);

      const secondController = new FileDesiredStateController(context.options);
      const second = await secondController.set({
        nodeId: "kitchen",
        resource: "light:kitchen",
        value: false,
      });
      assert.ok(second);
      assertLater(first.revision, second.revision);

      const persisted: unknown = JSON.parse(
        await readFile(context.revisionStatePath, "utf8"),
      );
      const state = DesiredStateRevisionStateV1Schema.assert(persisted);
      assert.deepEqual(state.revision, second.revision);
      assert.equal((await stat(context.revisionStatePath)).mode & 0o777, 0o600);
      await assert.rejects(() => stat(`${context.revisionStatePath}.lock`), {
        code: "ENOENT",
      });
      assert.ok(
        context.bridge.submissions.some(
          (records) => records.length === 1 && records[0]?.id === first.commandId,
        ),
      );
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  },
);

test("ten controllers allocate unique revisions and recover a stale lock", async () => {
  const context = await fixture();
  try {
    const lockPath = `${context.revisionStatePath}.lock`;
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 20_000);
    await utimes(lockPath, stale, stale);

    const submissions = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        new FileDesiredStateController(context.options).set({
          nodeId: "kitchen",
          resource: "light:kitchen",
          value: index,
        }),
      ),
    );
    assert.ok(submissions.every((submission) => submission !== undefined));
    const revisions = submissions.map((submission) => submission!.revision);
    assert.equal(
      new Set(revisions.map(({ epoch, sequence }) => `${epoch}:${sequence}`)).size,
      10,
    );
    const ordered = revisions.toSorted((left, right) =>
      left.epoch === right.epoch
        ? left.sequence - right.sequence
        : left.epoch - right.epoch,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      assertLater(ordered[index - 1]!, ordered[index]!);
    }
    await assert.rejects(() => stat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("forged command history cannot raise allocated revisions", async () => {
  const context = await fixture();
  try {
    const authority = new FleetAuthority(
      context.authority.id,
      context.authority.privateKey,
    );
    const valid = authority.issueSet({
      fleet: "home",
      recipient: context.recipient,
      resource: "light:kitchen",
      revision: { epoch: 1, sequence: 0 },
      value: false,
    });
    context.bridge.responseRecords = (records) => [
      ...records,
      {
        ...valid,
        id: "forged-history",
        header: {
          ...valid.header,
          revision: { epoch: Number.MAX_SAFE_INTEGER, sequence: 0 },
        },
      },
    ];
    const controller = new FileDesiredStateController(context.options);
    await assert.rejects(
      () =>
        controller.set({
          nodeId: "kitchen",
          resource: "light:kitchen",
          value: true,
        }),
      /invalid command record/,
    );
    await assert.rejects(() => stat(context.revisionStatePath), { code: "ENOENT" });
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("forged receipts and wrong-kind command id collisions fail closed", async () => {
  const context = await fixture();
  try {
    const controller = new FileDesiredStateController(context.options);
    const submission = await controller.set({
      nodeId: "kitchen",
      resource: "display:portrait",
      value: { page: 3 },
    });
    assert.ok(submission);
    context.bridge.deliver();
    const records = context.bridge.bridge.records();
    const receipt = records.find(
      (record): record is ReceiptEnvelope => record.kind === "receipt",
    );
    assert.ok(receipt);

    context.bridge.responseRecords = (current) =>
      current.map((record) =>
        record.id === receipt.id
          ? { ...receipt, status: "rejected", reason: "stale" }
          : record,
      );
    await assert.rejects(
      () => controller.status(submission.commandId),
      /invalid receipt record/,
    );

    context.bridge.responseRecords = (current) => [
      ...current.filter(
        (record) =>
          record.id !== submission.commandId && record.id !== receipt.id,
      ),
      { ...receipt, id: submission.commandId },
    ];
    await assert.rejects(
      () => controller.status(submission.commandId),
      /invalid receipt record/,
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test(
  "status moves from pending to an authenticated recipient receipt without private output",
  async () => {
    const context = await fixture();
    try {
      const controller = new FileDesiredStateController(context.options);
      const submission = await controller.set({
        nodeId: "kitchen",
        resource: "display:portrait",
        value: { page: 3 },
      });
      assert.ok(submission);
      const pending = await controller.status(submission.commandId);
      assert.deepEqual(pending, {
        kind: "fleet.desired-state-status",
        version: 1,
        commandId: submission.commandId,
        state: "pending",
        receipt: null,
      });
      assert.equal(await controller.status("missing"), undefined);

      context.bridge.deliver();
      const recorded = await controller.status(submission.commandId);
      assert.equal(recorded?.state, "recorded");
      assert.equal(recorded.receipt.commandId, submission.commandId);
      assert.equal(recorded.receipt.node, "kitchen");
      assert.equal(recorded.receipt.status, "applied");

      const outputs = JSON.stringify({ submission, pending, recorded });
      assert.equal(outputs.includes(context.authority.privateKey), false);
      assert.equal(
        outputs.includes(context.bridge.recipient.identity.signingPrivateKey),
        false,
      );
      assert.equal(
        outputs.includes(context.bridge.recipient.identity.encryptionPrivateKey),
        false,
      );
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  },
);

test("bridge responses are exact, nonnegative, and capped at 1 MiB", async () => {
  const context = await fixture();
  try {
    const malformed = new FileDesiredStateController({
      ...context.options,
      fetch: (async () =>
        new Response(
          JSON.stringify({ accepted: 0, records: [], extra: true }),
        )) as typeof globalThis.fetch,
    });
    await assert.rejects(() => malformed.status("missing"));

    const negative = new FileDesiredStateController({
      ...context.options,
      fetch: (async () =>
        new Response(
          JSON.stringify({ accepted: -1, records: [] }),
        )) as typeof globalThis.fetch,
    });
    await assert.rejects(
      () => negative.status("missing"),
      /accepted count cannot be negative/,
    );

    const oversized = new FileDesiredStateController({
      ...context.options,
      fetch: (async () =>
        new Response("x".repeat(1024 * 1024 + 1))) as typeof globalThis.fetch,
    });
    await assert.rejects(
      () => oversized.status("missing"),
      /response exceeds 1 MiB/,
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test(
  "duplicate response ids and missing exact submission acknowledgements are rejected",
  async () => {
    const context = await fixture();
    try {
      context.bridge.responseRecords = (records) =>
        records.length > 0 ? [...records, structuredClone(records[0]!)] : records;
      const duplicate = new FileDesiredStateController(context.options);
      await assert.rejects(
        () =>
          duplicate.set({
            nodeId: "kitchen",
            resource: "light:kitchen",
            value: true,
          }),
        /duplicate record id/,
      );

      context.bridge.responseRecords = (records) => records.slice(0, -1);
      const missing = new FileDesiredStateController(context.options);
      await assert.rejects(
        () =>
          missing.set({
            nodeId: "kitchen",
            resource: "display:portrait",
            value: true,
          }),
        /did not acknowledge the submitted command exactly/,
      );
    } finally {
      await rm(context.directory, { recursive: true, force: true });
    }
  },
);
