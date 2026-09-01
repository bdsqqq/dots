{ config, lib, hostSystem ? null, headMode ? "graphical", ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  repoConfig = "${config.my.paths.commonplace}/01_files/nix/modules/zed";
in
lib.mkIf (headMode == "graphical" && isDarwin) {
  homebrew.casks = [ "zed" ];

  home-manager.users.bdsqqq = { config, ... }: {
    home.file.".config/zed/settings.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/settings.json";
      force = true;
    };
    home.file.".config/zed/keymap.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${repoConfig}/keymap.json";
      force = true;
    };
  };
}
