import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getExtensionConfigWithSchema } from "@bds_pi/config";
import type { MemoryConfig } from "../catalog.js";
import type { HistoryConfig } from "./history.js";

export type MaintainerConfig = MemoryConfig &
  HistoryConfig & {
    sessions: string[];
  };

const HOME = homedir();
const envPath = (name: string, fallback: string): string =>
  resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, HOME));

type PiMemoryExtensionConfig = { sessionsDirs: string[] };
const defaults: PiMemoryExtensionConfig = {
  sessionsDirs: [join(HOME, ".pi/agent/sessions")],
};

function validConfig(
  value: Record<string, unknown>,
): value is PiMemoryExtensionConfig {
  return (
    Array.isArray(value.sessionsDirs) &&
    value.sessionsDirs.length > 0 &&
    value.sessionsDirs.every(
      (path) => typeof path === "string" && path.trim().length > 0,
    )
  );
}

export function maintainerConfig(): MaintainerConfig {
  const configured = getExtensionConfigWithSchema(
    "@bds_pi/pi-memory",
    defaults,
    { schema: { validate: validConfig } },
  );
  const sessions = process.env.PI_CODING_AGENT_SESSION_DIR
    ? [envPath("PI_CODING_AGENT_SESSION_DIR", "")]
    : configured.sessionsDirs.map((path) =>
        resolve(path.replace(/^~(?=$|\/)/, HOME)),
      );
  const remote = process.env.PI_MEMORY_GIT_REMOTE;
  if (!remote?.trim()) throw new Error("PI_MEMORY_GIT_REMOTE is required");
  return {
    sessions: [...new Set(sessions)],
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
