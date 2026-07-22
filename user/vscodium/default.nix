{ config, lib, hostSystem ? null, ... }:
let
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/user/vscodium";
in
if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  {
    home-manager.users.bdsqqq = { config, ... }: {
      home.file."Library/Application Support/VSCodium/User/settings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/settings.json";
        force = true;
      };
      home.file."Library/Application Support/VSCodium/User/keybindings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/keybindings.json";
        force = true;
      };
    };
  }
