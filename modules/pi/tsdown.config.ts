import { defineConfig } from "tsdown";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function syncExtensionManifest(path: string, entries: string[]): void {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const extensions = entries.sort().map((entry) => `./dist/${entry}.js`);
  if (JSON.stringify(manifest.pi?.extensions) === JSON.stringify(extensions))
    return;
  manifest.pi ??= {};
  manifest.pi.extensions = extensions;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export default defineConfig({
  hooks: {
    // The build entrypoints own manifest discovery too; there is no second directory scan.
    "build:prepare": () =>
      syncExtensionManifest(
        resolve("package.json"),
        Object.keys(extensionEntries),
      ),
  },
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
    neverBundle: [
      /^@earendil-works\//,
      /^@sinclair\//,
      /^evlog(?:\/|$)/,
      /^typescript$/,
    ],
  },
  // resolve @bds_pi/* to source so they get bundled in
  alias: bdsPiAlias,
  define: { "import.meta.vitest": "undefined" },
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});

if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");

  function sourceViolations(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === "scripts" ? [path] : sourceViolations(path);
      return /\.(?:[cm]?js)$/.test(entry.name) ? [path] : [];
    });
  }

  it("keeps handwritten sources TypeScript and tooling with its owner", () => {
    expect(
      sourceViolations(fileURLToPath(new URL(".", import.meta.url))),
    ).toEqual([]);
    const fixture = mkdtempSync(resolve(tmpdir(), "pi-source-policy-"));
    try {
      writeFileSync(resolve(fixture, "valid.ts"), "");
      expect(sourceViolations(fixture)).toEqual([]);
      for (const name of ["tool.js", "tool.mjs", "tool.cjs"])
        writeFileSync(resolve(fixture, name), "");
      mkdirSync(resolve(fixture, "scripts"));
      expect(
        sourceViolations(fixture)
          .map((path) => path.slice(fixture.length + 1))
          .sort(),
      ).toEqual(["scripts", "tool.cjs", "tool.js", "tool.mjs"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("derives the extension manifest from build entries without replacing other metadata", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "pi-extension-manifest-"));
    const path = resolve(fixture, "package.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ name: "fixture", pi: { extensions: ["stale"] } }),
      );
      syncExtensionManifest(path, ["extensions/z", "extensions/a"]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        name: "fixture",
        pi: {
          extensions: ["./dist/extensions/a.js", "./dist/extensions/z.js"],
        },
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
