import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export type WorkflowNodeStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowNodeRecord {
  nodeId: string;
  key: string;
  inputHash: string;
  status: WorkflowNodeStatus;
  phase?: string;
  label?: string;
  recipe?: "delegate" | "oracle" | "librarian" | "finder";
  childSessionId?: string;
  childSessionFile?: string;
  result?: unknown;
  error?: string;
  usage: WorkflowUsage;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowRunJournal {
  version: 1;
  runId: string;
  workflow: {
    name: string;
    description: string;
    phases?: string[];
    agents?: Array<"delegate" | "oracle" | "librarian" | "finder">;
    source: string;
    scriptHash: string;
  };
  invoking: {
    sessionId: string;
    sessionFile: string;
    cwd: string;
  };
  limits: { maxConcurrency: number; maxAgents: number };
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  nodes: WorkflowNodeRecord[];
}

export const ZERO_USAGE: WorkflowUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

export function aggregateUsage(nodes: WorkflowNodeRecord[]): WorkflowUsage {
  return nodes.reduce(
    (total, node) => ({
      input: total.input + node.usage.input,
      output: total.output + node.usage.output,
      cacheRead: total.cacheRead + node.usage.cacheRead,
      cacheWrite: total.cacheWrite + node.usage.cacheWrite,
      cost: total.cost + node.usage.cost,
      turns: total.turns + node.usage.turns,
    }),
    { ...ZERO_USAGE },
  );
}

interface JournalLease {
  readonly controller: AbortController;
  readonly compromised: () => Error | undefined;
  readonly release: () => Promise<void>;
}

const LEASE_STALE_MS = 30_000;
const LEASE_UPDATE_MS = 10_000;

async function acquireLease(file: string): Promise<JournalLease> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  let compromised: Error | undefined;
  const release = await lock(file, {
    realpath: false,
    stale: LEASE_STALE_MS,
    update: LEASE_UPDATE_MS,
    retries: 0,
    onCompromised(error) {
      compromised = error;
      controller.abort(error);
    },
  });
  return { controller, compromised: () => compromised, release };
}

export class JournalStore {
  readonly file: string;
  readonly signal: AbortSignal;
  private writeQueue: Promise<void> = Promise.resolve();
  private released = false;

  private constructor(
    readonly directory: string,
    readonly journal: WorkflowRunJournal,
    private readonly lease: JournalLease,
  ) {
    this.file = join(directory, `${journal.runId}.json`);
    this.signal = lease.controller.signal;
  }

  static async create(
    directory: string,
    journal: Omit<
      WorkflowRunJournal,
      "version" | "runId" | "createdAt" | "updatedAt" | "nodes"
    > & {
      runId?: string;
    },
  ): Promise<JournalStore> {
    const now = new Date().toISOString();
    const value: WorkflowRunJournal = {
      ...journal,
      version: 1,
      runId: journal.runId ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
      nodes: [],
    };
    const file = join(directory, `${value.runId}.json`);
    const lease = await acquireLease(file);
    const store = new JournalStore(directory, value, lease);
    try {
      await store.save();
      return store;
    } catch (error) {
      await store.release();
      throw error;
    }
  }

  static async load(directory: string, runId: string): Promise<JournalStore> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId))
      throw new Error("invalid workflow run id");
    const file = join(directory, `${runId}.json`);
    const lease = await acquireLease(file);
    try {
      const parsed = JSON.parse(
        await readFile(file, "utf8"),
      ) as WorkflowRunJournal;
      if (
        parsed.version !== 1 ||
        parsed.runId !== runId ||
        !Array.isArray(parsed.nodes)
      ) {
        throw new Error(`invalid workflow journal: ${runId}`);
      }
      return new JournalStore(directory, parsed, lease);
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  findCompleted(
    key: string,
    inputHash: string,
  ): WorkflowNodeRecord | undefined {
    for (let index = this.journal.nodes.length - 1; index >= 0; index--) {
      const node = this.journal.nodes[index]!;
      if (
        node.key === key &&
        node.inputHash === inputHash &&
        node.status === "completed"
      )
        return node;
    }
    return undefined;
  }

  async mutate(mutator: (journal: WorkflowRunJournal) => void): Promise<void> {
    this.assertHeld();
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        this.assertHeld();
        mutator(this.journal);
        this.journal.updatedAt = new Date().toISOString();
        await this.writeAtomic();
      });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async save(): Promise<void> {
    return this.mutate(() => undefined);
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.writeQueue.catch(() => undefined);
    this.released = true;
    await this.lease.release().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTACQUIRED" && error.code !== "ERELEASED")
        throw error;
    });
  }

  private assertHeld(): void {
    if (this.released) throw new Error("workflow journal lease was released");
    const compromised = this.lease.compromised();
    if (compromised)
      throw new Error(
        `workflow journal lease was compromised: ${compromised.message}`,
      );
  }

  private async writeAtomic(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.journal, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.file);
    const handle = await open(this.file, "r+");
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await open(dirname(this.file), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

if (import.meta.vitest) {
  const { afterEach, describe, expect, it } = import.meta.vitest;
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const join = (...parts: string[]) => pathModule.join(...parts);
  const dirs: string[] = [];
  const stores: JournalStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.release()));
    await Promise.all(
      dirs
        .splice(0)
        .map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  describe("workflow journal", () => {
    it("atomically persists and reloads mode-0600 journals", async () => {
      const dir = await mkdtemp(join(tmpdir(), "workflow-journal-"));
      dirs.push(dir);
      const store = await JournalStore.create(dir, {
        workflow: {
          name: "test",
          description: "test",
          source: "inline",
          scriptHash: "hash",
        },
        invoking: {
          sessionId: "parent",
          sessionFile: "/tmp/parent.jsonl",
          cwd: "/tmp",
        },
        limits: { maxConcurrency: 2, maxAgents: 3 },
        status: "running",
      });
      stores.push(store);
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.mutate((journal) => {
            journal.nodes.push({
              nodeId: String(index),
              key: String(index),
              inputHash: "x",
              status: "completed",
              result: index,
              usage: { ...ZERO_USAGE },
              startedAt: new Date().toISOString(),
            });
          }),
        ),
      );
      await store.release();
      const loaded = await JournalStore.load(dir, store.journal.runId);
      stores.push(loaded);
      expect(loaded.journal.nodes).toHaveLength(12);
      expect((await stat(store.file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(store.file, "utf8")).nodes).toHaveLength(
        12,
      );
    });

    it("returns only completed nodes with unchanged inputs", async () => {
      const dir = await mkdtemp(join(tmpdir(), "workflow-cache-"));
      dirs.push(dir);
      const store = await JournalStore.create(dir, {
        workflow: {
          name: "test",
          description: "test",
          source: "inline",
          scriptHash: "hash",
        },
        invoking: {
          sessionId: "parent",
          sessionFile: "/tmp/parent.jsonl",
          cwd: "/tmp",
        },
        limits: { maxConcurrency: 1, maxAgents: 1 },
        status: "running",
      });
      stores.push(store);
      await store.mutate((journal) =>
        journal.nodes.push({
          nodeId: "one",
          key: "stable",
          inputHash: "old",
          status: "completed",
          result: 42,
          usage: { ...ZERO_USAGE },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      );
      expect(store.findCompleted("stable", "old")?.result).toBe(42);
      expect(store.findCompleted("stable", "changed")).toBeUndefined();
    });

    it("holds an exclusive lease across independent store instances", async () => {
      const dir = await mkdtemp(join(tmpdir(), "workflow-lease-"));
      dirs.push(dir);
      const store = await JournalStore.create(dir, {
        workflow: {
          name: "test",
          description: "test",
          source: "inline",
          scriptHash: "hash",
        },
        invoking: {
          sessionId: "parent",
          sessionFile: "/tmp/parent.jsonl",
          cwd: "/tmp",
        },
        limits: { maxConcurrency: 1, maxAgents: 1 },
        status: "running",
      });
      stores.push(store);
      await expect(
        JournalStore.load(dir, store.journal.runId),
      ).rejects.toMatchObject({
        code: "ELOCKED",
      });
      await store.release();
      const resumed = await JournalStore.load(dir, store.journal.runId);
      stores.push(resumed);
      expect(resumed.journal.runId).toBe(store.journal.runId);
    });
  });
}
