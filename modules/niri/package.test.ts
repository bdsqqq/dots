import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const modulePath = process.env.NIRI_MODULE ?? fileURLToPath(new URL("./default.nix", import.meta.url));

test("use nixpkgs's ABI-matched niri rather than the stale niri-flake builder", () => {
  const result = execFileSync("nix", ["eval", "--impure", "--raw", "--expr", `
    (import (builtins.toPath ${JSON.stringify(modulePath)}) {
      pkgs = {
        niri = "nixpkgs-niri";
        niri-unstable = throw "stale niri-flake builder selected";
      };
      lib = {};
      config = {};
    }).programs.niri.package
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result, "nixpkgs-niri");
});
