#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { capture, isMain, privateFile, type Command } from "../tool-auth/process.ts";
export interface PlacesConfig { enabled: boolean; executable: string; apiKeyFile: string; }
const setup = "places auth is not ready; enable my.goplaces and provision its SOPS owner or intentional apiKeyFile; enable Places API (New), billing and suitable key restrictions; manually run goplaces-auth ready QUERY (potentially billable)";
export function environment(cfg: PlacesConfig): NodeJS.ProcessEnv {
  // Preserve intentional external-file usage even in package-only mode, but
  // readiness still requires an explicitly enabled integration.
  const key = privateFile(cfg.apiKeyFile).trim();
  return { ...process.env, GOOGLE_PLACES_API_KEY: key };
}
export function ready(cfg: PlacesConfig, query: string, run: (command: Command, timeout?: number) => string = capture): string {
  if (!cfg.enabled || !query.trim() || query.length > 300) throw new Error(setup);
  const env = environment(cfg);
  // Readiness must reach the real service; ordinary CLI calls retain native
  // proxy/test endpoint support when intentionally configured by the operator.
  delete env.GOOGLE_PLACES_BASE_URL;
  delete env.GOOGLE_ROUTES_BASE_URL;
  delete env.GOOGLE_DIRECTIONS_BASE_URL;
  const result = run({ executable: cfg.executable, args: ["search", query, "--limit", "1", "--json", "--timeout", "10s"], env });
  try {
    const value: unknown = JSON.parse(result);
    if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results)) throw new Error(setup);
  } catch { throw new Error(setup); }
  return "places: ready; bounded authenticated Places search succeeded (potentially billable); response discarded";
}
if (isMain(import.meta.url)) {
  try {
    const cfg = { enabled: process.env.TOOL_AUTH_PLACES_ENABLED === "1", executable: process.env.TOOL_AUTH_PLACES_BINARY ?? "goplaces", apiKeyFile: process.env.TOOL_AUTH_PLACES_KEY_FILE ?? "" };
    const [action, ...args] = process.argv.slice(2);
    if (action === "ready" && args.length === 1) console.log(ready(cfg, args[0]));
    else if (action === "run") {
      if (args.some(a => a === "--api-key" || a.startsWith("--api-key="))) throw new Error(setup);
      const result = spawnSync(cfg.executable, args, { env: environment(cfg), stdio: "inherit" });
      process.exitCode = result.status ?? 1;
    } else throw new Error(setup);
  } catch { console.error(setup); process.exitCode = 1; }
}
