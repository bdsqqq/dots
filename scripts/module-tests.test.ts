import assert from "node:assert/strict";
import test from "node:test";

import { selectSuites } from "./module-tests.ts";

test("new tests are selected by default; packages run once; exclusions hold", () => {
  const files = [
    "modules/new-thing/brand-new.test.ts",
    "modules/company-money/money.test.ts",
    "modules/company-money/ledger/state.test.ts",
    "modules/pi/packages/core/x/index.test.ts",
    "modules/html-stuff/server.test.ts",
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
    { kind: "file", file: "modules/new-thing/brand-new.test.ts" },
  ]);
});

test("platform-only tests run only on their platform", () => {
  const files = ["modules/app-pins/pins.test.ts", "modules/other/x.test.ts"];
  const names = (platform: NodeJS.Platform) =>
    selectSuites(files, () => false, platform).map((s) => (s.kind === "file" ? s.file : s.dir));
  assert.deepEqual(names("darwin"), ["modules/app-pins/pins.test.ts", "modules/other/x.test.ts"]);
  assert.deepEqual(names("linux"), ["modules/other/x.test.ts"]);
});
