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
/** Never echo peer-controlled stderr: it can contain private note/provider data. */
function replicaExitDiagnostic(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes("PI_MEMORY_GIT_REMOTE is required"))
    return "legacy remote CLI; native exchange is not installed";
  if (lines.includes("exchange requires an authenticated SSH connection"))
    return "remote SSH account binding unavailable";
  if (lines.includes("unknown or ambiguous SSH memory peer"))
    return "remote configured-peer binding rejected";
  if (
    lines.includes("database is locked") ||
    lines.includes("memory store contention deadline exceeded")
  )
    return "remote storage contention";
  if (
    lines.some((line) =>
      /^ssh: connect to host .+ port \d+: (?:Operation timed out|Connection timed out|Connection refused|No route to host)$/.test(
        line,
      ),
    )
  )
    return "SSH connection unavailable";
  if (lines.includes("Host key verification failed."))
    return "SSH host verification failed";
  if (
    lines.some((line) =>
      /^(?:sh|bash|zsh):.*(?:pi-memory: (?:command )?not found|command not found: pi-memory)$/.test(
        line,
      ),
    )
  )
    return "remote pi-memory command unavailable";
  return null;
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
        const diagnostics: Buffer[] = [];
        let diagnosticBytes = 0;
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
        const timeout =
          limits.timeoutMs === undefined
            ? undefined
            : setTimeout(
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
          if (diagnosticBytes < 4096) {
            const prefix = chunk.subarray(0, 4096 - diagnosticBytes);
            diagnostics.push(prefix);
            diagnosticBytes += prefix.length;
          }
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
          else if (code !== 0) {
            const diagnostic = replicaExitDiagnostic(
              Buffer.concat(diagnostics).toString("utf8"),
            );
            reject(
              new Error(
                `replica process exited ${code}${diagnostic ? `: ${diagnostic}` : ""}`,
              ),
            );
          } else {
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
        // connection/SSH responsiveness are independent of receiver preparation.
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
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
  const signal =
    limits.timeoutMs === undefined
      ? deps.signal
      : AbortSignal.any([deps.signal, AbortSignal.timeout(limits.timeoutMs)]);
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
  const { test, expect, beforeEach, afterEach, vi } = import.meta.vitest;
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const { FileMemoryStore } = await import("./store.js");
  const { createNoteRevision } = await import("./markdown.js");
  const { revisionId, hashSourceWindow, windowId, canonicalJSON, sha256 } =
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
  test("empty checkpoint requests reach the network without certifying unavailable history", async () => {
    const local = store("empty-handshake");
    await commit(local, "seed", [note("seed")]);
    fs.renameSync(
      join(config("empty-handshake").data, "objects"),
      join(config("empty-handshake").data, "objects-offline"),
    );
    await expect(
      synchronizeReplica({
        store: local,
        peerId: "unavailable-peer",
        policy,
        signal: signal(),
        transport: {
          exchange: async () => {
            throw new Error("fixture network unavailable");
          },
        },
      }),
    ).rejects.toThrow("fixture network unavailable");
    const saved = await local
      .forPeer("replica-client:unavailable-peer")
      .readCursor();
    expect(JSON.parse(saved!).attempts).toBe(1);
    await expect(
      synchronizeReplica({
        store: local,
        peerId: "wrong-owner",
        policy: { ...policy, peerOwnerId: "different-owner" },
        signal: signal(),
        transport: {
          exchange: async () => {
            throw new Error("owner check bypassed");
          },
        },
      }),
    ).rejects.toThrow("replica owner denied");
  });
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
  test("default process synchronization survives the former lifetime while a real receiver waits", async () => {
    const a = store("long-client");
    await commit(a, "long-note", [note("long-note")]);
    const release = join(dir, "release");
    const ready = join(dir, "ready");
    const child = `import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,5));
      ${fs.readFileSync(helper("long-receiver"), "utf8")}`;
    const { setTimeout: delay } = await import("node:timers/promises");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // AbortSignal's native clock is separate from global timers.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("fixture deadline")), ms);
      return controller.signal;
    });
    const cancel = new AbortController();
    let settled = false;
    const pending = synchronizeReplica({
      store: a,
      peerId: "long-receiver",
      policy,
      signal: cancel.signal,
      transport: processReplicaTransport({
        executable: process.execPath,
        args: ["--input-type=module", "-e", child],
      }),
    }).finally(() => {
      settled = true;
    });
    // Attach rejection handling before advancing the external clock.
    void pending.catch(() => {});
    try {
      for (let i = 0; !fs.existsSync(ready) && i < 1000; i++) await delay(5);
      expect(fs.existsSync(ready)).toBe(true);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(settled).toBe(false);
      fs.writeFileSync(release, "go");
      vi.useRealTimers();
      expect((await pending).kind).toBe("complete");
      const receiver = store("long-receiver");
      expect((await receiver.listNotes(scope)).map((n) => n.noteId)).toEqual([
        "long-note",
      ]);
    } finally {
      cancel.abort();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await pending.catch(() => {});
    }
  }, 30_000);

  test("native stdio and exchange survive virtual preparation time; explicit budgets still abort", async () => {
    const { PassThrough } = await import("node:stream");
    const a = store("native-long");
    await commit(a, "native-note", [note("native-note")]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("fixture deadline")), ms);
      return controller.signal;
    });
    try {
      for (const budget of [undefined, 100]) {
        const input = new PassThrough(),
          output = new PassThrough();
        let bytes = "";
        output.on("data", (chunk) => {
          bytes += chunk;
        });
        const pending = serveReplicaExchange(input, output, {
          store: a,
          peerId: "native-peer",
          policy,
          signal: signal(),
          limits: {
            ...REPLICA_LIMITS,
            ...(budget === undefined ? {} : { timeoutMs: budget }),
          },
        });
        void pending.catch(() => {});
        await vi.advanceTimersByTimeAsync(31_000);
        if (budget !== undefined) {
          await expect(pending).rejects.toThrow("aborted");
          expect(bytes).toBe("");
          continue;
        }
        input.end(JSON.stringify({ outgoing: [], cursor: null }));
        await pending;
        expect(
          JSON.parse(bytes).incoming.map((c: Change) => c.commitId),
        ).toEqual(["native-note"]);
      }
      for (const budget of [undefined, 100]) {
        const pending = exchangeReplica(
          { outgoing: [], cursor: null },
          {
            store: a,
            peerId: "native-direct",
            policy,
            signal: signal(),
            limits: {
              ...REPLICA_LIMITS,
              ...(budget === undefined ? {} : { timeoutMs: budget }),
            },
          },
        );
        void pending.catch(() => {});
        // readCursor yields on the real store before authorization and acceptance.
        vi.advanceTimersByTime(31_000);
        if (budget === undefined)
          expect((await pending).incoming.map((c) => c.commitId)).toEqual([
            "native-note",
          ]);
        else await expect(pending).rejects.toThrow("fixture deadline");
      }
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test.each(["deadline", "cancel", "sync-budget"] as const)(
    "explicit %s reaps a child that ignores SIGTERM",
    async (mode) => {
      const { setTimeout: delay } = await import("node:timers/promises");
      const ready = join(dir, "ignores-term");
      const cancel = new AbortController();
      const channel = processReplicaTransport(
        {
          executable: process.execPath,
          args: [
            "-e",
            `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`,
          ],
        },
        {
          ...REPLICA_LIMITS,
          ...(mode === "deadline" ? { timeoutMs: 100 } : {}),
        },
      );
      const pending =
        mode === "sync-budget"
          ? synchronizeReplica({
              store: store("deadline-client"),
              peerId: "deadline-peer",
              policy,
              signal: cancel.signal,
              transport: channel,
              limits: { ...REPLICA_LIMITS, timeoutMs: 100 },
            })
          : channel.exchange({ outgoing: [], cursor: null }, cancel.signal);
      void pending.catch(() => {});
      try {
        for (let i = 0; !fs.existsSync(ready) && i < 1000; i++) await delay(5);
        expect(fs.existsSync(ready)).toBe(true);
        const pid = Number(fs.readFileSync(ready, "utf8"));
        if (mode === "cancel") cancel.abort();
        await expect(pending).rejects.toThrow(
          mode === "deadline" ? "timeout" : "aborted",
        );
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        cancel.abort();
        await pending.catch(() => {});
      }
    },
  );

  test("offline SSH handshake is bounded while an independent process peer retains progress", async () => {
    const { createServer } = await import("node:net");
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture TCP address missing");
    const bin = join(dir, "bin");
    fs.mkdirSync(bin);
    const sshConfig = join(dir, "ssh-config");
    fs.writeFileSync(
      sshConfig,
      `Host fixture-offline
 HostName 127.0.0.1
 Port ${address.port}
 IdentityAgent none
 IdentitiesOnly yes
 UserKnownHostsFile /dev/null
 GlobalKnownHostsFile /dev/null
`,
    );
    // Only the network/process boundary is substituted; OpenSSH enforces the policy.
    fs.writeFileSync(
      join(bin, "ssh"),
      `#!/bin/sh
exec /usr/bin/ssh -F '${sshConfig}' "$@"
`,
      { mode: 0o700 },
    );
    const a = store("ssh-client");
    await commit(a, "healthy-note", [note("healthy-note")]);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const offline = synchronizeReplica({
        store: a,
        peerId: "offline",
        policy,
        signal: signal(),
        transport: sshReplicaTransport("fixture-offline", ["fixture-offline"]),
      });
      const outcomes = await Promise.allSettled([offline, sync(a, "healthy")]);
      expect(outcomes[0].status).toBe("rejected");
      if (outcomes[0].status === "rejected")
        expect(String(outcomes[0].reason)).toMatch(/replica process exited/);
      expect(outcomes[1].status).toBe("fulfilled");
      expect(
        (await store("healthy").listNotes(scope)).map((n) => n.noteId),
      ).toEqual(["healthy-note"]);
      expect(
        (
          await synchronizeReplica({
            store: a,
            peerId: "offline",
            policy,
            signal: signal(),
            transport: sshReplicaTransport("fixture-offline", [
              "fixture-offline",
            ]),
          })
        ).kind,
      ).toBe("backoff");
    } finally {
      process.env.PATH = originalPath;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

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
          // a warmed direct page may exceed the ancestry budget; wire bounds still apply.
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
    240_000,
  );

  test("a direct batch larger than the closure count converges after bounded warming", async () => {
    const a = store("a");
    for (let i = 0; i < 6; i++) await commit(a, `c${i}`);
    const limits = { ...REPLICA_LIMITS, maxClosureChanges: 2 };
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        const response = await exchangeReplica(
          { outgoing: [], cursor: null },
          { store: a, peerId: "cold", policy, signal: signal(), limits },
        );
        expect(response.incoming.map((c) => c.commitId)).toEqual([
          "c0",
          "c1",
          "c2",
          "c3",
          "c4",
          "c5",
        ]);
        expect(attempt).toBeGreaterThan(0);
        return;
      } catch (error) {
        expect(String(error)).toContain("replica closure limit");
      }
    }
    throw new Error("cold batch proofs did not rebuild");
  });

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

  test.each(["outgoing", "incoming", "batch"] as const)(
    "%s denies personal evidence dependencies even without declared parents",
    async (direction) => {
      for (const declared of [false, true]) {
        const a = store(`${direction}-${declared}`);
        const payload = {
          source: {
            sourceId: "source" as import("./contracts.js").SourceId,
            producer: "fixture",
            origin: {
              kind: "session" as const,
              sessionId: "session" as import("./contracts.js").SessionId,
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
          windowId: windowId(payload),
          sourceHash: hashSourceWindow(payload),
          capturedAt: now,
          importance: "ordinary" as const,
        };
        const revision = createNoteRevision({
          noteId: "project-note" as Note["noteId"],
          scope: { kind: "project", repositoryId: "fixture-project" },
          ancestry: { kind: "known", parents: [] },
          path: "project-note.md",
          body: "# project note",
          links: [],
          exposure: { kind: "active" },
          authoredAt: now,
          claims: [
            {
              kind: "producer-statement",
              markdownSpan: { start: 0, end: 1 },
              evidence: [
                {
                  windowId: w.windowId,
                  source: w.source,
                  sourceHash: w.sourceHash,
                  spans: [w.excerpts[0].span],
                },
              ],
              derivedFrom: [],
            },
          ],
        });
        const ancestor: Change = {
          commitId: "c0" as Change["commitId"],
          replicaId: "a" as Change["replicaId"],
          parents: [],
          revisions: [],
          windows: [w],
          suppressions: [],
          outcomes: [],
        };
        const child: Change = {
          ...ancestor,
          commitId: "c1" as Change["commitId"],
          parents: declared ? [ancestor.commitId] : [],
          revisions: [revision],
          windows: [],
        };
        const retained =
          direction === "outgoing"
            ? [ancestor, child]
            : direction === "incoming"
              ? [ancestor]
              : [];
        await a.forPeer("restore").integrate(retained);
        const restricted = { ...policy, personal: false };
        if (direction === "outgoing") {
          // old authorization certified this exact parentless child under the
          // restricted policy. new semantics must never reuse those v2 proofs.
          const token = await a.forPeer("inspect").continuityToken();
          const namespace = `replica-proof:v2:${sha256(canonicalJSON({ policy: restricted, token }))}`;
          await a
            .forPeer(`${namespace}:${sha256(child.commitId)}`)
            .acknowledge([], sha256(canonicalJSON(child)));
        }
        const request = {
          outgoing:
            direction === "outgoing"
              ? []
              : direction === "incoming"
                ? [child]
                : [child, ancestor],
          cursor: JSON.stringify({
            version: 1,
            after: "c0",
            received: null,
            attempts: 0,
            retryAt: 0,
          }),
        };
        await expect(
          exchangeReplica(request, {
            store: a,
            peerId: "restricted",
            policy: restricted,
            signal: signal(),
          }),
        ).rejects.toThrow("scope denied");
        if (direction !== "outgoing")
          expect(await a.listNotes(revision.scope)).toEqual([]);
        // the same payload is valid when the owner authorizes all dependencies.
        await exchangeReplica(request, {
          store: a,
          peerId: "authorized",
          policy,
          signal: signal(),
        });
        expect(
          (await a.listNotes(revision.scope)).map((n) => n.revisionId),
        ).toEqual([revision.revisionId]);
      }
    },
  );

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

  test("process failure reports safe boundary hints without echoing peer stderr", async () => {
    const privateText = "PRIVATE_FIXTURE_NOTE_DO_NOT_ECHO";
    for (const [stderr, hint] of [
      ["PI_MEMORY_GIT_REMOTE is required", "legacy remote CLI"],
      [
        "unknown or ambiguous SSH memory peer",
        "configured-peer binding rejected",
      ],
      [
        "memory store contention deadline exceeded",
        "remote storage contention",
      ],
      [
        "ssh: connect to host fixture-peer port 22: Operation timed out",
        "SSH connection unavailable",
      ],
      ["unrecognized remote failure", "replica process exited 1"],
    ]) {
      const transport = processReplicaTransport({
        executable: process.execPath,
        args: [
          "-e",
          `process.stderr.end(${JSON.stringify(stderr + "\n" + privateText)},()=>process.exit(1))`,
        ],
      });
      const error = await transport
        .exchange({ outgoing: [], cursor: null }, signal())
        .catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(hint);
      expect(error.message).not.toContain(privateText);
      expect(error.message).not.toContain("fixture-peer");
      expect(error.message).not.toContain("unrecognized remote failure");
    }
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
