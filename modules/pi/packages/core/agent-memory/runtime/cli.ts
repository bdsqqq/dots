import type { Readable } from "node:stream";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type * as C from "./contracts.js";
import {
  createMemoryApplication,
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
export async function readBoundedJSON(stream: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if ((length += b.length) > 1024 * 1024)
      throw new Error("memory JSON byte limit");
    chunks.push(b);
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
  const timer = setTimeout(abort, 150_000);
  const deadline = setTimeout(() => {
    console.error("memory process deadline");
    process.exit(1);
  }, 155_000);
  deadline.unref();
  let app: MemoryApplication | undefined;
  try {
    app = createMemoryApplication();
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
    const raw = needsData ? await readBoundedJSON(process.stdin) : {};
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
    clearTimeout(timer);
    clearTimeout(deadline);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { spawnSync } = await import("node:child_process");
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    existsSync,
    rmSync,
    symlinkSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { SessionMemoryWorker, runtimeStoreConfiguration } =
    await import("./session-worker.js");
  const { memoryConfiguration } = await import("./config.js");
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
}
