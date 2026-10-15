import { capture, isMain, privateFile, type Command } from "../tool-auth/process.ts";
export type Runner = (command: Command, timeout?: number) => string;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid native response; check the selected integration privately");
  }
};
import { join } from "node:path";
export interface Config {
  enabled: boolean;
  executable: string;
  yaml: string;
  configHome: string;
  bridge: string;
}
export function check(cfg: Config, local = false, run: Runner = capture): void {
  if (!cfg.enabled || !cfg.configHome.startsWith("/") || !cfg.bridge)
    throw new Error(
      "configure my.openhue.integration enable, configHome, nativeConfigFile and bridge; physical bridge pairing is explicit",
    );
  const file = join(cfg.configHome, "openhue/config.yaml");
  privateFile(file);
  const config = parse(run({ executable: cfg.yaml, args: ["-o=json", ".", file] }));
  if (
    !record(config) ||
    (config.bridge ?? config.Bridge) !== cfg.bridge ||
    typeof (config.key ?? config.Key) !== "string" ||
    !(config.key ?? config.Key)
  )
    throw new Error(
      "selected Hue bridge/key is missing or mismatched; pair the intended bridge explicitly",
    );
  if (local) return;
  const value = parse(
    run({
      executable: cfg.executable,
      args: ["get", "--type", "bridge", "--json"],
      env: { ...process.env, XDG_CONFIG_HOME: cfg.configHome },
    }),
  );
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (v) => record(v) && typeof v.id === "string" && v.id.length > 0 && v.type === "bridge",
    )
  )
    throw new Error(
      "Hue authenticated bridge read failed or returned invalid resource data; check pairing and bridge reachability privately",
    );
}
function main(args: string[]): void {
  const [executable = "openhue", yaml = "yq", enabled, configHome = "", bridge = "", mode] = args;
  if (mode && mode !== "--local") throw new Error("usage: openhue-ready [--local]");
  check({ executable, yaml, enabled: enabled === "1", configHome, bridge }, mode === "--local");
  console.log(
    mode === "--local"
      ? "openhue: local configuration checked; authenticated readiness unverified"
      : "openhue: authenticated bridge read ready",
  );
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "readiness failed");
    process.exitCode = 1;
  }
}
