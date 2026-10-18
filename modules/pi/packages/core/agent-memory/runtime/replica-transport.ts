import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ReplicaTransport } from "./contracts.js";
import {
  exchangeReplica,
  parseExchangeRequest,
  parseExchangeResponse,
  parseReplicaJSON,
  REPLICA_LIMITS,
  type ExchangeDependencies,
  type ReplicaLimits,
} from "./replica.js";

export interface ReplicaProcess {
  /** trusted adapter configuration, never supplied by a peer payload. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}
/** one child per exchange; no producer daemon, shell or persistent listener. */
export function processReplicaTransport(
  command: ReplicaProcess,
  limits: ReplicaLimits = REPLICA_LIMITS,
): ReplicaTransport {
  return {
    async exchange(input, signal) {
      const request = JSON.stringify(parseExchangeRequest(input, limits));
      signal.throwIfAborted();
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(command.executable, [...command.args], {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: command.cwd,
          env: command.environment,
        });
        const chunks: Buffer[] = [];
        let bytes = 0,
          stderrBytes = 0,
          failure: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error): void => {
          if (failure) return;
          failure = error;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        };
        const abort = (): void => stop(new Error("replica process aborted"));
        const timeout = setTimeout(
          () => stop(new Error("replica process timeout")),
          limits.timeoutMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        // abort can race child creation and listener installation.
        if (signal.aborted) abort();
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.maxBytes)
            stop(new Error("replica response byte limit"));
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > limits.maxBytes)
            stop(new Error("replica stderr byte limit"));
        });
        child.stdin.on("error", (error) => stop(error));
        child.on("error", (error) => {
          failure ??= error;
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          clearTimeout(killTimer);
          signal.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else if (code !== 0)
            reject(new Error(`replica process exited ${code}`));
          else {
            try {
              resolve(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks),
                ),
              );
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stdin.end(request);
      });
      return parseExchangeResponse(parseReplicaJSON(output, limits), limits);
    },
  };
}
export function sshReplicaTransport(
  destination: string,
  configuredPeers: readonly string[],
  limits: ReplicaLimits = REPLICA_LIMITS,
): ReplicaTransport {
  if (
    !configuredPeers.includes(destination) ||
    !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$/.test(destination)
  )
    throw new Error("unconfigured or unsafe replica destination");
  return processReplicaTransport(
    {
      executable: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `ConnectTimeout=${Math.max(1, Math.ceil(limits.timeoutMs / 1000))}`,
        "--",
        destination,
        "pi-memory",
        "exchange",
      ],
    },
    limits,
  );
}
/** stdout is exclusively the bounded protocol response; errors belong to the CLI's stderr. */
export async function serveReplicaExchange(
  input: Readable,
  output: Writable,
  deps: ExchangeDependencies,
): Promise<void> {
  const limits = deps.limits ?? REPLICA_LIMITS;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(limits.timeoutMs),
  ]);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stop = (): void => {
    input.destroy(new Error("replica request aborted"));
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limits.maxBytes)
        throw new Error("replica request byte limit");
      chunks.push(buffer);
      signal.throwIfAborted();
    }
    const request = parseExchangeRequest(
      parseReplicaJSON(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        limits,
      ),
      limits,
    );
    const response = JSON.stringify(
      await exchangeReplica(request, { ...deps, signal }),
    );
    if (Buffer.byteLength(response) > limits.maxBytes)
      throw new Error("replica response byte limit");
    await new Promise<void>((resolve, reject) =>
      output.write(response, (error) => (error ? reject(error) : resolve())),
    );
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

if (import.meta.vitest) {
  const { test, expect, beforeEach, afterEach } = import.meta.vitest;
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const { FileMemoryStore } = await import("./store.js");
  const { createNoteRevision } = await import("./markdown.js");
  const { revisionId, hashSourceWindow, windowId } =
    await import("./identity.js");
  const { synchronizeReplica } = await import("./replica.js");
  type Note = import("./contracts.js").NoteRevision;
  type Change = import("./contracts.js").ReplicaChange;
  const scope = { kind: "personal" as const, ownerId: "fixture-owner" };
  const policy = {
    ownerId: "fixture-owner",
    peerOwnerId: "fixture-owner",
    personal: true,
    projects: ["fixture-project"],
  };
  const now = "2026-01-01T00:00:00.000Z";
  const signal = (): AbortSignal => new AbortController().signal;
  let dir: string;
  const open: InstanceType<typeof FileMemoryStore>[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "pi-replica-m4-"));
  });
  afterEach(() => {
    for (const store of open.splice(0)) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = (id: string) => ({
    root: join(dir, id, "notes"),
    data: join(dir, id, "data"),
    state: join(dir, id, "state"),
    owner: "fixture-owner",
    replicaId: id as import("./contracts.js").ReplicaId,
  });
  function store(id: string): InstanceType<typeof FileMemoryStore> {
    const s = new FileMemoryStore(config(id));
    open.push(s);
    return s;
  }
  function note(
    id: string,
    body = `# ${id}\n\nfixture`,
    parents: readonly import("./contracts.js").RevisionId[] = [],
    path = `${id}.md`,
  ): Note {
    return createNoteRevision({
      noteId: id as Note["noteId"],
      scope,
      ancestry: { kind: "known", parents },
      path,
      body,
      claims: [],
      links: [],
      exposure: { kind: "active" },
      authoredAt: now,
    });
  }
  async function commit(
    s: InstanceType<typeof FileMemoryStore>,
    id: string,
    notes: readonly Note[] = [],
    windows: readonly import("./contracts.js").SourceWindow[] = [],
    suppressions: readonly import("./contracts.js").Suppression[] = [],
  ): Promise<void> {
    const result = await s.commit({
      commitId: id as Change["commitId"],
      now,
      windows,
      edits: await Promise.all(
        notes.map(async (revision) => ({
          revision,
          expectedHeads: (await s.readNotes(scope, [revision.noteId])).map(
            (n) => n.revisionId,
          ),
        })),
      ),
      suppressions,
      outcomes: [],
      lease: null,
    });
    expect(result.kind).toBe("locally-committed");
  }
  function helper(id: string, overrides: object = {}): string {
    const file = join(dir, `${id}-worker.mjs`);
    const runtime = dirname(fileURLToPath(import.meta.url));
    fs.writeFileSync(
      file,
      `import {createJiti} from 'jiti'; const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false}); const {FileMemoryStore}=await jiti.import(${JSON.stringify(join(runtime, "store.ts"))}); const {serveReplicaExchange}=await jiti.import(${JSON.stringify(join(runtime, "replica-transport.ts"))}); const store=new FileMemoryStore(${JSON.stringify(config(id))}); try { await serveReplicaExchange(process.stdin,process.stdout,{store,peerId:'fixture-client',policy:${JSON.stringify(policy)},signal:new AbortController().signal,...${JSON.stringify(overrides)}}); }catch(error){console.error(error.message);process.exitCode=1;}finally{store.close();}`,
    );
    return file;
  }
  function transport(
    id: string,
    limits: ReplicaLimits = REPLICA_LIMITS,
  ): ReplicaTransport {
    // node resolves jiti from this existing package; the helper is trusted fixture configuration.
    return processReplicaTransport({
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        fs.readFileSync(helper(id, { limits }), "utf8"),
      ],
    });
  }
  async function sync(
    s: InstanceType<typeof FileMemoryStore>,
    id: string,
    limits: ReplicaLimits = REPLICA_LIMITS,
  ): Promise<Awaited<ReturnType<typeof synchronizeReplica>>> {
    return synchronizeReplica({
      store: s,
      peerId: id,
      policy,
      signal: signal(),
      transport: transport(id, limits),
      limits,
    });
  }
  test("an explicit same-owner vault grant includes projects without accepting another owner's evidence", async () => {
    const a = store("a");
    const project = {
      kind: "project" as const,
      repositoryId: "new-owned-project",
    };
    const decision = createNoteRevision({
      noteId: "project-decision" as Note["noteId"],
      scope: project,
      ancestry: { kind: "known", parents: [] },
      path: "decision--project-decision.md",
      body: "dated project judgment",
      claims: [],
      links: [],
      exposure: { kind: "active" },
      authoredAt: now,
    });
    await commit(a, "owned-project", [decision]);
    const trusted = { ...policy, projects: "all-owned" as const };
    const channel = processReplicaTransport({
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        fs.readFileSync(helper("b", { policy: trusted }), "utf8"),
      ],
    });
    expect(
      (
        await synchronizeReplica({
          store: a,
          peerId: "b",
          policy: trusted,
          signal: signal(),
          transport: channel,
        })
      ).kind,
    ).toBe("complete");
    const b = store("b");
    expect((await b.listNotes(project)).map((n) => n.noteId)).toEqual([
      decision.noteId,
    ]);
    b.close();
    open.splice(open.indexOf(b), 1);
    const foreign = createNoteRevision({
      noteId: "foreign" as Note["noteId"],
      scope: { kind: "personal", ownerId: "someone-else" },
      ancestry: { kind: "known", parents: [] },
      path: "foreign--foreign.md",
      body: "not part of this owner grant",
      claims: [],
      links: [],
      exposure: { kind: "active" },
      authoredAt: now,
    });
    await commit(a, "foreign-owner", [foreign]);
    await expect(
      synchronizeReplica({
        store: a,
        peerId: "b",
        policy: trusted,
        signal: signal(),
        transport: channel,
      }),
    ).rejects.toThrow("replica scope denied");
    const restored = store("b");
    expect(await restored.listNotes(foreign.scope)).toEqual([]);
  });
  test("three real stores and worker exchanges retain offline alternatives, rename/edit and delete/edit", async () => {
    const a = store("a");
    const base = note("shared", "# shared\n\nfirst\nlast");
    await commit(a, "base", [base]);
    expect((await sync(a, "b")).kind).toBe("complete");
    expect((await sync(a, "c")).kind).toBe("complete");
    const b = store("b");
    const editA = note("shared", "# shared\n\nchanged first\nlast", [
      base.revisionId,
    ]);
    const editB = note(
      "shared",
      "# shared\n\nfirst\nchanged last",
      [base.revisionId],
      "renamed-shared.md",
    );
    await commit(a, "offline-a", [editA]);
    await commit(b, "offline-b", [editB]);
    b.close();
    open.splice(open.indexOf(b), 1);
    await sync(a, "b");
    await sync(a, "c");
    expect((await a.listNotes(scope)).map((n) => n.revisionId).sort()).toEqual(
      [editA.revisionId, editB.revisionId].sort(),
    );
    expect(
      (await a.listNotes(scope)).find((n) => n.revisionId === editB.revisionId)
        ?.path,
    ).toBe("renamed-shared.md");
    const c = store("c");
    expect((await c.listNotes(scope)).map((n) => n.revisionId).sort()).toEqual(
      [editA.revisionId, editB.revisionId].sort(),
    );
    const tombstoneEnvelope = {
      ...editA,
      ancestry: {
        kind: "known" as const,
        parents: [editA.revisionId, editB.revisionId],
      },
      exposure: { kind: "deleted" as const, reason: "fixture removal" },
    };
    const { revisionId: _id, ...e } = tombstoneEnvelope;
    const tombstone = { ...e, revisionId: revisionId(e) };
    await commit(a, "delete", [tombstone]);
    const offline = note("shared", "# contradictory offline edit", [
      editA.revisionId,
      editB.revisionId,
    ]);
    await commit(c, "offline-c", [offline]);
    c.close();
    open.splice(open.indexOf(c), 1);
    await sync(a, "c");
    await sync(a, "b");
    expect(
      (await a.listNotes(scope)).map((n) => n.exposure.kind).sort(),
    ).toEqual(["active", "deleted"]);
    const reread = store("b");
    expect(
      (await reread.listNotes(scope)).map((n) => n.revisionId).sort(),
    ).toEqual([tombstone.revisionId, offline.revisionId].sort());
  }, 60_000);

  test("closed older backup and fresh root recover despite previous peer ACKs", async () => {
    const a = store("a");
    await commit(a, "one", [note("one")]);
    await sync(a, "b");
    fs.cpSync(join(dir, "b"), join(dir, "old-backup"), { recursive: true });
    await commit(a, "two", [note("two")]);
    await sync(a, "b");
    expect(await a.forPeer("replica-client:b").pending(100)).toEqual([]);
    // restore the closed snapshot at its configured paths; preserve the newer tree too.
    fs.renameSync(join(dir, "b"), join(dir, "newer-b"));
    fs.cpSync(join(dir, "old-backup"), join(dir, "b"), { recursive: true });
    // newer operational metadata must not certify knowledge lost in the restore.
    fs.renameSync(join(dir, "b", "state"), join(dir, "older-state"));
    fs.cpSync(join(dir, "newer-b", "state"), join(dir, "b", "state"), {
      recursive: true,
    });
    const restored = new FileMemoryStore(config("b"));
    expect((await restored.listNotes(scope)).map((n) => n.noteId)).toEqual([
      "one",
    ]);
    restored.close();
    await sync(a, "b");
    const r = store("b");
    expect((await r.listNotes(scope)).map((n) => n.noteId).sort()).toEqual([
      "one",
      "two",
    ]);
    r.close();
    open.splice(open.indexOf(r), 1);
    await sync(a, "fresh");
    const fresh = store("fresh");
    expect((await fresh.listNotes(scope)).length).toBe(2);
  }, 60_000);

  test("history beyond the closure budget advances across process restarts, fresh peers and restored data", async () => {
    const a = store("a");
    const limits = {
      ...REPLICA_LIMITS,
      maxChanges: 1,
      maxClosureChanges: 2,
      maxRounds: 3,
    };
    await commit(a, "c0", [note("n0")]);
    await sync(a, "b", limits);
    fs.cpSync(join(dir, "b"), join(dir, "old-b"), { recursive: true });
    for (let i = 1; i < 6; i++) await commit(a, `c${i}`, [note(`n${i}`)]);
    async function converge(id: string): Promise<void> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await sync(a, id, limits);
        if (result.kind === "complete") return;
        expect(result.kind).toBe("bounded");
      }
      throw new Error("bounded invocations did not converge");
    }
    await converge("b");
    expect(await a.forPeer("replica-client:b").pending(100)).toEqual([]);
    fs.renameSync(join(dir, "b"), join(dir, "newer-b"));
    fs.cpSync(join(dir, "old-b"), join(dir, "b"), { recursive: true });
    fs.renameSync(config("b").state, join(dir, "old-b-state"));
    fs.cpSync(join(dir, "newer-b", "state"), config("b").state, {
      recursive: true,
    });
    await converge("b");
    await converge("fresh");
    for (const id of ["b", "fresh"]) {
      const receiver = store(id);
      expect(
        (await receiver.forPeer("audit").scan(null, 100)).map(
          (c) => c.commitId,
        ),
      ).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    }
  }, 90_000);

  test("policy tightening and reused ids cannot reuse broader or different-payload proofs", async () => {
    const a = store("a");
    await commit(a, "parent", [note("parent")]);
    await commit(a, "child", [note("child")]);
    await exchangeReplica(
      { outgoing: [], cursor: null },
      { store: a, peerId: "warm", policy, signal: signal() },
    );
    await expect(
      exchangeReplica(
        { outgoing: [], cursor: null },
        {
          store: a,
          peerId: "warm",
          policy: { ...policy, personal: false },
          signal: signal(),
        },
      ),
    ).rejects.toThrow("scope denied");
    const original = (await a.forPeer("audit").scan(null, 1))[0]!;
    const different = { ...original, revisions: [note("different")] };
    await expect(
      exchangeReplica(
        { outgoing: [different], cursor: null },
        {
          store: a,
          peerId: "warm",
          policy,
          signal: signal(),
        },
      ),
    ).rejects.toThrow(/payload mismatch|identity collision/);
  });

  test("lost local proof metadata rebuilds bounded prefixes behind a deep peer cursor", async () => {
    let a = store("a");
    for (let i = 0; i < 6; i++) await commit(a, `c${i}`);
    await exchangeReplica(
      { outgoing: [], cursor: null },
      { store: a, peerId: "warm", policy, signal: signal() },
    );
    a.close();
    open.splice(open.indexOf(a), 1);
    fs.renameSync(config("a").state, join(dir, "saved-proof-state"));
    a = store("a");
    const limits = { ...REPLICA_LIMITS, maxChanges: 1, maxClosureChanges: 2 };
    const deep = JSON.stringify({
      version: 1,
      after: "c4",
      received: null,
      attempts: 0,
      retryAt: 0,
    });
    let failures = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const response = await exchangeReplica(
          { outgoing: [], cursor: deep },
          { store: a, peerId: "warm", policy, signal: signal(), limits },
        );
        expect(response.incoming.map((c) => c.commitId)).toEqual(["c5"]);
        expect(failures).toBeGreaterThan(0);
        return;
      } catch (error) {
        expect(String(error)).toContain("replica closure limit");
        failures++;
      }
    }
    throw new Error("cold proofs did not rebuild");
  });

  test.each(["stock", "scaled"] as const)(
    "cold byte repair progresses across reopen with %s limits and default page count",
    async (size) => {
      let a = store("a");
      const count = size === "stock" ? 20 : 6;
      const body = "x".repeat(size === "stock" ? 900_000 : 300);
      const changes: Change[] = Array.from({ length: count }, (_, i) => ({
        commitId: `c${i}` as Change["commitId"],
        replicaId: "a" as Change["replicaId"],
        parents: i ? [`c${i - 1}` as Change["commitId"]] : [],
        revisions: [note(`n${i}`, body)],
        windows: [],
        suppressions: [],
        outcomes: [],
      }));
      await a.forPeer("restore").integrate(changes);
      const history = await a.forPeer("inspect").scan(null, 100);
      const largest = Math.max(
        ...history.map((change) => Buffer.byteLength(JSON.stringify(change))),
      );
      const limits =
        size === "stock"
          ? REPLICA_LIMITS
          : { ...REPLICA_LIMITS, maxClosureBytes: largest * 2 + 10 };
      expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(
        limits.maxClosureBytes,
      );
      const deep = JSON.stringify({
        version: 1,
        after: `c${count - 2}`,
        received: null,
        attempts: 0,
        retryAt: 0,
      });
      let failures = 0;
      for (
        let attempt = 0;
        attempt < (size === "stock" ? 4 : count + 1);
        attempt++
      ) {
        try {
          const response = await exchangeReplica(
            { outgoing: [], cursor: deep },
            { store: a, peerId: "cold", policy, signal: signal(), limits },
          );
          expect(response.incoming.map((c) => c.commitId)).toEqual([
            `c${count - 1}`,
          ]);
          expect(failures).toBeGreaterThan(0);
          // A warmed direct page may exceed the ancestry budget; wire bounds still apply.
          const complete = await exchangeReplica(
            { outgoing: [], cursor: null },
            { store: a, peerId: "cold", policy, signal: signal(), limits },
          );
          expect(complete.incoming.map((c) => c.commitId)).toEqual(
            history
              .slice(0, size === "stock" ? 1 : count)
              .map((c) => c.commitId),
          );
          return;
        } catch (error) {
          expect(String(error)).toContain("replica closure byte limit");
          failures++;
        }
        a.close();
        open.splice(open.indexOf(a), 1);
        a = store("a");
      }
      throw new Error("cold byte proofs did not rebuild");
    },
    90_000,
  );

  test("actual repository replacement during proof reads or writes cannot authorize under a new epoch", async () => {
    for (const phase of ["read", "write"] as const) {
      const id = `source-${phase}`;
      const a = store(id);
      await commit(a, "parent");
      await commit(a, "child");
      await exchangeReplica(
        { outgoing: [], cursor: null },
        { store: a, peerId: "warm", policy, signal: signal() },
      );
      if (phase === "write") await commit(a, "new-child");
      const original = await a.forPeer("audit").scan(null, 100);
      const replacement = store(`replacement-${phase}`);
      const { revisionId: _id, ...foreign } = {
        ...note("foreign"),
        scope: { kind: "personal" as const, ownerId: "someone-else" },
      };
      await replacement.forPeer("restore").integrate([
        {
          ...original[0]!,
          revisions: [{ ...foreign, revisionId: revisionId(foreign) }],
        },
        ...original.slice(1),
      ]);
      let changed = false;
      function replace(): void {
        changed = true;
        fs.renameSync(config(id).data, join(dir, `old-data-${phase}`));
        fs.cpSync(config(`replacement-${phase}`).data, config(id).data, {
          recursive: true,
        });
      }
      const repository = {
        forPeer(peer: string) {
          const port = a.forPeer(peer);
          if (!peer.startsWith("replica-proof:")) return port;
          return {
            ...port,
            async readCursor() {
              const saved = await port.readCursor();
              if (phase === "read" && !changed) replace();
              return saved;
            },
            async acknowledge(
              commits: Parameters<typeof port.acknowledge>[0],
              cursor: string,
            ) {
              await port.acknowledge(commits, cursor);
              if (phase === "write" && !changed) replace();
            },
          };
        },
      };
      const skipped = JSON.stringify({
        version: 1,
        after: phase === "read" ? "parent" : "child",
        received: null,
        attempts: 0,
        retryAt: 0,
      });
      await expect(
        exchangeReplica(
          { outgoing: [], cursor: skipped },
          { store: repository, peerId: "warm", policy, signal: signal() },
        ),
      ).rejects.toThrow("continuity changed");
      expect(changed).toBe(true);
      await expect(
        exchangeReplica(
          { outgoing: [], cursor: skipped },
          { store: a, peerId: "warm", policy, signal: signal() },
        ),
      ).rejects.toThrow("scope denied");
    }
  });

  test("failed durable integration cannot publish incoming proofs", async () => {
    const source = store("source"),
      receiver = store("receiver");
    await commit(source, "incoming", [note("incoming")]);
    const incoming = await source.forPeer("audit").scan(null, 100);
    let proofWrites = 0;
    const repository = {
      forPeer(peer: string) {
        const port = receiver.forPeer(peer);
        return {
          ...port,
          async integrate() {
            throw new Error("fixture durable integration failure");
          },
          async acknowledge(
            commits: Parameters<typeof port.acknowledge>[0],
            cursor: string,
          ) {
            if (peer.startsWith("replica-proof:")) proofWrites++;
            await port.acknowledge(commits, cursor);
          },
        };
      },
    };
    await expect(
      exchangeReplica(
        { outgoing: incoming, cursor: null },
        { store: repository, peerId: "source", policy, signal: signal() },
      ),
    ).rejects.toThrow("durable integration failure");
    expect(proofWrites).toBe(0);
    expect(await receiver.listNotes(scope)).toEqual([]);
  });

  test("uncached count and byte limits still refuse disclosure", async () => {
    const a = store("a");
    for (let i = 0; i < 3; i++) await commit(a, `c${i}`, [note(`n${i}`)]);
    const skipped = JSON.stringify({
      version: 1,
      after: "c1",
      received: null,
      attempts: 0,
      retryAt: 0,
    });
    await expect(
      exchangeReplica(
        { outgoing: [], cursor: skipped },
        {
          store: a,
          peerId: "cold",
          policy,
          signal: signal(),
          limits: { ...REPLICA_LIMITS, maxChanges: 1, maxClosureChanges: 2 },
        },
      ),
    ).rejects.toThrow("closure limit");
    await expect(
      exchangeReplica(
        { outgoing: [], cursor: skipped },
        {
          store: a,
          peerId: "bytes",
          policy,
          signal: signal(),
          limits: { ...REPLICA_LIMITS, maxChanges: 1, maxClosureBytes: 1 },
        },
      ),
    ).rejects.toThrow("closure byte limit");
  });

  test("bounded interruption resumes durable cursors; unavailable peer never gates local acceptance", async () => {
    const a = store("a");
    for (let i = 0; i < 4; i++) await commit(a, `c${i}`, [note(`n${i}`)]);
    const limited = { ...REPLICA_LIMITS, maxChanges: 1, maxRounds: 1 };
    expect((await sync(a, "b", limited)).kind).toBe("bounded");
    expect(await a.forPeer("replica-client:b").readCursor()).not.toBeNull();
    expect((await sync(a, "b")).kind).toBe("complete");
    const b = store("b");
    expect((await b.listNotes(scope)).length).toBe(4);
    b.close();
    open.splice(open.indexOf(b), 1);
    const unavailable = processReplicaTransport({
      executable: process.execPath,
      args: ["-e", "process.exit(23)"],
    });
    await commit(a, "offline", [note("offline")]);
    await expect(
      synchronizeReplica({
        store: a,
        peerId: "unavailable",
        policy,
        signal: signal(),
        transport: unavailable,
      }),
    ).rejects.toThrow("23");
    const saved = JSON.parse(
      (await a.forPeer("replica-client:unavailable").readCursor())!,
    );
    expect(saved.after).toBeNull();
    expect(saved.attempts).toBe(1);
    expect(saved.retryAt).toBeGreaterThan(Date.now());
    expect((await a.listNotes(scope)).length).toBe(5);
    expect((await a.forPeer("other-peer").pending(100)).length).toBe(5);
  }, 60_000);

  test("real receiving store rejects corrupt hashes and missing dependencies; reordered duplicates integrate", async () => {
    const a = store("a"),
      b = store("b");
    await commit(a, "parent", [note("n")]);
    const base = (await a.listNotes(scope))[0]!;
    await commit(a, "child", [note("n", "# update", [base.revisionId])]);
    const all = await a.forPeer("fixture").pending(100);
    await expect(b.forPeer("a").integrate([all[1]!])).rejects.toThrow(
      /missing/,
    );
    const corrupt = structuredClone(all[0]!);
    (corrupt.revisions[0] as { markdown: string }).markdown += "corrupt";
    await expect(b.forPeer("a").integrate([corrupt])).rejects.toThrow(/hash/);
    expect(await b.listNotes(scope)).toEqual([]);
    await b.forPeer("a").integrate([all[1]!, all[0]!, all[1]!]);
    await b.forPeer("a").integrate(all);
    expect((await b.listNotes(scope)).map((n) => n.markdown)).toEqual([
      (await a.listNotes(scope))[0]!.markdown,
    ]);
  });

  test("source roles, evidence identity and suppression survive real worker exchange", async () => {
    const a = store("a");
    const payload = {
      source: {
        sourceId: "source" as import("./contracts.js").SourceId,
        producer: "fixture",
        origin: {
          kind: "session" as const,
          sessionId: "native-session" as import("./contracts.js").SessionId,
          project: { repositoryId: "fixture-project" },
        },
      },
      scope,
      excerpts: [
        {
          span: {
            entryId: "entry" as import("./contracts.js").EntryId,
            partId: "text",
            start: 0,
            end: 7,
          },
          parentEntryId: null,
          producerRole: "user",
          occurredAt: now,
          text: "fixture",
        },
      ] as const,
    };
    const w = {
      ...payload,
      sourceHash: hashSourceWindow(payload),
      windowId: windowId(payload),
      capturedAt: now,
      importance: "ordinary" as const,
    };
    await commit(a, "window", [], [w]);
    const evidence = {
      windowId: w.windowId,
      source: w.source,
      sourceHash: w.sourceHash,
      spans: [w.excerpts[0].span] as const,
    };
    const backed = createNoteRevision({
      noteId: "backed" as Note["noteId"],
      scope,
      ancestry: { kind: "known", parents: [] },
      path: "backed.md",
      body: "# backed\nfixture",
      claims: [
        {
          kind: "producer-statement",
          markdownSpan: { start: 0, end: 1 },
          evidence: [evidence],
          derivedFrom: [],
        },
      ],
      links: [],
      exposure: { kind: "active" },
      authoredAt: now,
    });
    await commit(a, "backed", [backed]);
    const suppression = {
      suppressionId: "suppression" as import("./contracts.js").SuppressionId,
      scope,
      target: {
        kind: "evidence" as const,
        evidence: {
          windowId: w.windowId,
          source: w.source,
          sourceHash: w.sourceHash,
          spans: [w.excerpts[0].span] as const,
        },
      },
      reason: "fixture",
      createdAt: now,
    };
    await commit(a, "suppression", [], [], [suppression]);
    await sync(a, "b");
    const b = store("b");
    const replicated = await b.forPeer("inspect").pending(100);
    expect(replicated.flatMap((c) => c.windows)).toEqual([w]);
    expect(await b.readSuppressions(scope)).toEqual([suppression]);
    expect((await b.listNotes(scope))[0]!.claims).toEqual(backed.claims);
  }, 60_000);

  test("native editable Markdown is ingested before it enters the subprocess exchange", async () => {
    const a = store("a");
    await commit(a, "base", [note("editable")]);
    await sync(a, "b");
    fs.appendFileSync(
      join(config("a").root, "editable.md"),
      "\nexternal editor changed this offline\n",
    );
    await sync(a, "b");
    const b = store("b");
    expect(
      (await b.listNotes(scope)).some((n) =>
        n.markdown.includes("external editor changed this offline"),
      ),
    ).toBe(true);
  }, 60_000);

  test("forbidden entire ancestor payload fails closed, even after a cursor skips its page", async () => {
    const a = store("a");
    const forbidden = {
      ...note("foreign"),
      scope: { kind: "personal" as const, ownerId: "someone-else" },
    };
    const { revisionId: _id, ...env } = forbidden;
    await commit(a, "foreign", [{ ...env, revisionId: revisionId(env) }]);
    await commit(a, "allowed", [note("allowed")]);
    await expect(sync(a, "b")).rejects.toThrow();
    const s = store("b");
    expect(await s.listNotes(scope)).toEqual([]);
    s.close();
    open.splice(open.indexOf(s), 1);
    await expect(
      exchangeReplica(
        {
          outgoing: [],
          cursor: JSON.stringify({
            version: 1,
            after: "foreign",
            received: null,
            attempts: 0,
            retryAt: 0,
          }),
        },
        { store: a, peerId: "malicious-cursor", policy, signal: signal() },
      ),
    ).rejects.toThrow("scope denied");
    await expect(
      exchangeReplica(
        { outgoing: [], cursor: null },
        {
          store: a,
          peerId: "bad-owner",
          policy: { ...policy, peerOwnerId: "foreign" },
          signal: signal(),
        },
      ),
    ).rejects.toThrow("owner denied");
  });

  test("retained local proofs cannot hide an ancestor replaced beneath an unchanged descendant", async () => {
    const a = store("a");
    await commit(a, "parent", [note("parent")]);
    await commit(a, "child", [note("child")]);
    await exchangeReplica(
      { outgoing: [], cursor: null },
      {
        store: a,
        peerId: "warm",
        policy,
        signal: signal(),
      },
    );
    const original = await a.forPeer("inspect").scan(null, 100);
    const replacement = store("replacement");
    const { revisionId: _id, ...foreign } = {
      ...note("foreign"),
      scope: { kind: "personal" as const, ownerId: "someone-else" },
    };
    await replacement.forPeer("restore").integrate([
      {
        ...original[0]!,
        revisions: [{ ...foreign, revisionId: revisionId(foreign) }],
      },
    ]);
    await replacement.forPeer("restore").integrate([original[1]!]);
    for (const s of [a, replacement]) {
      s.close();
      open.splice(open.indexOf(s), 1);
    }
    fs.cpSync(config("a").state, config("replacement").state, {
      recursive: true,
    });
    const restored = store("replacement");
    await expect(
      exchangeReplica(
        {
          outgoing: [],
          cursor: JSON.stringify({
            version: 1,
            after: "parent",
            received: null,
            attempts: 0,
            retryAt: 0,
          }),
        },
        { store: restored, peerId: "warm", policy, signal: signal() },
      ),
    ).rejects.toThrow("scope denied");
  });

  test("actual process invalid/oversized stdin and stdout, timeout and cancellation fail closed", async () => {
    const code = fs.readFileSync(
      helper("b", { limits: { ...REPLICA_LIMITS, maxBytes: 4096 } }),
      "utf8",
    );
    for (const input of [
      "{",
      JSON.stringify({ outgoing: [], cursor: null, command: "bad" }),
      " ".repeat(4097),
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", code],
        { input, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    const invalid = processReplicaTransport({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('not json')"],
    });
    await expect(
      invalid.exchange({ outgoing: [], cursor: null }, signal()),
    ).rejects.toThrow();
    const invalidResponse = JSON.stringify({
      incoming: [],
      acknowledged: ["INVALID_UTF8"],
      cursor: JSON.stringify({
        version: 1,
        after: null,
        received: null,
        attempts: 0,
        retryAt: 0,
      }),
    });
    const [prefix, suffix] = invalidResponse.split("INVALID_UTF8");
    const invalidUtf8 = processReplicaTransport({
      executable: process.execPath,
      args: [
        "-e",
        `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(prefix)}),Buffer.from([255]),Buffer.from(${JSON.stringify(suffix)})]))`,
      ],
    });
    await expect(
      invalidUtf8.exchange({ outgoing: [], cursor: null }, signal()),
    ).rejects.toThrow(/encoded data/);
    const oversized = processReplicaTransport(
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(8192))"],
      },
      { ...REPLICA_LIMITS, maxBytes: 4096 },
    );
    await expect(
      oversized.exchange({ outgoing: [], cursor: null }, signal()),
    ).rejects.toThrow("byte limit");
    const hanging = processReplicaTransport(
      {
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      },
      { ...REPLICA_LIMITS, timeoutMs: 100 },
    );
    await expect(
      hanging.exchange({ outgoing: [], cursor: null }, signal()),
    ).rejects.toThrow("timeout");
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 30);
    await expect(
      processReplicaTransport({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      }).exchange({ outgoing: [], cursor: null }, cancel.signal),
    ).rejects.toThrow("aborted");
    for (const host of [
      "-oProxyCommand=bad",
      "host;touch /tmp/bad",
      "host\ncommand",
      "unconfigured",
    ])
      expect(() => sshReplicaTransport(host, ["fixture-alias"])).toThrow();
  }, 30_000);
}
