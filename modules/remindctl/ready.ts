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
export interface Config {
  enabled: boolean;
  executable: string;
  account: string;
  listId: string;
  platform?: string;
}
export function check(cfg: Config, local = false, run: Runner = capture): void {
  if ((cfg.platform ?? process.platform) !== "darwin")
    throw new Error(
      "remindctl readiness requires macOS 14+ and this process's Reminders permission",
    );
  if (!cfg.enabled || !cfg.account || !cfg.listId)
    throw new Error(
      "configure my.remindctl.integration enable, account and listId for the intended EventKit list",
    );
  const status = parse(run({ executable: cfg.executable, args: ["status", "--json"] }));
  if (!record(status) || status.authorized !== true || status.status !== "full-access")
    throw new Error(
      "Reminders TCC access is missing or revoked; authorize explicitly in the intended host/terminal",
    );
  if (local) return;
  const lists = parse(run({ executable: cfg.executable, args: ["list", "--json"] }));
  if (
    !Array.isArray(lists) ||
    !lists.every(
      (v) =>
        record(v) &&
        typeof v.id === "string" &&
        typeof v.title === "string" &&
        Number.isInteger(v.reminderCount) &&
        Number.isInteger(v.overdueCount),
    ) ||
    !lists.some((v) => record(v) && v.id === cfg.listId)
  )
    throw new Error(
      "Reminders list read failed, is malformed, or the exact selected list is unavailable; verify account/list privately",
    );
}
function main(args: string[]): void {
  const [executable = "remindctl", enabled, account = "", listId = "", mode] = args;
  if (mode && mode !== "--local") throw new Error("usage: remindctl-ready [--local]");
  check({ executable, enabled: enabled === "1", account, listId }, mode === "--local");
  console.log(
    mode === "--local"
      ? "remindctl: local TCC checked; EventKit read unverified"
      : "remindctl: selected EventKit list read ready; cloud sync unverified",
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
