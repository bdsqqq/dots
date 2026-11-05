import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SagemcomXmoClient } from "../src/client.ts";
import { discoverCapabilities } from "../src/discovery.ts";
import { readHar, capturedCredentials, sourceInventory } from "./har.ts";

const harIndex = process.argv.indexOf("--har");
const harPath = harIndex < 0 ? undefined : process.argv[harIndex + 1];
const har = harPath ? readHar(harPath) : undefined;
const sources = harPath && har ? sourceInventory(harPath, har) : undefined;
if (process.argv.includes("--sources-only")) {
  if (!sources) throw new Error("--sources-only requires --har");
  writeFileSync(
    fileURLToPath(new URL("../inventory/sources.json", import.meta.url)),
    JSON.stringify(sources, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      scripts: sources.scripts.length,
      paths: new Set(sources.paths.map((p) => p.path)).size,
      frontendCommands: new Set(sources.frontendCommands.map((c) => c.method)).size,
      errorCodes: Object.keys(sources.errorCodes).length,
    }),
  );
  process.exit(0);
}
// --har explicitly opts into recovering the assigned admin credential from this local capture.
const credentials = har
  ? capturedCredentials(har)
  : {
      username: process.env.FAST3896_CLARO_USERNAME ?? "",
      password: process.env.FAST3896_CLARO_PASSWORD_FILE
        ? readFileSync(process.env.FAST3896_CLARO_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "")
        : "",
    };
const client = new SagemcomXmoClient({
  baseUrl: process.env.FAST3896_CLARO_URL ?? "http://192.168.0.1",
  auth: { mode: "credentials", ...credentials },
});
try {
  const catalog = await discoverCapabilities(client, {
    seeds: ["Device/DeviceInfo", ...new Set(sources?.paths.map((p) => p.path) ?? [])],
    maxPaths: 8000,
    batchSize: 20,
    onProgress: (p) => {
      if (p.queried % 100 < 20) console.error(JSON.stringify(p));
    },
  });
  writeFileSync(
    fileURLToPath(new URL("../inventory/firmware.json", import.meta.url)),
    JSON.stringify(catalog, null, 2) + "\n",
  );
  if (sources)
    writeFileSync(
      fileURLToPath(new URL("../inventory/sources.json", import.meta.url)),
      JSON.stringify(sources, null, 2) + "\n",
    );
  console.log(
    JSON.stringify({
      identity: catalog.identity,
      nodes: catalog.nodes.length,
      commands: catalog.nodes.reduce((n, x) => n + x.commands.length, 0),
      coverage: {
        requests: catalog.coverage.requests,
        queriedPaths: catalog.coverage.queriedPaths.length,
        issues: catalog.coverage.issues.length,
        limitsReached: catalog.coverage.limitsReached,
      },
    }),
  );
} finally {
  await client.logout();
}
