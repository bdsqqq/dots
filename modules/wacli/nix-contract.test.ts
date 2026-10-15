import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const lock: unknown = JSON.parse(readFileSync(resolve(root, "flake.lock"), "utf8"));
assert.ok(
  record(lock) &&
    record(lock.nodes) &&
    record(lock.nodes.nixpkgs) &&
    record(lock.nodes.nixpkgs.locked),
);
const pinned = lock.nodes.nixpkgs.locked;
const tree = ["type", "owner", "repo", "rev", "narHash"]
  .map((k) => {
    assert.equal(typeof pinned[k], "string");
    return `${k} = ${JSON.stringify(pinned[k])};`;
  })
  .join(" ");
const valid: Record<string, string> = {
  wacli: 'account = "chosen"; storeDir = "/private/wacli"; probeGroupJid = "123@g.us";',
  xurl: 'account = "alice"; app = "chosen"; nativeHome = "/private/home"; nativeStateFile = "/private/home/.xurl/auth.yml";',
  openhue:
    'bridge = "192.0.2.1"; configHome = "/private/config"; nativeConfigFile = "/private/config/openhue/config.yaml";',
  remindctl: 'account = "chosen"; listId = "exact-id";',
};
for (const name of Object.keys(valid)) {
  test(`${name}: disabled package mode passes; enabled missing dependency fails; explicit native setup passes`, () => {
    for (const [setting, expected, extra = ""] of [
      ["enable = false;", true],
      ["enable = true;", false],
      [`enable = true; ${valid[name]}`, true],
      ...(name === "xurl"
        ? ([
            [`enable = true; ${valid[name]} authMode = "bootstrap";`, false],
            [
              `enable = true; ${valid[name]} authMode = "bootstrap"; credentialFile = "/private/static.json";`,
              true,
            ],
            [
              `enable = true; ${valid[name]} authMode = "bootstrap";`,
              true,
              // Evaluation-only source fixture; never a deployable credential.
              `config.my.xurl.credential.sopsFile = ${root}/modules/xurl/default.nix;`,
            ],
          ] satisfies [string, boolean, string?][])
        : []),
    ] satisfies [string, boolean, string?][]) {
      const expr = `let source = builtins.fetchTree { ${tree} }; lib = import (source.outPath + "/lib");
      result = lib.evalModules {
        specialArgs.hostSystem = "aarch64-darwin";
        modules = [ ${root}/modules/${name}/default.nix ({ lib, ... }: {
          options.assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = []; };
          options.home-manager = lib.mkOption { type = lib.types.attrs; default = {}; };
          options.homebrew = lib.mkOption { type = lib.types.attrs; default = {}; };
          options.sops.secrets = lib.mkOption {
            default = {};
            type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
              options = {
                path = lib.mkOption { type = lib.types.str; default = "/run/secrets/\${name}"; };
                sopsFile = lib.mkOption { type = lib.types.path; };
                owner = lib.mkOption { type = lib.types.str; };
                mode = lib.mkOption { type = lib.types.str; };
              };
            }));
          };
          options.my.paths.commonplace = lib.mkOption { type = lib.types.str; default = "/private/vault"; };
          config.my.${name}.integration = { ${setting} };
          ${extra}
        }) ];
      }; in builtins.all (x: x.assertion) result.config.assertions`;
      const result = spawnSync("nix", ["eval", "--impure", "--json", "--expr", expr], {
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), expected, `${name}: ${setting}`);
    }
  });
}
