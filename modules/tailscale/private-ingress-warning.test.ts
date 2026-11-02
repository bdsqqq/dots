import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policy = fileURLToPath(new URL("./private-ingress.nix", import.meta.url));
const diagnostic = fileURLToPath(new URL("./private-ingress-warning.nix", import.meta.url));

// Exercise Nix's actual import/disabledModules handling, not a source-text grep.
// These minimal option contracts need no target platform, packages, or builds.
const expression = `let
  lib = (builtins.getFlake ${JSON.stringify(root)}).inputs.nixpkgs.lib;
  policy = builtins.toPath ${JSON.stringify(policy)};
  diagnostic = builtins.toPath ${JSON.stringify(diagnostic)};
  schema = { lib, ... }: {
    options = {
      warnings = lib.mkOption { type = lib.types.listOf lib.types.str; default = []; };
      networking.hostName = lib.mkOption { type = lib.types.str; };
      networking.firewall = lib.mkOption { type = lib.types.attrs; default = {}; };
      services.openssh = lib.mkOption { type = lib.types.attrs; default = {}; };
      services.tailscale = lib.mkOption {
        type = lib.types.attrs;
        default = {};
      };
    };
    config.services.tailscale.interfaceName = "tailscale0";
  };
  evaluate = name: modules: lib.evalModules {
    modules = [ schema diagnostic { networking.hostName = name; } ] ++ modules;
  };
  present = evaluate "covered" [ policy ];
  removed = present.extendModules { modules = [{ disabledModules = [ policy ]; }]; };
in {
  missing = (evaluate "new-linux-host" []).config.warnings;
  present = present.config.warnings;
  indirect = (evaluate "indirect" [{ imports = [ policy ]; }]).config.warnings;
  disabled = (evaluate "disabled" [ policy { disabledModules = [ policy ]; }]).config.warnings;
  removed = removed.config.warnings;
}`;
const warnings = JSON.parse(execFileSync("nix", ["eval", "--impure", "--json", "--no-write-lock-file", "--expr", expression], {
  encoding: "utf8", timeout: 120_000,
})) as Record<string, string[]>;

function assertMissing(actual: string[], hostname: string): void {
  assert.equal(actual.length, 1);
  assert.ok(actual[0].startsWith(`${hostname}: missing `));
  assert.ok(actual[0].includes("modules/tailscale/private-ingress.nix"));
}

test("a new Linux host without any Tailscale import gets an actionable warning", () => {
  assertMissing(warnings.missing, "new-linux-host");
});

test("direct and indirect imports suppress the diagnostic", () => {
  assert.deepEqual(warnings.present, []);
  assert.deepEqual(warnings.indirect, []);
});

test("disabled and subsequently removed policy imports still warn", () => {
  assertMissing(warnings.disabled, "disabled");
  assertMissing(warnings.removed, "covered");
});
