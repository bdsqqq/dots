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
    { kind: "file", file: "modules/new-thing/brand-new.test.ts" },
  ]);
});
