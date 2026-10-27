{ lib }:
let
  evaluate = extra: (lib.evalModules {
    specialArgs = {
      hostSystem = "aarch64-darwin";
      pkgs = {
        nodejs_24 = "/fixture/node";
        writeShellScriptBin = name: text: { inherit name text; };
      };
    };
    modules = [
      ./default.nix
      ({ lib, config, ... }: {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          sops.secrets = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
          my.paths.commonplace = lib.mkOption { type = lib.types.str; default = "/fixture/commonplace"; };
          homebrew = {
            prefix = lib.mkOption { type = lib.types.str; default = "/opt/homebrew"; };
            taps = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
            brews = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
          };
          home-manager.users.bdsqqq = {
            home.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
            xdg.configHome = lib.mkOption { type = lib.types.str; default = "/fixture/home/.config"; };
          };
        };
        config = lib.mkIf config.my.depot.credential.required {
          sops.secrets.depot_org_token.path = "/run/secrets/depot_org_token";
        };
      })
      extra
    ];
  }).config;
  dormant = evaluate { };
  missingScope = evaluate { my.depot.credential.required = true; };
  enabled = evaluate { my.depot = { credential.required = true; organizationId = "personal123"; }; };
  valid = cfg: lib.all (a: a.assertion) cfg.assertions;
in
assert valid dormant && dormant.sops.secrets == { };
assert dormant.home-manager.users.bdsqqq.home.packages == [ ];
assert dormant.homebrew.brews == [ "depot" ] && dormant.homebrew.taps == [ "depot/tap" ];
assert !(valid missingScope);
assert valid enabled;
assert builtins.attrNames enabled.sops.secrets == [ "depot_org_token" ];
assert enabled.sops.secrets.depot_org_token.sopsFile == ./secrets.yaml;
assert enabled.sops.secrets.depot_org_token.owner == "bdsqqq";
assert enabled.sops.secrets.depot_org_token.mode == "0400";
assert builtins.length enabled.home-manager.users.bdsqqq.home.packages == 1;
assert (builtins.head enabled.home-manager.users.bdsqqq.home.packages).name == "depot-org";
assert lib.hasInfix "/fixture/commonplace/01_files/nix/modules/depot/auth.ts"
  (builtins.head enabled.home-manager.users.bdsqqq.home.packages).text;
true
