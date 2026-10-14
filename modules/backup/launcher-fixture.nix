{ root, guid, port
, pkgs ? import (builtins.getFlake ("git+file://" + toString ../..)).inputs.nixpkgs {
    system = builtins.currentSystem;
  }
}:
let
  inherit (pkgs) lib;
  evaluated = (lib.evalModules {
    specialArgs = { inherit pkgs; hostSystem = pkgs.stdenv.hostPlatform.system; };
    modules = [
      ./default.nix
      {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          home-manager = lib.mkOption { type = lib.types.attrs; default = { }; };
          networking = lib.mkOption { type = lib.types.attrs; };
        };
        config = {
          networking.localHostName = "launcher-fixture";
          my.backup = {
            homeDirectory = "${root}/home";
            configDirectory = "${root}/config";
            dataDirectory = "${root}/data";
            bindAddress = "127.0.0.1:${toString port}";
            defaultRepository = "local";
            repositories.local = {
              uri = "${root}/repository";
              inherit guid;
              passwordFile = "${root}/password";
              autoInitialize = false;
              autoUnlock = false;
              checkPolicy.schedule.disabled = true;
              prunePolicy.schedule.disabled = true;
            };
            plans.fixture = {
              paths = [ "${root}/source" ];
              schedule.disabled = true;
            };
          };
        };
      }
    ];
  }).config;
in
assert lib.hasPrefix "/" root && !(lib.hasPrefix "/nix/store/" root);
assert builtins.match "[0-9a-f]{64}" guid != null;
assert builtins.isInt port && port > 0 && port < 65536;
assert builtins.all (item: item.assertion) evaluated.assertions;
evaluated.my.backup.package
