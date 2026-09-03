import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { flushLogs } from "@bds_pi/log";
import {
  renderPromptCatalog,
  scanCatalog,
  type MemoryConfig,
} from "./catalog.js";
import { verifyHistory } from "./history.js";
import { migrateV1 } from "./workflow.js";
import { maintainerConfig } from "./maintainer/config.js";
import { requestMaintenance } from "./maintainer/demand.js";
import { buildMaintainerHealth } from "./maintainer/health.js";
import {
  auditCanonicalHistory,
  fetchCanonicalHead,
  materializeCanonicalHead,
} from "./maintainer/history.js";
import {
  findIndexedProposal,
  importV2Indexes,
  listIndexedProposals,
} from "./maintainer/proposals.js";
import { publishVerifiedQmdSource } from "./maintainer/projection.js";
import {
  compensateCanonicalMutation,
  reviewProposalV3,
  runMaintainer,
  submitAndReconcileManualProposal,
} from "./maintainer/runtime.js";

process.umask(0o077);

export { renderPromptCatalog } from "./catalog.js";
export * from "./maintainer/config.js";
export * from "./maintainer/demand.js";
export * from "./maintainer/health.js";
export * from "./maintainer/runtime.js";
export * from "./maintainer/workflows.js";

function valueAfter(args: string[], name: string): string | undefined {
  const positions = args.flatMap((arg, index) => (arg === name ? [index] : []));
  if (positions.length > 1) throw new Error(`duplicate option ${name}`);
  if (!positions.length) return undefined;
  const value = args[positions[0]! + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function legacyHistoryConfig(): MemoryConfig {
  const home = homedir();
  const path = (name: string, fallback: string): string =>
    resolve((process.env[name] || fallback).replace(/^~(?=$|\/)/, home));
  return {
    state: path("PI_MEMORY_STATE_DIR", join(home, ".local/state/pi-memory")),
    data: path("PI_MEMORY_DATA_DIR", join(home, ".local/share/pi-memory")),
    root: path(
      "PI_MEMORY_ROOT",
      join(home, "commonplace/01_files/_utilities/agent-memories"),
    ),
    skillsRoot: path(
      "PI_MEMORY_SKILLS_ROOT",
      join(home, "commonplace/01_files/nix/modules/agents/skills"),
    ),
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (
    command === "history" &&
    (args[0] ?? "verify") === "verify" &&
    !process.env.PI_MEMORY_GIT_REMOTE
  ) {
    const verification = verifyHistory(legacyHistoryConfig());
    console.log(JSON.stringify(verification, null, 2));
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  const cfg = maintainerConfig();
  if (command === "maintain") {
    console.log(JSON.stringify(await runMaintainer(cfg), null, 2));
  } else if (command === "request") {
    const scopes = (valueAfter(args, "--scopes") ?? "sources,history")
      .split(",")
      .filter(Boolean);
    console.log(
      JSON.stringify(
        requestMaintenance(cfg, {
          reason: valueAfter(args, "--reason") ?? "manual cli request",
          scopes,
          priority: args.includes("--integrity") ? "integrity" : "normal",
        }),
        null,
        2,
      ),
    );
  } else if (command === "catalog") {
    const catalog = scanCatalog(cfg.root);
    console.log(
      args.includes("--json")
        ? JSON.stringify(catalog, null, 2)
        : renderPromptCatalog(
            catalog,
            resolve(valueAfter(args, "--cwd") ?? process.cwd()),
          ),
    );
  } else if (command === "propose") {
    const inline = valueAfter(args, "--json");
    const file = valueAfter(args, "--file");
    if (inline && file)
      throw new Error("propose accepts either --json or --file");
    const raw = file
      ? readFileSync(resolve(file), "utf8")
      : inline
        ? inline
        : readFileSync(0, "utf8");
    console.log(
      JSON.stringify(
        submitAndReconcileManualProposal(
          cfg,
          raw,
          valueAfter(args, "--source"),
        ),
        null,
        2,
      ),
    );
  } else if (command === "proposals") {
    const state = valueAfter(args, "--status") ?? "pending";
    if (!new Set(["pending", "reviewed", "expired"]).has(state))
      throw new Error("invalid proposal status");
    console.log(
      JSON.stringify(
        listIndexedProposals(cfg, [
          state as "pending" | "reviewed" | "expired",
        ]),
        null,
        2,
      ),
    );
  } else if (command === "show" && args[0]) {
    console.log(JSON.stringify(findIndexedProposal(cfg, args[0]), null, 2));
  } else if (command === "review" && args[0] && args[1]) {
    if (args[1] !== "accept" && args[1] !== "reject")
      throw new Error("review decision must be accept or reject");
    console.log(
      JSON.stringify(reviewProposalV3(cfg, args[0], args[1]), null, 2),
    );
  } else if (command === "migrate") {
    if (args.includes("--dry-run")) {
      const legacy = migrateV1(cfg, true);
      const indexes = importV2Indexes(cfg, () => new Date(), { dryRun: true });
      console.log(JSON.stringify({ legacy, indexes }, null, 2));
      if (indexes.unresolved.length)
        throw new Error("migration would leave unresolved records");
    } else {
      const legacy = migrateV1(cfg, false);
      const indexes = importV2Indexes(cfg);
      console.log(JSON.stringify({ legacy, indexes }, null, 2));
      if (indexes.unresolved.length)
        throw new Error("migration left unresolved records");
    }
  } else if (command === "history") {
    const action = args[0] ?? "verify";
    const head = fetchCanonicalHead(cfg);
    const audit = auditCanonicalHistory(cfg, head);
    if (action === "sync") {
      if (!materializeCanonicalHead(cfg, head))
        throw new Error("checkout publication lock contended");
      publishVerifiedQmdSource(cfg, head);
    } else if (action !== "verify")
      throw new Error("history supports verify or sync");
    console.log(
      JSON.stringify({ head, audit, synchronized: action === "sync" }, null, 2),
    );
  } else if (command === "health" || command === "status") {
    let remoteHead: string | undefined;
    let remoteCheckedAt: string | undefined;
    try {
      remoteHead = fetchCanonicalHead(cfg);
      remoteCheckedAt = new Date().toISOString();
    } catch {}
    console.log(
      JSON.stringify(
        buildMaintainerHealth(cfg, {
          ...(remoteHead ? { remoteHead } : {}),
          ...(remoteCheckedAt ? { remoteCheckedAt } : {}),
          logDirectory: process.env.BDS_PI_LOG_DIR,
        }),
        null,
        2,
      ),
    );
  } else if (command === "rollback") {
    const identifier = args[0];
    const reason = valueAfter(args, "--reason");
    if (!identifier || !reason)
      throw new Error(
        "rollback requires a mutation, proposal, or commit and --reason",
      );
    console.log(
      JSON.stringify(
        compensateCanonicalMutation(cfg, identifier, reason),
        null,
        2,
      ),
    );
  } else {
    throw new Error(
      "usage: pi-memory maintain|request|catalog|propose|proposals|show|review|migrate|history|status|health|rollback <mutation|proposal|commit> --reason TEXT",
    );
  }
}

const executedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (executedPath === import.meta.url)
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => flushLogs());
