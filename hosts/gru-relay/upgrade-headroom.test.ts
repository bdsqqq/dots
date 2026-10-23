import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./default.nix", import.meta.url), "utf8");
const admission = source.match(/preStart = ''([\s\S]*?)'';/)?.[1];
assert.ok(admission, "upgrade admission must run before the build");

for (const [label, available, expected] of [
  ["insufficient headroom", "5945790464", 1],
  ["one byte below minimum", "8589934591", 1],
  ["exact minimum", "8589934592", 0],
  ["df padding", "    8589934592", 0],
  ["ample headroom", "10737418240", 0],
  ["missing capacity", "", 1],
  ["malformed capacity", "unknown", 1],
] as const) {
  test(label, () => {
    // A shell function substitutes only df; the admission block is unchanged.
    const result = spawnSync("bash", ["-c", `
      df() { printf 'Avail\\n%s\\n' "$AVAILABLE"; }
      ${admission}
      printf started
    `], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, AVAILABLE: available },
    });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.stdout, expected === 0 ? "started" : "");
  });
}
