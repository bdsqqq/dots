import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path, { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const bundled = (name) =>
	require(path.join(root, "node_modules", "npm", "node_modules", name));

const expectedVersions = {
	"brace-expansion": "5.0.9",
	"ip-address": "10.3.1",
	tar: "7.5.21",
	undici: "6.28.0",
};
for (const [name, expected] of Object.entries(expectedVersions)) {
	assert.equal(bundled(`${name}/package.json`).version, expected);
}

const pluginRoot = dirname(dirname(require.resolve("@oclif/plugin-plugins")));
const { NPM } = await import(pathToFileURL(path.join(pluginRoot, "lib", "npm.js")));
const npm = new NPM({ config: {}, logLevel: "silent" });
const npmVersion = await npm.exec(["--version"], { cwd: root, logLevel: "silent" });
assert.deepEqual(npmVersion.stdout, ["12.0.2"]);

const { expand } = bundled("brace-expansion");
const boundedExpansion = expand("{a,b}".repeat(1_500));
assert.ok(boundedExpansion.length > 0);
assert.ok(boundedExpansion.reduce((length, value) => length + value.length, 0) <= 4_000_000);
const expansion = expand(`{${Array(1_000).fill("{1..5}").join(",")}}`, { maxLength: 50 });
assert.ok(expansion.length > 0);
assert.ok(expansion.reduce((length, value) => length + value.length, 0) <= 50);

const { Address4, Address6 } = bundled("ip-address");
assert.equal(Address4.isValid("012.0.0.1"), false);
assert.throws(() => new Address4("012.0.0.1"));
assert.equal(new Address4("127.0.0.1/0").isLoopback(), true);
assert.equal(new Address6("::ffff:127.0.0.1").isLoopback(), true);

const { Headers, setCookie } = bundled("undici");
assert.throws(() =>
	setCookie(new Headers(), {
		name: "sid",
		value: "x",
		domain: "example.com; SameSite=None",
	}),
);
