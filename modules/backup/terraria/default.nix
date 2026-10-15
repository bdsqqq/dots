{ config, lib, ... }:
let
  policy = builtins.fromJSON (builtins.readFile ./plan.json);
  repository = (builtins.fromJSON (builtins.readFile ../ssd-01/drive.json)).repository;
in
{
  imports = [ ../ssd-01/repository.nix ];

  options.my.backup.terraria.saveRoot = lib.mkOption {
    type = lib.types.addCheck lib.types.str (path: lib.hasPrefix "/" path && path != "/");
    description = "existing Terraria save/archive root; backup does not configure syncing";
  };

  config.my.backup.plans.terraria = {
    repository = repository.id;
    paths = map (name: "${config.my.backup.terraria.saveRoot}/${name}") policy.directories;
    inherit (policy) schedule excludes;
  };
}
