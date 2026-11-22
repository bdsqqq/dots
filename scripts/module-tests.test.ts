import assert from "node:assert/strict";
import test from "node:test";

import { selectSuites } from "./module-tests.ts";

test("new tests are selected by default; packages run once; exclusions hold", () => {
  const files = [
    "modules/new-thing/brand-new.test.ts",
    "modules/company-money/money.test.ts",
    "modules/company-money/ledger/state.test.ts",
    "modules/pi/packages/core/x/index.test.ts",
    "modules/foo/README.md",
  ];
  const suites = selectSuites(files, (dir) => dir === "modules/company-money", "darwin");
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

test("platform-only tests run only on their platform", () => {
  const files = ["modules/app-pins/pins.test.ts", "modules/other/x.test.ts"];
  const names = (platform: NodeJS.Platform) =>
    selectSuites(files, () => false, platform).map((s) => (s.kind === "file" ? s.file : s.dir));
  assert.deepEqual(names("darwin"), ["modules/app-pins/pins.test.ts", "modules/other/x.test.ts"]);
  assert.deepEqual(names("linux"), ["modules/other/x.test.ts"]);
});

test("a package runs every selected test file, not just its script's glob", () => {
  const files = [
    "modules/syncthing/automerge/syncthing-automerge.test.ts",
    "modules/syncthing/automerge/regression.test.ts",
  ];
  assert.deepEqual(selectSuites(files, (dir) => dir === "modules/syncthing/automerge", "linux"), [
    { kind: "package", dir: "modules/syncthing/automerge", files: [...files].sort() },
  ]);
});

test("every node test extension is discovered", () => {
  const files = ["a/x.test.ts", "a/x.test.mts", "a/x.test.cts", "a/x.test.js", "a/x.test.mjs", "a/x.test.cjs", "a/test_x.ts", "a/x.ts", "a/latest_x.ts"];
  assert.equal(selectSuites(files, () => false, "linux").length, 7);
});

test("bun suites stay on bun even inside a package", () => {
  const suites = selectSuites(["modules/html-stuff/server.test.ts"], (dir) => dir === "modules/html-stuff", "linux");
  assert.deepEqual(suites, [{ kind: "file", file: "modules/html-stuff/server.test.ts", runner: "bun" }]);
});
