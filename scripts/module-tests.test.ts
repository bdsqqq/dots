import assert from "node:assert/strict";
import test from "node:test";

import { importsBunTest, selectSuites } from "./module-tests.ts";

test("new tests are selected by default; packages run once; exclusions hold", () => {
  const files = [
    "modules/new-thing/brand-new.test.ts",
    "modules/company-money/money.test.ts",
    "modules/company-money/ledger/state.test.ts",
    "modules/pi/packages/core/x/index.test.ts",
    "modules/foo/README.md",
  ];
  const suites = selectSuites(files, (dir) => dir === "modules/company-money");
  assert.deepEqual(suites, [
    {
      kind: "package",
      dir: "modules/company-money",
      files: [
        "modules/company-money/ledger/state.test.ts",
        "modules/company-money/money.test.ts",
      ],
    },
    { kind: "file", file: "modules/new-thing/brand-new.test.ts", runner: "node" },
  ]);
});


test("a package runs every selected test file, not just its script's glob", () => {
  const files = [
    "modules/syncthing/automerge/syncthing-automerge.test.ts",
    "modules/syncthing/automerge/regression.test.ts",
  ];
  assert.deepEqual(selectSuites(files, (dir) => dir === "modules/syncthing/automerge"), [
    { kind: "package", dir: "modules/syncthing/automerge", files: [...files].sort() },
  ]);
});

test("every node test extension is discovered", () => {
  const files = ["a/x.test.ts", "a/x.test.mts", "a/x.test.cts", "a/x.test.js", "a/x.test.mjs", "a/x.test.cjs", "a/test_x.ts", "a/x.ts", "a/latest_x.ts"];
  assert.equal(selectSuites(files, () => false).length, 7);
});

test("bun suites stay on bun even inside a package", () => {
  const suites = selectSuites(
    ["modules/html-stuff/server.test.ts"],
    (dir) => dir === "modules/html-stuff",
    (file) => file === "modules/html-stuff/server.test.ts",
  );
  assert.deepEqual(suites, [{ kind: "file", file: "modules/html-stuff/server.test.ts", runner: "bun" }]);
});

test("bun detection reads import specifiers, not prose", () => {
  // built from parts so this file doesn't itself look like a bun test.
  const bun = ["bun", "test"].join(":");
  assert.ok(importsBunTest(`import { test } from "${bun}";`));
  assert.ok(importsBunTest(`import { test } from'${bun}'`));
  assert.ok(importsBunTest(`const { test } = await import("${bun}");`));
  assert.ok(!importsBunTest(`// unlike files that import { test } from "${bun}"\nimport test from "node:test";`));
  assert.ok(!importsBunTest(`/* from "${bun}" */ import test from "node:test";`));
  assert.ok(!importsBunTest('const url = "https://example.test"; import test from "node:test";'));
});
