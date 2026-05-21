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
      ...collectAliases("packages/core"),
      ...collectAliases("packages/extensions"),
    },
  },
  test: {
    includeSource: ["packages/**/*.ts"],
    exclude: ["**/node_modules/**", "**/*.sync-conflict-*.ts"],
  },
  define: {
    "import.meta.vitest": "undefined",
  },
});
