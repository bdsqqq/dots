import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

function collectAliases(base: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const name of readdirSync(resolve(base))) {
    const dir = resolve(base, name);
    const entry = resolve(dir, "index.ts");
    if (statSync(dir).isDirectory() && existsSync(entry)) {
      aliases[`@bds_pi/${name}`] = entry;
    }
  }
  return aliases;
}

export default defineConfig({
  resolve: {
    alias: {
      "@bds_pi/pi-memory/catalog": resolve(
        "packages/core/agent-memory/catalog.ts",
      ),
      "@bds_pi/pi-memory/demand": resolve(
        "packages/core/agent-memory/maintainer/demand.ts",
      ),
      "@bds_pi/pi-memory/evidence": resolve(
        "packages/core/agent-memory/evidence.ts",
      ),
      "@bds_pi/pi-memory/receipt": resolve(
        "packages/core/agent-memory/receipt.ts",
      ),
      "@bds_pi/pi-memory/tiering": resolve(
        "packages/core/agent-memory/tiering.ts",
      ),
      "@bds_pi/pi-memory/observability": resolve(
        "packages/core/agent-memory/observability.ts",
      ),
      ...collectAliases("packages/core"),
      ...collectAliases("packages/extensions"),
    },
  },
  test: {
    includeSource: ["packages/**/*.ts"],
    exclude: ["**/node_modules/**", "**/*.sync-conflict-*.ts"],
    setupFiles: ["./test/setup-memory-observability.ts"],
    testTimeout: 15_000,
  },
  define: {
    "import.meta.vitest": "undefined",
  },
});
