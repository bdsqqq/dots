import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { getExtensionConfig, resolveGlobalSettingsPath } from "@bds_pi/config";
import { resolveNativeSessionRoot } from "@bds_pi/sessions";
import type { BacklogPolicy } from "./contracts.js";

const nonempty = Type.String({ minLength: 1 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const settingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    root: Type.Optional(nonempty),
    data: Type.Optional(nonempty),
    state: Type.Optional(nonempty),
    ownerId: Type.Optional(nonempty),
    model: Type.Optional(nonempty),
    peers: Type.Optional(
      Type.Array(
        Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._@-]{0,253}$" }),
        { maxItems: 32, uniqueItems: true },
      ),
    ),
    backlog: Type.Optional(
      Type.Object({
        minWindows: Type.Optional(
          Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        ),
        maxPendingAgeMs: Type.Optional(
          Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        ),
        maxBatchWindows: Type.Optional(positive),
        maxBatchBytes: Type.Optional(positive),
        leaseMs: Type.Optional(positive),
      }),
    ),
  },
  { additionalProperties: true },
);

/** thresholds are tunable scheduling defaults, not measured quality targets. */
export const DEFAULT_BACKLOG_POLICY: BacklogPolicy = {
  minWindows: 4,
  maxPendingAgeMs: 60 * 60 * 1000,
  maxBatchWindows: 32,
  maxBatchBytes: 64 * 1024,
  leaseMs: 10 * 60 * 1000,
};

export interface MemoryConfiguration {
  readonly enabled: boolean;
  readonly root: string;
  readonly data: string;
  readonly state: string;
  readonly ownerId: string;
  readonly model: string | null;
  readonly peers: readonly string[];
  readonly sessionRoot: string;
  readonly backlog: BacklogPolicy;
}

export interface MemoryConfigurationInput {
  readonly cwd?: string;
  readonly home?: string;
  /** a supplied native snapshot owns configuration; no settings file is read. */
  readonly settings?: Readonly<object>;
  /** overrides memory variables only; native session selection keeps its API. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function nativeSettings(): Readonly<object> {
  let text: string;
  try {
    text = readFileSync(resolveGlobalSettingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("invalid native pi settings");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("native pi settings must be an object");
  return value;
}

/**
 * one snapshot feeds both namespace and native session-root selection. cwd never
 * grants project configuration authority; Git transport belongs to compatibility
 * commands, not local memory configuration or acceptance.
 */
export function memoryConfiguration(
  input: MemoryConfigurationInput = {},
): MemoryConfiguration {
  const settings = input.settings ?? nativeSettings();
  const value = getExtensionConfig<Record<string, unknown>>(
    "@bds_pi/agent-memory",
    {},
    { settings },
  );
  if (!Check(settingsSchema, value))
    throw new Error("invalid @bds_pi/agent-memory settings");
  const env = input.environment ?? process.env;
  const home = input.home ?? homedir();
  const cwd = input.cwd ?? process.cwd();
  const choose = (
    name: string,
    configured: string | undefined,
    fallback: string,
  ): string => {
    const result = env[name] ?? configured ?? fallback;
    if (!result.trim()) throw new Error(`invalid ${name}`);
    return result;
  };
  const path = (
    name: string,
    configured: string | undefined,
    fallback: string,
  ): string =>
    resolve(
      cwd,
      choose(name, configured, fallback).replace(/^~(?=$|\/)/, home),
    );
  let peers: unknown = value.peers ?? [];
  if (env.PI_MEMORY_PEERS !== undefined) {
    try {
      peers = JSON.parse(env.PI_MEMORY_PEERS);
    } catch {
      throw new Error(
        "PI_MEMORY_PEERS must be a JSON array of SSH destinations",
      );
    }
  }
  const peerSettings: unknown = { peers };
  if (!Check(settingsSchema, peerSettings))
    throw new Error("invalid PI_MEMORY_PEERS destinations");
  const model = env.PI_MEMORY_MODEL ?? value.model ?? null;
  if (model !== null && !model.trim())
    throw new Error("invalid PI_MEMORY_MODEL");
  return {
    enabled: value.enabled ?? true,
    root: path(
      "PI_MEMORY_ROOT",
      value.root,
      join(home, "commonplace/01_files/_utilities/agent-memories"),
    ),
    data: path(
      "PI_MEMORY_DATA_DIR",
      value.data,
      join(home, ".local/share/pi-memory"),
    ),
    state: path(
      "PI_MEMORY_STATE_DIR",
      value.state,
      join(home, ".local/state/pi-memory"),
    ),
    ownerId: choose("PI_MEMORY_OWNER", value.ownerId, userInfo().username),
    model,
    peers: peerSettings.peers ?? [],
    sessionRoot: resolveNativeSessionRoot({ cwd, settings }),
    backlog: { ...DEFAULT_BACKLOG_POLICY, ...value.backlog },
  };
}

if (import.meta.vitest) {
  const { beforeEach, afterEach, expect, test, vi } = import.meta.vitest;
  const fs = await import("node:fs");
  const os = await import("node:os");
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(
      fs.mkdtempSync(join(os.tmpdir(), "pi-memory-config-")),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("supplied settings survive an unreadable native configuration and never grant project authority", () => {
    fs.mkdirSync(join(dir, "agent"));
    fs.writeFileSync(join(dir, "agent/settings.json"), "{corrupt");
    fs.mkdirSync(join(dir, ".pi"));
    fs.writeFileSync(
      join(dir, ".pi/settings.json"),
      JSON.stringify({
        sessionDir: "wrong-project-root",
        "@bds_pi/agent-memory": { root: "wrong-memory-root" },
      }),
    );
    const settings = {
      sessionDir: "sessions-flat",
      "@bds_pi/agent-memory": {
        enabled: false,
        root: "notes",
        backlog: { minWindows: 0, maxPendingAgeMs: 0 },
      },
    };
    const config = memoryConfiguration({
      settings,
      cwd: dir,
      home: dir,
      environment: {},
    });
    expect(config.root).toBe(join(dir, "notes"));
    expect(config.sessionRoot).toBe(join(dir, "sessions-flat"));
    expect(config.enabled).toBe(false);
    expect(config.backlog.minWindows).toBe(0);
    expect(config.backlog.maxPendingAgeMs).toBe(0);
    expect(() => memoryConfiguration({ cwd: dir, environment: {} })).toThrow(
      "invalid native pi settings",
    );
  });

  test("native namespace and env resolve paths without a Git remote or writes", () => {
    fs.mkdirSync(join(dir, "agent"));
    const file = join(dir, "agent/settings.json");
    const text = JSON.stringify({
      unrelated: { preserved: true },
      sessionDir: "flat",
      "@bds_pi/agent-memory": { root: "~/notes", peers: ["one"] },
    });
    fs.writeFileSync(file, text);
    const config = memoryConfiguration({
      cwd: dir,
      home: dir,
      environment: {
        PI_MEMORY_DATA_DIR: "stateful",
        PI_MEMORY_PEERS: '["two"]',
      },
    });
    expect(config.root).toBe(join(dir, "notes"));
    expect(config.data).toBe(join(dir, "stateful"));
    expect(config.peers).toEqual(["two"]);
    expect(config.sessionRoot).toBe(join(dir, "flat"));
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(fs.existsSync(config.data)).toBe(false);
  });

  test("invalid external options do not silently become a different writable root or peer", () => {
    for (const settings of [
      { "@bds_pi/agent-memory": { root: "" } },
      { "@bds_pi/agent-memory": { backlog: { maxBatchWindows: 0 } } },
      { "@bds_pi/agent-memory": { peers: ["-oProxyCommand=bad"] } },
    ])
      expect(() =>
        memoryConfiguration({ settings, environment: {} }),
      ).toThrow();
    for (const environment of [
      { PI_MEMORY_ROOT: "" },
      { PI_MEMORY_PEERS: "one,two" },
      { PI_MEMORY_PEERS: '["one", "one"]' },
    ])
      expect(() =>
        memoryConfiguration({ settings: {}, environment }),
      ).toThrow();
  });
}
