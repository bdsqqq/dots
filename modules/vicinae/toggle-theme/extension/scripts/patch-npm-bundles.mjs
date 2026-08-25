import { cp, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const npmRoot = path.join(root, "node_modules", "npm");
const replacements = [
	["brace-expansion", "npm-patched-brace-expansion", "5.0.7", "5.0.9"],
	["ip-address", "npm-patched-ip-address", "10.2.0", "10.3.1"],
	["tar", "npm-patched-tar", "7.5.19", "7.5.21"],
	["undici", "npm-patched-undici", "6.27.0", "6.28.0"],
];

async function version(directory) {
	return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).version;
}

const npmVersion = await version(npmRoot);
if (npmVersion !== "12.0.2") {
	throw new Error(`refusing to patch unexpected npm ${npmVersion}`);
}

for (const [name, replacement, bundledVersion, patchedVersion] of replacements) {
	const source = path.join(root, "node_modules", replacement);
	const target = path.join(npmRoot, "node_modules", name);
	const actualBundledVersion = await version(target);
	const actualPatchedVersion = await version(source);

	if (actualPatchedVersion !== patchedVersion) {
		throw new Error(
			`refusing ${name} replacement: expected source ${patchedVersion}, got ${actualPatchedVersion}`,
		);
	}
	if (actualBundledVersion === patchedVersion) continue;
	if (actualBundledVersion !== bundledVersion) {
		throw new Error(
			`refusing ${name} replacement: expected target ${bundledVersion}, got ${actualBundledVersion}`,
		);
	}

	await rm(target, { recursive: true });
	await cp(source, target, { recursive: true });
}
