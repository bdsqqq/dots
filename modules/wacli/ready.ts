import { capture, isMain, type Command } from "../tool-auth/process.ts";
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
import { statSync } from "node:fs";
import { join } from "node:path";
export interface Config {
  enabled: boolean;
  executable: string;
  account: string;
  store: string;
  probeGroup: string;
}
export function check(cfg: Config, local = false, run: Runner = capture): void {
  if (
    !cfg.enabled ||
    !cfg.account ||
    !cfg.store.startsWith("/") ||
    !cfg.probeGroup.endsWith("@g.us")
  )
    throw new Error(
      "configure my.wacli.integration enable, account, storeDir and probeGroupJid; pair explicitly with wacli --store DIR auth",
    );
  // Metadata preflight prevents doctor from manufacturing a fresh empty store.
  try {
    const directory = statSync(cfg.store);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error();
  } catch {
    throw new Error("selected WhatsApp store must be an existing private owner-only directory");
  }
  for (const name of ["session.db", "wacli.db"]) {
    try {
      const s = statSync(join(cfg.store, name));
      if (!s.isFile() || s.size === 0) throw new Error();
    } catch {
      throw new Error(
        "selected WhatsApp store is missing; pair explicitly, never provision device databases through SOPS",
      );
    }
  }
  const args = ["--store", cfg.store, "--timeout", "10s", "--json"];
  const report = parse(
    run({ executable: cfg.executable, args: [...args, "doctor", ...(local ? [] : ["--connect"])] }),
  );
  if (
    !record(report) ||
    report.success !== true ||
    report.error != null ||
    !record(report.data) ||
    report.data.authenticated !== true ||
    report.data.lock_held !== false
  )
    throw new Error(
      "WhatsApp is unpaired, locked, or invalid; resolve the selected store privately",
    );
  if (local) return;
  if (report.data.connected !== true)
    throw new Error("WhatsApp connection failed; check the selected linked device privately");
  // doctor --connect alone only proves transport. A single group info request
  // proves authenticated access without sync/backfill; upstream caches its metadata.
  const response = parse(
    run({ executable: cfg.executable, args: [...args, "groups", "info", "--jid", cfg.probeGroup] }),
  );
  if (
    !record(response) ||
    response.success !== true ||
    response.error != null ||
    !record(response.data) ||
    response.data.JID !== cfg.probeGroup ||
    !Array.isArray(response.data.Participants)
  )
    throw new Error(
      "WhatsApp authenticated group read failed or returned invalid data; check pairing and probeGroupJid",
    );
}
function main(args: string[]): void {
  const [executable = "wacli", enabled, account = "", store = "", probeGroup = "", mode] = args;
  if (mode && mode !== "--local") throw new Error("usage: wacli-ready [--local]");
  check({ executable, enabled: enabled === "1", account, store, probeGroup }, mode === "--local");
  console.log(
    mode === "--local"
      ? "wacli: local paired state checked; online readiness unverified"
      : "wacli: authenticated read ready",
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
