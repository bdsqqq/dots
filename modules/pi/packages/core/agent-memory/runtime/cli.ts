import type { Readable } from "node:stream";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type * as C from "./contracts.js";
import {
  openMemoryApplication,
  type MemoryApplication,
} from "./application.js";
import { parseWindow, parseChange } from "./wire.js";
import { importLegacyMarkdown } from "./legacy-import.js";
import { authenticateInboundPeer } from "./peer-auth.js";
import { serveReplicaExchange } from "./replica-transport.js";

const obj = <P extends Record<string, TSchema>>(p: P) =>
  Type.Object(p, { additionalProperties: false });
const id = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000\\r\\n]+$",
});
const scope = Type.Union([
  obj({ kind: Type.Literal("personal"), ownerId: id }),
  obj({ kind: Type.Literal("project"), repositoryId: id }),
]);
const intentSchema = obj({
  intentId: id,
  target: obj({ consumerId: id, sessionId: id, scope }),
  entryId: id,
  query: Type.String({ maxLength: 16384 }),
  expiresAt: Type.String(),
  maxChars: Type.Integer({ minimum: 1, maximum: 32768 }),
  maxNotes: Type.Integer({ minimum: 1, maximum: 64 }),
});
const requestSchema = Type.Union([
  obj({ command: Type.Literal("status") }),
  obj({ command: Type.Literal("maintain") }),
  obj({ command: Type.Literal("catch-up") }),
  obj({ command: Type.Literal("replicate") }),
  obj({
    command: Type.Literal("capture"),
    windows: Type.Array(Type.Unknown(), { maxItems: 128 }),
  }),
  obj({ command: Type.Literal("recall"), intent: intentSchema }),
  obj({ command: Type.Literal("suppress"), suppression: Type.Unknown() }),
  obj({
    command: Type.Literal("import-legacy"),
    paths: Type.Array(id, { minItems: 1, maxItems: 128 }),
  }),
]);
export async function readBoundedJSON(
  stream: Readable,
  signal?: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = () => stream.destroy(new Error("memory input interrupted"));
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if ((length += b.length) > 1024 * 1024)
        throw new Error("memory JSON byte limit");
      chunks.push(b);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
/** local SDK/CLI calls are owner actions. exchange is absent from this protocol. */
export async function handleMemoryJSON(
  value: unknown,
  app: MemoryApplication,
  signal: AbortSignal,
): Promise<unknown> {
  if (!Check(requestSchema, value))
    throw new Error(
      "invalid memory request; root/owner/peer/configuration are not request fields",
    );
  const request = value;
  switch (request.command) {
    case "status":
      return app.status();
    case "maintain":
      return app.maintain(signal);
    case "catch-up":
      return app.catchUp(signal);
    case "replicate":
      return app.replicate(signal);
    case "capture":
      return app.capture(request.windows.map(parseWindow));
    case "recall": {
      if (
        !Number.isFinite(Date.parse(request.intent.expiresAt)) ||
        new Date(request.intent.expiresAt).toISOString() !==
          request.intent.expiresAt
      )
        throw new Error("invalid recall expiry");
      return app.recall(request.intent as C.RecallIntent, signal);
    }
    case "suppress": {
      const change = parseChange({
        commitId: "validation",
        now: new Date().toISOString(),
        windows: [],
        edits: [],
        suppressions: [request.suppression],
        outcomes: [],
        lease: null,
      });
      return app.suppress(change.suppressions[0]!);
    }
    case "import-legacy":
      return importLegacyMarkdown({
        paths: request.paths,
        store: app.store,
        scope: app.scope,
        archive: join(app.configuration.data, "runtime", "legacy-originals"),
      });
  }
}
const legacy = new Set([
  "project-proposals",
  "project-resolve",
  "propose",
  "proposals",
  "show",
  "review",
  "history",
  "catalog",
  "migrate",
  "request",
  "rollback",
]);
export async function memoryCLI(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const command = args[0];
  if (command === "legacy" || (command && legacy.has(command))) {
    const previousRemote = process.env.PI_MEMORY_GIT_REMOTE;
    if (
      previousRemote === undefined &&
      process.env.PI_MEMORY_LEGACY_GIT_REMOTE !== undefined
    )
      process.env.PI_MEMORY_GIT_REMOTE =
        process.env.PI_MEMORY_LEGACY_GIT_REMOTE;
    const { legacyMain } = await import("../legacy-cli.js");
    try {
      await legacyMain(command === "legacy" ? args.slice(1) : args);
    } finally {
      if (previousRemote === undefined) delete process.env.PI_MEMORY_GIT_REMOTE;
      else process.env.PI_MEMORY_GIT_REMOTE = previousRemote;
      const { flushLogs } = await import("@bds_pi/log");
      await flushLogs();
    }
    return;
  }
  if (command === "--help" || command === "help" || !command) {
    console.log(
      "pi-memory status|maintain|catch-up|replicate|capture|recall|suppress|import-legacy|json|exchange\nJSON data commands read one bounded object from stdin; json also requires command.\nlegacy <command> preserves colliding historical maintain/status/health.\nlegacy: project-proposals/project-resolve/propose/proposals/show/review/history/catalog/migrate/request/rollback",
    );
    return;
  }
  if (args.length !== 1)
    throw new Error("native commands take JSON on stdin, not extra arguments");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("memory CLI interrupted"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let app: MemoryApplication | undefined;
  try {
    app = await openMemoryApplication({}, controller.signal);
    if (command === "exchange") {
      const peerId = await authenticateInboundPeer({
        connection: process.env.SSH_CONNECTION,
        peers: app.configuration.peers,
      });
      await serveReplicaExchange(process.stdin, process.stdout, {
        store: app.store,
        peerId,
        policy: app.policy(),
        signal: controller.signal,
      });
      return;
    }
    const needsData = [
      "json",
      "capture",
      "recall",
      "suppress",
      "import-legacy",
    ].includes(command);
    const raw = needsData
      ? await readBoundedJSON(process.stdin, controller.signal)
      : {};
    const value =
      command === "json"
        ? raw
        : raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? { ...raw, command }
          : raw;
    console.log(
      JSON.stringify(await handleMemoryJSON(value, app, controller.signal)),
    );
  } finally {
    app?.close();
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { spawnSync, spawn } = await import("node:child_process");
  const { DatabaseSync } = await import("node:sqlite");
  const { EventEmitter } = await import("node:events");
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    existsSync,
    rmSync,
    symlinkSync,
    readdirSync,
    unlinkSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { SessionMemoryWorker, runtimeStoreConfiguration } =
    await import("./session-worker.js");
  const { memoryConfiguration } = await import("./config.js");
  it("real CLI survives former whole-job deadlines and interrupts an open input pipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-cli-lifetime-"));
    const harness = join(dir, "clock.mjs");
    writeFileSync(harness, `
      const loaded = await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});
      const { memoryCLI } = loaded.default ?? loaded;
      const nativeTimeout = globalThis.setTimeout;
      const deadlines = [];
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay >= 60000) {
          deadlines.push(() => callback(...args));
          return { unref() {} };
        }
        return nativeTimeout(callback, delay, ...args);
      };
      process.on("message", () => {
        for (const callback of deadlines.splice(0)) callback();
        process.send("advanced");
      });
      process.send("ready");
      try { await memoryCLI(["capture"]); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }
      process.disconnect();
    `);
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
      PI_MEMORY_ROOT: join(dir, "notes"),
      PI_MEMORY_DATA_DIR: join(dir, "data"),
      PI_MEMORY_STATE_DIR: join(dir, "state"),
      PI_MEMORY_OWNER: "fixture",
      PI_MEMORY_PEERS: "[]",
      PI_OFFLINE: "1",
    };
    try {
      for (const interrupt of [false, true]) {
        const child = spawn(process.execPath, ["--import", "jiti/register", harness], {
          env,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        let output = "", errors = "";
        child.stdout!.on("data", (b) => { output += b; });
        child.stderr!.on("data", (b) => { errors += b; });
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
        try {
          await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("message", () => resolve());
            child.once("exit", () => reject(new Error(errors || "CLI exited before ready")));
          });
          const advanced = new Promise<void>((resolve) => child.once("message", () => resolve()));
          child.send("advance beyond former deadlines");
          await advanced;
          if (interrupt) child.kill("SIGTERM");
          else child.stdin!.end(JSON.stringify({ windows: [] }));
          expect(await exited, errors).toBe(interrupt ? 1 : 0);
          if (interrupt) expect(errors).toMatch(/interrupt/);
          else expect(JSON.parse(output).kind).toBe("unchanged");
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it("real source and built CLI share native settings, JSON rejection, independent maintenance and fail-closed exchange", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-cli-"));
    try {
      const agent = join(dir, "agent");
      mkdirSync(agent);
      const text = JSON.stringify({
        unrelated: { mutable: "keep" },
        sessionDir: join(dir, "sessions"),
        "@bds_pi/agent-memory": {
          root: join(dir, "notes"),
          data: join(dir, "data"),
          state: join(dir, "state"),
          ownerId: "fixture",
          peers: [],
        },
      });
      writeFileSync(join(agent, "settings.json"), text);
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
        PI_MEMORY_ROOT: join(dir, "notes"),
        PI_MEMORY_DATA_DIR: join(dir, "data"),
        PI_MEMORY_STATE_DIR: join(dir, "state"),
        PI_MEMORY_OWNER: "fixture",
        PI_MEMORY_PEERS: "[]",
        PI_OFFLINE: "1",
        SSH_CONNECTION: "",
      };
      const built = resolve("dist/core/agent-memory.js");
      expect(existsSync(built)).toBe(true);
      const executable = join(dir, "pi-memory");
      symlinkSync(built, executable);
      const help = spawnSync(executable, ["--help"], {
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("pi-memory");
      writeFileSync(join(agent, "settings.json"), "{invalid native settings");
      for (const source of [true, false]) {
        const file = source
          ? resolve("packages/core/agent-memory/index.ts")
          : built;
        const imported = spawnSync(
          process.execPath,
          [
            ...(source ? ["--import", "jiti/register"] : []),
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify((await import("node:url")).pathToFileURL(file).href)})`,
          ],
          { env, encoding: "utf8", timeout: 15_000 },
        );
        expect(imported.status, imported.stderr).toBe(0);
        expect(existsSync(join(dir, "notes"))).toBe(false);
      }
      writeFileSync(join(agent, "settings.json"), text);

      for (const entry of [
        [
          "--import",
          "jiti/register",
          resolve("packages/core/agent-memory/index.ts"),
        ],
        [built],
        [executable],
      ]) {
        const run = (command: string, input = "") =>
          spawnSync(process.execPath, [...entry, command], {
            env,
            input,
            encoding: "utf8",
            timeout: 15_000,
          });
        const status = run("status");
        expect(status.stderr, status.stdout).not.toContain("Error");
        expect(status.status, status.stderr).toBe(0);
        expect(JSON.parse(status.stdout).paths.root).toBe(
          join(dir, "notes", "runtime"),
        );
        const maintained = run("maintain");
        expect(maintained.status, maintained.stderr).toBe(0);
        expect(JSON.parse(maintained.stdout).reconciliation.idle.reason).toBe(
          "empty",
        );
        for (const payload of [
          "{malformed",
          JSON.stringify({ command: "exchange", peer: "forged" }),
          JSON.stringify({ command: "status", root: "/forged" }),
        ])
          expect(run("json", payload).status).toBe(1);
        const exchange = run(
          "exchange",
          JSON.stringify({ outgoing: [], cursor: null, owner: "forged" }),
        );
        expect(exchange.status).toBe(1);
        expect(exchange.stderr).toContain("authenticated SSH connection");
        expect(exchange.stdout).toBe("");
      }
      const original = join(dir, "legacy-fixture.md");
      writeFileSync(original, "a green kettle bought with my sister");
      const runBuilt = (command: string, input = "") =>
        spawnSync(process.execPath, [built, command], {
          env,
          input,
          encoding: "utf8",
          timeout: 15_000,
        });
      const imported = runBuilt(
        "import-legacy",
        JSON.stringify({ paths: [original] }),
      );
      expect(imported.status, imported.stderr).toBe(0);
      expect(JSON.parse(imported.stdout)[0].kind).toBe("locally-committed");
      const recalled = runBuilt(
        "recall",
        JSON.stringify({
          intent: {
            intentId: "cli-query",
            entryId: "entry",
            target: {
              consumerId: "fixture",
              sessionId: "fixture",
              scope: { kind: "personal", ownerId: "fixture" },
            },
            query: "green kettle",
            expiresAt: "2099-01-01T00:00:00.000Z",
            maxChars: 2000,
            maxNotes: 2,
          },
        }),
      );
      expect(recalled.status, recalled.stderr).toBe(0);
      expect(JSON.parse(recalled.stdout).kind).toBe("queued");
      const below = runBuilt("maintain");
      expect(below.status, below.stderr).toBe(0);
      expect(JSON.parse(below.stdout).reconciliation.idle.reason).toBe(
        "below-threshold",
      );
      expect(await import("../index.js")).toHaveProperty(
        "createMemoryApplication",
      );
      expect(existsSync(join(dir, "notes", "runtime"))).toBe(true);
      const configuration = memoryConfiguration({
        settings: JSON.parse(text),
        environment: {},
        cwd: dir,
        home: dir,
      });
      const worker = new SessionMemoryWorker({
        store: runtimeStoreConfiguration(configuration),
        entry: new URL(
          `file://${resolve("dist/core/agent-memory-session-worker.js")}`,
        ),
      });
      try {
        const result = await worker.request({
          kind: "recall",
          intent: {
            intentId: "worker" as C.IntentId,
            entryId: "entry" as C.EntryId,
            query: "empty",
            target: {
              consumerId: "fixture",
              sessionId: "fixture" as C.SessionId,
              scope: { kind: "personal", ownerId: "fixture" },
            },
            expiresAt: "2099-01-01T00:00:00.000Z",
            maxChars: 1000,
            maxNotes: 2,
          },
        });
        expect(result).toEqual({ kind: "empty" });
      } finally {
        worker.close();
      }
      expect(
        (await import("node:fs")).readFileSync(
          join(agent, "settings.json"),
          "utf8",
        ),
      ).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("cold eligibility bounds opening and does not poison subsequent worker operations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-cold-check-"));
    const configuration = memoryConfiguration({
      settings: {
        "@bds_pi/agent-memory": {
          root: join(dir, "notes"),
          data: join(dir, "data"),
          state: join(dir, "state"),
          ownerId: "fixture",
          peers: [],
        },
      },
      environment: {},
      cwd: dir,
      home: dir,
    });
    const seed = await openMemoryApplication({ configuration });
    const store = seed.store.config;
    seed.close();
    const { createNoteRevision } = await import("./markdown.js");
    const editable = join(store.root, "manual.md");
    writeFileSync(
      editable,
      createNoteRevision({
        noteId: "manual" as C.NoteId,
        ancestry: { kind: "known", parents: [] },
        scope: { kind: "personal", ownerId: "fixture" },
        path: "manual.md",
        body: "fixture only",
        authoredAt: new Date().toISOString(),
        claims: [],
        links: [],
        exposure: { kind: "active" },
      }).markdown,
    );
    const worker = new SessionMemoryWorker({
      store,
      entry: new URL(
        `file://${resolve("dist/core/agent-memory-session-worker.js")}`,
      ),
    });
    const lock = new DatabaseSync(join(store.state, "coordination.sqlite"));
    const target: C.RecallTarget = {
      consumerId: "fixture",
      sessionId: "fixture" as C.SessionId,
      scope: { kind: "personal", ownerId: "fixture" },
    };
    const intent: C.RecallIntent = {
      target,
      intentId: "fixture" as C.IntentId,
      entryId: "fixture" as C.EntryId,
      query: "fixture",
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxChars: 1000,
      maxNotes: 1,
    };
    const delivery: C.RecallDelivery = {
      deliveryId: "unknown" as C.DeliveryId,
      intent,
      context: {
        text: "untrusted fixture",
        notes: [
          {
            noteId: "unknown" as C.NoteId,
            revisionId: "unknown" as C.RevisionId,
          },
        ],
        evidence: [],
      },
    };
    let held = false;
    try {
      // Load the worker/module graph without opening its store, so startup time
      // cannot hide an over-budget database acquisition.
      await worker.request({ kind: "project-context", cwd: dir });
      lock.exec("BEGIN IMMEDIATE");
      held = true;
      const checked = worker
        .request({ kind: "check", deliveries: [delivery] }, 5000)
        .then(
          (value) => ({ value }),
          (error) => ({ error: String(error) }),
        );
      const result = await Promise.race([
        checked,
        new Promise((resolve) =>
          setTimeout(() => resolve({ overran: true }), 600),
        ),
      ]);
      expect(result).toMatchObject({
        error: expect.stringMatching(/timeout|deadline/i),
      });
      expect(readdirSync(join(store.data, "commits"))).toEqual([]);
      lock.exec("COMMIT");
      held = false;
      unlinkSync(editable);
      expect(
        await worker.request({ kind: "check", deliveries: [delivery] }),
      ).toEqual([{ kind: "discard", reason: "obsolete" }]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await worker.request({ kind: "recover", target, intent })).toBe(
        null,
      );
    } finally {
      if (held) lock.exec("ROLLBACK");
      lock.close();
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each(["status", "maintain"])(
    "production %s imports an editable note despite an existing writer without caller retries",
    async (command) => {
      const dir = mkdtempSync(join(tmpdir(), "memory-cli-contention-"));
      const agent = join(dir, "agent");
      mkdirSync(agent);
      writeFileSync(join(agent, "settings.json"), "{}");
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
        PI_MEMORY_ROOT: join(dir, "notes"),
        PI_MEMORY_DATA_DIR: join(dir, "data"),
        PI_MEMORY_STATE_DIR: join(dir, "state"),
        PI_MEMORY_OWNER: "fixture",
        PI_MEMORY_PEERS: "[]",
        PI_OFFLINE: "1",
      };
      const configuration = memoryConfiguration({
        settings: {},
        environment: env,
      });
      const seed = await openMemoryApplication({ configuration });
      const database = join(seed.store.config.state, "coordination.sqlite");
      const editable = join(seed.store.config.root, "manual.md");
      seed.close();
      const { createNoteRevision } = await import("./markdown.js");
      writeFileSync(
        editable,
        createNoteRevision({
          noteId: "manual" as C.NoteId,
          ancestry: { kind: "known", parents: [] },
          scope: { kind: "personal", ownerId: "fixture" },
          path: "manual.md",
          body: "a fixture note edited outside the application",
          authoredAt: new Date().toISOString(),
          claims: [],
          links: [],
          exposure: { kind: "active" },
        }).markdown,
      );
      const lock = new DatabaseSync(database);
      let child: ReturnType<typeof spawn> | undefined;
      let released = false;
      try {
        lock.exec("BEGIN IMMEDIATE");
        // Imports finish before ready, so the measured hold covers real production
        // opening/operations rather than Jiti or module startup time.
        const script = `import {createJiti} from 'jiti';
        const jiti=createJiti(process.cwd()+'/package.json',{moduleCache:false,fsCache:false});
        const {memoryCLI}=await jiti.import(${JSON.stringify(resolve("packages/core/agent-memory/runtime/cli.ts"))});
        process.send('ready');
        try { await memoryCLI([${JSON.stringify(command)}]); }
        catch(error) { console.error(error.message); process.exitCode=1; }
        finally { process.disconnect(); }`;
        child = spawn(
          process.execPath,
          ["--input-type=module", "--eval", script],
          {
            env,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout!.on("data", (value) => {
          stdout += value;
        });
        child.stderr!.on("data", (value) => {
          stderr += value;
        });
        const closed = EventEmitter.once(child, "close");
        await Promise.race([
          EventEmitter.once(child, "message"),
          closed.then(() => {
            throw new Error(`CLI exited before readiness: ${stderr}`);
          }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 700));
        lock.exec("COMMIT");
        released = true;
        const [code] = await closed;
        expect(code, stderr).toBe(0);
        const result = JSON.parse(stdout);
        if (command === "status")
          expect(result).toMatchObject({ enabled: true, notes: 1 });
        else expect(result.reconciliation.idle.reason).toBe("empty");
      } finally {
        if (!released) lock.exec("ROLLBACK");
        lock.close();
        if (child && child.exitCode === null) child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
