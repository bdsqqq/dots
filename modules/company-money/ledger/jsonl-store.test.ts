import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ingestLedger } from "./ingest.ts";
import {
  JsonlLedgerStore,
  JsonlLedgerStoreError,
  encodeCanonicalJsonl,
} from "./jsonl-store.ts";
import { emptyLedgerSnapshot } from "./state.ts";
import {
  syntheticBatch,
  syntheticCandidate,
  syntheticIdentity,
} from "./test-fixtures.ts";

async function privateRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "company-money-store-"));
  const root = join(parent, "ledger");
  await mkdir(root, { mode: 0o700 });
  return root;
}

async function removeRoot(root: string): Promise<void> {
  await rm(join(root, ".."), { recursive: true, force: true });
}

const transferPolicy = { isEligibleAccountPair: () => false };

test("CAS commits canonical bytes, revisions, and private modes atomically", async () => {
  const root = await privateRoot();
  try {
    const store = new JsonlLedgerStore({ rootPath: root });
    const next = {
      ...emptyLedgerSnapshot(),
      quarantine: [
        {
          kind: "company-money.quarantine-entry" as const,
          version: 1 as const,
          id: "quarantine-1",
          provider: "synthetic",
          channel: "synthetic",
          sourceRef: "opaque-source",
          evidenceId: "evidence-quarantine",
          contentDigest: "digest",
          parserId: "synthetic-parser",
          parserVersion: 1 as const,
          reason: "unsupported-template" as const,
          resolution: "pending" as const,
        },
      ],
    };
    assert.equal(await store.compareAndSwap(null, next), "committed");
    const bytes = await readFile(join(root, "ledger.jsonl"));
    const current = await store.read();
    assert.equal(current.revision, createHash("sha256").update(bytes).digest("hex"));
    assert.doesNotMatch(bytes.toString("utf8"), new RegExp(current.revision!));
    assert.deepEqual(current.snapshot, next);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, "state"))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, "exports"))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, "ledger.jsonl"))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(root)).sort(), ["exports", "ledger.jsonl", "state"]);
    assert.deepEqual(await readdir(join(root, "state")), []);
  } finally {
    await removeRoot(root);
  }
});

test("concurrent incremental ingestion cannot lose either update", async () => {
  const root = await privateRoot();
  try {
    const store = new JsonlLedgerStore({ rootPath: root, lockDelayMs: 2, lockAttempts: 100 });
    await Promise.all([
      ingestLedger(
        syntheticBatch([
          syntheticCandidate({
            providerTransactionId: "transaction-a",
            evidence: {
              ...syntheticCandidate().evidence,
              id: "evidence-a",
              contentDigest: "content-a",
            },
            classification: {
              ...syntheticCandidate().classification,
              evidenceIds: ["evidence-a"],
            },
          }),
        ]),
        { identity: syntheticIdentity, store, transferPolicy, maxCasAttempts: 10 },
      ),
      ingestLedger(
        syntheticBatch([
          syntheticCandidate({
            providerTransactionId: "transaction-b",
            evidence: {
              ...syntheticCandidate().evidence,
              id: "evidence-b",
              contentDigest: "content-b",
            },
            classification: {
              ...syntheticCandidate().classification,
              evidenceIds: ["evidence-b"],
            },
          }),
        ]),
        { identity: syntheticIdentity, store, transferPolicy, maxCasAttempts: 10 },
      ),
    ]);
    assert.equal((await store.read()).snapshot.transactions.length, 2);
  } finally {
    await removeRoot(root);
  }
});

test("canonical encoding ignores array order and stale CAS preserves state", async () => {
  const first = {
    ...emptyLedgerSnapshot(),
    quarantine: [
      {
        kind: "company-money.quarantine-entry" as const,
        version: 1 as const,
        id: "b",
        provider: "synthetic",
        channel: "synthetic",
        sourceRef: "source-b",
        evidenceId: "evidence-b",
        contentDigest: "content-b",
        parserId: "synthetic",
        parserVersion: 1 as const,
        reason: "malformed-record" as const,
        resolution: "pending" as const,
      },
      {
        kind: "company-money.quarantine-entry" as const,
        version: 1 as const,
        id: "a",
        provider: "synthetic",
        channel: "synthetic",
        sourceRef: "source-a",
        evidenceId: "evidence-a",
        contentDigest: "content-a",
        parserId: "synthetic",
        parserVersion: 1 as const,
        reason: "malformed-record" as const,
        resolution: "pending" as const,
      },
    ],
  };
  assert.ok(
    encodeCanonicalJsonl(first).equals(
      encodeCanonicalJsonl({ ...first, quarantine: [...first.quarantine].reverse() }),
    ),
  );

  const root = await privateRoot();
  try {
    const store = new JsonlLedgerStore({ rootPath: root });
    await store.compareAndSwap(null, first);
    const before = await store.read();
    assert.equal(await store.compareAndSwap("stale", emptyLedgerSnapshot()), "conflict");
    assert.deepEqual(await store.read(), before);
  } finally {
    await removeRoot(root);
  }
});

test("corrupt, future, oversized, wrong-mode, and symlink ledgers fail closed", async () => {
  const cases: Array<{
    name: string;
    prepare(root: string): Promise<void>;
    options?: { maxLedgerBytes: number };
    reason?: string;
  }> = [
    {
      name: "corrupt",
      prepare: async (root) => writeFile(join(root, "ledger.jsonl"), "not-json\n", { mode: 0o600 }),
      reason: "corrupt",
    },
    {
      name: "future",
      prepare: async (root) =>
        writeFile(
          join(root, "ledger.jsonl"),
          '{"id":"future","kind":"company-money.transaction","version":2}\n',
          { mode: 0o600 },
        ),
      reason: "future-version",
    },
    {
      name: "oversized",
      prepare: async (root) => writeFile(join(root, "ledger.jsonl"), "123456", { mode: 0o600 }),
      options: { maxLedgerBytes: 5 },
      reason: "unreadable",
    },
    {
      name: "wrong-mode",
      prepare: async (root) => writeFile(join(root, "ledger.jsonl"), "", { mode: 0o644 }),
      reason: "unreadable",
    },
    {
      name: "symlink",
      prepare: async (root) => {
        const target = join(root, "target");
        await writeFile(target, "", { mode: 0o600 });
        await symlink(target, join(root, "ledger.jsonl"));
      },
      reason: "unreadable",
    },
  ];
  for (const entry of cases) {
    const root = await privateRoot();
    try {
      await entry.prepare(root);
      const store = new JsonlLedgerStore({ rootPath: root, ...entry.options });
      await assert.rejects(
        () => store.read(),
        (error: unknown) =>
          error instanceof JsonlLedgerStoreError &&
          error.ledgerUnavailableReason === entry.reason,
        entry.name,
      );
    } finally {
      await removeRoot(root);
    }
  }
});

test("a failed commit leaves the prior revision and no temporary files", async () => {
  const root = await privateRoot();
  try {
    const store = new JsonlLedgerStore({ rootPath: root });
    await store.compareAndSwap(null, emptyLedgerSnapshot());
    const before = await store.read();
    await rm(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state"), "not-a-directory", { mode: 0o600 });
    await assert.rejects(() => store.compareAndSwap(before.revision, emptyLedgerSnapshot()));
    assert.deepEqual(await store.read(), before);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await chmod(join(root, "state"), 0o600).catch(() => undefined);
    await removeRoot(root);
  }
});
