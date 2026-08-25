import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const extensionsDir = path.join(rootDir, "packages", "extensions");
const excludedExtensionDirs = new Set(["e2e", "test-utils"]);

function collectExtensionEntries() {
  return readdirSync(extensionsDir)
    .filter((name) => !excludedExtensionDirs.has(name))
    .filter((name) => {
      const dir = path.join(extensionsDir, name);
      if (!statSync(dir).isDirectory()) return false;
      return existsSync(path.join(dir, "index.ts"));
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `./dist/extensions/${name}.js`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const nextExtensions = collectExtensionEntries();
const prevExtensions = packageJson.pi?.extensions ?? [];

const changed =
  prevExtensions.length !== nextExtensions.length ||
  prevExtensions.some((value, index) => value !== nextExtensions[index]);

if (!packageJson.pi) packageJson.pi = {};
packageJson.pi.extensions = nextExtensions;

if (changed) {
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(
    `updated pi.extensions manifest (${nextExtensions.length} entries)`,
  );
} else {
  console.log(
    `pi.extensions manifest already in sync (${nextExtensions.length} entries)`,
  );
}
