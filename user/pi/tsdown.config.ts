import { defineConfig } from "tsdown";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const excludedEntryDirs = new Set(["e2e", "test-utils"]);

/** collect all index.ts entry points from a packages subdirectory. */
function collectEntries(base: string, prefix: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(resolve(base))) {
    if (excludedEntryDirs.has(name)) continue; // test-only package

    const dir = resolve(base, name);
    const entry = resolve(dir, "index.ts");

    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(entry)) continue;

    entries[`${prefix}/${name}`] = entry;
  }
  return entries;
}

const coreEntries = collectEntries("packages/core", "core");
const extensionEntries = collectEntries("packages/extensions", "extensions");

/** all @bds_pi/* workspace packages resolved to their source. */
const bdsPiAlias: Record<string, string> = {};
for (const [key, value] of Object.entries({
  ...coreEntries,
  ...extensionEntries,
})) {
  const pkgName = `@bds_pi/${key.split("/")[1]}`;
  bdsPiAlias[pkgName] = value;
}

export default defineConfig({
  entry: {
    // barrel
    extensions: "src/extensions.ts",
    // individual extensions + core
    ...extensionEntries,
    ...coreEntries,
  },
  format: "esm",
  dts: { resolver: "oxc" },
  tsconfig: "tsconfig.build.json",
  deps: {
    neverBundle: [/^@mariozechner\//, /^@sinclair\//],
  },
  // resolve @bds_pi/* to source so they get bundled in
  alias: bdsPiAlias,
  define: { "import.meta.vitest": "undefined" },
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});
