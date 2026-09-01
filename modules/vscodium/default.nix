{ config, lib, pkgs, hostSystem ? null, ... }:
let
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/vscodium";
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
lib.mkIf (isDarwin || isLinux) {
  home-manager.users.bdsqqq = { config, ... }: lib.mkMerge [
    (lib.mkIf isDarwin {
      home.file."Library/Application Support/VSCodium/User/settings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/settings.json";
        force = true;
      };
      home.file."Library/Application Support/VSCodium/User/keybindings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/keybindings.json";
        force = true;
      };
    })
    (lib.mkIf isLinux {
      home.packages = [ pkgs.vscodium ];
      home.file.".config/VSCodium/User/settings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/settings.json";
        force = true;
      };
      home.file.".config/VSCodium/User/keybindings.json" = {
        source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/keybindings.json";
        force = true;
      };
    })
  ];
}
