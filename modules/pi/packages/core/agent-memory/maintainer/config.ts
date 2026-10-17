import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveNativeSessionRoot,
  type NativeSessionRootOptions,
} from "@bds_pi/sessions";
import type { MemoryConfig } from "../catalog.js";
import type { HistoryConfig } from "./history.js";

export type MaintainerConfig = MemoryConfig &
  HistoryConfig & {
    sessions: string[];
  };

const HOME = homedir();
const envPath = (name: string, fallback: string): string =>
  resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, HOME));

export type MaintainerSessionOptions = Omit<
  NativeSessionRootOptions,
  "sessionManager"
>;

/**
 * matches CLI storage selection, not SessionManager's cwd grouping parameter:
 * custom roots are flat and relative to the launching working directory;
 * the default root contains native per-workspace directories. the maintainer
 * recursively consumes either layout without moving files or rewriting IDs.
 */
export function resolveMaintainerSessionRoot(
  opts: MaintainerSessionOptions = {},
): string {
  return resolveNativeSessionRoot(opts);
}

export function maintainerConfig(
  opts: MaintainerSessionOptions = {},
): MaintainerConfig {
  const remote = process.env.PI_MEMORY_GIT_REMOTE;
  if (!remote?.trim()) throw new Error("PI_MEMORY_GIT_REMOTE is required");
  return {
    sessions: [resolveMaintainerSessionRoot(opts)],
    state: envPath("PI_MEMORY_STATE_DIR", join(HOME, ".local/state/pi-memory")),
    data: envPath("PI_MEMORY_DATA_DIR", join(HOME, ".local/share/pi-memory")),
    root: envPath(
      "PI_MEMORY_ROOT",
      join(HOME, "commonplace/01_files/_utilities/agent-memories"),
    ),
    skillsRoot: envPath(
      "PI_MEMORY_SKILLS_ROOT",
      join(HOME, "commonplace/01_files/nix/modules/agents/skills"),
    ),
    remote,
  };
}

export function demandConfigFromEnvironment(): Pick<MemoryConfig, "state"> {
  return {
    state: envPath("PI_MEMORY_STATE_DIR", join(HOME, ".local/state/pi-memory")),
  };
}

if (import.meta.vitest) {
  const { beforeEach, afterEach, expect, test, vi } = import.meta.vitest;
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  let dir: string;
  let agent: string;
  function write(file: string, data: unknown): void {
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  beforeEach(() => {
    dir = fs.realpathSync(
      fs.mkdtempSync(join(tmpdir(), "pi-maintainer-settings-")),
    );
    agent = join(dir, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
    vi.stubEnv("PI_MEMORY_GIT_REMOTE", "https://example.invalid/memory.git");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("default native root contains SDK workspace directories; branded root lists have no effect", () => {
    write(join(agent, "settings.json"), {
      "@bds_pi/pi-memory": { sessionsDirs: ["/stale"] },
    });
    const manager = SessionManager.create(dir);
    const id = manager.getSessionId();
    expect(maintainerConfig({ cwd: dir }).sessions).toEqual([
      dirname(manager.getSessionDir()),
    ]);
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(
      join(agent, "sessions"),
    );
    expect(manager.getSessionId()).toBe(id);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    expect(resolveMaintainerSessionRoot({ settings: {} })).toBe(
      join(HOME, ".pi/agent/sessions"),
    );
  });

  test("native sessionDir is flat, accepts absolute/tilde/relative paths and is overridden by env", () => {
    const absolute = join(dir, "custom");
    write(join(agent, "settings.json"), { sessionDir: absolute });
    const manager = SessionManager.create(dir, absolute);
    expect(maintainerConfig({ cwd: dir }).sessions).toEqual([
      manager.getSessionDir(),
    ]);
    write(join(agent, "settings.json"), { sessionDir: "relative" });
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(
      join(dir, "relative"),
    );
    write(join(agent, "settings.json"), { sessionDir: "~/pi-fixture" });
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(
      join(HOME, "pi-fixture"),
    );
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "env-relative");
    fs.writeFileSync(join(agent, "settings.json"), "{broken");
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(
      join(dir, "env-relative"),
    );
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", absolute);
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(absolute);
  });

  test("SDK relative custom paths use the launching process cwd, not its session grouping cwd", () => {
    const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { SessionManager } from ${JSON.stringify(sdk)};
      import { resolve } from "node:path";
      const session = SessionManager.create("/different/grouping/cwd", "relative");
      console.log(JSON.stringify(resolve(session.getSessionDir())));
    `,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(
      resolveMaintainerSessionRoot({
        cwd: dir,
        settings: { sessionDir: "relative" },
      }),
    ).toBe(JSON.parse(result));
  });

  test("project authority is opt-in and caller snapshots avoid all settings reads", () => {
    write(join(agent, "settings.json"), { sessionDir: "global" });
    write(join(dir, ".pi/settings.json"), { sessionDir: "project" });
    expect(resolveMaintainerSessionRoot({ cwd: dir })).toBe(
      join(dir, "global"),
    );
    expect(
      resolveMaintainerSessionRoot({ cwd: dir, allowProjectConfig: true }),
    ).toBe(join(dir, "project"));
    fs.writeFileSync(join(agent, "settings.json"), "{broken");
    fs.writeFileSync(join(dir, ".pi/settings.json"), "{broken");
    expect(resolveMaintainerSessionRoot({ cwd: dir, settings: {} })).toBe(
      join(agent, "sessions"),
    );
    expect(
      resolveMaintainerSessionRoot({
        cwd: dir,
        settings: { sessionDir: "" },
        allowProjectConfig: true,
      }),
    ).toBe(join(agent, "sessions"));
    expect(() => resolveMaintainerSessionRoot({ cwd: dir })).toThrow(
      /failed to load/,
    );
    write(join(agent, "settings.json"), { sessionDir: 42 });
    expect(() => resolveMaintainerSessionRoot({ cwd: dir })).toThrow(
      /must be a string/,
    );
  });
}
